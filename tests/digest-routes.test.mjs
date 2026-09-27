// 「日报 / 晚报」接口的验证（含推送失败要说人话、agent 兜底、母线不越界）。
//
//   node tests/digest-routes.test.mjs

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { createDigestRoutes, explainPushFailure } from '../lib/routes/digest.mjs';
import { createPriorityRoutes } from '../lib/routes/priority.mjs';
import { buildPlan } from '../lib/plan-export.mjs';

let failures = 0;
const ok = (label, cond, detail = '') => {
  if (cond) console.log(`  PASS ${label}`);
  else {
    failures += 1;
    console.log(`  FAIL ${label}${detail ? ` -- ${detail}` : ''}`);
  }
};

console.log('digest-routes.test.mjs');

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const DAY = 86400000;
// 锚点用**真实现在**：写死某一天的话，夹具里"未来"的条目会自然过期
// （2026-09-25 实测踩到：iso(1)/iso(2) 变成过去 ⇒ 「榜单里出现那条高重要性信息」整天空转失败）
const NOW = Date.now();
const iso = (off, hour = 23) => { const d = new Date(NOW + off * DAY); d.setHours(hour, 0, 0, 0); return d.toISOString(); };
const dstr = (off) => { const d = new Date(NOW + off * DAY); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`; };
// 「今天」要用**真实今天**：buildPlan 读的是系统日期，写死某一天会在跨零点后失效
const todayAt = (hour = 23) => { const d = new Date(); d.setHours(hour, 0, 0, 0); return d.toISOString(); };

// ---------------- 替身（和 priority-routes 同一套做法） ----------------
const sync = new Map();
const db = {
  tasks: [{ id: 't1', title: 'MATH1860J 作业', status: 'todo', due_at: todayAt(23) }],
  events: [{ id: 'e1', title: '班会', start_at: todayAt(18) }],
  milestones: [{ id: 'm1', title: '托福考试', target_at: dstr(20), done: 0 }],
  academic: [{ id: 'a1', kind: 'exam', title: '线性代数期中', start_at: dstr(3), end_at: dstr(3) }],
  courses: [{ id: 'c1', course: '线性代数', course_code: 'MATH1860J', weekday: new Date(NOW).getDay() }],
  pending: [{ id: 'p1', source: 'email', kind: 'task', title: '关于 MATH1860J 的通知', notes: '', due_at: iso(2) }],
  notifications: [
    { id: 'n1', source: 'canvas', title: '实验报告明天截止，务必提交', trigger_at: iso(1), enabled: true, priority: 0 },
  ],
};
const store = {
  getSync: (k) => (sync.has(k) ? sync.get(k) : null),
  setSync: (k, v) => sync.set(k, v),
  listTasks: () => db.tasks,
  listEvents: () => db.events,
  listMilestones: () => db.milestones,
  listAcademic: () => db.academic,
  listCourses: () => db.courses,
  listPending: () => db.pending,
  listNotifications: () => db.notifications,
};
const mkRes = () => ({ code: null, body: null });
const sendJson = (res, code, obj) => { res.code = code; res.body = obj; };
const sendError = (res, code, msg) => { res.code = code; res.body = { error: msg }; };
const readBody = async (req) => req.body || {};

function makePriority({ askAgent } = {}) {
  return createPriorityRoutes({
    store, sendJson, sendError, readBody,
    getProfile: () => ({ keywords: ['讲座'], courseCodes: ['MATH1860J'] }),
    getLearning: () => ({ accept: {}, reject: {} }),
    learningKeyOf: (row) => row.source || 'app',
    isPeak: () => false,
    askAgent: askAgent || (async () => ({ ok: true, text: '- 假建议' })),
  });
}

function makeDigest({ pushBark, isPeak = () => false, askAgent } = {}) {
  const pushed = [];
  const priority = makePriority({ askAgent });
  const routes = createDigestRoutes({
    store, sendJson, sendError, readBody,
    priority,
    getPlan: () => buildPlan(store, { days: 2 }),
    appName: () => 'Cairn',
    pushBark: pushBark || (async (o) => { pushed.push(o); return { ok: true, sent: 1 }; }),
    isPeak,
    askAgent: askAgent || (async () => ({ ok: true, text: '- 假建议', via: 'fake' })),
  });
  return { routes, pushed, priority };
}

const req = (method, body) => ({ method, body });
const urlOf = (p) => new URL('http://127.0.0.1:3210' + p);

// ---------------- 1. 看摘要 ----------------
{
  const { routes } = makeDigest();

  const auto = mkRes();
  await routes.handleDigest(req('GET'), auto, urlOf('/api/digest'));
  ok('200 且 schema 对', auto.code === 200 && auto.body.ok === true && auto.body.schema === 'digest.v1');
  ok('auto 会给一份早报或晚报',
    ['morning', 'evening'].includes(auto.body.kind) && auto.body.brief.text.includes('【最值得先看的'));
  ok('返回里带 text（前端直接显示）', auto.body.text === auto.body.brief.text);

  const m = mkRes();
  await routes.handleDigest(req('GET'), m, urlOf('/api/digest?kind=morning'));
  ok('指定早报 → 抬头是早报', m.body.kind === 'morning' && m.body.brief.text.startsWith('Cairn · 早报 ·'));
  ok('早报看今天', m.body.brief.text.includes('【今天的安排】'));

  const e = mkRes();
  await routes.handleDigest(req('GET'), e, urlOf('/api/digest?kind=evening'));
  ok('指定晚报 → 抬头是晚报', e.body.kind === 'evening' && e.body.brief.text.startsWith('Cairn · 晚报 ·'));
  ok('晚报看明天 + 讲今天进度',
    e.body.brief.text.includes('【明天的安排】') && e.body.brief.text.includes('【今天做完 / 没做完】'));

  const both = mkRes();
  await routes.handleDigest(req('GET'), both, urlOf('/api/digest?kind=both'));
  ok('both 一次给两份', !!both.body.briefs.morning && !!both.body.briefs.evening
    && both.body.briefs.morning.kind === 'morning' && both.body.briefs.evening.kind === 'evening');

  const bad = mkRes();
  await routes.handleDigest(req('GET'), bad, urlOf('/api/digest/nope'));
  ok('不认识的路径 404（不会静默成功）', bad.code === 404);
}

// ---------------- 2. 排序确实复用了同一套引擎 ----------------
{
  const { routes } = makeDigest();
  const res = mkRes();
  await routes.handleDigest(req('GET'), res, urlOf('/api/digest?kind=morning'));
  const brief = res.body.brief;
  ok('榜单里出现真数据里的那条高重要性信息', brief.text.includes('实验报告明天截止'));
  ok('榜单条数不超过 3', brief.top.length <= 3);
  ok('带上分档计数（界面要显示"参考了多少条"）',
    Number.isFinite(brief.counts.high) && Number.isFinite(brief.counts.normal) && Number.isFinite(brief.counts.low));
  ok('今天到期的任务进了"今天的安排"', brief.text.includes('[截止] MATH1860J 作业'));
}

// ---------------- 3. 推到手机 ----------------
{
  const { routes, pushed } = makeDigest();
  const res = mkRes();
  await routes.handleDigest(req('POST', { kind: 'morning' }), res, urlOf('/api/digest/push'));
  ok('推送成功回 ok + 推送内容', res.body.ok === true && res.body.sent && res.body.sent.title.includes('早报'));
  ok('推送正文是短的那份（不是整篇）', res.body.sent.body.length <= 200 && res.body.sent.body.includes('1. '));
  ok('确实调用了推送通道，且是显式动作', pushed.length === 1 && pushed[0].title.includes('早报'));
}
{
  const { routes } = makeDigest({ pushBark: async () => ({ ok: false, skipped: 'no-key' }) });
  const res = mkRes();
  await routes.handleDigest(req('POST', {}), res, urlOf('/api/digest/push'));
  ok('没配推送不会假装成功', res.body.ok === false);
  ok('没配推送时说清楚去哪儿配（不丢 skipped 代号）',
    /Bark 密钥/.test(res.body.error) && /手机通道/.test(res.body.error) && !/no-key/.test(res.body.error), res.body.error);
}
{
  const { routes } = makeDigest({ pushBark: async () => ({ ok: false, skipped: 'rate-limited' }) });
  const res = mkRes();
  await routes.handleDigest(req('POST', {}), res, urlOf('/api/digest/push'));
  ok('被限流时说人话（提到刷屏）', /刷屏/.test(res.body.error), res.body.error);
}
{
  const { routes } = makeDigest({ pushBark: async () => { throw new Error('socket hang up'); } });
  const res = mkRes();
  await routes.handleDigest(req('POST', {}), res, urlOf('/api/digest/push'));
  ok('推送抛异常也不会 500', res.code === 200 && res.body.ok === false && /socket hang up/.test(res.body.error));
}

// ---------------- 4. agent 建议（成功 / 高峰 / 失败 / 只有思考） ----------------
{
  const { routes } = makeDigest({ askAgent: async () => ({ ok: true, text: '【建议】\n- 今晚先写实验报告引言\n【结束】\n（多余的话）', via: 'fake' }) });
  const res = mkRes();
  await routes.handleDigest(req('POST', { kind: 'evening' }), res, urlOf('/api/digest/advice'));
  ok('agent 成功：只取结论、标记来源',
    res.body.ok === true && res.body.advice_source === 'agent'
    && res.body.text.includes('今晚先写实验报告引言') && !res.body.text.includes('【结束】'), res.body.text);
  ok('回话里带上这次是哪一份', res.body.kind === 'evening');
}
{
  let called = false;
  const { routes } = makeDigest({ isPeak: () => true, askAgent: async () => { called = true; return { ok: true, text: 'x' }; } });
  const res = mkRes();
  await routes.handleDigest(req('POST', {}), res, urlOf('/api/digest/advice'));
  ok('高峰不调用模型', called === false && res.body.ok === false && res.body.skipped === 'peak');
  ok('高峰回落规则版并说明原因',
    res.body.advice_source === 'rules' && Array.isArray(res.body.advice) && /高峰/.test(res.body.message));
}
{
  const { routes } = makeDigest({ askAgent: async () => ({ ok: false, error: 'spawn codex ENOENT' }) });
  const res = mkRes();
  await routes.handleDigest(req('POST', {}), res, urlOf('/api/digest/advice'));
  ok('agent 失败回落规则版', res.body.ok === false && res.body.advice_source === 'rules');
  ok('失败说明说人话（不提 ENOENT，提桌面版）',
    !/ENOENT/.test(res.body.message) && /桌面版/.test(res.body.message), res.body.message);
}
{
  const { routes } = makeDigest({ askAgent: async () => ({ ok: true, text: '我们需要回答用户。总长度不超过200字。注意不要编造。' }) });
  const res = mkRes();
  await routes.handleDigest(req('POST', {}), res, urlOf('/api/digest/advice'));
  ok('模型只吐思考过程时不硬塞给用户',
    res.body.ok === false && /思考过程/.test(res.body.message) && res.body.advice_source === 'rules');
}

// ---------------- 5. 失败解释器（单独可测） ----------------
ok('没配密钥 → 指向「手机通道」', /手机通道/.test(explainPushFailure({ ok: false, skipped: 'no-key' })));
ok('来源过滤 → 说明怎么放开', /来源/.test(explainPushFailure({ ok: false, skipped: 'source-filtered' })));
ok('限流 → 说"别刷屏"', /刷屏/.test(explainPushFailure({ ok: false, skipped: 'rate-limited' })));
ok('空值也有兜底文案', /没有再试|推送没有成功/.test(explainPushFailure(null)));
ok('其它错误会截断原文', explainPushFailure({ error: '坏'.repeat(300) }).length < 160);

// ---------------- 6. 接线与边界（不改变现有行为） ----------------
{
  const srv = readFileSync(join(ROOT, 'server.mjs'), 'utf8');
  ok('服务端引入了 routes/digest.mjs', srv.includes("from './lib/routes/digest.mjs'") && srv.includes('createDigestRoutes({'));
  ok('三条路径都被分发', srv.includes("p === '/api/digest'") && srv.includes("p.startsWith('/api/digest/')")
    && srv.includes('digestRoutes.handleDigest(req, res, url)'));
  ok('分发在静态资源之前（否则会被 SPA 兜底吞掉）',
    srv.indexOf('digestRoutes.handleDigest') < srv.indexOf('return serveStatic(req, res, p)'));
  // 这条原本靠"digestRoutes 附近 200 字内不出现 barkNotify"来判断；
  // 2026-09-23 把手机通道拆成 mobileRoutes 之后，两段接线挨在了一起 ⇒ 改成按**意图**断言：
  // ① 摘要模块自己不直接调推送（只能经注入的通道、且由用户点「推到手机」触发）；
  // ② 主程序里 digest 只走 handleDigest 这一个入口。
  const digestMod = readFileSync(join(ROOT, 'lib', 'routes', 'digest.mjs'), 'utf8');
  ok('日报/晚报没有偷偷接进推送链路',
    !/barkNotify\(/.test(digestMod) && !/pushItemToNotification/.test(digestMod)
    && srv.includes('digestRoutes.handleDigest(req, res, url)'));
  ok('原有那封定时邮件没被改动（正文仍是 buildDigestText，到点判断仍在）',
    readFileSync(join(ROOT, 'lib', 'mobile.mjs'), 'utf8').includes('buildDigestText(store, { days: 2')
    && srv.includes('await sendDueDigests(store, {'));
  ok('摘要引擎是纯函数文件（不碰 fs / 数据库 / 网络）',
    !/node:fs|node:sqlite|fetch\(/.test(readFileSync(join(ROOT, 'lib', 'digest.mjs'), 'utf8')));
}

console.log('');
console.log(failures === 0 ? 'digest-routes.test: PASS' : `digest-routes.test: FAIL (${failures})`);
process.exit(failures === 0 ? 0 : 1);
