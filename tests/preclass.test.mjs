// 「上课前 Canvas 检查」的验证：纯函数（周次/时间窗/signal）+ 功能 + 调度 + 接口 + 接线。
//
//   node tests/preclass.test.mjs

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  PRECLASS_DEFAULT, buildSignal, courseCodeOf, dateKeyOf, describeCheck, meetsOn, normalizePreclass,
  parseWeeks, sessionStartAt, upcomingSessions, weekNumber, weekdayOf,
} from '../lib/preclass.mjs';
import { createSeenStore, createPreclassRunner } from '../lib/preclass-run.mjs';
import { createPreclassRoutes } from '../lib/routes/preclass.mjs';
import { scanModules } from '../lib/modules.mjs';

let failures = 0;
const ok = (label, cond, detail = '') => {
  if (cond) console.log(`  PASS ${label}`);
  else {
    failures += 1;
    console.log(`  FAIL ${label}${detail ? ` -- ${detail}` : ''}`);
  }
};

console.log('preclass.test.mjs');

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

// ---------------- 1. 纯函数：周次 / 星期 / 时间窗 ----------------
ok('周次解析：区间 / 列举 / 混合',
  JSON.stringify(parseWeeks('1-3')) === '[1,2,3]'
  && JSON.stringify(parseWeeks('1,3,5')) === '[1,3,5]'
  && JSON.stringify(parseWeeks('1-3,7')) === '[1,2,3,7]'
  && parseWeeks('') === null && parseWeeks('没写') === null);
{
  // 2026-09-14 是周一（学期第 1 周起点）
  const term = '2026-09-14';
  // 2026-09-28：这里的时间一律用**本地时间**构造（`new Date(2026, 8, 14, 12)`）。
  // 以前写的是 '2026-09-14T12:00:00+08:00' —— 那是个**绝对时刻**，只有在 +08 的机器上
  // 本地小时数才是 12。GitHub 的 runner 跑在 UTC，于是"09:40 的课"变成了"01:40"，
  // 整组断言假失败（还顺带把 [0].courseCode 崩掉）。本地构造在哪个时区都成立。
  ok('第 1 周算得对', weekNumber(new Date(2026, 8, 14, 12), term) === 1);
  ok('第 2 周算得对', weekNumber(new Date(2026, 8, 21, 12), term) === 2);
  ok('没有学期起点就返回 null', weekNumber(new Date(), null) === null);
  ok('星期几是 1-7（周一=1）', weekdayOf(new Date(2026, 8, 14, 12)) === 1
    && weekdayOf(new Date(2026, 8, 19, 12)) === 6
    && weekdayOf(new Date(2026, 8, 20, 12)) === 7);
  const oddWeek = { weekday: 5, weeks: '1,3,5,7', start_at: '10:00' };
  ok('单双周：第 1 周上、第 2 周不上',
    meetsOn(oddWeek, new Date(2026, 8, 18, 9), term) === true      // 9/18 是第 1 周周五
    && meetsOn(oddWeek, new Date(2026, 8, 25, 9), term) === false); // 第 2 周周五
  ok('没写 weeks = 每周都上', meetsOn({ weekday: 5 }, new Date(2026, 8, 25, 9), term) === true);
  ok('星期不对就不上', meetsOn({ weekday: 1, weeks: '1-13' }, new Date(2026, 8, 25, 9), term) === false);
}
ok('课程代码能从名字里抠出来',
  courseCodeOf({ course: '高等数学B1 · Honors Mathematics II MATH1860J' }) === 'MATH1860J'
  && courseCodeOf({ course_code: 'ENGR1010J' }) === 'ENGR1010J');
{
  const base = new Date(2026, 8, 23, 9, 40);   // 本地 09:40（下面 10:00 的课还差 20 分钟）
  const c = { weekday: weekdayOf(base), start_at: '10:00', weeks: '1-16', course: '示例课 DEMO1010J', location: '东中院' };
  const got = upcomingSessions([c], { now: base.getTime(), leadMinutes: 30, termStart: '2026-09-14' });
  ok('20 分钟后上课 → 命中', got.length === 1 && got[0].minutesLeft === 20, JSON.stringify(got.map((x) => x.minutesLeft)));
  ok('命中的课带齐信息（课号/地点/日期键/检查键）',
    !!got[0] && got[0].courseCode === 'DEMO1010J' && got[0].location === '东中院'
    && !!got[0].dateKey && /^preclass:/.test(got[0].key));
  const later = upcomingSessions([c], { now: base.getTime(), leadMinutes: 10, termStart: '2026-09-14' });
  ok('不在窗口内（还差 20 分钟 > 提前 10 分钟）→ 不命中', later.length === 0);
  const past = upcomingSessions([c], { now: new Date(2026, 8, 23, 10, 5).getTime(), leadMinutes: 30, termStart: '2026-09-14' });
  ok('已经开始了 → 不再检查', past.length === 0);
  const checked = upcomingSessions([c], { now: base.getTime(), leadMinutes: 30, termStart: '2026-09-14', checked: [got[0].key] });
  ok('今天已经查过这节课 → 跳过（一节课只查一次）', checked.length === 0);
  ok('没写 start_at 的课不会崩', upcomingSessions([{ weekday: weekdayOf(base), course: 'X DEMO1010J' }], { now: base.getTime() }).length === 0);
}
{
  const s = { key: 'preclass:DEMO1010J:2026-09-23:10:00', courseCode: 'DEMO1010J', courseName: '示例课', startAt: '2026-09-23T02:00:00.000Z', minutesLeft: 20, dateKey: '2026-09-23', location: '东中院', course: {} };
  const sig = buildSignal(s, { now: new Date(2026, 8, 23, 9, 40).getTime(), sinceMs: 0 });
  ok('signal 形状符合契约（schema/item_id/band/verdict 都有）',
    sig.schema === 'signal.v1' && !!sig.item_id && sig.band === 'high' && sig.verdict === 'push');
  ok('signal 解释了"为什么现在"', sig.reasons.some((r) => r.rule === 'class-soon'));
  ok('meta 里带了功能需要的全部信息',
    sig.meta.courseCode === 'DEMO1010J' && sig.meta.minutesLeft === 20 && typeof sig.meta.sinceMs === 'number');
}
ok('设置清洗：提前分钟被夹在 5–180',
  normalizePreclass({ lead_minutes: 999 }).lead_minutes === 180
  && normalizePreclass({ lead_minutes: 1 }).lead_minutes === 5
  && normalizePreclass({}).enabled === PRECLASS_DEFAULT.enabled);
