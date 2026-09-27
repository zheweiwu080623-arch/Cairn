// P2-1 接线测试（数据级）：「通知」视图取数是否等价于 ViewModel 层。
//   node tests/notifications-wiring.test.mjs

import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import { notificationsSelection as vmSelection } from '../public/viewmodel.js';

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
const region = /\/\/ #region notifications-selection[\s\S]*?\/\/ #endregion notifications-selection/.exec(appSrc);
if (!region) {
  console.error('找不到 #region notifications-selection');
  process.exit(2);
}

const sandbox = { window: {}, DB: { notifications: [] } };
const factory = new Function(
  'window', 'DB', 'tsMs', 'vmTodayEnabled',
  `${region[0]}
   return { legacyNotificationsSelection, notificationsSelectionFromVM, notificationsSelectionFor };`,
);

// app.js 里的 tsMs：数字直接用，字符串走 Date.parse
const tsMs = (v) => {
  const t = typeof v === 'number' ? v : Date.parse(String(v || ''));
  return Number.isNaN(t) ? 0 : t;
};

const make = (db, plannerVM) => {
  sandbox.window = plannerVM ? { PlannerVM: plannerVM } : {};
  sandbox.DB = db;
  return factory(sandbox.window, db, tsMs,
    () => Boolean(plannerVM && typeof plannerVM.notificationsSelection === 'function'));
};

const state = JSON.parse(readFileSync(join(BASELINE, 'planner-state.json'), 'utf8'));
const plannerVM = { notificationsSelection: vmSelection };
console.log('notifications-wiring.test.mjs');
console.log(`  baseline: ${BASELINE}（${state.notifications.length} 条通知）`);

const ids = (rows) => rows.map((n) => n.id).join(',');
{
  const api = make(state, plannerVM);
  const legacy = api.legacyNotificationsSelection();
  const fromVm = api.notificationsSelectionFromVM();
  const same = ids(legacy.list) === ids(fromVm.list);
  ok(`两条路径的通知与顺序完全一致（${legacy.list.length} 条）`, same,
    same ? '' : `legacy=${ids(legacy.list).slice(0, 80)} vm=${ids(fromVm.list).slice(0, 80)}`);
  ok('排序规则：重点优先', (() => {
    const firstNonPrio = fromVm.list.findIndex((n) => !n.priority);
    const lastPrio = fromVm.list.map((n) => Boolean(n.priority)).lastIndexOf(true);
    return lastPrio < firstNonPrio || firstNonPrio === -1;
  })());
  ok('排序规则：同级内按 trigger_at 倒序', (() => {
    const prio = fromVm.list.filter((n) => n.priority);
    for (let i = 1; i < prio.length; i += 1) {
      if (tsMs(prio[i - 1].trigger_at) < tsMs(prio[i].trigger_at)) return false;
    }
    return true;
  })());
}

ok('PlannerVM 未加载 → 走旧实现',
  ids(make(state, null).notificationsSelectionFor().list) === ids(make(state, null).legacyNotificationsSelection().list));
ok('有 PlannerVM → 走新实现',
  ids(make(state, plannerVM).notificationsSelectionFor().list) === ids(make(state, plannerVM).notificationsSelectionFromVM().list));

ok('renderNotifications 用 notificationsSelectionFor 取数',
  /function renderNotifications\(\)[\s\S]{0,200}notificationsSelectionFor\(\)\.list/.test(appSrc));
ok('app.js 保留可回退的旧实现', appSrc.includes('function legacyNotificationsSelection('));
ok('viewmodel.js 导出 notificationsSelection',
  readFileSync(join(ROOT, 'public/viewmodel.js'), 'utf8').includes('export function notificationsSelection('));
ok('vm-bridge.js 挂载了 notificationsSelection',
  readFileSync(join(ROOT, 'public/vm-bridge.js'), 'utf8').includes('notificationsSelection'));

console.log('');
console.log(failures === 0 ? 'notifications-wiring.test: PASS' : `notifications-wiring.test: FAIL (${failures})`);
process.exit(failures === 0 ? 0 : 1);
