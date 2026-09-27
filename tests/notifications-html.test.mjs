// P2-1 端到端（HTML 级）：加载真实 app.js，两条取数路径分别调用真正的
// renderNotifications()，比较写进 #view-notifications 的 HTML 是否逐字节相同。
//   node tests/notifications-html.test.mjs

import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import { notificationsSelection } from '../public/viewmodel.js';

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
     return { DB, renderNotifications };`,
  );
  const api = factory(
    windowStub, documentStub, windowStub.localStorage, windowStub.sessionStorage, windowStub.location,
    windowStub.navigator, URLSearchParams, windowStub.requestAnimationFrame,
    windowStub.getComputedStyle, windowStub.fetch, console,
  );
  return { ...api, sandbox: { get, window: windowStub } };
}

const state = JSON.parse(readFileSync(join(BASELINE, 'planner-state.json'), 'utf8'));
console.log('notifications-html.test.mjs');
console.log(`  baseline: ${BASELINE}（${state.notifications.length} 条通知）`);

const html = {};
for (const useVM of [true, false]) {
  const app = loadApp(useVM ? { notificationsSelection } : null);
  Object.assign(app.DB, state);
  app.renderNotifications();
  html[useVM ? 'vm' : 'legacy'] = app.sandbox.get('#view-notifications').innerHTML;
}
const same = html.vm === html.legacy;
ok(`两条路径渲染的 HTML 逐字节相同（${html.vm.length} 字符）`, same,
  same ? '' : `@ ${[...html.vm].findIndex((c, i) => c !== html.legacy[i])}`);
ok('渲染结果非空且含提醒列表', html.vm.includes('新增提醒') && html.vm.includes('list-item'));
ok('条目数与数据条数一致',
  (html.vm.match(/data-edit="notif"/g) || []).length === state.notifications.length,
  `${(html.vm.match(/data-edit="notif"/g) || []).length} vs ${state.notifications.length}`);

console.log('');
console.log(failures === 0 ? 'notifications-html.test: PASS' : `notifications-html.test: FAIL (${failures})`);
process.exit(failures === 0 ? 0 : 1);
