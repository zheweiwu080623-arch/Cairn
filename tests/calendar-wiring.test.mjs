// A4 接线测试（数据级）：app.js 的「日程·月」取数是否等价于 ViewModel 层。
//
//   node tests/calendar-wiring.test.mjs
//
// 这里不自己另写一份日期工具，而是把 app.js 里的真实实现（due-rule 区域、
// monthWeeks、eventsOn/tasksOn/academicOn…）按原文抽出来注入，测的是真代码。

import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import { calendarMonthSelection as vmCalendarMonthSelection } from '../public/viewmodel.js';

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

// ---- 从 app.js 里按原文抓出要用的片段 ----
const grabbed = {};
const grab = (key, pattern, label) => {
  const m = pattern.exec(appSrc);
  if (!m) {
    console.error(`找不到 ${label} —— app.js 结构变了`);
    process.exit(2);
  }
  grabbed[key] = m[0];
};

grab('region', /\/\/ #region calendar-month-selection[\s\S]*?\/\/ #endregion calendar-month-selection/, '#region calendar-month-selection');
grab('dueRegion', /\/\/ #region due-rule[\s\S]*?\/\/ #endregion due-rule/, '#region due-rule');
grab('pad', /const pad = \(n\) =>[^\n]*/, 'pad()');
grab('dayKey', /const dayKey = \(iso\) => \{[\s\S]*?\n\};/, 'dayKey()');
grab('dateKeyOf', /const dateKeyOf = \(d\) =>[^\n]*/, 'dateKeyOf()');
grab('weekdayIndex', /const weekdayIndex = \(d\) =>[^\n]*/, 'weekdayIndex()');
grab('mondayOf', /const mondayOf = \(d\) => \{[\s\S]*?\n\};/, 'mondayOf()');
grab('addDays', /const addDays = \(d, n\) => \{[^\n]*/, 'addDays()');
grab('monthWeeks', /function monthWeeks\(cursor\) \{[\s\S]*?\n\}/, 'monthWeeks()');
grab('eventsOn', /function eventsOn\(key\) \{[^\n]*/, 'eventsOn()');
grab('tasksOn', /function tasksOn\(key\) \{[^\n]*/, 'tasksOn()');
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
   ${grabbed.monthWeeks}
   ${grabbed.eventsOn}
   ${grabbed.tasksOn}
   ${grabbed.academicOn}
   ${grabbed.region}
   return { legacyCalendarMonthSelection, calendarMonthSelectionFromVM, monthGridFor };`,
);

const state = JSON.parse(readFileSync(join(BASELINE, 'planner-state.json'), 'utf8'));
// 基线快照是裁剪过的（没有 academic/courses 这些空集合），补齐成 /api/state 的真实形状
for (const key of ['events', 'tasks', 'notifications', 'academic', 'courses']) {
  if (!Array.isArray(state[key])) state[key] = [];
}
console.log('calendar-wiring.test.mjs');
console.log(`  baseline: ${BASELINE}（${(state.events || []).length} 个日程 / ${(state.tasks || []).length} 条任务）`);

const make = (plannerVM) => {
  const windowStub = plannerVM ? { PlannerVM: plannerVM } : {};
  const enabled = () => Boolean(plannerVM && typeof plannerVM.calendarMonthSelection === 'function');
  return factory(windowStub, state, enabled);
};

const p = (n) => String(n).padStart(2, '0');
const plannerVM = { calendarMonthSelection: vmCalendarMonthSelection };
const months = [
  [2026, 8], // 2026-09（本月）
  [2026, 7], // 2026-08
  [2026, 1], // 2026-02（短月，最容易在补格上出错）
  [2026, 0], // 2026-01
  [2027, 2], // 2027-03
];

for (const [y, m] of months) {
  const cursor = new Date(y, m, 15, 0, 0, 0, 0);
  const api = make(plannerVM);
  const legacy = api.legacyCalendarMonthSelection(cursor);
  const fromVm = api.calendarMonthSelectionFromVM(cursor);
  const same = JSON.stringify(legacy) === JSON.stringify(fromVm);
  const dayCount = legacy.weeks.reduce((n, w) => n + w.days.length, 0);
  ok(`[${y}-${p(m + 1)}] 两条路径逐格一致（${legacy.weeks.length} 周 / ${dayCount} 天）`, same,
    same ? '' : `第 ${legacy.weeks.findIndex((w, i) => JSON.stringify(w) !== JSON.stringify(fromVm.weeks[i])) + 1} 周开始不同`);
}

for (const [y, m] of months) {
  const cursor = new Date(y, m, 15);
  const grid = make(plannerVM).calendarMonthSelectionFromVM(cursor);
  const cells = grid.weeks.flatMap((w) => w.days);
  const inMonth = cells.filter((d) => d.inMonth).length;
  const daysInMonth = new Date(y, m + 1, 0).getDate();
  ok(`[${y}-${p(m + 1)}] 本月天数对得上（${inMonth}/${daysInMonth}）`, inMonth === daysInMonth);
  ok(`[${y}-${p(m + 1)}] 每周第一格是周一`,
    grid.weeks.every((w) => new Date(w.mondayMs).getDay() === 1));
  ok(`[${y}-${p(m + 1)}] 周数与范围文字完整`,
    grid.weeks.length >= 4 && grid.weeks.every((w) => /^\d+\/\d+–\d+\/\d+$/.test(w.range)),
    grid.weeks.map((w) => w.range).join(' | '));
}

// 跨月补格：相邻月的条目会被算进来，所以只校验"不丢条目"
const cursor = new Date(2026, 8, 15);
const grid = make(plannerVM).calendarMonthSelectionFromVM(cursor);
const cells = grid.weeks.flatMap((w) => w.days);
const cellKeys = new Set(cells.map((d) => d.key));
const eventsInGrid = (state.events || []).filter((e) => {
  const d = new Date(e.start_at);
  return cellKeys.has(`${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`);
}).length;
ok(`网格里一个日程都不丢（${cells.reduce((n, d) => n + d.events.length, 0)} 个格子条目 / 应含 ${eventsInGrid}）`,
  cells.reduce((n, d) => n + d.events.length, 0) === eventsInGrid);
ok('每个格子的 key 格式统一（YYYY-MM-DD）', cells.every((d) => /^\d{4}-\d{2}-\d{2}$/.test(d.key)));
ok('任务格子已滤掉已完成', cells.every((d) => d.tasks.every((t) => t.status !== 'done')));
ok('格子里的天数与日期一致（本月一定含 1 号）', cells.some((d) => d.inMonth && d.day === 1));

// 开关行为
ok('有 PlannerVM → 走新实现',
  JSON.stringify(make(plannerVM).monthGridFor(cursor)) === JSON.stringify(make(plannerVM).calendarMonthSelectionFromVM(cursor)));
ok('PlannerVM 未加载 → 走旧实现',
  JSON.stringify(make(null).monthGridFor(cursor)) === JSON.stringify(make(null).legacyCalendarMonthSelection(cursor)));

// 防回归
ok('renderMonth 用 monthGridFor 取数',
  /function renderMonth\(el\)[\s\S]{0,200}monthGridFor\(cursor\)/.test(appSrc));
ok('renderMonth 不再自己算 weeks',
  !/function renderMonth\(el\)[\s\S]{0,200}monthWeeks\(cursor\)/.test(appSrc));
ok('app.js 保留可回退的旧实现', appSrc.includes('function legacyCalendarMonthSelection('));
ok('viewmodel.js 导出 calendarMonthSelection',
  readFileSync(join(ROOT, 'public/viewmodel.js'), 'utf8').includes('export function calendarMonthSelection('));
ok('vm-bridge.js 挂载了 calendarMonthSelection',
  readFileSync(join(ROOT, 'public/vm-bridge.js'), 'utf8').includes('calendarMonthSelection'));

console.log('');
console.log(failures === 0 ? 'calendar-wiring.test: PASS' : `calendar-wiring.test: FAIL (${failures})`);
process.exit(failures === 0 ? 0 : 1);
