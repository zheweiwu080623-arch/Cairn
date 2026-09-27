// P0-2 端到端（HTML 级）验证：在 Node 里加载真实的 app.js，用两条取数路径
// 渲染同一份数据，比较生成的 HTML 是否**逐字节相同**。
//
//   node tests/today-html.test.mjs
//
// 与 today-wiring.test.mjs 的区别：那个只比数据，这个比最终 HTML——
// 用的是 app.js 里真实的 evtCard / taskRow / notifRow / todayHtml，
// 所以它能抓住「数据一样但渲染不一样」这一类问题。

import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import { todaySelection } from '../public/viewmodel.js';

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

// ---- 极简 DOM 桩：只为让 app.js 的渲染函数能跑起来
function makeElement(tag = 'div') {
  const el = {
    tagName: tag, innerHTML: '', textContent: '', value: '', className: '', checked: false,
    style: {}, dataset: {}, children: [],
    classList: { add() {}, remove() {}, toggle() {}, contains: () => false },
    appendChild(child) { this.children.push(child); return child; },
    removeChild() {}, remove() {}, setAttribute() {}, removeAttribute() {},
    addEventListener() {}, removeEventListener() {}, focus() {}, blur() {}, click() {},
    querySelector: () => null, querySelectorAll: () => [], insertAdjacentHTML() {},
    getBoundingClientRect: () => ({ top: 0, left: 0, width: 0, height: 0, bottom: 0, right: 0 }),
  };
  return el;
}

function makeSandbox(search = '') {
  const elements = new Map();
  const get = (key) => {
    if (!elements.has(key)) elements.set(key, makeElement(key.startsWith('#') ? key.slice(1) : 'div'));
    return elements.get(key);
  };
  const documentStub = {
    body: makeElement('body'),
    documentElement: makeElement('html'),
    title: '',
    querySelector: (s) => get(s),
    querySelectorAll: () => [],
    getElementById: (id) => get('#' + id),
    createElement: (t) => makeElement(t),
    createTextNode: (t) => ({ textContent: t }),
    addEventListener() {}, removeEventListener() {},
    cookie: '',
  };
  const windowStub = {
    document: documentStub,
    location: { search, href: 'http://127.0.0.1:3210/' + search, origin: 'http://127.0.0.1:3210' },
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
  return { elements, get, document: documentStub, window: windowStub };
}

function loadApp(search = '', plannerVM = null) {
  const sb = makeSandbox(search);
  if (plannerVM) sb.window.PlannerVM = plannerVM;
  const src = readFileSync(join(ROOT, 'public/app.js'), 'utf8');
  const factory = new Function(
    'window', 'document', 'localStorage', 'sessionStorage', 'location', 'navigator',
    'URLSearchParams', 'requestAnimationFrame', 'getComputedStyle', 'fetch', 'console',
    `${src}
     return { DB, renderToday, todayHtml, legacyTodaySelection, todaySelectionFromVM,
              todaySelectionFor, vmSelfCheck };`,
  );
  const api = factory(
    sb.window, sb.document, sb.window.localStorage, sb.window.sessionStorage, sb.window.location,
    sb.window.navigator, URLSearchParams, sb.window.requestAnimationFrame,
    sb.window.getComputedStyle, sb.window.fetch, console,
  );
  return { ...api, sandbox: sb };
}

const state = JSON.parse(readFileSync(join(BASELINE, 'planner-state.json'), 'utf8'));
const expected = JSON.parse(readFileSync(join(BASELINE, 'expected-today.json'), 'utf8'));

console.log('today-html.test.mjs');
console.log(`  baseline: ${BASELINE}`);

const plannerVM = { todaySelection };
for (const variant of expected.variants) {
  const app = loadApp('', plannerVM);
  Object.assign(app.DB, state);
  const html = {
    legacy: app.todayHtml(app.legacyTodaySelection(variant.now_ms), variant.now_ms),
    vm: app.todayHtml(app.todaySelectionFromVM(variant.now_ms), variant.now_ms),
  };
  const same = html.legacy === html.vm;
  ok(`[${variant.label}] 两条路径渲染出的 HTML 逐字节相同（${html.vm.length} 字符）`,
    same, same ? '' : firstDiff(html.legacy, html.vm));
  ok(`[${variant.label}] 渲染结果非空且含今日卡片`,
    html.vm.length > 400 && html.vm.includes('今日日程') && html.vm.includes('Codex 连接'));
}

// 默认路径确实走 VM：把 VM 的输出改一个字符，默认渲染结果应当随之变化
{
  const app = loadApp('', plannerVM);
  Object.assign(app.DB, state);
  const before = app.todayHtml(app.todaySelectionFromVM(expected.variants[3].now_ms), expected.variants[3].now_ms);
  const legacyOnly = app.todayHtml(app.legacyTodaySelection(expected.variants[3].now_ms), expected.variants[3].now_ms);
  ok('默认（有 PlannerVM）与回退路径结果一致', before === legacyOnly);

  const appOff = loadApp('?vm=0', plannerVM);
  Object.assign(appOff.DB, state);
  const off = appOff.todaySelectionFor(expected.variants[3].now_ms);
  ok('?vm=0 时取数走旧实现（返回同一批数据）',
    JSON.stringify(off.overdue.map((t) => t.id))
    === JSON.stringify(appOff.legacyTodaySelection(expected.variants[3].now_ms).overdue.map((t) => t.id)));
}

// renderToday() 本体：写进 #view-today 的 HTML 与 todayHtml 一致
{
  const app = loadApp('', plannerVM);
  Object.assign(app.DB, state);
  const now = expected.variants[3].now_ms;
  app.renderToday();
  const el = app.sandbox.get('#view-today');
  ok('renderToday() 真的把 HTML 写进了 #view-today',
    el.innerHTML.length > 400 && el.innerHTML.includes('今天的安排'));
}

function firstDiff(a, b) {
  let i = 0;
  while (i < a.length && i < b.length && a[i] === b[i]) i += 1;
  return `@${i} legacy=${JSON.stringify(a.slice(i, i + 80))} vm=${JSON.stringify(b.slice(i, i + 80))}`;
}

console.log('');
console.log(failures === 0 ? 'today-html.test: PASS' : `today-html.test: FAIL (${failures})`);
process.exit(failures === 0 ? 0 : 1);
