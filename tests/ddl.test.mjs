// DDL 到点提醒的验证（D5）：引擎（lib/ddl.mjs）早就写好，这次验证**接上之后**的行为。
//
//   node tests/ddl.test.mjs

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { DDL_DEFAULT_STEPS, countdownText, nextStep, normalizeDdlPrefs, stepsDueNow } from '../lib/ddl.mjs';
import { DDL_PREFS_KEY, DDL_SEEN_KEY, createDdlStack, selectDdlReminders } from '../lib/ddl-stack.mjs';

let failures = 0;
const ok = (label, cond, detail = '') => {
  if (cond) console.log(`  PASS ${label}`);
  else { failures += 1; console.log(`  FAIL ${label}${detail ? ` -- ${detail}` : ''}`); }
};

console.log('ddl.test.mjs');
const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const H = 3600000;
const D = 86400000;

// ---------------- 1. 引擎（沿用原有纯函数，确认没被接歪） ----------------
ok('默认五档：7 天 / 3 天 / 1 天 / 3 小时 / 30 分钟',
  JSON.stringify(DDL_DEFAULT_STEPS) === JSON.stringify([7 * D, 3 * D, D, 3 * H, 30 * 60000]));
ok('倒计时说人话', countdownText(new Date(Date.now() + 2 * H).toISOString()).includes('小时'));
ok('计划里的档位是从近到远（界面显示"下一次提醒"用它）',
  (() => { const p = nextStep(new Date(Date.now() + 2 * D).toISOString()); return p && p.label.includes('天'); })());

// ---------------- 2. 找"现在该提醒谁" ----------------
const NOW = new Date(2026, 8, 24, 12, 0).getTime();
const iso = (ms) => new Date(ms).toISOString();
const tasks = [
  { id: 't1', title: '数学作业', status: 'todo', due_at: iso(NOW + D) },            // 正好"还剩 1 天"
  { id: 't2', title: '做完了的', status: 'done', due_at: iso(NOW + D) },
  { id: 't3', title: '没有截止时间', status: 'todo', due_at: null },
  { id: 't4', title: '三天后', status: 'todo', due_at: iso(NOW + 3 * D) },          // 正好"还剩 3 天"
  { id: 't5', title: '很远的', status: 'todo', due_at: iso(NOW + 30 * D) },
  { id: 't6', title: '还差一点才到档位', status: 'todo', due_at: iso(NOW + D + 5 * H) },
];
const prefs = normalizeDdlPrefs({});
{
  const due = selectDdlReminders(tasks, { prefs, now: NOW });
  const ids = due.map((d) => d.task.id);
  ok('到档位的挑出来：t1（还剩 1 天）、t4（还剩 3 天）',
    ids.includes('t1') && ids.includes('t4'), JSON.stringify(ids));
  ok('做完的不提醒', !ids.includes('t2'));
  ok('没有截止时间的不提醒', !ids.includes('t3'));
  ok('还没到档位的不提醒（t6 差 5 小时）', !ids.includes('t6'));
  ok('很远的（30 天）不提醒（默认档位最大 7 天）', !ids.includes('t5'));
  ok('每条都带"还剩多久"的人话与紧急度', due.every((d) => d.countdown && d.level));
  ok('去重键是"任务+档位"（同一档不会重复提醒）',
    due.find((d) => d.task.id === 't1').key === `ddl:t1:${D}`, JSON.stringify(due.find((d) => d.task.id === 't1').key));
}
ok('已经提醒过的档位不再出现',
  selectDdlReminders(tasks, { prefs, now: NOW, seen: { [`ddl:t1:${D}`]: NOW - 1000 } }).every((d) => d.task.id !== 't1'));
ok('补提醒窗口：电脑睡醒后 15 分钟内仍然算"刚该提醒"',
  stepsDueNow(iso(NOW + D), NOW + 10 * 60000, DDL_DEFAULT_STEPS).length === 1
  && stepsDueNow(iso(NOW + D), NOW + 20 * 60000, DDL_DEFAULT_STEPS).length === 0);

