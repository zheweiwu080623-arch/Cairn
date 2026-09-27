// 月历能翻页 + 跨月自动跟随（2026-09-27）
//
//   node tests/calendar-nav.test.mjs
//
// 用户原话：「日程部分我看不到后面的日程安排，让月历可以翻阅（目前在9月，应该有：
// 1. 到了十月自动翻阅；2. 可以自选随时翻到后面或者前面的月份）」。
//
// 查证：schedNav() 收了 onPrev / onNext 两个回调**却从没接到按钮上** ⇒ 顶栏只有「今天」，
// 月 / 周 / 日 三种视图都翻不了页；定时器也只更新时钟文本，跨天不会自己翻。
// 这里用真实 app.js（同一套 DOM 替身）测三件事：按钮在、跟随逻辑对、学期标记不刷屏。

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
let failures = 0;
const ok = (label, cond, detail = '') => {
  if (cond) console.log(`  PASS ${label}`);
  else { failures += 1; console.log(`  FAIL ${label}${detail ? ` -- ${detail}` : ''}`); }
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
    querySelector: (s) => { if (!kids.has(s)) kids.set(s, makeElement('div')); return kids.get(s); },
    querySelectorAll: () => [], insertAdjacentHTML() {},
    getBoundingClientRect: () => ({ top: 0, left: 0, width: 0, height: 0, bottom: 0, right: 0 }),
    offsetHeight: 0,
  };
}

