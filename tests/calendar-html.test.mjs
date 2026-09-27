// A4 端到端（HTML 级）验证：在 Node 里加载真实 app.js，用两条取数路径分别调用
// 真正的 renderMonth()，比较写进 #view-calendar 的 HTML 是否**逐字节相同**。
//
//   node tests/calendar-html.test.mjs

import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import { calendarMonthSelection } from '../public/viewmodel.js';

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
  const kids = new Map();
  return {
    tagName: tag, innerHTML: '', textContent: '', value: '', className: '', checked: false,
    style: {}, dataset: {}, children: [], onclick: null,
    classList: { add() {}, remove() {}, toggle() {}, contains: () => false },
    appendChild(c) { this.children.push(c); return c; }, prepend(c) { this.children.unshift(c); return c; },
    removeChild() {}, remove() {}, setAttribute() {}, removeAttribute() {},
    addEventListener() {}, removeEventListener() {}, focus() {}, blur() {}, click() {},
    // 真实页面里 el.querySelector 总能拿到元素；这里也返回一个替身，
    // 否则 schedNav 里 `$('[data-sd="today"]', bar).onclick = ...` 会炸。
    querySelector: (s) => { if (!kids.has(s)) kids.set(s, makeElement('div')); return kids.get(s); },
    querySelectorAll: () => [], insertAdjacentHTML() {},
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
     return { DB, state, renderMonth };`,
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
for (const key of ['events', 'tasks', 'notifications', 'academic', 'courses']) {
  if (!Array.isArray(state[key])) state[key] = [];
}
console.log('calendar-html.test.mjs');
console.log(`  baseline: ${BASELINE}（${(state.events || []).length} 个日程）`);

const p = (n) => String(n).padStart(2, '0');
const months = [[2026, 8], [2026, 7], [2026, 1], [2027, 2]];

for (const [y, m] of months) {
  const html = {};
  for (const useVM of [true, false]) {
    const app = loadApp(useVM ? { calendarMonthSelection } : null);
    Object.assign(app.DB, state);
    app.state.sched.cursor = new Date(y, m, 15, 0, 0, 0, 0);
    app.renderMonth(app.sandbox.get('#view-calendar'));
    html[useVM ? 'vm' : 'legacy'] = app.sandbox.get('#view-calendar').children.map((c) => c.innerHTML).join('');
  }
  const same = html.vm === html.legacy;
  ok(`[${y}-${p(m + 1)}] 两条路径渲染的 HTML 逐字节相同（${html.vm.length} 字符）`, same,
    same ? '' : firstDiff(html.legacy, html.vm));
}

// 结构自检：格子数 = 周数 × 7，且表头 7 列
const app = loadApp({ calendarMonthSelection });
Object.assign(app.DB, state);
app.state.sched.cursor = new Date(2026, 8, 15);
app.renderMonth(app.sandbox.get('#view-calendar'));
const gridEl = app.sandbox.get('#view-calendar').children.find((c) => c.className === 'month-view');
const gridHtml = gridEl ? gridEl.innerHTML : '';
const cells = [...gridHtml.matchAll(/class="mg-cell/g)].length;
const heads = [...gridHtml.matchAll(/class="mg-head"/g)].length;
ok(`月历表头 7 列（${heads}）`, heads === 7);
ok(`格子数是 7 的倍数（${cells} 格）`, cells > 0 && cells % 7 === 0);
ok('本月格子数与真实天数一致（2026-09 应为 30 天）',
  [...gridHtml.matchAll(/class="mg-cell (?!dim)/g)].length === 30);
ok('渲染结果含周号', gridHtml.includes('wnum'));
ok('中文没有变成问号（编码正常）', !gridHtml.includes('?????'));

console.log('');
console.log(failures === 0 ? 'calendar-html.test: PASS' : `calendar-html.test: FAIL (${failures})`);
process.exit(failures === 0 ? 0 : 1);
