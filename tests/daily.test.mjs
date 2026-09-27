// 「每日 18:00 开工」的验证（D5）。
//
//   node tests/daily.test.mjs

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { DAILY_PREFS_KEY, dailyDue, dateKeyOf, normalizeDailyPrefs } from '../lib/daily.mjs';
import { createDailyStack } from '../lib/daily-stack.mjs';

let failures = 0;
const ok = (label, cond, detail = '') => {
  if (cond) console.log(`  PASS ${label}`);
  else { failures += 1; console.log(`  FAIL ${label}${detail ? ` -- ${detail}` : ''}`); }
};

console.log('daily.test.mjs');
const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const day = (h, m = 0) => new Date(2026, 8, 24, h, m, 0, 0).getTime();

// ---------------- 1. 设置 ----------------
ok('默认：开 · 18:00 · 顺手刷新本周巩固 · 不推手机',
  JSON.stringify(normalizeDailyPrefs({})).includes('"at":"18:00"')
  && normalizeDailyPrefs({}).enabled === true && normalizeDailyPrefs({}).weekly === true
  && normalizeDailyPrefs({}).push === false);
ok('时间写坏了退回 18:00（不让人因为一个错字就再也不会开工）',
  normalizeDailyPrefs({ at: '25:99' }).at === '18:00' && normalizeDailyPrefs({ at: '乱写' }).at === '18:00');
ok('可以改成别的点（例如 21:30）', normalizeDailyPrefs({ at: '21:30' }).minutes === 21 * 60 + 30);

// ---------------- 2. 到点没有 ----------------
ok('关掉就不开工', dailyDue({ prefs: { enabled: false }, now: day(19) }).ok === false);
ok('18:00 之前不开工，并说还差多久',
  dailyDue({ prefs: {}, now: day(13) }).ok === false && dailyDue({ prefs: {}, now: day(13) }).reason.includes('还没到点'));
ok('过了 18:00 就开工', dailyDue({ prefs: {}, now: day(18, 0) }).ok === true && dailyDue({ prefs: {}, now: day(23, 59) }).ok === true);
ok('同一天只开一次工（不重复写文件、不重复打扰）',
  dailyDue({ prefs: {}, now: day(20), last: { date: '2026-09-23' } }).ok === true
  && dailyDue({ prefs: {}, now: day(20), last: { date: dateKeyOf(day(20)) } }).ok === false);
ok('昨天开过、今天没开 → 照常开工', dailyDue({ prefs: {}, now: day(19), last: { date: '2026-09-23' } }).ok === true);

// ---------------- 3. 执行能力 ----------------
const map = new Map();
const store = {
  getSync: (k) => map.get(k),
  setSync: (k, v) => map.set(k, v),
  listTasks: () => ([
    { id: 'a', title: '昨天的作业', status: 'todo', due_at: new Date(2026, 8, 23, 23, 59).toISOString() },
    { id: 'b', title: '今天到期', status: 'todo', due_at: new Date(2026, 8, 24, 23, 59).toISOString() },
    { id: 'c', title: '明天到期', status: 'todo', due_at: new Date(2026, 8, 25, 23, 59).toISOString() },
    { id: 'd', title: '做完了的', status: 'done', due_at: new Date(2026, 8, 24, 10, 0).toISOString() },
    { id: 'e', title: '很远', status: 'todo', due_at: new Date(2026, 9, 30, 23, 59).toISOString() },
  ]),
};
const calls = [];
const notes = [];
let clock = day(18, 5);
const stack = createDailyStack({
  store, log: () => {}, now: () => clock, dataDir: 'C:\\数据',
  runModule: async (id, opts) => { calls.push([id, opts]); return { ok: true, actions: [{ type: 'file', status: 'done', summary: '第 2 周巩固包（读了 2/3 份材料）' }] }; },
  onReady: (n) => notes.push(n),
  sendJson: (res, code, obj) => { res.code = code; res.body = obj; },
  sendError: (res, code, message) => { res.code = code; res.body = { error: message }; },
  readBody: async (req) => req.body || {},
});