// ---------------- 3. 执行能力 + 接口 ----------------
const map = new Map();
const store = {
  getSync: (k) => map.get(k),
  setSync: (k, v) => map.set(k, v),
  listTasks: () => tasks,
};
const made = [];
const pushed = [];
const stack = createDdlStack({
  store, log: () => {}, now: () => NOW,
  notify: (n) => { made.push(n); return { id: 'n' + made.length }; },
  bark: async (o) => { pushed.push(o); return { ok: true }; },
  sendJson: (res, code, obj) => { res.code = code; res.body = obj; },
  sendError: (res, code, message) => { res.code = code; res.body = { error: message }; },
  readBody: async (req) => req.body || {},
});

{
  const r = await stack.maybeRun();
  ok('到档位就提醒：两条（1 天 / 3 天）', r.ok && r.fired === 2 && made.length === 2, JSON.stringify(r));
  ok('提醒文案是"还剩 X 天：任务名"', made[0].title.includes('还剩') && made[0].title.includes('数学作业'), made[0].title);
  ok('正文里有倒计时与截止时间', made[0].text.includes('小时') || made[0].text.includes('天'), made[0].text);
  ok('默认不推手机', pushed.length === 0);
  ok('"已提醒"记进同步表（跨重启有效）', Object.keys(stack.readSeen()).length === 2);
}
{
  const r = await stack.maybeRun();
  ok('再跑一次不会重复提醒（同一档只响一次）', r.fired === 0 && made.length === 2, JSON.stringify(r));
}
{
  stack.savePrefs({ bark: true });
  map.set(DDL_SEEN_KEY, JSON.stringify({}));               // 当作"从没提醒过"
  const r = await stack.maybeRun();
  ok('勾了手机推送才推，且只发一句话（≤60 字）',
    r.pushed === 2 && pushed.length === 2 && pushed.every((p) => p.body.length <= 60), JSON.stringify(pushed.map((p) => p.body)));
}
{
  stack.savePrefs({ enabled: false });
  map.set(DDL_SEEN_KEY, JSON.stringify({}));
  const r = await stack.maybeRun();
  ok('关掉之后什么都不做', r.ran === false && r.fired === 0 && r.reason.includes('关闭'));
}
{
  stack.savePrefs({ enabled: true });
  const req = (method, body) => ({ method, body });
  const urlOf = (p) => new URL('http://127.0.0.1:3210' + p);
  const res1 = {};
  await stack.handleDdl(req('GET'), res1, urlOf('/api/ddl'));
  ok('GET /api/ddl 给设置 + 接下来会提醒什么 + 已提醒条数',
    res1.code === 200 && res1.body.schema === 'ddl.v1' && Array.isArray(res1.body.upcoming) && res1.body.upcoming.length >= 3);
  ok('接下来的提醒里带着"下一次什么时候叫"',
    res1.body.upcoming.some((u) => u.next_step && u.next_step.label && typeof u.next_step.sent === 'boolean'));
  const res2 = {};
  await stack.handleDdl(req('POST', { prefs: { steps: [D, H], bark: false } }), res2, urlOf('/api/ddl'));
  ok('POST /api/ddl 改档位并回读（只剩 1 天 / 1 小时两档）',
    res2.code === 200 && res2.body.prefs.steps.length === 2 && res2.body.prefs.bark === false);
  const res3 = {};
  await stack.handleDdl(req('GET'), res3, urlOf('/api/ddl/别的'));
  ok('不认识的路径 → 404', res3.code === 404);
  const res4 = {};
  await stack.handleDdl(req('POST', {}), res4, urlOf('/api/ddl/reset'));
  ok('清空"已提醒"要显式确认（防手滑把提醒重放一遍）', res4.code === 400 && res4.body.error.includes('confirm'));
  const res5 = {};
  await stack.handleDdl(req('POST', { confirm: true }), res5, urlOf('/api/ddl/reset'));
  ok('确认后清空成功', res5.code === 200 && res5.body.reset === true && res5.body.seen_count === 0);
}
{
  const noNotify = createDdlStack({
    store, log: () => {}, now: () => NOW,
    sendJson: () => {}, sendError: () => {}, readBody: async () => ({}),
  });
  map.set(DDL_SEEN_KEY, JSON.stringify({}));
  const r = await noNotify.maybeRun();
  ok('没有"建通知"的能力时不崩，也不假装提醒过（fired=0，下次还能补）',
    r.ok === true && r.fired === 0 && Object.keys(noNotify.readSeen()).length === 0);
}

