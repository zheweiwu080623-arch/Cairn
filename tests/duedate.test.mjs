// 截止时间规则测试 —— 「纯日期 = 当天 23:59 截止」。
//
//   node tests/duedate.test.mjs
//
// 四件事：
//   1. 一致性：lib/duedate.mjs、public/app.js、public/viewmodel.js 里的规则副本
//      必须逐字相同（去掉 export 关键字后），行为也必须逐项相同。
//   2. 边界：23:59:59.999 前后、带时刻与不带时刻、非法输入。
//   3. 不再重复计数：同一份真实数据里，没有任何任务同时出现在「逾期」和「今天到期」。
//   4. 防回归：旧的写法（new Date(t.due_at) < now、dayKey(t.due_at)）不得再出现。

import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import * as canonical from '../lib/duedate.mjs';
import { buildTodayVM } from '../public/viewmodel.js';

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

// ---------------------------------------------------------------- 1. 一致性

const REGION = /\/\/ #region due-rule[\s\S]*?\/\/ #endregion due-rule/;

function regionOf(relPath) {
  const src = readFileSync(join(ROOT, relPath), 'utf8');
  const m = REGION.exec(src);
  if (!m) throw new Error(`找不到 due-rule 区块：${relPath}`);
  return m[0];
}

function instantiate(regionText) {
  const code = regionText.replace(/^export /gm, '');
  const factory = new Function(
    `${code}\nreturn { hasTimeOfDay, dueMs, isOverdue, dueDayKey, dueLabel };`,
  );
  return factory();
}

const COPIES = {
  'lib/duedate.mjs': regionOf('lib/duedate.mjs'),
  'public/app.js': regionOf('public/app.js'),
  'public/viewmodel.js': regionOf('public/viewmodel.js'),
};
const normalised = Object.fromEntries(
  Object.entries(COPIES).map(([k, v]) => [k, v.replace(/^export /gm, '')]),
);
const texts = Object.values(normalised);

console.log('duedate.test.mjs');
ok('三处规则副本逐字相同（去掉 export 后）', texts.every((t) => t === texts[0]),
  Object.entries(normalised).map(([k, v]) => `${k}:${v.length}`).join(' '));

const mods = Object.fromEntries(Object.entries(COPIES).map(([k, v]) => [k, instantiate(v)]));
ok('三处副本都能实例化', Object.values(mods).every((m) => typeof m.dueMs === 'function'));

// ---------------------------------------------------------------- 2. 边界

const at = (y, mo, d, h = 0, mi = 0, s = 0, ms = 0) => new Date(y, mo - 1, d, h, mi, s, ms).getTime();

const MATRIX = [
  null, undefined, '', '   ',
  '2026-10-04',
  '2026-10-04T09:00',
  '2026-10-04T23:59',
  '2026-10-04T23:59:59.999',
  '2026-10-05',
  '2025-12-31',
  '2026-02-28',
  '乱七八糟',
  '2026-10-04 09:00',            // 带空格的时间（不是 ISO-T 形式）
  '2026-10-04T09:00:00+08:00',   // 带时区
];
const NOWS = [at(2026, 10, 4, 0, 0, 0, 0), at(2026, 10, 4, 8, 0), at(2026, 10, 4, 12, 0),
  at(2026, 10, 4, 23, 59, 59, 998), at(2026, 10, 5, 0, 0, 0, 0), at(2026, 10, 5, 9, 0)];

let mismatches = 0;
for (const value of MATRIX) {
  for (const now of NOWS) {
    const base = {
      ms: canonical.dueMs(value),
      day: canonical.dueDayKey(value),
      label: canonical.dueLabel(value),
      late: canonical.isOverdue(value, now),
      hasTime: canonical.hasTimeOfDay(value),
    };
    for (const [name, mod] of Object.entries(mods)) {
      const got = {
        ms: mod.dueMs(value),
        day: mod.dueDayKey(value),
        label: mod.dueLabel(value),
        late: mod.isOverdue(value, now),
        hasTime: mod.hasTimeOfDay(value),
      };
      if (JSON.stringify(got) !== JSON.stringify(base)) {
        mismatches += 1;
        if (mismatches < 4) console.log(`       ${name} 与权威实现不一致：value=${JSON.stringify(value)} now=${now} got=${JSON.stringify(got)} want=${JSON.stringify(base)}`);
      }
    }
  }
}
ok(`三处副本在 ${MATRIX.length}×${NOWS.length} 组输入下行为完全一致`, mismatches === 0, `${mismatches} 处不一致`);

// 规则本身的边界
ok('纯日期 = 本地 23:59:59.999',
  canonical.dueMs('2026-10-04') === at(2026, 10, 4, 23, 59, 59, 999),
  String(canonical.dueMs('2026-10-04')));
ok('带时刻的截止 = 那一刻',
  canonical.dueMs('2026-10-04T09:00') === at(2026, 10, 4, 9, 0));