ok('检查结果能说成人话',
  /没有新东西/.test(describeCheck({ courseName: '示例课', minutesLeft: 20, fresh: [] }))
  && /2 条新东西/.test(describeCheck({ courseName: '示例课', minutesLeft: 20, fresh: [{ type: 'file' }, { type: 'page' }] }))
  && /没成功/.test(describeCheck({ courseName: '示例课', error: '网络不通' })));

// ---------------- 2. 功能：有新报新、没新就安静 ----------------
const processor = await import('../modules/preclass-check/run.js');
function fakeDedupe() {
  const seen = new Set();
  return {
    filterNew: (items) => items.filter((i) => !seen.has(`${i.type}:${i.id}`)),
    markSeen: (items) => items.forEach((i) => seen.add(`${i.type}:${i.id}`)),
    size: () => seen.size,
  };
}
const signalBase = {
  meta: { courseCode: 'DEMO1010J', courseName: '示例课', minutesLeft: 25, dateKey: '2026-09-23', sinceMs: 0 },
};
{
  const dedupe = fakeDedupe();
  const check = { ok: true, course: { name: '示例课 · DEMO1010J' }, items: [{ type: 'file', id: 'f1', title: 'Week4 题单.pdf' }, { type: 'page', id: 'p1', title: '第 4 周' }] };
  const actions = await processor.run(signalBase, { canvas: { checkCourse: () => check }, dedupe, prefs: () => ({ bark: false }), log: () => {} });
  ok('有新东西 → 一条应用内通知', actions.length === 1 && actions[0].type === 'notify');
  ok('提醒里写清课号与分钟数', /DEMO1010J/.test(actions[0].summary) && /25/.test(actions[0].summary), actions[0].summary);
  ok('通知正文带前几条标题', /Week4 题单\.pdf/.test(actions[0].payload.text));
  ok('没勾手机推送 → 不产 push 动作', !actions.some((a) => a.type === 'push'));
  ok('报过之后记指纹（下次不再报）', dedupe.size() === 2);
  const again = await processor.run(signalBase, { canvas: { checkCourse: () => check }, dedupe, prefs: () => ({ bark: false }), log: () => {} });
  ok('同样两条再来一次 → 安静（0 条动作）', again.length === 0);
}
{
  const quiet = await processor.run(signalBase, { canvas: { checkCourse: () => ({ ok: true, items: [] }) }, dedupe: fakeDedupe(), prefs: () => ({}), log: () => {} });
  ok('没有新东西 → 0 条动作（不打扰）', quiet.length === 0);
  const failed = await processor.run(signalBase, { canvas: { checkCourse: () => ({ ok: false, error: '网络不通' }) }, dedupe: fakeDedupe(), prefs: () => ({}), log: () => {} });
  ok('查不到（网络/无权限）→ 也不打扰', failed.length === 0);
  const boom = await processor.run(signalBase, { canvas: { checkCourse: () => { throw new Error('炸了'); } }, dedupe: fakeDedupe(), prefs: () => ({}), log: () => {} });
  ok('检查抛异常 → 安静返回（不 500）', boom.length === 0);
  const noCap = await processor.run(signalBase, { log: () => {} });
  ok('没有 canvas 能力 → 安静返回', noCap.length === 0);
  const push = await processor.run(signalBase, {
    canvas: { checkCourse: () => ({ ok: true, items: [{ type: 'file', id: 'x', title: 'x' }] }) },
    dedupe: fakeDedupe(), prefs: () => ({ bark: true }), log: () => {},
  });
  ok('勾了手机推送 → 多一条 push，且是短句',
    push.length === 2 && push[1].type === 'push' && push[1].payload.push.length <= 60);
}