{
  const r = await stack.runOnce({ dryRun: true });
  ok('演练：只说会做什么，不写文件、不发通知',
    r.dry_run === true && r.ran === false && calls.length === 0 && notes.length === 0);
  ok('演练里也能看到今天有多少事',
    r.plan.counts.overdue === 1 && r.plan.counts.today === 1 && r.plan.counts.tomorrow === 1, JSON.stringify(r.plan.counts));
}
{
  const r = await stack.runOnce({ dryRun: false });
  ok('真开工：刷新本周巩固包（走功能，真跑）',
    r.ran === true && calls.length === 1 && calls[0][0] === 'course-assist'
    && calls[0][1].input.mode === 'weekly' && calls[0][1].dryRun === false, JSON.stringify(calls[0]));
  ok('汇总成一条通知：今天几件事 + 巩固包结果',
    notes.length === 1 && notes[0].title.includes('每日开工') && notes[0].text.includes('1 件已逾期')
    && notes[0].text.includes('第 2 周巩固包'), JSON.stringify(notes[0]));
  ok('记下"今天开过工了"（含结果，界面能回看）',
    stack.readLast().date === dateKeyOf(clock) && Boolean(stack.readLast().weekly_result));
}
{
  const r = await stack.runOnce({ dryRun: false });
  ok('同一天再叫它也不重复开工', r.ran === false && calls.length === 1 && notes.length === 1, JSON.stringify(r.reason));
}
{
  clock = day(19, 0) + 86400000;                            // 第二天
  const r = await stack.runOnce({ dryRun: false });
  ok('第二天到点又开一次工', r.ran === true && calls.length === 2);
}
{
  stack.savePrefs({ weekly: false });
  clock = day(19, 0) + 2 * 86400000;
  const r = await stack.runOnce({ dryRun: false });
  ok('关掉"顺手刷新巩固包"之后就不跑功能了', r.ran === true && calls.length === 2, String(calls.length));
}
{
  const noRunner = createDailyStack({
    store, log: () => {}, now: () => day(19, 0) + 3 * 86400000,
    onReady: () => {}, sendJson: () => {}, sendError: () => {}, readBody: async () => ({}),
  });
  const r = await noRunner.runOnce({ dryRun: false });
  ok('没有功能运行器时不会崩（照常汇总通知）', r.ok === true && r.ran === true);
}
{
  // 默认的通知方式：一天最多一条（同一天手动再开一次工也不刷屏）
  const rows = [];
  const map2 = new Map();
  const store2 = {
    getSync: (k) => map2.get(k), setSync: (k, v) => map2.set(k, v),
    listTasks: () => [], listNotifications: () => rows,
    createNotification: (n) => { rows.push(n); return n; },
  };
  const stack2 = createDailyStack({ store: store2, now: () => day(19), log: () => {} });
  await stack2.runOnce({ dryRun: false, force: true });
  const second = await stack2.runOnce({ dryRun: false, force: true });
  ok('一天只留一条「开工」通知（同一天再手动开也只在应用内留一条）',
    rows.length === 1 && second.notified === false && String(second.notify_skipped).includes('已经有一条'));
  ok('通知按日期去重（external_id=daily:<日期>）',
    rows[0].external_id === `daily:${dateKeyOf(day(19))}` && rows[0].source === 'daily');
}

// ---------------- 4. 接口 ----------------
{
  const req = (method, body) => ({ method, body });
  const urlOf = (p) => new URL('http://127.0.0.1:3210' + p);
  const res1 = {};
  await stack.handleDaily(req('GET'), res1, urlOf('/api/daily'));
  ok('GET /api/daily 给设置 + 上次结果 + 今天到点没有',
    res1.code === 200 && res1.body.schema === 'daily.v1' && typeof res1.body.due.ok === 'boolean' && !!res1.body.last);
  const res2 = {};
  await stack.handleDaily(req('POST', { prefs: { at: '21:00', push: true } }), res2, urlOf('/api/daily'));
  ok('POST /api/daily 改时间与推送开关并回读',
    res2.code === 200 && res2.body.prefs.at === '21:00' && res2.body.prefs.push === true);
  const res3 = {};
  await stack.handleDaily(req('POST', {}), res3, urlOf('/api/daily/run'));
  ok('POST /api/daily/run **默认演练**（不会真写文件）', res3.code === 200 && res3.body.dry_run === true);
  const res4 = {};
  await stack.handleDaily(req('GET'), res4, urlOf('/api/daily/别的'));
  ok('不认识的路径 → 404', res4.code === 404);
}

// ---------------- 5. 接线守卫 ----------------
{
  const srv = readFileSync(join(ROOT, 'server.mjs'), 'utf8');
  const dailySrc = readFileSync(join(ROOT, 'lib', 'daily-stack.mjs'), 'utf8');
  const modSrc = readFileSync(join(ROOT, 'modules', 'course-assist', 'run.js'), 'utf8');
  ok('主程序接上了：接口 + 心跳里的一条 job',
    srv.includes('createDailyStack') && srv.includes("p.startsWith('/api/daily/')") && srv.includes("name: 'daily'"));
  ok('开工结果默认进通知表（source=daily，按日期去重 ⇒ 一天一条）',
    dailySrc.includes("source: 'daily'") && dailySrc.includes('`daily:${dateKeyOf(now())}`'));
  ok('功能支持 mode=weekly（巩固包）', /mode === 'weekly'/.test(modSrc));
  ok('主程序行数护栏内', srv.split('\n').length < 2200, String(srv.split('\n').length));
}

console.log('');
console.log(failures === 0 ? 'daily.test: PASS' : `daily.test: FAIL (${failures})`);
process.exit(failures === 0 ? 0 : 1);
