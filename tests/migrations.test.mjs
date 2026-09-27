// 数据版本迁移台账测试（2026-09-21）。
//
//   node tests/migrations.test.mjs
//
// 要证明的四件事：
//   1. 全新库：一次跑完全部迁移，版本号 = 最大编号；
//   2. 只跑一次：再跑不会重跑（这是"换新版本不折腾用户"的关键）；
//   3. 老库：缺列的表会被补齐，而不是报错；
//   4. 失败的那条**不能被记成已应用**（否则升级会永久卡住）。

import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  MIGRATIONS, currentSchemaVersion, ensureColumn, listMigrations, migrationSummary, runMigrations,
  tableColumns,
} from '../lib/migrations.mjs';

let failures = 0;
const ok = (label, cond, detail = '') => {
  if (cond) console.log(`  PASS ${label}`);
  else {
    failures += 1;
    console.log(`  FAIL ${label}${detail ? ` -- ${detail}` : ''}`);
  }
};

console.log('migrations.test.mjs');

const base = process.env.PLANNER_TEST_TMP || tmpdir();
const dir = mkdtempSync(join(base, 'migrate-'));
let seq = 0;
const openDb = (name) => new DatabaseSync(join(dir, `${name}.sqlite`));

// ---------- 1. 迁移清单本身要干净 ----------
const versions = MIGRATIONS.map((m) => m.version);
ok('迁移清单不为空', MIGRATIONS.length >= 6);
ok('编号严格递增且不重复', versions.every((v, i) => i === 0 || v > versions[i - 1]));
ok('每条迁移都有名字', MIGRATIONS.every((m) => typeof m.name === 'string' && m.name.trim().length > 0));
ok('每条迁移都有 up()', MIGRATIONS.every((m) => typeof m.up === 'function'));

// ---------- 2. 全新库：补齐 + 登记 ----------
const fresh = openDb('fresh');
ok('没跑之前版本是 0', currentSchemaVersion(fresh) === 0);
const first = runMigrations(fresh);
ok('全新库跑完 = 全部应用', first.ran.length === MIGRATIONS.length, JSON.stringify(first));
ok('版本号 = 最大编号', first.version === Math.max(...versions));
ok('应用的条数对得上', first.applied === MIGRATIONS.length);
ok('返回里报了跑过哪些', first.ran.every((r) => typeof r.version === 'number' && r.name));

// 台账本身的内容
const rows = fresh.prepare('SELECT version, name, applied_at FROM schema_migrations ORDER BY version').all();
ok('台账每行都有时间戳', rows.every((r) => Number(r.applied_at) > 0));
ok('台账条数与清单一致', rows.length === MIGRATIONS.length);

// ---------- 3. 只跑一次 ----------
const second = runMigrations(fresh);
ok('第二次跑：一条都不跑', second.ran.length === 0);
ok('第二次跑：版本号不变', second.version === first.version);
ok('第二次跑：条数不变', second.applied === first.applied);
const third = runMigrations(fresh);
ok('连跑三次仍然稳定', third.ran.length === 0 && third.version === first.version);

// ---------- 4. 老库缺列：自愈而不是报错 ----------
const legacy = openDb('legacy');
legacy.exec(`
CREATE TABLE connector_data (id TEXT PRIMARY KEY, source TEXT, payload TEXT);
CREATE TABLE notifications (id TEXT PRIMARY KEY, title TEXT, trigger_at TEXT);
CREATE TABLE course_files (id TEXT PRIMARY KEY, filename TEXT);
CREATE TABLE course_schedule (id TEXT PRIMARY KEY, course TEXT);
`);
const legacyRes = runMigrations(legacy);
ok('老库也能跑完全部迁移', legacyRes.ran.length === MIGRATIONS.length);
ok('老库：connector_data 补出裁决列',
  ['score', 'verdict', 'reasons', 'approved'].every((c) => tableColumns(legacy, 'connector_data').includes(c)));
ok('老库：notifications 补出 external_id / priority / url',
  ['external_id', 'priority', 'url'].every((c) => tableColumns(legacy, 'notifications').includes(c)));
ok('老库：course_files 补出 local_name / file_date',
  ['local_name', 'file_date'].every((c) => tableColumns(legacy, 'course_files').includes(c)));
ok('老库：course_schedule 补出 platform',
  tableColumns(legacy, 'course_schedule').includes('platform'));
ok('老库：原有数据没被动过', legacy.prepare('SELECT COUNT(*) AS n FROM notifications').get().n === 0);

// ---------- 5. 缺列补齐要幂等 ----------
ok('再加一次已有的列 → 返回 false 且不报错', ensureColumn(legacy, 'notifications', 'url', 'TEXT') === false);
ok('表不存在时不造半个表、也不报错', ensureColumn(legacy, '根本没有这张表', 'x', 'TEXT') === false);

// ---------- 6. 回填：老库里已存在的数据要留着 ----------
const keeper = openDb('keeper');
keeper.exec('CREATE TABLE notifications (id TEXT PRIMARY KEY, title TEXT);');
keeper.prepare('INSERT INTO notifications (id, title) VALUES (?, ?)').run('n1', '别把我弄丢了');
runMigrations(keeper);
ok('补列之后老数据还在', keeper.prepare('SELECT title FROM notifications WHERE id = ?').get('n1')?.title === '别把我弄丢了');

// ---------- 7. 失败的迁移不能记成"已应用" ----------
const failing = openDb('failing');
const BAD_VERSION = Math.max(...versions) + 1;
MIGRATIONS.push({
  version: BAD_VERSION,
  name: '故意失败的迁移（测试用）',
  up() { throw new Error('故意的'); },
});
let threw = '';
try {
  runMigrations(failing);
} catch (e) {
  threw = e.message;
}
MIGRATIONS.pop();
ok('坏迁移会抛出并且带编号', threw.includes(`#${BAD_VERSION}`), threw);
ok('坏迁移**没有**被记进台账',
  !failing.prepare('SELECT version FROM schema_migrations WHERE version = ?').get(BAD_VERSION));
ok('坏迁移之前的那些正常迁移仍在台账里',
  failing.prepare('SELECT COUNT(*) AS n FROM schema_migrations').get().n === MIGRATIONS.length - 0);

// ---------- 8. 摘要文案（给 /api/status 用） ----------
const sum = migrationSummary(fresh);
ok('摘要里有版本号', sum.version === first.version);
ok('摘要里没有待办', sum.pending.length === 0);
ok('摘要文案可读', sum.detail.includes('数据版本') && sum.detail.includes(`${MIGRATIONS.length}/${MIGRATIONS.length}`));
ok('listMigrations 每条都标了 applied', listMigrations(fresh).every((m) => m.applied === true));

console.log('');
console.log(failures === 0 ? 'migrations.test: PASS' : `migrations.test: FAIL (${failures})`);
process.exit(failures === 0 ? 0 : 1);
