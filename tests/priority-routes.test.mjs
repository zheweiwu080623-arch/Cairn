// 重要性接口的验证（含"agent 失败也要说人话"）。
//
//   node tests/priority-routes.test.mjs

import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  GOALS_KEY, buildAdvicePrompt, createPriorityRoutes, explainAgentFailure, extractAdviceText,
} from '../lib/routes/priority.mjs';

let failures = 0;
const ok = (label, cond, detail = '') => {
  if (cond) console.log(`  PASS ${label}`);
  else {
    failures += 1;
    console.log(`  FAIL ${label}${detail ? ` -- ${detail}` : ''}`);
  }
};

console.log('priority-routes.test.mjs');

const DAY = 86400000;
/**
 * 2026-09-27 修：这里以前把 NOW 钉死在 2026-09-22，于是"考试还有 3 天"这种夹具
 * 一到 09-26 之后就变成**过去的日期**，而接口那头算"考试临近"用的是真实当天 ⇒
 * 一到第二天这个套件就红（典型的"写死日期定时炸弹"）。现在 NOW = 真实当天，
 * 夹具全部相对它生成，跟哪天跑没关系。
 */
const NOW = (() => { const d = new Date(); d.setHours(10, 0, 0, 0); return d.getTime(); })();
const iso = (off, hour = 23) => { const d = new Date(NOW + off * DAY); d.setHours(hour, 0, 0, 0); return d.toISOString(); };
const dstr = (off) => { const d = new Date(NOW + off * DAY); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`; };

// ---------------- 替身 ----------------
const sync = new Map();
const db = {
  tasks: [{ id: 't1', title: 'MATH1860J 作业', status: 'todo', due_at: iso(1) }],
  events: [], milestones: [{ id: 'm1', title: '托福考试', target_at: dstr(20), done: 0 }],
  academic: [{ id: 'a1', kind: 'exam', title: '线性代数期中', start_at: dstr(3), end_at: dstr(3) }],
  courses: [{ id: 'c1', course: '线性代数', course_code: 'MATH1860J' }],
  pending: [{ id: 'p1', source: 'email', kind: 'task', title: '关于 MATH1860J 的通知', notes: '', due_at: iso(2) }],
  notifications: [
    { id: 'n1', source: 'canvas', title: '实验报告明天截止，务必提交', trigger_at: iso(1), enabled: true, priority: 0 },
    { id: 'n2', source: 'rss', title: '很久以前的旧公告', trigger_at: iso(-40), enabled: true, priority: 0 },   // 太旧 → 不该收
    { id: 'n3', source: 'canvas', title: '重要来源的旧提醒', trigger_at: iso(-40), enabled: true, priority: 1 }, // 重点来源 → 收
    { id: 'n4', source: 'rss', title: '已关掉的提醒', trigger_at: iso(0), enabled: false, priority: 0 },        // 关掉 → 不收
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

const routes = createPriorityRoutes({
  store, sendJson, sendError,
  readBody: async (req) => req.body || {},
  getProfile: () => ({ keywords: ['讲座'], courseCodes: ['MATH1860J'] }),
  getLearning: () => ({ accept: {}, reject: {} }),
  learningKeyOf: (row) => row.source || 'app',
  isPeak: () => false,
  askAgent: async () => ({ ok: true, text: '（假 agent 的回答）先做实验报告。', via: 'fake' }),
});
const req = (method, body) => ({ method, body });
const urlOf = (p) => new URL('http://127.0.0.1:3210' + p);

// ---------------- 1. 取料规则 ----------------
{
  const items = routes.collectItems();
  const ids = items.map((x) => x.id);
  ok('待批准条目会被收进来', ids.includes('pending:p1'));
  ok('窗口内的通知会被收进来', ids.includes('notification:n1'));
  ok('**40 天前的普通提醒不收**（避免被历史刷屏）', !ids.includes('notification:n2'));
  ok('重点来源即使旧也收', ids.includes('notification:n3'));
  ok('**关掉的提醒不收**', !ids.includes('notification:n4'));
  ok('每条都带 origin（界面要区分"没处理过"）', items.every((x) => x.origin));
}

// ---------------- 1b. 真库踩过的坑：通知太多时不能把"今天的"挤掉 ----------------
{
  // 复刻当时的情况：库里 295 条通知，listNotifications() 从旧到新返回，
  // 老的 150 条装满上限 → 今天/明天的条目整段消失（界面看起来"没有重要的事"）。
  const oldDays = Array.from({ length: 300 }, (_, i) => ({
    id: `old${i}`, source: 'email', title: `很久以前的邮件 ${i}`,
    trigger_at: new Date(Date.parse('2026-09-12T10:00:00Z') + i * 1000).toISOString(),
    enabled: true, priority: 1,   // 重点来源 → 不受时间窗口限制，正是它们把名额占满
  }));
  const today = {
    id: 'hot', source: 'app', title: '选 ENGR1010J Lab 组（先到先得，周五 23:59 截止）',
    trigger_at: iso(1, 9), enabled: true, priority: 1,
  };
  const bigStore = {
    ...store,
    listNotifications: () => [...oldDays, today],   // 新的在最后（和真实顺序一致）
    listPending: () => [],
  };
  const bigRoutes = createPriorityRoutes({
    store: bigStore, sendJson, sendError, readBody: async (r) => r.body || {},
    getProfile: () => ({ keywords: ['ENGR1010J'] }), getLearning: () => ({ accept: {}, reject: {} }),
    learningKeyOf: () => 'x', isPeak: () => false, askAgent: async () => ({ ok: true, text: '- x' }),
  });
  const got = bigRoutes.collectItems();
  ok('通知再多，今天的条目也在名单里', got.some((x) => /Lab 组/.test(x.title)), String(got.length));
  ok('名单长度仍受上限保护（不会爆）', got.length <= 200, String(got.length));
  const top = bigRoutes.computePriority().result.ranked;
  ok('而且它能排到前面（不会被旧邮件压住）',
    top.findIndex((x) => /Lab 组/.test(x.title)) >= 0 && top.findIndex((x) => /Lab 组/.test(x.title)) < 10,
    String(top.findIndex((x) => /Lab 组/.test(x.title))));
}

// ---------------- 2. 主接口 ----------------
{
  const res = mkRes();
  await routes.handlePriority(req('GET'), res, urlOf('/api/priority'));
  ok('200 且结构完整', res.code === 200 && res.body.schema === 'priority.v1'
    && res.body.context && res.body.counts && Array.isArray(res.body.ranked) && Array.isArray(res.body.advice));
  ok('上下文里报了"参考了什么"',
    Array.isArray(res.body.context.upcoming) && typeof res.body.context.horizonDays === 'number');
  ok('考试被识别出来', res.body.context.examSoon && res.body.context.examSoon.title === '线性代数期中');
  ok('排序结果带 band/why', res.body.ranked.every((x) => x.band && x.why));
  ok('最快的排在最前', res.body.ranked[0].daysLeft <= 2, JSON.stringify(res.body.ranked.map((x) => x.daysLeft)));
  ok('top 参数生效', (await (async () => { const r2 = mkRes(); await routes.handlePriority(req('GET'), r2, urlOf('/api/priority?top=2')); return r2.body.ranked.length; })()) <= 2);
}

// ---------------- 3. 规划读写 ----------------
{
  const res = mkRes();
  await routes.handlePriority(req('GET'), res, urlOf('/api/plan/goals'));
  ok('默认没有规划', res.code === 200 && res.body.goals.goals.length === 0);

  const save = mkRes();
  await routes.handlePriority(req('POST', { goals: ['11 月要考托福', '  ', '托福', 'GPA 上 3.8'] }), save, urlOf('/api/plan/goals'));
  ok('保存成功且去空去重', save.body.ok === true && save.body.goals.goals.length === 3, JSON.stringify(save.body.goals.goals));
  ok('写进了本机存储', String(sync.get(GOALS_KEY)).includes('托福'));
  ok('带了更新时间', save.body.goals.updated_at > 0);

  const again = mkRes();
  await routes.handlePriority(req('GET'), again, urlOf('/api/plan/goals'));
  ok('再读能读回来', again.body.goals.goals.length === 3);

  // 核心承诺：写了规划之后，"托福"相关条目的重要性应该**真的上升**
  const { scoreImportance } = await import('../lib/priority.mjs');
  const before = scoreImportance({ id: 'x', source: 'rss', title: '托福考试报名开始' }, routes.computePriority().context);
  db.pending.push({ id: 'p2', source: 'rss', kind: 'reminder', title: '托福考试报名开始', notes: '', due_at: null });
  const after = routes.computePriority().result.ranked.find((x) => x.id === 'pending:p2');
  ok('写了规划后，相关条目的重要性上升',
    after.importance > before.score, `${before.score} -> ${after && after.importance}`);
  ok('而且理由里点名了那条规划',
    after.reasons.some((r) => r.rule === 'plan-hit' && /托福/.test(r.label)), JSON.stringify(after.reasons));
  db.pending.pop();
}

// ---------------- 4. agent 建议（成功 / 高峰跳过 / 失败兜底） ----------------
{
  const res = mkRes();
  await routes.handlePriority(req('POST', {}), res, urlOf('/api/priority/advice'));
  ok('agent 成功时回 text 且标记来源', res.body.ok === true && res.body.advice_source === 'agent' && /实验报告/.test(res.body.text));
}
{
  const peakRoutes = createPriorityRoutes({
    store, sendJson, sendError, readBody: async (r) => r.body || {},
    getProfile: () => ({}), getLearning: () => ({}), learningKeyOf: () => 'x',
    isPeak: () => true,                      // 模拟高峰
    askAgent: async () => { throw new Error('不该被调用'); },
  });
  const res = mkRes();
  await peakRoutes.handlePriority(req('POST', {}), res, urlOf('/api/priority/advice'));
  ok('高峰时段不调用模型', res.body.ok === false && res.body.skipped === 'peak');
  ok('高峰时给的是规则版建议', res.body.advice_source === 'rules' && Array.isArray(res.body.advice));
  ok('并说明了原因', /高峰/.test(res.body.message));
}
{
  const badRoutes = createPriorityRoutes({
    store, sendJson, sendError, readBody: async (r) => r.body || {},
    getProfile: () => ({}), getLearning: () => ({}), learningKeyOf: () => 'x',
    isPeak: () => false,
    askAgent: async () => ({ ok: false, error: 'spawn codex ENOENT' }),
  });
  const res = mkRes();
  await badRoutes.handlePriority(req('POST', {}), res, urlOf('/api/priority/advice'));
  ok('agent 失败时回落到规则版', res.body.ok === false && res.body.advice_source === 'rules' && Array.isArray(res.body.advice));
  ok('失败说明说人话（不提 ENOENT）', !/ENOENT/.test(res.body.message) && /桌面版/.test(res.body.message), res.body.message);
}
{
  const boom = createPriorityRoutes({
    store, sendJson, sendError, readBody: async (r) => r.body || {},
    getProfile: () => ({}), getLearning: () => ({}), learningKeyOf: () => 'x',
    isPeak: () => false,
    askAgent: async () => { throw new Error('socket hang up'); },
  });
  const res = mkRes();
  await boom.handlePriority(req('POST', {}), res, urlOf('/api/priority/advice'));
  ok('agent 抛异常也不会 500', res.code === 200 && res.body.advice_source === 'rules');
}

// ---------------- 5. 失败解释器 ----------------
ok('ENOENT → 提示桌面版与替代路径', /桌面版/.test(explainAgentFailure('spawn codex ENOENT')));
ok('超时 → 提示稍后再试', /超时/.test(explainAgentFailure('ETIMEDOUT timeout')));
ok('没错误信息 → 通用提示', /规则版建议/.test(explainAgentFailure('')));
ok('其它错误 → 带上原文但截断', explainAgentFailure('奇怪错误'.repeat(60)).length < 220);
ok('解释里不出现原始的英文报错码', !/ENOENT/.test(explainAgentFailure('spawn codex ENOENT')));

// ---------------- 6. 提示词 ----------------
{
  const { context, result } = routes.computePriority();
  const p = buildAdvicePrompt({ context, result });
  ok('提示词里有未来规划段', p.includes('【他的未来规划】'));
  ok('提示词里有未来安排', p.includes('【未来 14 天的安排】'));
  ok('提示词里有排序后的信息', p.includes('【按重要性排过的信息'));
  ok('提示词明确要求"不要编造"', p.includes('不要编造'));
  ok('要求了字数上限', p.includes('200 字'));
  ok('要求了输出标记（便于只取结论）', p.includes('【建议】') && p.includes('【结束】'));
  ok('明确要求不要输出思考过程', /思考过程/.test(p));
  ok('空上下文也能拼出提示词', buildAdvicePrompt({}).includes('还没有写过规划'));
}

// ---------------- 6b. 只取结论（实测踩坑后新增） ----------------
{
  // 这是 2026-09-22 从 DeepSeek（经本机中转）拿到的**真实返回原文的节选**：
  // 它把思考过程也放在正文里，直接展示就是一堵墙。
  const REAL = [
    '我们需要回答中文，谨慎个人助理。必须只依据内容，不编造。总长度不超过200字，最多3条。',
    '我们需要分析未来规划空，14天安排。信息足够给建议？需要不超过200字，最多3条。',
    '可能的三条：',
    '1. 先写下连接器范围一页纸：若只自用则列出邮箱/Canvas权限，供0天后拍板。',
    '2. 明早09:00前确认国家安全教育计分班，只留一门，并检查第三轮选课。',
    '- 4天后选组前先查 ENGR1010J Lab Section 1 的冲突情况。',
    '总字数？ 第一约70，第二约60，第三约65 = 195。可以。',
  ].join('\n');
  const got = extractAdviceText(REAL);
  ok('从"思考墙"里只取出要点行', /连接器范围/.test(got) && /国家安全教育/.test(got) && /ENGR1010J/.test(got), got);
  ok('不包含思考句', !/总字数/.test(got) && !/我们需要/.test(got), got);
  ok('长度被压到合理范围', got.length <= 600, String(got.length));

  ok('有标记时取标记之间',
    extractAdviceText('【建议】\n- 先做 A\n- 再做 B\n【结束】\n（后面这些是多余的话）') === '- 先做 A\n- 再做 B');
  ok('标记不完整也能兜住', extractAdviceText('【建议】\n- 只有一条') === '- 只有一条');
  ok('没有要点行时剔除嘀咕行', !/我们需要/.test(extractAdviceText('我们需要回答用户。\n- 真的建议')));
  ok('全是嘀咕行就返回空（交给规则版兜底）',
    extractAdviceText('我们需要回答。总长度不超过200字。注意不要编造。') === '');
  ok('空输入返回空', extractAdviceText('') === '' && extractAdviceText(null) === '');
  ok('超长也会被截断', extractAdviceText('- ' + '长'.repeat(900)).length <= 600);
}

// ---------------- 7. 接线（不改变现有行为） ----------------
{
  const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
  const { readFileSync } = await import('node:fs');
  const srv = readFileSync(join(ROOT, 'server.mjs'), 'utf8');
  ok('server 接了三条件路由', srv.includes("p === '/api/priority'") && srv.includes("'/api/plan/goals'") && srv.includes("'/api/priority/advice'"));
  ok('没有改推送逻辑（pushItemToNotification 仍只由原逻辑决定）',
    srv.includes('function pushItemToNotification') && !/priorityRoutes[\s\S]{0,80}pushItemToNotification/.test(srv));
  ok('纯函数引擎单独成文件', readFileSync(join(ROOT, 'lib', 'priority.mjs'), 'utf8').includes('export function scoreImportance'));
}

console.log('');
console.log(failures === 0 ? 'priority-routes.test: PASS' : `priority-routes.test: FAIL (${failures})`);
process.exit(failures === 0 ? 0 : 1);
