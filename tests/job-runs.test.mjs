// 作业运行记录（改造项 2）的验证。
//
//   node tests/job-runs.test.mjs
//
// 两类断言：
//   ① 调度器钩子：成功的记 ok、抛异常的记 failed、自报失败的记 failed、没到点的不记、
//      钩子自己抛错**不能**影响调度；
//   ② 表与查询：迁移能建出 job_runs（列 + 两个索引），并且"查某作业最近一次""近 N 天""90 天清理"
//      这三条查询的语义是对的。

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

import { runMigrations } from '../lib/migrations.mjs';
import { createTickRunner } from '../lib/notify-tick.mjs';

let failures = 0;
const ok = (label, cond, detail = '') => {
  if (cond) console.log(`  PASS ${label}`);
  else {
    failures += 1;
    console.log(`  FAIL ${label}${detail ? ` -- ${detail}` : ''}`);
  }
};

console.log('job-runs.test.mjs');

const mkTick = (jobs, onJobRun, clock) => createTickRunner({
  now: () => clock.t,
  timers: { set: () => 1, clear: () => {} },
  log: () => {},
  warn: () => {},
  onJobRun,
  jobs,
});

// ---------------- ① 调度器钩子 ----------------
{
  const recs = [];
  const clock = { t: 1_000_000 };
  const tick = mkTick([
    { name: 'ok-job', due: () => true, run: async () => { clock.t += 250; return { note: '干了活' }; } },
    { name: 'boom-job', due: () => true, run: async () => { clock.t += 10; throw new Error('炸了'); } },
    { name: 'self-fail', due: () => true, run: async () => { clock.t += 5; return { error: '源不可达' }; } },
    { name: 'idle', due: () => true, run: async () => { clock.t += 1; return { ok: false }; } },
    { name: 'not-due', due: () => false, run: async () => ({ note: '不该跑' }) },
  ], (r) => recs.push(r), clock);

  await tick.tickOnce();
  const by = Object.fromEntries(recs.map((r) => [r.job_id, r]));

  ok('只记"干了活/明确报错"的：记三条（没到点的不记、空手而归的也不记）',
    recs.length === 3, JSON.stringify(recs.map((r) => r.job_id)));
  ok('成功那条：status=ok、时长=250ms、摘要带出来',
    by['ok-job']?.status === 'ok' && by['ok-job']?.duration_ms === 250 && by['ok-job']?.summary === '干了活',
    JSON.stringify(by['ok-job']));
  ok('抛异常那条：status=failed 且带上原因',
    by['boom-job']?.status === 'failed' && /炸了/.test(by['boom-job']?.error || ''),
    JSON.stringify(by['boom-job']));
  ok('自报失败那条：也记 failed（不吞掉）',
    by['self-fail']?.status === 'failed' && /源不可达/.test(by['self-fail']?.error || ''));
  ok('没到点的作业没有记录', !by['not-due']);
  ok('**空手而归**（ok:false 但没说明）不记 —— 否则 4 秒一轮会把表刷爆', !by['idle']);
  ok('每条都带 trigger 与起止时间',
    recs.every((r) => r.trigger === 'tick' && Number(r.started_at) > 0 && Number(r.finished_at) >= Number(r.started_at)));
}
{
  // 钩子自己抛错：不能影响这一轮，也不能影响别的作业
  const clock = { t: 5 };
  const tick = mkTick([
    { name: 'a', due: () => true, run: async () => ({ note: 'x' }) },
    { name: 'b', due: () => true, run: async () => ({ note: 'y' }) },
  ], () => { throw new Error('记录失败'); }, clock);
  const out = await tick.tickOnce();
  ok('记录钩子抛错：两个作业照跑，错误没冒出去',
    out.ran.a?.note === 'x' && out.ran.b?.note === 'y' && out.errors.length === 0,
    JSON.stringify(out.errors));
}

// ---------------- ② 表与查询 ----------------
{
  const dir = mkdtempSync(join(process.env.PLANNER_TEST_TMP || tmpdir(), 'jobruns-'));
  const db = new DatabaseSync(join(dir, 't.sqlite'));
  runMigrations(db);

  const cols = db.prepare('PRAGMA table_info(job_runs)').all().map((c) => c.name);
  ok('迁移建出 job_runs（列齐全）',
    ['id', 'job_id', 'trigger', 'status', 'started_at', 'finished_at', 'duration_ms', 'summary', 'error', 'session_id', 'meta_json']
      .every((c) => cols.includes(c)),
    cols.join(','));
  const idx = db.prepare("SELECT name FROM pragma_index_list('job_runs')").all().map((r) => r.name);
  ok('两个索引都在（按作业、按时间）',
    idx.includes('idx_job_runs_job') && idx.includes('idx_job_runs_started'), idx.join(','));

  const ins = db.prepare(`INSERT INTO job_runs
    (id,job_id,trigger,status,started_at,finished_at,duration_ms,summary,error)
    VALUES (?,?,?,?,?,?,?,?,?)`);
  const t0 = Date.now();
  ins.run('r1', 'autosync', 'tick', 'ok', t0 - 3600e3, t0 - 3600e3 + 1200, 1200, '同步完成', null);
  ins.run('r2', 'autosync', 'tick', 'failed', t0 - 1800e3, t0 - 1800e3 + 5000, 5000, null, '网络超时');
  ins.run('r3', 'digest', 'tick', 'ok', t0 - 60e3, t0, 300, '早报已发', null);
  ins.run('r4', 'autosync', 'tick', 'ok', t0 - 200 * 86400e3, t0, 1, '很久以前', null);

  const last = db.prepare('SELECT * FROM job_runs WHERE job_id = ? ORDER BY started_at DESC LIMIT 1').get('autosync');
  ok('「某作业最近一次」拿到最新那条（失败的那次）',
    last.id === 'r2' && last.status === 'failed' && last.error === '网络超时');

  const recent = db.prepare('SELECT * FROM job_runs WHERE started_at >= ? ORDER BY started_at DESC')
    .all(t0 - 2 * 86400e3);
  ok('「近两天」包含三条、不含 200 天前那条',
    recent.length === 3 && !recent.some((r) => r.id === 'r4'), recent.map((r) => r.id).join(','));

  const byJob = db.prepare('SELECT * FROM job_runs WHERE job_id = ? ORDER BY started_at DESC').all('digest');
  ok('按作业过滤有效', byJob.length === 1 && byJob[0].summary === '早报已发');

  const del = db.prepare('DELETE FROM job_runs WHERE started_at < ?').run(t0 - 90 * 86400e3);
  ok('90 天清理：恰好删掉那条过期的', Number(del.changes) === 1);

  db.close();
  rmSync(dir, { recursive: true, force: true });
}

console.log('');
console.log(failures === 0 ? 'job-runs.test: PASS' : `job-runs.test: FAIL (${failures})`);
process.exit(failures === 0 ? 0 : 1);
