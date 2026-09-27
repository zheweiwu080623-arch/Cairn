// A3 接线测试（数据级）：app.js 的「数据源」取数是否等价于 ViewModel 层。
//
//   node tests/connectors-wiring.test.mjs

import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import { connectorsSelection as vmConnectorsSelection } from '../public/viewmodel.js';

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
const region = /\/\/ #region connectors-selection[\s\S]*?\/\/ #endregion connectors-selection/.exec(appSrc);
if (!region) {
  console.error('找不到 #region connectors-selection —— app.js 结构变了');
  process.exit(2);
}

const sandbox = { window: {}, DB: { connectors: {} } };
const factory = new Function(
  'window', 'DB', 'vmTodayEnabled',
  `${region[0]}
   return { legacyConnectorsSelection, connectorsSelectionFromVM, connectorsSelectionFor };`,
);
const make = (db, plannerVM) => {
  sandbox.window = plannerVM ? { PlannerVM: plannerVM } : {};
  sandbox.DB = db;
  const enabled = () => Boolean(plannerVM && typeof plannerVM.connectorsSelection === 'function');
  return factory(sandbox.window, db, enabled);
};

const state = JSON.parse(readFileSync(join(BASELINE, 'planner-state.json'), 'utf8'));
const plannerVM = { connectorsSelection: vmConnectorsSelection };
const meta = (state.connectors && state.connectors.meta) || [];

console.log('connectors-wiring.test.mjs');
console.log(`  baseline: ${BASELINE}（${meta.length} 个数据源）`);

const legacy = make(state, plannerVM).legacyConnectorsSelection();
const fromVm = make(state, plannerVM).connectorsSelectionFromVM();

ok('两条路径选出的数据源逐字段完全一致',
  JSON.stringify(legacy) === JSON.stringify(fromVm),
  JSON.stringify(legacy) === JSON.stringify(fromVm) ? '' : '字段不一致');
ok(`卡片数量一致（${legacy.list.length} 个）`, legacy.list.length === meta.length);
ok('数据源顺序一致（与 /api/state 给的一致）',
  legacy.list.map((m) => m.id).join(',') === meta.map((m) => m.id).join(','),
  legacy.list.map((m) => m.id).join(','));

const counts = (state.connectors || {}).counts || {};
ok('每条数据的条数没丢', legacy.list.every((m, i) => m.count === (counts[meta[i].id] || 0)),
  JSON.stringify(legacy.list.map((m) => `${m.id}=${m.count}`)));
ok('每条数据的字段定义没丢（配置表单靠它渲染）',
  legacy.list.every((m, i) => m.fields.length === ((meta[i].fields || []).length)),
  JSON.stringify(legacy.list.map((m) => `${m.id}:${m.fields.length}`)));
ok('状态与状态样式都在', legacy.list.every((m) => m.status && m.statusCls));
ok('已填过的配置被带出来（输入框的 value）',
  legacy.list.every((m) => m.savedCfg && typeof m.savedCfg === 'object'));

const errors = legacy.list.filter((m) => m.lastError);
ok(`错误提示字段保留（本次 ${errors.length} 个数据源有 last_error）`,
  legacy.list.every((m, i) => {
    const cfg = ((state.connectors || {}).configs || []).find((c) => c.source === meta[i].id);
    return (m.lastError || null) === ((cfg && cfg.last_error) || null);
  }));

const on = make(state, plannerVM);
ok('有 PlannerVM → 走新实现', JSON.stringify(on.connectorsSelectionFor()) === JSON.stringify(fromVm));
const off = make(state, null);
ok('PlannerVM 未加载 → 走旧实现', JSON.stringify(off.connectorsSelectionFor()) === JSON.stringify(legacy));

// 防回归
ok('renderConnectors 用 connectorsSelectionFor 取数',
  /function renderConnectors\(\)[\s\S]{0,200}connectorsSelectionFor\(\)/.test(appSrc));
ok('renderConnectors 不再自己去读 DB.connectors.meta',
  !/function renderConnectors\(\)[\s\S]{0,400}DB\.connectors\?\.meta/.test(appSrc));
ok('app.js 保留可回退的旧实现', appSrc.includes('function legacyConnectorsSelection('));
ok('viewmodel.js 导出 connectorsSelection',
  readFileSync(join(ROOT, 'public/viewmodel.js'), 'utf8').includes('export function connectorsSelection('));
ok('vm-bridge.js 挂载了 connectorsSelection',
  readFileSync(join(ROOT, 'public/vm-bridge.js'), 'utf8').includes('connectorsSelection'));

console.log('');
console.log(failures === 0 ? 'connectors-wiring.test: PASS' : `connectors-wiring.test: FAIL (${failures})`);
process.exit(failures === 0 ? 0 : 1);
