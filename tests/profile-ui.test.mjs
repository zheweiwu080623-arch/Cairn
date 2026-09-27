// 「我关心什么」面板 + 待批准条目的裁决回显（信息筛选 P0 的 UI 部分）。
//
//   node tests/profile-ui.test.mjs
//
// 做法与其它 HTML 级测试一致：在 Node 里加载真实 app.js，调用真实的 renderConnectors()，
// 断言面板与徽章真的渲染出来了、两条画像入口都在。

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..');

let failures = 0;
const ok = (label, cond, detail = '') => {
  if (cond) console.log(`  PASS ${label}`);
  else {
    failures += 1;
    console.log(`  FAIL ${label}${detail ? ` -- ${detail}` : ''}`);
  }
};

function makeElement(tag = 'div') {
  const kids = new Map();
  return {
    tagName: tag, innerHTML: '', textContent: '', value: '', className: '', checked: false,
    style: {}, dataset: {}, children: [], onclick: null, offsetHeight: 0,
    classList: { add() {}, remove() {}, toggle() {}, contains: () => false },
    appendChild(c) { this.children.push(c); return c; },
    prepend(c) { this.children.unshift(c); return c; },
    removeChild() {}, remove() {}, setAttribute() {}, removeAttribute() {}, after() {},
    addEventListener() {}, removeEventListener() {}, focus() {}, blur() {}, click() {},
    querySelector: (s) => { if (!kids.has(s)) kids.set(s, makeElement('div')); return kids.get(s); },
    querySelectorAll: () => [], insertAdjacentHTML() {},
    getBoundingClientRect: () => ({ top: 0, left: 0, width: 0, height: 0, bottom: 0, right: 0 }),
  };
}

function loadApp(state) {
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

  const src = readFileSync(join(ROOT, 'public', 'app.js'), 'utf8');
  const build = new Function(
    'window', 'document', 'localStorage', 'sessionStorage', 'location', 'navigator',
    'URLSearchParams', 'requestAnimationFrame', 'getComputedStyle', 'fetch', 'console',
    `${src}
     return { DB, state, renderConnectors, verdictPill, verdictWhy };`,
  );
  const api = build(
    windowStub, documentStub, windowStub.localStorage, windowStub.sessionStorage, windowStub.location,
    windowStub.navigator, URLSearchParams, windowStub.requestAnimationFrame,
    windowStub.getComputedStyle, windowStub.fetch, console,
  );
  Object.assign(api.DB, state);
  return { ...api, sandbox: { get } };
}

console.log('profile-ui.test.mjs');

const state = JSON.parse(readFileSync(join(ROOT, 'tests', 'fixtures', 'planner-state.json'), 'utf8'));

// ---- 1. 数据源页留给模块的挂载点 ----
// 注：「我关心什么」面板本身已搬进可插拔模块，卡片内容的断言在 tests/modules.test.mjs 里；
// 这里只确认 app.js 仍然会去挂载它（挂载点还在页面结构里）。
const app = loadApp({ ...state, pending: [] });
app.renderConnectors();
const html = app.sandbox.get('#view-connectors').innerHTML;
ok('数据源页仍在渲染连接器卡片（模块挂载点依附于它）', html.includes('conn-card') || html.includes('每日自动同步'));
ok('卡片主体已不在 app.js 内联（搬家完成）', !html.includes('id="profile-card"'));

// ---- 2. 待批准条目的裁决徽章与"为什么" ----
const app2 = loadApp({
  ...state,
  profile: { enabled: true, pushAt: 3, dropAt: -3, origin: 'manual' },
  pending: [
    {
      id: 'p1', source: 'email', kind: 'reminder', title: '限时优惠：全场促销',
      verdict: 'drop', score: -4,
      reasons: JSON.stringify([{ rule: 'promo-tone', delta: -2, note: '标题像推广/订阅类内容' }]),
    },
    {
      id: 'p2', source: 'email_sjtu', kind: 'reminder', title: '选课通知',
      verdict: 'review', score: 0, reasons: JSON.stringify([]),
    },
    { id: 'p3', source: 'canvas', kind: 'task', title: '老数据（没有裁决）' },
  ],
});
app2.renderConnectors();
const html2 = app2.sandbox.get('#view-connectors').innerHTML;

ok('待批准里出现「建议忽略」徽章', html2.includes('建议忽略'), '没有 drop 徽章');
ok('待批准里出现「待确认」徽章', html2.includes('待确认'), '没有 review 徽章');
ok('徽章带上分数', html2.includes('建议忽略 -4'), '分数没显示');
ok('有「为什么」一行，把规则翻成人话',
  html2.includes('为什么：') && html2.includes('标题像推广/订阅类内容'));
ok('没有裁决的老数据不会渲染出空徽章',
  app2.verdictPill({ id: 'p3', title: '老数据' }) === '');

// ---- 3. 纯函数边界 ----
ok('verdictWhy 对空 reasons 返回空串', app2.verdictWhy({ reasons: '[]' }) === '');
ok('verdictWhy 对坏 JSON 不抛异常', app2.verdictWhy({ reasons: '{坏掉的' }) === '');
ok('没有裁决的条目不会渲染出徽章（边界）', app2.verdictPill({}) === '');

console.log('');
console.log(failures === 0 ? 'profile-ui.test: PASS' : `profile-ui.test: FAIL (${failures})`);
process.exit(failures === 0 ? 0 : 1);
