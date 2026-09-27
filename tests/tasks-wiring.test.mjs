// P2-1 接线测试（数据级）：app.js 的「任务」取数是否等价于 ViewModel 层。
//
//   node tests/tasks-wiring.test.mjs

import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import { tasksSelection as vmTasksSelection } from '../public/viewmodel.js';
import { dueMs } from '../lib/duedate.mjs';

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
const region = /\/\/ #region tasks-selection[\s\S]*?\/\/ #endregion tasks-selection/.exec(appSrc);
if (!region) {
  console.error('找不到 #region tasks-selection —— app.js 结构变了');
  process.exit(2);
}

const sandbox = { window: {}, DB: { tasks: [] } };
const factory = new Function(
  'window', 'DB', 'dueMs', 'vmTodayEnabled',
  `${region[0]}
   return { legacyTasksSelection, tasksSelectionFromVM, tasksSelectionFor };`,
);
const make = (db, plannerVM) => {
  sandbox.window = plannerVM ? { PlannerVM: plannerVM } : {};
  sandbox.DB = db;
  // 用真实的开关语义：有 PlannerVM 且没被 ?vm=0 关掉
  const enabled = () => Boolean(plannerVM && typeof plannerVM.tasksSelection === 'function');
  return factory(sandbox.window, db, dueMs, enabled);
};

const state = JSON.parse(readFileSync(join(BASELINE, 'planner-state.json'), 'utf8'));
const plannerVM = { tasksSelection: vmTasksSelection };

console.log('tasks-wiring.test.mjs');
console.log(`  baseline: ${BASELINE}（${state.tasks.length} 条任务）`);

const ids = (rows) => rows.map((t) => t.id).join(',');
// 两种排序各跑一遍（2026-09-25 新增「时间优先」，见测试反馈 v）
for (const sort of ['smart', 'balanced', 'due']) {
  for (const filter of ['all', 'todo', 'doing', 'done']) {
    const api = make(state, plannerVM);
    const legacy = api.legacyTasksSelection(filter, sort);
    const fromVm = api.tasksSelectionFromVM(filter, sort);
    const same = ids(legacy.list) === ids(fromVm.list);
    ok(`[${sort}/${filter}] 两条路径选出的任务与顺序完全一致（${legacy.list.length} 条）`, same,
      same ? '' : `legacy=${ids(legacy.list).slice(0, 60)} vm=${ids(fromVm.list).slice(0, 60)}`);
  }
}

// 计数与状态过滤
const all = make(state, plannerVM).tasksSelectionFromVM('all');
ok('计数与数据一致',
  all.counts.all === state.tasks.length
  && all.counts.todo + all.counts.doing + all.counts.done === state.tasks.length,
  JSON.stringify(all.counts));
ok('两条路径的计数也一致',
  JSON.stringify(make(state, plannerVM).legacyTasksSelection('all').counts)
  === JSON.stringify(make(state, plannerVM).tasksSelectionFromVM('all').counts),
  JSON.stringify(make(state, plannerVM).tasksSelectionFromVM('all').counts));
ok('todo 过滤只含 todo', make(state, plannerVM).tasksSelectionFromVM('todo').list.every((t) => t.status === 'todo'));
ok('done 排最后（排序规则不变）',
  make(state, plannerVM).tasksSelectionFromVM('all').list.slice(-all.counts.done).every((t) => t.status === 'done'),
  `done=${all.counts.done}`);

// 开关行为
const off = make(state, null);
ok('PlannerVM 未加载 → 走旧实现', ids(off.tasksSelectionFor('all').list) === ids(off.legacyTasksSelection('all').list));
const on = make(state, plannerVM);
ok('有 PlannerVM → 走新实现', ids(on.tasksSelectionFor('all').list) === ids(on.tasksSelectionFromVM('all').list));

// 防回归
const renderTasksBody = /function renderTasks\(\)[\s\S]*?\n}/.exec(appSrc);
ok('renderTasks 用 tasksSelectionFor 取数（并把排序方式一起传下去）',
  !!renderTasksBody && renderTasksBody[0].includes('tasksSelectionFor(filter, sort'));
ok('排序方式来自 state.taskSort，三档（smart / balanced / due），脏值回落到 smart',
  /\['due', 'balanced'\]\.includes\(state\.taskSort\) \? state\.taskSort : 'smart'/.test(appSrc)
  && appSrc.includes("['due', 'balanced'].includes(e.target.value) ? e.target.value : 'smart'"));
ok('app.js 保留可回退的旧实现', appSrc.includes('function legacyTasksSelection('));
ok('viewmodel.js 导出 tasksSelection',
  readFileSync(join(ROOT, 'public/viewmodel.js'), 'utf8').includes('export function tasksSelection('));
ok('vm-bridge.js 挂载了 tasksSelection',
  readFileSync(join(ROOT, 'public/vm-bridge.js'), 'utf8').includes('tasksSelection'));

console.log('');
console.log(failures === 0 ? 'tasks-wiring.test: PASS' : `tasks-wiring.test: FAIL (${failures})`);
process.exit(failures === 0 ? 0 : 1);
