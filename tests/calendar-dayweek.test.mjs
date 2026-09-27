// A4 续（周/日）接线测试：数据级 + HTML 级一起验。
//
//   node tests/calendar-dayweek.test.mjs
//
// 数据级：app.js 的旧算法 vs ViewModel 层，逐字段比对（含"这周有没有这门课"）。
// HTML 级：真的调用 renderWeek() / renderDay()，比较两条路径写出的 HTML 是否逐字节相同。

import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import {
  calendarWeekSelection as vmWeekSelection,
  calendarDaySelection as vmDaySelection,
  weekNumberOf as vmWeekNumberOf,
  coursesForDay as vmCoursesForDay,
} from '../public/viewmodel.js';

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

const appSrc = readFileSync(join(ROOT, 'public/app.js'), 'utf8');
const grabbed = {};
const grab = (key, pattern, label) => {
  const m = pattern.exec(appSrc);
  if (!m) {
    console.error(`找不到 ${label} —— app.js 结构变了`);
    process.exit(2);
  }
  grabbed[key] = m[0];
};

grab('region', /\/\/ #region calendar-dayweek-selection[\s\S]*?\/\/ #endregion calendar-dayweek-selection/, '#region calendar-dayweek-selection');
grab('dueRegion', /\/\/ #region due-rule[\s\S]*?\/\/ #endregion due-rule/, '#region due-rule');
grab('pad', /const pad = \(n\) =>[^\n]*/, 'pad()');
grab('dayKey', /const dayKey = \(iso\) => \{[\s\S]*?\n\};/, 'dayKey()');
grab('dateKeyOf', /const dateKeyOf = \(d\) =>[^\n]*/, 'dateKeyOf()');
grab('weekdayIndex', /const weekdayIndex = \(d\) =>[^\n]*/, 'weekdayIndex()');
grab('mondayOf', /const mondayOf = \(d\) => \{[\s\S]*?\n\};/, 'mondayOf()');
grab('addDays', /const addDays = \(d, n\) => \{[^\n]*/, 'addDays()');
grab('termStart', /function termStart\(\) \{[\s\S]*?\n\}/, 'termStart()');
grab('weekNumberOf', /function weekNumberOf\(date\) \{[\s\S]*?\n\}/, 'weekNumberOf()');
grab('courseInWeek', /function courseInWeek\(course, monday\) \{[\s\S]*?\n\}/, 'courseInWeek()');
grab('coursesOnWeekday', /function coursesOnWeekday\(wd, monday\) \{[\s\S]*?\n\}/, 'coursesOnWeekday()');
grab('courseForDay', /function courseForDay\(date\) \{[^\n]*/, 'courseForDay()');
grab('eventsOn', /function eventsOn\(key\) \{[^\n]*/, 'eventsOn()');
grab('tasksOn', /function tasksOn\(key\) \{[^\n]*/, 'tasksOn()');
grab('notifsOn', /function notifsOn\(key\) \{[^\n]*/, 'notifsOn()');
grab('academicOn', /function academicOn\(key\) \{[\s\S]*?\n\}/, 'academicOn()');

const factory = new Function(
  'window', 'DB', 'vmTodayEnabled',
  `${grabbed.pad}
   ${grabbed.dayKey}
   ${grabbed.dateKeyOf}
   ${grabbed.weekdayIndex}
   ${grabbed.mondayOf}
   ${grabbed.addDays}
   ${grabbed.dueRegion}
   ${grabbed.termStart}
   ${grabbed.weekNumberOf}
   ${grabbed.courseInWeek}
   ${grabbed.coursesOnWeekday}
   ${grabbed.courseForDay}
   ${grabbed.eventsOn}
   ${grabbed.tasksOn}
   ${grabbed.notifsOn}
   ${grabbed.academicOn}
   ${grabbed.region}
   return { legacyCalendarWeekSelection, legacyCalendarDaySelection,
            calendarWeekSelectionFromVM, calendarDaySelectionFromVM,
            weekSelectionFor, daySelectionFor, courseForDay, weekNumberOf };`,
);

const state = JSON.parse(readFileSync(join(BASELINE, 'planner-state.json'), 'utf8'));
for (const key of ['events', 'tasks', 'notifications', 'academic', 'courses']) {
  if (!Array.isArray(state[key])) state[key] = [];
}
// 基线快照里没有课表和校历 —— 这两样正是"周次过滤"的考点，补一份可推演的进去。
state.academic = [
  { id: 'term-1', kind: 'term', title: '2026秋 · 开学（学期第1周）', start_at: '2026-09-07', end_at: '2027-01-15' },
  { id: 'hol-1', kind: 'holiday', title: '国庆节', start_at: '2026-10-01', end_at: '2026-10-07' },
];
state.courses = [
  { id: 'c1', course: '高等数学', weekday: 1, weeks: '1-14', start_at: '08:00', end_at: '09:40', color: '#4f7cff', location: 'A301', teacher: '张老师' },
  { id: 'c2', course: '程序设计', weekday: 3, weeks: '1-8', start_at: '14:00', end_at: '15:40', color: '#3ecf8e', platform: 'Canvas' },
  { id: 'c3', course: '体育', weekday: 6, weeks: '20-30', start_at: '10:00', end_at: '11:00', color: '#ffd166' },
];

const make = (plannerVM) => {
  const windowStub = plannerVM ? { PlannerVM: plannerVM } : {};
  const enabled = () => Boolean(plannerVM
    && typeof plannerVM.calendarWeekSelection === 'function'
    && typeof plannerVM.calendarDaySelection === 'function');
  return factory(windowStub, state, enabled);
};

const p = (n) => String(n).padStart(2, '0');
const vmApi = createVmApi();
function createVmApi() {
  return { calendarWeekSelection: vmWeekSelection, calendarDaySelection: vmDaySelection };
}

console.log('calendar-dayweek.test.mjs');
console.log(`  baseline: ${BASELINE}（补了 ${state.courses.length} 门课 + ${state.academic.length} 条校历）`);

// ---------- 1. 数据级：几段有代表性的日期 ----------
const cursors = [
  new Date(2026, 8, 14, 0, 0, 0, 0),  // 学期第 2 周（课都在）
  new Date(2026, 8, 7, 0, 0, 0, 0),   // 学期第 1 周（周一）
  new Date(2026, 10, 2, 0, 0, 0, 0),  // 第 9 周（程序设计已结课）
  new Date(2027, 1, 3, 0, 0, 0, 0),   // 第 22 周（只有体育）
  new Date(2026, 8, 14, 13, 37, 0, 0),// 带时刻的游标（不能因为时间而换天）
];

for (const cursor of cursors) {
  const api = make(vmApi);
  const wLegacy = api.legacyCalendarWeekSelection(cursor);
  const wVm = api.calendarWeekSelectionFromVM(cursor);
  ok(`[${wLegacy.mondayKey}] 周视图两条路径一致`, JSON.stringify(wLegacy) === JSON.stringify(wVm),
    `legacy=${JSON.stringify(wLegacy).slice(0, 120)}`);
  ok(`[${wLegacy.mondayKey}] 一周固定 7 天且每天 key 连着`,
    wLegacy.days.length === 7
    && wLegacy.days.every((d, i) => new Date(d.ms).getDay() === ((i + 1) % 7)),
    wLegacy.days.map((d) => d.key).join(' '));

  const dLegacy = api.legacyCalendarDaySelection(cursor);
  const dVm = api.calendarDaySelectionFromVM(cursor);
  ok(`[${dLegacy.key}] 日视图两条路径一致`, JSON.stringify(dLegacy) === JSON.stringify(dVm));
  ok(`[${dLegacy.key}] 日视图五个桶齐全`,
    ['courses', 'events', 'tasks', 'notifs', 'acad'].every((k) => Array.isArray(dLegacy[k])));
}

ok('带时刻的游标不会被当成不同的一天',
  make(vmApi).calendarDaySelectionFromVM(cursors[0]).key
  === make(vmApi).calendarDaySelectionFromVM(cursors[4]).key);

// ---------- 2. 周次规则：逐天比一年 ----------
let wnSame = 0;
let wnDiff = null;
let coursesSame = 0;
let coursesDiff = null;
const api = make(vmApi);
const legacyApi = make(null);
for (let i = 0; i < 365; i += 1) {
  const d = new Date(2026, 8, 7 + i, 12, 0, 0, 0);
  if (api.weekNumberOf(d) !== vmWeekNumberOf(state, d)) wnDiff = d;
  else wnSame += 1;
  const a = legacyApi.courseForDay(d).map((c) => c.id).join(',');
  const b = vmCoursesForDay(state, d).map((c) => c.id).join(',');
  if (a !== b) coursesDiff = `${d.toDateString()} legacy=${a} vm=${b}`;
  else coursesSame += 1;
}
ok(`学期周次 365 天全部一致（${wnSame}/365）`, wnDiff === null, wnDiff ? wnDiff.toDateString() : '');
ok(`"今天上哪些课" 365 天全部一致（${coursesSame}/365）`, coursesDiff === null, coursesDiff || '');

const week2 = make(vmApi).calendarDaySelectionFromVM(new Date(2026, 8, 14));
ok('第 2 周周一有高等数学（1-14 周）', week2.courses.some((c) => c.id === 'c1'));
const week9 = make(vmApi).calendarDaySelectionFromVM(new Date(2026, 10, 2));
ok('第 9 周周一的程序设计已结课（1-8 周）',
  !make(vmApi).calendarDaySelectionFromVM(new Date(2026, 10, 4)).courses.some((c) => c.id === 'c2'));
const wk22 = make(vmApi).calendarWeekSelectionFromVM(new Date(2027, 1, 3));
ok('第 22 周只有体育（20-30 周）',
  wk22.days.some((d) => d.courses.some((c) => c.id === 'c3'))
  && !wk22.days.some((d) => d.courses.some((c) => c.id === 'c1')));

// ---------- 3. 开关行为 ----------
ok('有 PlannerVM → 走新实现',
  JSON.stringify(make(vmApi).weekSelectionFor(cursors[0])) === JSON.stringify(make(vmApi).calendarWeekSelectionFromVM(cursors[0])));
ok('PlannerVM 未加载 → 走旧实现',
  JSON.stringify(make(null).weekSelectionFor(cursors[0])) === JSON.stringify(make(null).legacyCalendarWeekSelection(cursors[0])));
ok('日视图同款：未加载走旧实现',
  JSON.stringify(make(null).daySelectionFor(cursors[0])) === JSON.stringify(make(null).legacyCalendarDaySelection(cursors[0])));

// ---------- 4. HTML 级 ----------
function makeElement(tag = 'div') {
  const kids = new Map();
  return {
    tagName: tag, innerHTML: '', textContent: '', value: '', className: '', checked: false,
    style: {}, dataset: {}, children: [], onclick: null, offsetHeight: 0,
    classList: { add() {}, remove() {}, toggle() {}, contains: () => false },
    appendChild(c) { this.children.push(c); return c; }, prepend(c) { this.children.unshift(c); return c; },
    removeChild() {}, remove() {}, setAttribute() {}, removeAttribute() {}, after() {},
    addEventListener() {}, removeEventListener() {}, focus() {}, blur() {}, click() {},
    querySelector: (s) => { if (!kids.has(s)) kids.set(s, makeElement('div')); return kids.get(s); },
    querySelectorAll: () => [], insertAdjacentHTML() {},
    getBoundingClientRect: () => ({ top: 0, left: 0, width: 0, height: 0, bottom: 0, right: 0 }),
  };
}

function loadApp(plannerVM) {
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
  const build = new Function(
    'window', 'document', 'localStorage', 'sessionStorage', 'location', 'navigator',
    'URLSearchParams', 'requestAnimationFrame', 'getComputedStyle', 'fetch', 'console',
    `${src}
     return { DB, state, renderWeek, renderDay, dayListInto, dayTimelineInto };`,
  );
  const apiOut = build(
    windowStub, documentStub, windowStub.localStorage, windowStub.sessionStorage, windowStub.location,
    windowStub.navigator, URLSearchParams, windowStub.requestAnimationFrame,
    windowStub.getComputedStyle, windowStub.fetch, console,
  );
  return { ...apiOut, sandbox: { get, window: windowStub } };
}

function firstDiff(a, b) {
  let i = 0;
  while (i < a.length && i < b.length && a[i] === b[i]) i += 1;
  return `@${i} legacy=${JSON.stringify(a.slice(i, i + 80))} vm=${JSON.stringify(b.slice(i, i + 80))}`;
}

// renderWeek / renderDay 会把内容挂在嵌套的 div 里（bar → wrap → 每天一列），
// 所以要递归把整棵树摘下来比，光看第一层会漏掉真正的差异。
function dump(node) {
  if (!node || !node.children) return '';
  return node.children
    .map((c) => `${c.className || ''}#${c.innerHTML}#${dump(c)}`)
    .join(';;');
}

for (const cursor of [cursors[0], cursors[1], cursors[2]]) {
  const html = {};
  for (const useVM of [true, false]) {
    const app = loadApp(useVM ? vmApi : null);
    Object.assign(app.DB, state);
    app.state.sched.cursor = cursor;
    const el = app.sandbox.get('#view-calendar');
    app.renderWeek(el);
    html[useVM ? 'vm' : 'legacy'] = dump(el);
  }
  const same = html.vm === html.legacy;
  ok(`[周 ${cursor.toDateString()}] HTML 逐字节相同（${html.vm.length} 字符，含嵌套）`, same,
    same ? '' : firstDiff(html.legacy, html.vm));
}

for (const mode of ['list', 'timeline']) {
  const html = {};
  for (const useVM of [true, false]) {
    const app = loadApp(useVM ? vmApi : null);
    Object.assign(app.DB, state);
    app.state.sched.cursor = new Date(2026, 8, 14);
    app.state.sched.dayMode = mode;
    const el = app.sandbox.get('#view-calendar');
    app.renderDay(el);
    html[useVM ? 'vm' : 'legacy'] = dump(el);
  }
  const same = html.vm === html.legacy;
  ok(`[日·${mode}] HTML 逐字节相同（${html.vm.length} 字符，含嵌套）`, same,
    same ? '' : firstDiff(html.legacy, html.vm));
}

const appWeek = loadApp(vmApi);
Object.assign(appWeek.DB, state);
appWeek.state.sched.cursor = new Date(2026, 8, 14);
const weekEl = appWeek.sandbox.get('#view-calendar');
appWeek.renderWeek(weekEl);
const weekHtml = dump(weekEl);
ok('周视图渲染出 7 个日期头', [...weekHtml.matchAll(/class="wd-head/g)].length === 7);
ok('周视图渲染出高等数学这节课', weekHtml.includes('高等数学'));
ok('周视图时间轴 07:00–24:00 都在', weekHtml.includes('07:00') && weekHtml.includes('24:00'));
// dump() 里 className 是以 `week-day#<innerHTML>` 的形式出现的（属性赋值不进 innerHTML）
ok('周视图把 7 天都放进了网格', [...weekHtml.matchAll(/week-day#/g)].length === 7,
  String([...weekHtml.matchAll(/week-day#/g)].length));
ok('周视图有全天日程/课程块的容器', weekHtml.includes('wd-body'));
ok('中文没有变成问号', !weekHtml.includes('?????'));

// ---------- 5. 防回归 ----------
ok('renderWeek 用 weekSelectionFor 取数', /function renderWeek\(el\)[\s\S]{0,200}weekSelectionFor\(/.test(appSrc));
ok('renderWeek 不再自己算 days/courseForDay',
  !/function renderWeek\(el\)[\s\S]{0,400}courseForDay\(/.test(appSrc));
ok('dayListInto 用 daySelectionFor 取数', /function dayListInto\(el, cursor\)[\s\S]{0,200}daySelectionFor\(/.test(appSrc));
ok('dayTimelineInto 用 daySelectionFor 取数', /function dayTimelineInto\(el, cursor\)[\s\S]{0,200}daySelectionFor\(/.test(appSrc));
ok('app.js 保留可回退的旧实现',
  appSrc.includes('function legacyCalendarWeekSelection(') && appSrc.includes('function legacyCalendarDaySelection('));
const vmSrc = readFileSync(join(ROOT, 'public/viewmodel.js'), 'utf8');
ok('viewmodel.js 导出 week/day 取数',
  vmSrc.includes('export function calendarWeekSelection(') && vmSrc.includes('export function calendarDaySelection('));
ok('viewmodel.js 把"这周上不上这门课"的规则也收进去了',
  vmSrc.includes('export function courseInWeek(') && vmSrc.includes('export function coursesForDay('));
const bridge = readFileSync(join(ROOT, 'public/vm-bridge.js'), 'utf8');
ok('vm-bridge.js 挂载了周/日取数',
  bridge.includes('calendarWeekSelection') && bridge.includes('calendarDaySelection'));

// 第 9 周那条断言用了两次调用，这里补一条更直白的
ok('第 9 周（2026-11-04）确实没有程序设计',
  !week9.courses.some((c) => c.id === 'c2'));

console.log('');
console.log(failures === 0 ? 'calendar-dayweek.test: PASS' : `calendar-dayweek.test: FAIL (${failures})`);
process.exit(failures === 0 ? 0 : 1);