// ---------------- 4. 设置清洗 ----------------
ok('档位去重、从大到小、最多 8 档、太小太大都丢掉',
  (() => { const p = normalizeDdlPrefs({ steps: [H, H, 60000, 30 * 60000, 99999999999, 100] });
    return JSON.stringify(p.steps) === JSON.stringify([H, 30 * 60000, 60000]); })(),
  JSON.stringify(normalizeDdlPrefs({ steps: [H, H, 60000, 30 * 60000, 99999999999, 100] }).steps));
ok('默认开、默认不推手机', normalizeDdlPrefs({}).enabled === true && normalizeDdlPrefs({}).bark === false);

// ---------------- 5. 接线与卡片 ----------------
{
  const srv = readFileSync(join(ROOT, 'server.mjs'), 'utf8');
  ok('主程序接上了 DDL：接口 + 心跳里的任务',
    srv.includes('createDdlStack') && srv.includes("p.startsWith('/api/ddl/')") && srv.includes("name: 'ddl'"));
  ok('进的是既有通知表（source=ddl，external_id 用去重键）',
    readFileSync(join(ROOT, 'lib', 'ddl-stack.mjs'), 'utf8').includes("source: 'ddl'")
    && readFileSync(join(ROOT, 'lib', 'ddl-stack.mjs'), 'utf8').includes('external_id: key'));
  ok('主程序仍在行数护栏内', srv.split('\n').length < 2200, String(srv.split('\n').length));
}
{
  const view = await import(pathToFileURL(join(ROOT, 'modules', 'ddl-card', 'view.js')).href);
  ok('卡片导出纯函数 renderCard', typeof view.renderCard === 'function');
  const html = view.renderCard({
    prefs: { enabled: true, bark: false, steps: DDL_DEFAULT_STEPS },
    seen_count: 3,
    upcoming: [{ id: 't1', title: '数学作业', due_at: iso(NOW + D), countdown: '还有 1 天', level: 'soon', next_step: { at: NOW + D, label: '还剩 1 天', sent: false } }],
  });
  ok('卡片上有开关 / 五个档位 / 推手机 / 保存 / 试一次',
    ['ddl-enabled', 'ddl-save', 'ddl-check'].every((id) => html.includes(`id="${id}"`)));
  // 2026-09-28：档位与"推手机"这两项细项搬进了页头那颗 ⚙（P2「就地设置」推广）——
  // 卡片上只留一行指路，避免同一个设置写两处。这里改成钉住"搬进抽屉、且卡片不重复"。
  ok('卡片不再重复档位控件，而是指路到页头 ⚙ 功能设置',
    !html.includes('class="ddl-step"') && !html.includes('id="ddl-bark"')
    && html.includes('⚙ 功能设置'));
  {
    const drawer = view.renderSettings({ prefs: { enabled: true, bark: false, steps: DDL_DEFAULT_STEPS } });
    ok('抽屉里才有五个档位与推手机（选项表仍只有一份 STEP_CHOICES）',
      (drawer.match(/class="ddl-set-step"/g) || []).length === view.STEP_CHOICES.length
      && view.STEP_CHOICES.length === 5
      && drawer.includes('id="ddl-set-bark"') && drawer.includes('id="ddl-set-save"'));
  }
  ok('卡片会列出"接下来什么时候叫"', html.includes('数学作业') && html.includes('还剩 1 天'));
  ok('卡片说明里写清"做完的不再提醒"', html.includes('做完'));
}

console.log('');
console.log(failures === 0 ? 'ddl.test: PASS' : `ddl.test: FAIL (${failures})`);
process.exit(failures === 0 ? 0 : 1);