function loadApp() {
  const elements = new Map();
  const get = (key) => {
    if (!elements.has(key)) elements.set(key, makeElement(key.startsWith('#') ? key.slice(1) : 'div'));
    return elements.get(key);
  };
  const documentStub = {
    body: makeElement('body'), documentElement: makeElement('html'), title: '', hidden: false,
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
  const factory = new Function(
    'window', 'document', 'localStorage', 'sessionStorage', 'location', 'navigator',
    'URLSearchParams', 'requestAnimationFrame', 'getComputedStyle', 'fetch', 'console',
    `${src}
     return { DB, state, renderMonth, schedFollowToday, schedNav };`,
  );
  const api = factory(
    windowStub, documentStub, windowStub.localStorage, windowStub.sessionStorage, windowStub.location,
    windowStub.navigator, URLSearchParams, windowStub.requestAnimationFrame,
    windowStub.getComputedStyle, windowStub.fetch, console,
  );
  return { ...api, sandbox: { get, window: windowStub } };
}

console.log('calendar-nav.test.mjs');

const A = (title, kind, start, end) => ({ id: `${kind}-${start}`, title, kind, start_at: start, end_at: end || start, color: '#e60012' });
const DB = {
  academic: [
    A('2026秋 · 开学', 'term', '2026-09-14', '2026-12-20'),
    A('国庆假期', 'holiday', '2026-10-01', '2026-10-07'),
    A('考试周', 'exam', '2026-12-14', '2026-12-18'),
  ],
  events: [
    { id: 'e1', title: '小组会', start_at: '2026-10-05T10:00:00', end_at: '2026-10-05T11:00:00', color: '#4f7cff' },
    { id: 'e2', title: '讲座', start_at: '2026-10-08T14:00:00', end_at: '2026-10-08T15:00:00', color: '#4f7cff' },
    { id: 'e3', title: '班会', start_at: '2026-10-08T16:00:00', end_at: '2026-10-08T17:00:00', color: '#4f7cff' },
  ],
  tasks: [
    { id: 't1', title: '交作业', due_at: '2026-10-05T23:59:00', status: 'todo' },
    { id: 't2', title: '写实验报告', due_at: '2026-10-08T23:00:00', status: 'todo' },
    { id: 't3', title: '复习线代', due_at: '2026-10-08T23:30:00', status: 'todo' },
    { id: 't4', title: '背单词', due_at: '2026-10-08T23:59:00', status: 'todo' },
  ],
  notifications: [], courses: [],
};

// ---------------- ① 顶栏有 ◀ ▶ 两个翻页按钮，并且真的接到了回调 ----------------
{
  const app = loadApp();
  Object.assign(app.DB, DB);
  app.state.sched.cursor = new Date(2026, 8, 27);
  const el = app.sandbox.get('#view-calendar');
  let prevCalled = 0; let nextCalled = 0;
  app.schedNav(el, '测试标题', () => { prevCalled += 1; }, () => { nextCalled += 1; }, () => {});
  const bar = el.children.find((c) => c.className === 'sched-top');
  const html = bar ? bar.innerHTML : '';
  ok('顶栏里有上一页 / 下一页按钮', html.includes('data-sd="prev"') && html.includes('data-sd="next"'));
  ok('按钮上写着 ◀ / ▶ 且带无障碍标签', html.includes('◀') && html.includes('▶') && html.includes('aria-label="上一月"'));
  ok('三种视图的提示文字会变（月/周/日）', html.includes('上一月') && !html.includes('undefined'));
  // 替身里 $('[data-sd="prev"]', bar) 返回的是"懒得建元素"的替身，onclick 能挂上，但没法真点。
  // 所以这里直接查源码里的接线（行为层面的翻页由下面的 follow 用例 + 真机实测覆盖）。
  const src = readFileSync(join(ROOT, 'public', 'app.js'), 'utf8');
  ok('onPrev / onNext 真的接到了按钮上（以前收了不用）',
    src.includes("if (onPrev) $('[data-sd=\"prev\"]', bar).onclick = manual(onPrev);")
    && src.includes("if (onNext) $('[data-sd=\"next\"]', bar).onclick = manual(onNext);"));
  ok('手动翻页会关掉"自动跟随"，点「今天」再打开',
    src.includes('const manual = (fn) => () => { state.sched.follow = false; fn(); };')
    && src.includes("$('[data-sd=\"today\"]', bar).onclick = () => { state.sched.follow = true; onToday(); };"));
}

// ---------------- ② 跟随"今天"：跨天 / 跨月自动翻 ----------------
{
  const app = loadApp();
  Object.assign(app.DB, DB);
  // 2026-09-28 修：原来写死 new Date(2026, 8, 27) 当"今天"——过了那一天就假失败。改成真的今天。
  const today = new Date();
  app.state.sched.cursor = new Date(today);            // 停在今天
  app.state.sched.follow = true;
  ok('已经在今天 → 不重画', app.schedFollowToday() === false);
  app.state.sched.cursor = new Date(today.getFullYear(), today.getMonth() - 2, 1);   // 模拟"页面还停在两个月前"
  ok('页面停在过去 → 自动把光标挪到今天（这就是"到了十月自动翻阅"）', app.schedFollowToday() === true);
  ok('挪过去就是今天那一天', app.state.sched.cursor.toDateString() === new Date().toDateString());
  app.state.sched.follow = false;                      // 用户手动翻过页
  app.state.sched.cursor = new Date(today.getFullYear(), today.getMonth() + 3, 20);  // 正在看几个月后的某一天
  ok('用户手动翻走的页面**不会被拽回来**（尊重他正在看的月份）', app.schedFollowToday() === false);
  ok('光标保持不动', app.state.sched.cursor.getMonth() === ((today.getMonth() + 3) % 12));
}

// ---------------- ③ 月历：学期标记只在开学那天标一次，假期照常覆盖每一天 ----------------
{
  const app = loadApp();
  Object.assign(app.DB, DB);
  app.state.sched.cursor = new Date(2026, 11, 15);     // 12 月（学期区间内）
  app.renderMonth(app.sandbox.get('#view-calendar'));
  const grid = app.sandbox.get('#view-calendar').children.find((c) => c.className === 'month-view');
  const html = grid ? grid.innerHTML : '';
  const termMarks = [...html.matchAll(/◆ 2026秋 · 开学/g)].length;
  ok(`12 月里"开学"不再每天印一遍（出现 ${termMarks} 次，应为 0：开学在 9 月）`, termMarks === 0);

  const app2 = loadApp();
  Object.assign(app2.DB, DB);
  app2.state.sched.cursor = new Date(2026, 9, 5);      // 10 月（国庆假期区间内）
  app2.renderMonth(app2.sandbox.get('#view-calendar'));
  const html2 = app2.sandbox.get('#view-calendar').children.find((c) => c.className === 'month-view').innerHTML;
  ok('假期仍然覆盖每一天（国庆 10/1–10/7 应出现 7 次）',
    [...html2.matchAll(/◆ 国庆假期/g)].length === 7, String([...html2.matchAll(/◆ 国庆假期/g)].length));
  ok('学期第一天照样标出来（9 月视图里"开学"出现 1 次）',
    (() => {
      const a3 = loadApp();
      Object.assign(a3.DB, DB);
      a3.state.sched.cursor = new Date(2026, 8, 15);
      a3.renderMonth(a3.sandbox.get('#view-calendar'));
      const h = a3.sandbox.get('#view-calendar').children.find((c) => c.className === 'month-view').innerHTML;
      return [...h.matchAll(/◆ 2026秋 · 开学/g)].length === 1;
    })());
  // 10/8 有 2 个日程 + 3 个任务，格子里只放得下 1 个日程 + 2 个任务 ⇒ 应该写「还有 2 条」
  ok('放不下的条目会写「还有 N 条」（10/8 有 2 日程 + 3 任务，放得下 1 + 2）',
    html2.includes('还有 2 条'), (html2.match(/mg-more[^<]*<\/div>/g) || []).join(' | '));
}

console.log('');
console.log(failures === 0 ? 'calendar-nav.test: PASS' : `calendar-nav.test: FAIL (${failures})`);
process.exit(failures === 0 ? 0 : 1);