// ---------------- 3. 调度：一节课只查一次 + 节流 ----------------
{
  const mem = new Map();
  const store = { getSync: (k) => (mem.has(k) ? mem.get(k) : null), setSync: (k, v) => mem.set(k, v) };
  const seen = createSeenStore(store, { key: 'seen_test' });
  ok('seen：第一次是新的，标记后就不再新',
    seen.filterNew([{ type: 'file', id: '1' }], { scope: 'X' }).length === 1
    && (seen.markSeen([{ type: 'file', id: '1' }], { scope: 'X' }), seen.filterNew([{ type: 'file', id: '1' }], { scope: 'X' }).length === 0));
  ok('seen：不同课程互不影响', seen.filterNew([{ type: 'file', id: '1' }], { scope: 'Y' }).length === 1);

  const calls = [];
  const nowMs = new Date(2026, 8, 23, 9, 40).getTime();   // 本地 09:40（同上：不用 +08:00 的绝对时刻）
  const courses = [{ weekday: weekdayOf(new Date(nowMs)), start_at: '10:00', weeks: '1-16', course: '示例课 DEMO1010J', location: '东中院' }];
  let clock = nowMs;
  const runner = createPreclassRunner({
    store, courses: () => courses, termStart: () => '2026-09-14',
    runModule: async (id, opts) => { calls.push([id, opts.dryRun, opts.input.meta.courseCode]); return { ok: true, actions: [{ type: 'notify' }], summary: '1 条动作' }; },
    intervalMs: 0, now: () => clock, log: () => {}, warn: () => {},
  });
  const first = await runner.maybeRun();
  ok('到点会跑这门课的再处理功能（真跑，不是演练）', calls.length === 1 && calls[0][0] === 'preclass-check' && calls[0][1] === false);
  ok('返回里报告了跑过哪节课', first.checked === 1 && first.results[0].courseCode === 'DEMO1010J');
  clock += 1000;
  const second = await runner.maybeRun();
  ok('同一节课不会重复检查（记了"已检查"）', second.checked === 0, JSON.stringify(second));
  const upcoming = runner.upcoming();
  ok('界面用的 upcoming() 会标出"这节课查过没有"', upcoming.length === 1 && upcoming[0].checked === true);
  mem.set('preclass_prefs_json', JSON.stringify({ enabled: false }));
  clock += 1000;
  const disabled = await runner.maybeRun();
  ok('关掉开关 → 直接跳过', disabled.skipped === 'disabled');
}

