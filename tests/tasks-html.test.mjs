// P2-1 端到端（HTML 级）验证：在 Node 里加载真实 app.js，用两条取数路径分别调用
// 真正的 renderTasks()，比较写进 #view-tasks 的 HTML 是否**逐字节相同**。
//
//   node tests/tasks-html.test.mjs

import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import { tasksSelection } from '../public/viewmodel.js';

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
    appendChild(c) { this.children.push(c); return c; },
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
     return { DB, state, renderTasks };`,
  );
  const api = factory(
    windowStub, documentStub, windowStub.localStorage, windowStub.sessionStorage, windowStub.location,
    windowStub.navigator, URLSearchParams, windowStub.requestAnimationFrame,
    windowStub.getComputedStyle, windowStub.fetch, console,
  );
  return { ...api, sandbox: { get, window: windowStub } };
}

const state = JSON.parse(readFileSync(join(BASELINE, 'planner-state.json'), 'utf8'));
console.log('tasks-html.test.mjs');
console.log(`  baseline: ${BASELINE}（${state.tasks.length} 条任务）`);

// 两种排序各跑一遍（2026-09-25 新增「时间优先」，见测试反馈 v）
for (const sort of ['smart', 'balanced', 'due']) {
  for (const filter of ['all', 'todo', 'doing', 'done']) {
    const html = {};
    for (const useVM of [true, false]) {
      const app = loadApp(useVM ? { tasksSelection } : null);
      Object.assign(app.DB, state);
      app.state.taskFilter = filter;
      app.state.taskSort = sort;
      app.renderTasks();
      html[useVM ? 'vm' : 'legacy'] = app.sandbox.get('#view-tasks').innerHTML;
    }
    const same = html.vm === html.legacy;
    ok(`[${sort}/${filter}] 两条路径渲染的 HTML 逐字节相同（${html.vm.length} 字符）`, same,
      same ? '' : firstDiff(html.legacy, html.vm));
    ok(`[${sort}/${filter}] 渲染结果非空、含表头与排序下拉`,
      html.vm.includes('新增任务') && html.vm.includes('截止时间') && html.vm.includes('id="task-sort"'));
  }
}

function firstDiff(a, b) {
  let i = 0;
  while (i < a.length && i < b.length && a[i] === b[i]) i += 1;
  return `@${i} legacy=${JSON.stringify(a.slice(i, i + 80))} vm=${JSON.stringify(b.slice(i, i + 80))}`;
}

console.log('');
console.log(failures === 0 ? 'tasks-html.test: PASS' : `tasks-html.test: FAIL (${failures})`);
process.exit(failures === 0 ? 0 : 1);