ok('当天 12:00：纯日期任务未逾期', canonical.isOverdue('2026-10-04', at(2026, 10, 4, 12, 0)) === false);
ok('当天 23:59:59.998：仍未逾期', canonical.isOverdue('2026-10-04', at(2026, 10, 4, 23, 59, 59, 998)) === false);
ok('次日 00:00：已逾期', canonical.isOverdue('2026-10-04', at(2026, 10, 5, 0, 0, 0, 0)) === true);
ok('带时刻 09:00 的任务在 10:00 已逾期', canonical.isOverdue('2026-10-04T09:00', at(2026, 10, 4, 10, 0)) === true);
ok('正好等于截止时刻不算逾期', canonical.isOverdue('2026-10-04T09:00', at(2026, 10, 4, 9, 0)) === false);
ok('纯日期的 day key 就是那一天', canonical.dueDayKey('2026-10-04') === '2026-10-04');
ok('纯日期标签写「当天截止」', canonical.dueLabel('2026-10-04') === '2026-10-04 当天截止');
ok('带时刻标签保留时分', canonical.dueLabel('2026-10-04T09:05') === '2026-10-04 09:05');
ok('空值与非法值 → null', canonical.dueMs('') === null && canonical.dueMs(null) === null
  && canonical.dueMs('乱七八糟') === null);

// ---------------------------------------------------------------- 3. 不再重复计数

if (BASELINE) {
  const state = JSON.parse(readFileSync(join(BASELINE, 'planner-state.json'), 'utf8'));
  const noon = at(2026, 10, 4, 12, 0);
  const vm = buildTodayVM(state, noon);
  const overdueIds = new Set(vm.sections.find((s) => s.id === 'focus').items.map((i) => i.id));
  const stats = vm.sections.find((s) => s.id === 'stats');
  const badge = vm.badge;

  // 独立重算一遍，只看 ids
  const open = state.tasks.filter((t) => t.status !== 'done' && t.due_at);
  const overdue = open.filter((t) => canonical.isOverdue(t.due_at, noon));
  const dueToday = open.filter((t) => canonical.dueDayKey(t.due_at) === '2026-10-04');
  const both = overdue.filter((t) => dueToday.includes(t));
  // 旧规则（new Date(纯日期) = UTC 零点 = 本地 08:00）在同一时刻会多算出来的部分
  const oldOverdue = open.filter((t) => {
    const parsed = new Date(t.due_at);
    return !Number.isNaN(parsed.getTime()) && parsed.getTime() < noon;
  });
  ok('没有任何任务同时算作「逾期」和「今天到期」', both.length === 0,
    both.map((t) => t.title).join(' / '));
  ok('badge = 逾期 + 今天到期（去重后）', badge === overdue.length + dueToday.length,
    `${badge} vs ${overdue.length}+${dueToday.length}`);
  ok('概览里的「到期/逾期」与 badge 一致',
    stats.items.find((i) => i.id === 'stat-due').title === String(overdue.length + dueToday.length));
  ok('旧规则在同一时刻确实多算（说明这个修复有意义）',
    oldOverdue.length > overdue.length,
    `旧 ${oldOverdue.length} vs 新 ${overdue.length}`);
  console.log(`       2026-10-04 12:00：逾期 ${overdue.length} + 今天到期 ${dueToday.length} = ${badge}` +
    `　（旧规则把 ${oldOverdue.length} 项算成逾期，同一批任务被数两次 → ${oldOverdue.length + dueToday.length}）`);
} else {
  console.log('  SKIP 重复计数检查（找不到 planner-state.json 测试数据）');
}

// ---------------------------------------------------------------- 4. 防回归

const appSrc = readFileSync(join(ROOT, 'public/app.js'), 'utf8');
const viewmodelSrc = readFileSync(join(ROOT, 'public/viewmodel.js'), 'utf8');
const staleComparisons = [
  /new Date\(\s*t\.due_at\s*\)\s*</,
  /new Date\(\s*a\.due_at\s*\)\s*-\s*new Date\(\s*b\.due_at\s*\)/,
  /dayKey\(\s*t\.due_at\s*\)/,
];
for (const [name, src] of [['public/app.js', appSrc], ['public/viewmodel.js', viewmodelSrc]]) {
  const hits = staleComparisons.filter((re) => re.test(src));
  ok(`${name} 里没有旧的截止时间写法`, hits.length === 0, hits.map(String).join(' | '));
}
ok('lib/plan-export.mjs 与 lib/ics.mjs 已改用统一规则', (() => {
  const p = readFileSync(join(ROOT, 'lib/plan-export.mjs'), 'utf8');
  const i = readFileSync(join(ROOT, 'lib/ics.mjs'), 'utf8');
  return p.includes("from './duedate.mjs'") && i.includes("from './duedate.mjs'");
})());

console.log('');
console.log(failures === 0 ? 'duedate.test: PASS' : `duedate.test: FAIL (${failures})`);
process.exit(failures === 0 ? 0 : 1);