// ---------------- 4. 接口 + 接线 ----------------
{
  const mem = new Map();
  const store = { getSync: (k) => (mem.has(k) ? mem.get(k) : null), setSync: (k, v) => mem.set(k, v) };
  const routes = createPreclassRoutes({
    store,
    sendJson: (res, code, obj) => { res.code = code; res.body = obj; },
    sendError: (res, code, msg) => { res.code = code; res.body = { error: msg }; },
    readBody: async (r) => r.body || {},
    runner: { upcoming: () => [{ courseCode: 'DEMO1010J', minutesLeft: 20, checked: false }] },
    runsOf: () => ({ at: '2026-09-23T01:40:00.000Z', summary: '1 条动作' }),
  });
  const mkRes = () => ({ code: null, body: null });
  const res = mkRes();
  await routes.handlePreclass({ method: 'GET' }, res, new URL('http://x/api/preclass'));
  ok('GET /api/preclass 给设置 + 接下来要上的课 + 上次运行',
    res.code === 200 && !!res.body.prefs && Array.isArray(res.body.upcoming) && !!res.body.last);
  const saved = mkRes();
  await routes.handlePreclass({ method: 'POST', body: { prefs: { lead_minutes: 999, bark: true } } }, saved, new URL('http://x/api/preclass'));
  ok('POST 会清洗设置（999 → 180）并回读', saved.body.prefs.lead_minutes === 180 && saved.body.prefs.bark === true);
  const again = mkRes();
  await routes.handlePreclass({ method: 'GET' }, again, new URL('http://x/api/preclass'));
  ok('设置真的存下来了', again.body.prefs.bark === true);
}
{
  const mods = scanModules(join(ROOT, 'modules'));
  const proc = mods.find((m) => m.id === 'preclass-check');
  const card = mods.find((m) => m.id === 'preclass-card');
  ok('功能模块被正确发现（processor + entry.run）',
    !!proc && !proc.error && proc.kind === 'processor' && proc.entry.run === 'run.js');
  ok('卡片模块被正确发现（gadget 挂今日页）',
    !!card && !card.error && card.kind === 'gadget' && card.mount_into === 'today');
  const view = await import('../modules/preclass-card/view.js');
  ok('卡片导出纯函数 renderCard', typeof view.renderCard === 'function' && typeof view.renderSession === 'function');
  const html = view.renderCard({
    prefs: { enabled: true, lead_minutes: 30, notify_in_app: true, bark: false, since_hours: 48 },
    upcoming: [{ courseCode: 'DEMO1010J', courseName: '示例课', minutesLeft: 20, checked: false, location: '东中院' }],
    last: { at: '2026-09-23T01:40:00.000Z', summary: '1 条动作' },
  });
  ok('卡片显示"还有几分钟上课"与课号', html.includes('20 分钟后上课') && html.includes('DEMO1010J'));
  ok('卡片有四个设置 + 三颗按钮',
    ['pc-lead', 'pc-enabled', 'pc-notify', 'pc-bark', 'pc-since', 'pc-save', 'pc-dry', 'pc-run'].every((id) => html.includes(`id="${id}"`)));
  ok('没有课时给出友好提示', view.renderCard({ prefs: {}, upcoming: [] }).includes('接下来没有马上要上的课'));

  const srv = readFileSync(join(ROOT, 'server.mjs'), 'utf8');
  ok('主程序接了 preclass 接口与心跳',
    srv.includes("if (p === '/api/preclass') return preclass.routes.handlePreclass(req, res, url);")
    && srv.includes('preclass.runner.maybeRun()'));
  // 2026-09-25（M1 · S4）：extraContext 从"主程序里手写合并"改成"能力宿主按登记表装配"，
  // 所以这条断言改成看新接线 —— 仍然钉住"preclass 的接线收在 stack 里、主程序只留几行"。
  ok('接线被收进 lib/preclass-stack.mjs（主程序只留宿主那几行）',
    srv.includes("from './lib/preclass-stack.mjs'")
    && srv.includes('preclass: () => preclass.extraContext()')
    && /extraContext: \(mod\) => capabilityHost\.extraContext\(mod\)/.test(srv));
  ok('Canvas 检查是只读的（文件里没有 POST/PUT 到 Canvas）',
    !/method:\s*'POST'/.test(readFileSync(join(ROOT, 'lib', 'canvas-check.mjs'), 'utf8')));
}

console.log('');
console.log(failures === 0 ? 'preclass.test: PASS' : `preclass.test: FAIL (${failures})`);
process.exit(failures === 0 ? 0 : 1);
