// P0-2 接线测试：app.js 的「今日」取数是否真的等价于 ViewModel 层。
//
//   node tests/today-wiring.test.mjs
//
// 做法：把 app.js 里 #region today-selection 的两个函数原样取出来在 Node 里跑，
// 与 public/viewmodel.js 的 todaySelection() 在多个时间点上逐项比对。
// HTML 层面的逐字节比对由浏览器自检完成（地址后加 ?vmcheck=1，见 app.js）。

import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import { todaySelection as vmTodaySelection } from '../public/viewmodel.js';
import { dueDayKey, dueMs, isOverdue } from '../lib/duedate.mjs';

// app.js 自己的 dayKey 助手（与它里面那份实现保持一致）
const pad = (n) => String(n).padStart(2, '0');
const dayKey = (value) => {
  const d = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(d.getTime())) return '';
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
};

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

// ---- 从 app.js 抽出 #region today-selection，构造一个可运行的沙箱
const appSrc = readFileSync(join(ROOT, 'public/app.js'), 'utf8');
const region = /\/\/ #region today-selection[\s\S]*?\/\/ #endregion today-selection/.exec(appSrc);
if (!region) {
  console.error('找不到 #region today-selection —— app.js 结构变了');
  process.exit(2);
}

const sandbox = { window: {}, location: { search: '' } };
const factory = new Function(
  'window', 'location', 'DB', 'dayKey', 'isOverdue', 'dueDayKey', 'dueMs',
  `${region[0]}
   return { vmTodayEnabled, legacyTodaySelection, todaySelectionFromVM, todaySelectionFor };`,
);
const make = (db, plannerVM, search = '') => {
  sandbox.window = plannerVM ? { PlannerVM: plannerVM } : {};
  sandbox.location = { search };
  sandbox.DB = db;
  return factory(sandbox.window, sandbox.location, db, dayKey, isOverdue, dueDayKey, dueMs);
};

const state = JSON.parse(readFileSync(join(BASELINE, 'planner-state.json'), 'utf8'));
const expected = JSON.parse(readFileSync(join(BASELINE, 'expected-today.json'), 'utf8'));

console.log('today-wiring.test.mjs');
console.log(`  baseline: ${BASELINE}`);

const ids = (rows, prefix) => rows.map((r) => `${prefix}${r.id}`);
const shape = (sel) => ({
  events: ids(sel.todaysEvents, 'event-'),
  overdue: ids(sel.overdue, 'task-'),
  dueToday: ids(sel.duetoday, 'task-'),
  upcoming: ids(sel.upcoming, 'task-'),
  notifs: ids(sel.openNotifs, 'notif-'),
  done: sel.doneCount,
});

// ---- 1. 两条路径在多个时间点上完全一致
const plannerVM = { todaySelection: vmTodaySelection };
for (const variant of expected.variants) {
  const api = make(state, plannerVM, '');
  const legacy = shape(api.legacyTodaySelection(variant.now_ms));
  const fromVm = shape(api.todaySelectionFromVM(variant.now_ms));
  const same = JSON.stringify(legacy) === JSON.stringify(fromVm);
  ok(`[${variant.label}] 两条路径选出的数据完全一致`
     + `（${legacy.events.length} 事件 / ${legacy.overdue.length} 逾期 / ${legacy.dueToday.length} 今天到期）`,
  same, same ? '' : `legacy=${JSON.stringify(legacy)} vm=${JSON.stringify(fromVm)}`);
  // 与契约 fixture 也算一遍，确保没跑偏
  const want = variant.expected;
  ok(`[${variant.label}] 与契约 fixture 的 badge 一致`,
    legacy.overdue.length + legacy.dueToday.length === want.badge,
    `${legacy.overdue.length + legacy.dueToday.length} vs ${want.badge}`);
}

// ---- 2. 开关行为
ok('默认（有 PlannerVM）→ 走 ViewModel', make(state, plannerVM, '').vmTodayEnabled() === true);
ok('?vm=0 → 回退旧实现', make(state, plannerVM, '?vm=0').vmTodayEnabled() === false);
ok('PlannerVM 尚未加载 → 自动回退', make(state, null, '').vmTodayEnabled() === false);
const off = make(state, plannerVM, '?vm=0');
ok('?vm=0 时 todaySelectionFor 返回旧实现的结果',
  JSON.stringify(shape(off.todaySelectionFor(1789351200000)))
  === JSON.stringify(shape(off.legacyTodaySelection(1789351200000))));
const on = make(state, plannerVM, '');
ok('默认时 todaySelectionFor 返回 ViewModel 的结果',
  JSON.stringify(shape(on.todaySelectionFor(1789351200000)))
  === JSON.stringify(shape(on.todaySelectionFromVM(1789351200000))));

// ---- 3. 接线本身的存在性（防止以后被人改回去）
ok('app.js 的 renderToday 用 todaySelectionFor 取数',
  /function renderToday\(\)[\s\S]{0,200}todaySelectionFor\(now\)/.test(appSrc));
ok('app.js 保留了可回退的旧实现', appSrc.includes('function legacyTodaySelection('));
ok('index.html 引入了 vm-bridge.js',
  readFileSync(join(ROOT, 'public/index.html'), 'utf8').includes('/vm-bridge.js'));
ok('vm-bridge.js 挂载了 window.PlannerVM',
  readFileSync(join(ROOT, 'public/vm-bridge.js'), 'utf8').includes('window.PlannerVM'));
ok('app.js 内有浏览器端 HTML 自检入口（?vmcheck=1）',
  appSrc.includes('vmcheck') && appSrc.includes('VMCHECK OK'));

console.log('');
console.log(failures === 0 ? 'today-wiring.test: PASS' : `today-wiring.test: FAIL (${failures})`);
process.exit(failures === 0 ? 0 : 1);
