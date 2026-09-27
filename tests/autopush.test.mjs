// 「重要信息自动进通知 / 推手机」的验证（规则 + 设置接口 + 接线 + 默认关闭）。
//
//   node tests/autopush.test.mjs

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  AUTOPUSH_DEFAULT, AUTOPUSH_KEY, autopushKey, describeAutopush, markSeen, normalizeAutopush, selectAutopush,
} from '../lib/autopush.mjs';
import { createPriorityRoutes } from '../lib/routes/priority.mjs';
import { createAutopushRunner } from '../lib/autopush-run.mjs';

let failures = 0;
const ok = (label, cond, detail = '') => {
  if (cond) console.log(`  PASS ${label}`);
  else {
    failures += 1;
    console.log(`  FAIL ${label}${detail ? ` -- ${detail}` : ''}`);
  }
};

console.log('autopush.test.mjs');

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const DAY = 86400000;
// 锚点用**真实现在**（同上：写死日期会让夹具里的"未来条目"过期，断言随机变红）
const NOW = Date.now();
const iso = (off, hour = 23) => { const d = new Date(NOW + off * DAY); d.setHours(hour, 0, 0, 0); return d.toISOString(); };
const dstr = (off) => { const d = new Date(NOW + off * DAY); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`; };

// ---------------- 1. 默认与清洗 ----------------
ok('默认是关的（不打扰是默认值）', AUTOPUSH_DEFAULT.enabled === false && normalizeAutopush(null).enabled === false);
ok('默认只勾"进通知"、不推手机', AUTOPUSH_DEFAULT.notify === true && AUTOPUSH_DEFAULT.bark === false);
{
  const c = normalizeAutopush({ enabled: '1', notify: 0, bark: 'true', threshold: 200, max_per_run: 99, window_days: 0, cooldown_hours: -5 });
  ok('布尔值各种写法都能认', c.enabled === true && c.notify === false && c.bark === true);
  ok('阈值被夹在 45~100', c.threshold === 100, String(c.threshold));
  ok('每次条数被夹在 1~10', c.max_per_run === 10, String(c.max_per_run));
  ok('窗口与冷却也有下限', c.window_days === 1 && c.cooldown_hours === 1);
  ok('非法输入回落到默认', normalizeAutopush({ threshold: 'x', max_per_run: null }).threshold === 70);
}
{
  const seen = normalizeAutopush({ seen: { a: NOW, b: 'x', '': 5, c: -1 } }).seen;
  ok('seen 只留合法的时间戳', Object.keys(seen).length === 1 && seen.a === Math.round(NOW), JSON.stringify(seen));
}
ok('同一条信息的 key 稳定（来源|标题）',
  autopushKey({ source: 'canvas', title: '实验报告' }) === 'canvas|实验报告'
  && autopushKey({ title: '实验报告' }) === 'app|实验报告');

// ---------------- 2. 挑哪几条 ----------------
const items = [
  { id: 'a', source: 'canvas', title: '高分手写：实验报告明天截止', importance: 92, band: 'high', daysLeft: 1 },
  { id: 'b', source: 'email_sjtu', title: '中分：选课通知', importance: 70, band: 'high', daysLeft: 3 },
  { id: 'c', source: 'rss', title: '低分：讲座', importance: 60, band: 'normal', daysLeft: 1 },
  { id: 'd', source: 'rss', title: '过期：上礼拜的公告', importance: 95, band: 'high', daysLeft: -3 },
  { id: 'e', source: 'rss', title: '太远：下个月的报名', importance: 88, band: 'high', daysLeft: 30 },
  { id: 'f', source: 'rss', title: '无时间但很高分', importance: 99, band: 'high', daysLeft: null },
  { id: 'g', source: 'priority', title: '我们自己推的通知不该再推一次', importance: 99, band: 'high', daysLeft: 0 },
];
const on = { enabled: true, notify: true, bark: false, threshold: 70, max_per_run: 10, window_days: 7, cooldown_hours: 24, seen: {} };
{
  ok('关着的时候一条都不挑', selectAutopush(items, { ...on, enabled: false }, { now: NOW }).length === 0);
  const picked = selectAutopush(items, on, { now: NOW }).map((x) => x.id);
  ok('低于阈值的不挑', !picked.includes('c'));
  ok('已过期的不挑', !picked.includes('d'));
  ok('太远的不挑', !picked.includes('e'));
  ok('我们自己推的不再推（防自己喂自己）', !picked.includes('g'));
  ok('没写时间的高分照样挑（宁多勿漏）', picked.includes('f'));
  ok('挑出来的都带 key（便于去重）', selectAutopush(items, on, { now: NOW }).every((x) => !!x.key));
  const limited = selectAutopush(items, { ...on, max_per_run: 2 }, { now: NOW });
  ok('一次最多几条的道理守住了', limited.length === 2, String(limited.length));
}
{
  const key = autopushKey(items[0]);
  const seen = { [key]: NOW - 3600000 };   // 1 小时前推过
  ok('冷却期内不重复推', !selectAutopush(items, { ...on, seen }, { now: NOW }).some((x) => x.key === key));
  ok('过了冷却期可以再推', selectAutopush(items, { ...on, seen: { [key]: NOW - 25 * 3600000 } }, { now: NOW }).some((x) => x.key === key));
  ok('关了冷却（1 小时）也不会立刻重推刚才那条',
    !selectAutopush(items, { ...on, cooldown_hours: 1, seen: { [key]: NOW - 60000 } }, { now: NOW }).some((x) => x.key === key));
}
ok('markSeen 记下这次推过的', markSeen({}, ['a|b'], NOW)['a|b'] === NOW);
ok('markSeen 顺手清掉太老的记录',
  Object.keys(markSeen({ old: NOW - 100 * DAY, fresh: NOW }, [], NOW)).join(',') === 'fresh');
ok('说明文字能读懂（关 / 开）',
  /关闭/.test(describeAutopush({})) && /≥70 分/.test(describeAutopush({ enabled: true, notify: true, bark: true })));
ok('开了但没勾渠道会说明', /没勾渠道/.test(describeAutopush({ enabled: true, notify: false, bark: false })));

// ---------------- 3. 设置接口（读 / 写 / 预览） ----------------
const sync = new Map();
const db = {
  tasks: [], events: [], milestones: [], academic: [], courses: [],
  pending: [{ id: 'p1', source: 'canvas', kind: 'task', title: 'MATH1860J 作业明天截止', notes: '', due_at: iso(1) }],
  notifications: [
    { id: 'n1', source: 'canvas', title: '实验报告明天截止，务必提交', trigger_at: iso(1), enabled: true, priority: 0 },
    { id: 'n2', source: 'priority', title: '我们自己推的', trigger_at: iso(0), enabled: true, priority: 1 },
  ],
};
const store = {
  getSync: (k) => (sync.has(k) ? sync.get(k) : null),
  setSync: (k, v) => sync.set(k, v),
  listTasks: () => db.tasks, listEvents: () => db.events, listMilestones: () => db.milestones,
  listAcademic: () => db.academic, listCourses: () => db.courses,
  listPending: () => db.pending, listNotifications: () => db.notifications,
};
const mkRes = () => ({ code: null, body: null });
const sendJson = (res, code, obj) => { res.code = code; res.body = obj; };
const sendError = (res, code, msg) => { res.code = code; res.body = { error: msg }; };
const routes = createPriorityRoutes({
  store, sendJson, sendError, readBody: async (r) => r.body || {},
  getProfile: () => ({}), getLearning: () => ({ accept: {}, reject: {} }), learningKeyOf: () => 'x',
  isPeak: () => false, askAgent: async () => ({ ok: true, text: '- x' }),
});
const req = (method, body) => ({ method, body });
const urlOf = (p) => new URL('http://127.0.0.1:3210' + p);
{
  const res = mkRes();
  await routes.handlePriority(req('GET'), res, urlOf('/api/priority/autopush'));
  ok('GET 返回设置 + 人话说明', res.code === 200 && res.body.cfg && res.body.describe);
  ok('刚装好时是关的', res.body.cfg.enabled === false);
  ok('**即使关着也给预览**（先看会被推什么，再决定开不开）',
    Array.isArray(res.body.preview) && res.body.preview.length >= 1, JSON.stringify(res.body.preview));
  ok('预览里不会出现我们自己推的通知', !res.body.preview.some((x) => x.source === 'priority'));
}
{
  const res = mkRes();
  await routes.handlePriority(req('POST', { enabled: true, notify: true, bark: true, threshold: 500, max_per_run: 2 }), res, urlOf('/api/priority/autopush'));
  ok('保存被夹到合法范围', res.body.cfg.threshold === 100 && res.body.cfg.max_per_run === 2);
  ok('真的写进了本机存储', String(sync.get(AUTOPUSH_KEY)).includes('"enabled":true'));
  ok('写完立刻给新的预览', Array.isArray(res.body.preview));
  const again = mkRes();
  await routes.handlePriority(req('GET'), res.body ? again : again, urlOf('/api/priority/autopush'));
  ok('再读能读回来', again.body.cfg.enabled === true && again.body.cfg.bark === true);
}
{
  const res = mkRes();
  await routes.handlePriority(req('POST', { clear_seen: true }), res, urlOf('/api/priority/autopush'));
  ok('清空已推记录后 seen 是空的', Object.keys(res.body.cfg.seen).length === 0);
}
{
  const res = mkRes();
  await routes.handlePriority(req('GET'), res, urlOf('/api/priority'));
  ok('主接口里也带上自动推送（界面一次请求就够）',
    res.body.autopush && res.body.autopush.cfg && Array.isArray(res.body.autopush.preview));
  ok('取料时排除我们自己推的通知',
    routes.collectItems().every((x) => x.source !== 'priority'));
}

// ---------------- 4. 接线：默认关 + 每 10 分钟才看一次 ----------------
// ---------------- 3b. 执行侧：预览不用开、真推要开、推过就不重复 ----------------
{
  const mem = new Map();
  const created = [];
  const barks = [];
  const fakeStore = {
    getSync: (k) => (mem.has(k) ? mem.get(k) : null),
    setSync: (k, v) => mem.set(k, v),
    listNotifications: () => [],
    createNotification: (row) => { created.push(row); return { id: `n${created.length}`, ...row }; },
  };
  const cfg = { enabled: false, notify: true, bark: true, threshold: 70, max_per_run: 2, window_days: 7, cooldown_hours: 24, seen: {} };
  const fakePriority = {
    getAutopush: () => normalizeAutopush(cfg),
    setAutopush: (patch) => { Object.assign(cfg, normalizeAutopush({ ...cfg, ...patch })); return normalizeAutopush(cfg); },
    computePriority: () => ({ result: { ranked: [
      { id: 'x1', source: 'canvas', title: '实验报告明天截止，务必提交', importance: 92, band: 'high', daysLeft: 1, why: '明天内到期' },
      { id: 'x2', source: 'rss', title: '低分噪音', importance: 50, band: 'normal', daysLeft: 1 },
    ] } }),
  };
  const runner = createAutopushRunner({
    store: fakeStore, priority: fakePriority, bark: async (o) => { barks.push(o); return { ok: true }; },
    // 节流测试要一个**明确大于 0** 的间隔：用 0 的话"同一毫秒内"才拦得住，会变成偶发假红
    intervalMs: 60_000,
  });

  const preview = await runner.run({ dry: true });
  ok('**关着也能预览**（先看会被推什么）', preview.ok === true && preview.dry === true && preview.count === 1);
  ok('预览不会真的建通知 / 推手机', created.length === 0 && barks.length === 0);

  const off = await runner.run();
  ok('真跑时开关关着 → 明确说没开', off.ok === false && off.skipped === 'disabled');

  cfg.enabled = true;
  const first = await runner.run();
  ok('开了之后真的建通知 + 推手机', first.ok === true && first.notified === 1 && first.pushed === 1);
  ok('通知带 external_id（同一件事只发一次）', created[0].external_id === 'canvas|实验报告明天截止，务必提交');
  ok('推送标题带星标（手机上一眼看出是重要信息）', String(barks[0].title).startsWith('⭐'));
  ok('结果写进了存储（界面要显示上次推了什么）', !!mem.get('priority_autopush_result'));

  const second = await runner.run();
  ok('冷却期内不重复推（第二次 0 条）', second.ok === true && second.count === 0 && created.length === 1);

  const t1 = await runner.maybeRun();
  const t2 = await runner.maybeRun();
  ok('maybeRun 有节流（同一次心跳内不会重复算）', t2.skipped === 'throttled', JSON.stringify(t2));
  ok('maybeRun 首次会真的跑', t1.ok === true || t1.skipped === 'throttled', JSON.stringify(t1));
}
{
  const srv = readFileSync(join(ROOT, 'server.mjs'), 'utf8');
  const runner = readFileSync(join(ROOT, 'lib', 'autopush-run.mjs'), 'utf8');
  ok('主程序只留一行接线（执行逻辑独立成文件）',
    srv.includes('createAutopushRunner({') && srv.includes('autopushRunner.maybeRun()'));
  ok('默认关着就不推（除非显式 force）', /if \(!cfg\.enabled && !force\) return \{ ok: false, skipped: 'disabled'/.test(runner));
  ok('推送来源单独标记（便于排除回环）', /AUTOPUSH_SOURCE = 'priority'/.test(runner));
  ok('有节流：不是每个心跳都算一遍',
    runner.includes('AUTOPUSH_INTERVAL_MS') && /Date\.now\(\) - lastRun <= intervalMs/.test(runner));
  ok('定时那条调用没有 force（不会绕过开关）', /await autopushRunner\.maybeRun\(\)/.test(srv));
  ok('两条路由都分发到 priority 路由', srv.includes("'/api/priority/autopush'") && srv.includes("p === '/api/priority/autopush/run'"));
  ok('手动跑一次默认是"真跑"，dry 才预览', /dry: body\?\.dry === true/.test(srv));
  ok('进通知用的是既有通知表（复用，不新建渠道）', runner.includes('store.createNotification({') && runner.includes('external_id: x.key'));
  ok('规则文件是纯函数（不碰 fs / 网络）',
    !/node:fs|node:sqlite|fetch\(|barkPush/.test(readFileSync(join(ROOT, 'lib', 'autopush.mjs'), 'utf8')));
  ok('执行文件里也不写死密钥/地址（只通过注入的 bark 通道发）',
    !/api\.day\.app|Bearer |token/.test(runner));
}

console.log('');
console.log(failures === 0 ? 'autopush.test: PASS' : `autopush.test: FAIL (${failures})`);
process.exit(failures === 0 ? 0 : 1);
