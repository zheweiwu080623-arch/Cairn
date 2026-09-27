// 自动备份的验证（2026-09-24，审阅反馈驱动）。
//
//   node tests/backup.test.mjs
//
// 用假 store + 假快照（写一个占位文件），不碰真数据库；真落盘由"实盘复验"另外跑。

import { mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import {
  AUTO_DIRNAME, backupDirOf, backupName, createBackupRunner, listBackups,
  normalizeBackupPrefs, pickPrunable, shouldBackup,
} from '../lib/backup.mjs';
import { createBackupStack } from '../lib/backup-stack.mjs';

let failures = 0;
const ok = (label, cond, detail = '') => {
  if (cond) console.log(`  PASS ${label}`);
  else { failures += 1; console.log(`  FAIL ${label}${detail ? ` -- ${detail}` : ''}`); }
};

const TMP = process.env.PLANNER_TEST_TMP || '';
if (!TMP) {
  console.error('需要 PLANNER_TEST_TMP（run_all_suites.py 会设置）');
  process.exit(2);
}
console.log('backup.test.mjs');

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const root = mkdtempSync(join(TMP, 'backup-'));
const dataDir = join(root, 'data');
mkdirSync(dataDir, { recursive: true });

// ---------------- 1. 设置清洗 ----------------
ok('默认：开 · 每 24 小时 · 留 7 份 · 目录留空',
  JSON.stringify(normalizeBackupPrefs({})) === JSON.stringify({ enabled: true, every_hours: 24, keep: 7, dir: '' }),
  JSON.stringify(normalizeBackupPrefs({})));
ok('坏值夹到合理区间（间隔 0.2 小时→1、999 小时→336；保留 0→1、999→60）',
  normalizeBackupPrefs({ every_hours: 0.2 }).every_hours === 1
  && normalizeBackupPrefs({ every_hours: 999 }).every_hours === 336
  && normalizeBackupPrefs({ keep: 0 }).keep === 1 && normalizeBackupPrefs({ keep: 999 }).keep === 60);
ok('显式关掉就是关掉（不是"没填"）', normalizeBackupPrefs({ enabled: false }).enabled === false);
ok('可以指定备份目录（指向网盘同步文件夹＝零账号的异地副本）',
  backupDirOf(dataDir, { dir: 'D:\\OneDrive\\cairn' }) === 'D:\\OneDrive\\cairn');
ok('没指定就是 <数据目录>/backups', backupDirOf(dataDir, {}) === join(dataDir, 'backups'));

// ---------------- 2. 文件名与"该不该跑" ----------------
ok('文件名带分钟时间戳（同一分钟不会重名）',
  /^auto-\d{8}-\d{4}\.db$/.test(backupName(new Date(2026, 8, 24, 1, 5).getTime())), backupName());
ok('分钟是补零的两位', backupName(new Date(2026, 8, 24, 1, 5).getTime()).endsWith('-0105.db'));

const H = 3600000;
const NOW = new Date(2026, 8, 24, 9, 0).getTime();
ok('没备过 → 该跑', shouldBackup({ prefs: {}, last: null, now: NOW }).ok === true);
ok('关掉后不跑，并说清原因',
  shouldBackup({ prefs: { enabled: false }, last: null, now: NOW }).ok === false
  && shouldBackup({ prefs: { enabled: false }, last: null, now: NOW }).reason.includes('关闭'));
ok('还没到间隔 → 不跑，并说还剩多少分钟',
  shouldBackup({ prefs: {}, last: { at: NOW - 2 * H }, now: NOW }).ok === false
  && shouldBackup({ prefs: {}, last: { at: NOW - 2 * H }, now: NOW }).reason.includes('到点'));
ok('到了间隔、且库有变化 → 该跑',
  shouldBackup({ prefs: {}, last: { at: NOW - 25 * H, db_mtime: 111 }, now: NOW, dbMtime: 222 }).ok === true);
ok('到了间隔、但库没变 → 跳过（不重复占 14 MB）',
  shouldBackup({ prefs: {}, last: { at: NOW - 25 * H, db_mtime: 222 }, now: NOW, dbMtime: 222 }).ok === false
  && shouldBackup({ prefs: {}, last: { at: NOW - 25 * H, db_mtime: 222 }, now: NOW, dbMtime: 222 }).reason.includes('没变化'));

// ---------------- 3. 定期清理：只留最近 N 份 ----------------
{
  const names = ['auto-20260924-0110.db', 'auto-20260924-0115.db', 'auto-20260924-0120.db', 'readme.txt', 'auto-bad.db'];
  ok('只挑自家命名的快照（别的文件不碰）',
    JSON.stringify(pickPrunable(names, { keep: 2 })) === JSON.stringify(['auto-20260924-0110.db']),
    JSON.stringify(pickPrunable(names, { keep: 2 })));
  ok('份数够时什么都不清', pickPrunable(names, { keep: 5 }).length === 0);
  ok('至少留 1 份（keep=0 也不会把最新那份清掉）', pickPrunable(names, { keep: 0 }).length === 2);
}

// ---------------- 4. 执行能力（假 store + 假快照） ----------------
const storeMap = new Map();
const store = {
  getSync: (k) => storeMap.get(k),
  setSync: (k, v) => storeMap.set(k, v),
  path: () => join(root, 'fake.db'),
};
writeFileSync(join(root, 'fake.db'), 'x'.repeat(1024));
const calls = [];
const snapshot = (file) => { calls.push(file); writeFileSync(file, 'FAKE-DB-SNAPSHOT'); return { ok: true }; };
let clock = NOW;
const runner = createBackupRunner({ store, dataDir, snapshot, now: () => clock, log: () => {} });

{
  const r = runner.runOnce({ dbMtime: 123 });
  ok('第一次该跑就跑，快照落在 <数据目录>/backups/auto/',
    r.ok === true && r.ran === true && r.file.startsWith(join(dataDir, 'backups', AUTO_DIRNAME)),
    JSON.stringify(r));
  ok('快照内容确实写进去了（用的是注入的落盘函数）',
    readFileSync(r.file, 'utf8') === 'FAKE-DB-SNAPSHOT' && calls.length === 1);
  ok('记下了"上次备份"（时间 + 文件 + 大小 + 库的 mtime）',
    (() => { const l = runner.readLast(); return l && l.at === NOW && l.file === r.file && l.bytes > 0 && l.db_mtime === 123; })(),
    JSON.stringify(runner.readLast()));
}
{
  clock = NOW + 2 * H;
  const r = runner.runOnce({ dbMtime: 999 });
  ok('没到间隔 → 不跑（并且不会多出一份文件）', r.ok === true && r.ran === false && calls.length === 1, JSON.stringify(r));
}
{
  clock = NOW + 25 * H;
  const r = runner.runOnce({ force: true, dryRun: true, dbMtime: 999 });
  ok('演练：只说出会备份到哪，不落盘', r.dry_run === true && r.ran === false && calls.length === 1, JSON.stringify(r));
}
{
  const r = runner.runOnce({ dbMtime: 999 });
  ok('到点且库有变化 → 再备一份', r.ok === true && r.ran === true && calls.length === 2, JSON.stringify(r));
}
{
  // 备 8 次（留 7 份）→ 最早那份该被清掉
  for (let i = 3; i <= 9; i += 1) {
    clock = NOW + (24 + i) * H;
    runner.runOnce({ force: true, dbMtime: 1000 + i });
  }
  const files = readdirSync(join(dataDir, 'backups', AUTO_DIRNAME)).filter((n) => n.endsWith('.db'));
  ok('定期清理：只留最近 7 份（多出来的自动清掉）', files.length === 7, JSON.stringify(files));
  const last = runner.readLast();
  ok('留下的都是比较新的（最新那份在里面）', files.includes(last.file.split(/[\\/]/).pop()));
}
{
  storeMap.set('backup_prefs_json', JSON.stringify({ keep: 20 }));
  ok('改了保留份数之后按新设置来', runner.readPrefs().keep === 20 && runner.savePrefs({ keep: 3 }).keep === 3);
}
{
  const bad = createBackupRunner({
    store: { getSync: () => null, setSync: () => {}, path: () => '' },
    dataDir: join(root, 'bad'),
    snapshot: () => ({ ok: false, error: '磁盘满了' }),
    now: () => NOW, log: () => {},
  });
  const r = bad.runOnce({ force: true });
  ok('落盘失败 → 如实报错，并且不记录"上次备份成功"',
    r.ok === false && r.error.includes('磁盘满了') && bad.readLast() === null, JSON.stringify(r));
}
{
  const noSnap = createBackupRunner({ store, dataDir: join(root, 'nosnap'), now: () => NOW, log: () => {} });
  ok('没有可用的落盘能力 → 明确说"没有能力"，不假装成功',
    noSnap.runOnce({ force: true }).ok === false && noSnap.runOnce({ force: true }).error.includes('没有可用'));
}
{
  mkdirSync(join(dataDir, 'backups', AUTO_DIRNAME), { recursive: true });
  writeFileSync(join(dataDir, 'backups', AUTO_DIRNAME, 'notes.txt'), 'x');
  const list = listBackups(join(dataDir, 'backups', AUTO_DIRNAME));
  ok('清单只列自家快照、新的在前、带大小与时间',
    list.length === 7 && !list.some((b) => b.name === 'notes.txt') && list[0].size > 0 && !!list[0].mtime);
  ok('目录不存在 → 空数组（不抛）', listBackups(join(root, '没这个')).length === 0);
}

// ---------------- 5. 接口 ----------------
{
  const stack = createBackupStack({
    store, dataDir, log: () => {},
    sendJson: (res, code, obj) => { res.code = code; res.body = obj; },
    sendError: (res, code, message) => { res.code = code; res.body = { error: message }; },
    readBody: async (req) => req.body || {},
  });
  const req = (method, body) => ({ method, body });
  const urlOf = (p) => new URL('http://127.0.0.1:3210' + p);

  const res1 = {};
  await stack.handleBackups(req('GET'), res1, urlOf('/api/backups'));
  ok('GET /api/backups 给设置 / 清单 / 上次结果',
    res1.code === 200 && res1.body.count === 7 && res1.body.schema === 'backup.v1' && !!res1.body.dir);

  const res2 = {};
  await stack.handleBackups(req('POST', { prefs: { every_hours: 12, keep: 5 } }), res2, urlOf('/api/backups'));
  ok('POST /api/backups 改设置并回读', res2.code === 200 && res2.body.prefs.every_hours === 12 && res2.body.prefs.keep === 5);

  const res3 = {};
  await stack.handleBackups(req('POST', {}), res3, urlOf('/api/backups/run'));
  ok('POST /api/backups/run **默认演练**（只规划，不落盘）',
    res3.code === 200 && res3.body.dry_run === true && res3.body.ran === false);

  const res4 = {};
  await stack.handleBackups(req('GET'), res4, urlOf('/api/backups/别的'));
  ok('不认识的路径 → 404（不抢别的路由）', res4.code === 404);
}

// ---------------- 6. 接线守卫 ----------------
{
  const srv = readFileSync(join(ROOT, 'server.mjs'), 'utf8');
  const storeSrc = readFileSync(join(ROOT, 'lib', 'store.mjs'), 'utf8');
  const appSrc = readFileSync(join(ROOT, 'public', 'app.js'), 'utf8');
  ok('主程序接上了备份接口与心跳', srv.includes('createBackupStack') && srv.includes('backups.maybeRun()')
    && srv.includes("p.startsWith('/api/backups/')"));
  ok('快照用 SQLite 自带的 VACUUM INTO（不是直接拷可能写了一半的文件）',
    storeSrc.includes('VACUUM INTO') && storeSrc.includes('backupTo(file)'));
  ok('备份默认开（兜底功能要默认开才叫兜底）', normalizeBackupPrefs({}).enabled === true);
  ok('主程序仍然在行数护栏内（<2200）', srv.split('\n').length < 2200, String(srv.split('\n').length));
  ok('卡片挂在「统计」页（不往今日页堆）',
    appSrc.includes("mountGadgets('stats')")
    && JSON.parse(readFileSync(join(ROOT, 'modules', 'backup-card', 'module.json'), 'utf8')).mount_into === 'stats');
}
{
  const view = await import(pathToFileURL(join(ROOT, 'modules', 'backup-card', 'view.js')).href);
  ok('卡片导出纯函数 renderCard / renderFiles', typeof view.renderCard === 'function' && typeof view.renderFiles === 'function');
  const html = view.renderCard({
    prefs: { enabled: true, every_hours: 24, keep: 7, dir: '' },
    dir: 'C:\\数据\\backups', bytes: 8 * 1048576,
    files: [{ name: 'auto-20260924-1208.db', size: 7987200, mtime: '2026-09-24T04:08:00.000Z' }],
    last: { at: '2026-09-24T04:08:00.000Z', bytes: 7987200 },
  });
  ok('卡片上有开关 / 间隔 / 份数 / 目录 / 演练 / 真备 / 打开文件夹',
    ['bk-enabled', 'bk-every', 'bk-keep', 'bk-dir', 'bk-dry', 'bk-run', 'bk-open'].every((id) => html.includes(`id="${id}"`)));
  ok('卡片如实显示现有份数与上次备份', html.includes('现有 1 份') && html.includes('上次备份'));
  ok('没有快照时给一句人话（不是空表）', view.renderFiles([]).includes('还没有快照'));
  ok('快照清单带大小与时间', view.renderFiles([{ name: 'a.db', size: 1048576, mtime: '2026-09-24T00:00:00.000Z' }]).includes('1.0 MB'));
}

console.log('');
console.log(failures === 0 ? 'backup.test: PASS' : `backup.test: FAIL (${failures})`);
process.exit(failures === 0 ? 0 : 1);
