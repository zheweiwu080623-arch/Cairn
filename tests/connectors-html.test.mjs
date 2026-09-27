// A3 端到端（HTML 级）验证：在 Node 里加载真实 app.js，用两条取数路径分别调用
// 真正的 renderConnectors()，比较写进 #view-connectors 的 HTML 是否**逐字节相同**。
//
//   node tests/connectors-html.test.mjs

import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import { connectorsSelection } from '../public/viewmodel.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..');
const CANDIDATES = [
  process.env.PLANNER_TEST_BASELINE,
  join(HERE, 'fixtures'),
  join(HERE, '..', '..', '..', 'baseline'),
].filter(Boolean);
const BASELINE = CANDIDATES.find((d) => existsSync(join(d, 'planner-state.json')));

let failures = 0;
const ok = (label, condition, detail = '') => {
  if (condition) console.log(`  PASS ${label}`);
  else {
    failures += 1;
    console.log(`  FAIL ${label}${detail ? ` -- ${detail}` : ''}`);
  }
};

function makeElement(tag = 'div') {
  return {
    tagName: tag, innerHTML: '', textContent: '', value: '', className: '', checked: false,
    style: {}, dataset: {}, children: [], onclick: null,
    classList: { add() {}, remove() {}, toggle() {}, contains: () => false },
    appendChild(c) { this.children.push(c); return c; }, prepend(c) { this.children.unshift(c); return c; },
    removeChild() {}, remove() {}, setAttribute() {}, removeAttribute() {},
    addEventListener() {}, removeEventListener() {}, focus() {}, blur() {}, click() {},
    querySelector: () => null, querySelectorAll: () => [], insertAdjacentHTML() {},
    getBoundingClientRect: () => ({ top: 0, left: 0, width: 0, height: 0, bottom: 0, right: 0 }),
  };
}

function loadApp(plannerVM = null) {
  const elements = new Map();
  const get = (key) => {
    if (!elements.has(key)) elements.set(key, makeElement(key.startsWith('#') ? key.slice(1) : 'div'));
    return elements.get(key);
  };
  const documentStub = {
    body: makeElement('body'), documentElement: makeElement('html'), title: '',
    querySelector: (s) => get(s), querySelectorAll: () => [],
    getElementById: (id) => get('#' + id),
    createElement: (t) => makeElement(t), createTextNode: (t) => ({ textContent: t }),
    addEventListener() {}, removeEventListener() {}, cookie: '',
  };
  const windowStub = {
    document: documentStub,
    location: { search: '', href: 'http://127.0.0.1:3210/', origin: 'http://127.0.0.1:3210' },
    navigator: { userAgent: 'node', language: 'zh-CN', clipboard: {} },
    localStorage: { getItem: () => null, setItem() {}, removeItem() {} },
    sessionStorage: { getItem: () => null, setItem() {}, removeItem() {} },
    matchMedia: () => ({ matches: false, addEventListener() {}, removeEventListener() {} }),
    requestAnimationFrame: (fn) => setTimeout(fn, 0),
    cancelAnimationFrame() {}, setTimeout, clearTimeout, setInterval: () => 0, clearInterval() {},
    addEventListener() {}, removeEventListener() {}, dispatchEvent() {},
    getComputedStyle: () => ({ getPropertyValue: () => '' }),
    innerWidth: 1280, innerHeight: 800, devicePixelRatio: 1,
    Audio: function Audio() { return { play() {}, pause() {}, addEventListener() {} }; },
    Image: function Image() { return makeElement('img'); },
    Notification: undefined,
    fetch: () => Promise.resolve({ ok: true, json: () => Promise.resolve({}) }),
    console,
  };
  windowStub.window = windowStub;
  windowStub.self = windowStub;
  if (plannerVM) windowStub.PlannerVM = plannerVM;

  const src = readFileSync(join(ROOT, 'public/app.js'), 'utf8');
  const factory = new Function(
    'window', 'document', 'localStorage', 'sessionStorage', 'location', 'navigator',
    'URLSearchParams', 'requestAnimationFrame', 'getComputedStyle', 'fetch', 'console',
    `${src}
     return { DB, state, renderConnectors };`,
  );
  const api = factory(
    windowStub, documentStub, windowStub.localStorage, windowStub.sessionStorage, windowStub.location,
    windowStub.navigator, URLSearchParams, windowStub.requestAnimationFrame,
    windowStub.getComputedStyle, windowStub.fetch, console,
  );
  return { ...api, sandbox: { get, window: windowStub } };
}

function firstDiff(a, b) {
  let i = 0;
  while (i < a.length && i < b.length && a[i] === b[i]) i += 1;
  return `@${i} legacy=${JSON.stringify(a.slice(i, i + 80))} vm=${JSON.stringify(b.slice(i, i + 80))}`;
}

const state = JSON.parse(readFileSync(join(BASELINE, 'planner-state.json'), 'utf8'));
const meta = (state.connectors && state.connectors.meta) || [];
console.log('connectors-html.test.mjs');
console.log(`  baseline: ${BASELINE}（${meta.length} 个数据源）`);

const html = {};
for (const useVM of [true, false]) {
  const app = loadApp(useVM ? { connectorsSelection } : null);
  Object.assign(app.DB, state);
  app.renderConnectors();
  html[useVM ? 'vm' : 'legacy'] = app.sandbox.get('#view-connectors').innerHTML;
}

const same = html.vm === html.legacy;
ok(`两条路径渲染的 HTML 逐字节相同（${html.vm.length} 字符）`, same,
  same ? '' : firstDiff(html.legacy, html.vm));
ok('渲染结果非空且含自动同步卡片', html.vm.includes('每日自动同步'));
ok('渲染结果非空且含后台常驻卡片', html.vm.includes('后台常驻'));

const cards = [...html.vm.matchAll(/class="card conn-card" data-conn="([^"]+)"/g)].map((m) => m[1]);
ok(`连接器卡片数量一致（${cards.length}/${meta.length}）`, cards.length === meta.length, cards.join(','));
ok('顺序与 /api/state 一致', cards.join(',') === meta.map((m) => m.id).join(','), cards.join(','));

const inputs = [...html.vm.matchAll(/data-key="([^"]+)"/g)].map((m) => m[1]);
const expectedInputs = meta.reduce((n, m) => n + ((m.fields || []).length), 0);
ok(`配置输入框数量一致（${inputs.length}/${expectedInputs}）`, inputs.length === expectedInputs);
ok('每条数据源的名称与条数都渲染出来了',
  meta.every((m) => html.vm.includes(m.name) && html.vm.includes(`${(state.connectors.counts || {})[m.id] || 0} 条`)));
ok('中文没有变成问号（编码正常）', !html.vm.includes('?????'));

console.log('');
console.log(failures === 0 ? 'connectors-html.test: PASS' : `connectors-html.test: FAIL (${failures})`);
process.exit(failures === 0 ? 0 : 1);
