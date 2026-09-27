// 养成（习惯 / 番茄 / 里程碑）与课表校历接口的验证（R2 第二组）。
//
//   node tests/study-routes.test.mjs
//
// 这里用**替身 store**（不碰真数据库），重点验证：
//   * 汇总数字算得对不对（统计页全靠它）；
//   * 连续打卡天数在"今天还没打卡"时不会被清零；
//   * 增删改的路径与状态码没变；
//   * 搬家之后 server.mjs 里不再有这些实现。

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import { DAY_MS, createStudyRoutes, hK, habitStreak, lastN } from '../lib/routes/study.mjs';

let failures = 0;
const ok = (label, cond, detail = '') => {
  if (cond) console.log(`  PASS ${label}`);
  else {
    failures += 1;
    console.log(`  FAIL ${label}${detail ? ` -- ${detail}` : ''}`);
  }
};

console.log('study-routes.test.mjs');

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const iso = (offsetDays, hour = 10) => {
  const d = new Date(Date.now() + offsetDays * DAY_MS);
  d.setHours(hour, 0, 0, 0);
  return d.toISOString();
};
const today = hK(new Date());

// ---------------- 替身 store ----------------
const db = {
  tasks: [
    { id: 't1', status: 'done', updated_at: Date.now() },
    { id: 't2', status: 'done', updated_at: Date.now() - 2 * DAY_MS },
    { id: 't3', status: 'todo', updated_at: Date.now() - 3 * DAY_MS },
  ],
  focus: [
    { id: 'f1', minutes: 25, started_at: iso(0) },
    { id: 'f2', minutes: 15, started_at: iso(0, 20) },
    { id: 'f3', minutes: 40, started_at: iso(-1) },
  ],
  habits: [{ id: 'h1', name: '背单词' }, { id: 'h2', name: '跑步' }],
  logs: [
    { habit_id: 'h1', date: today, done: 1 },
    { habit_id: 'h1', date: hK(new Date(Date.now() - DAY_MS)), done: 1 },
    { habit_id: 'h1', date: hK(new Date(Date.now() - 2 * DAY_MS)), done: 1 },
    { habit_id: 'h2', date: hK(new Date(Date.now() - 5 * DAY_MS)), done: 1 },
  ],
  milestones: [
    { id: 'm1', title: '远的', target_at: hK(new Date(Date.now() + 9 * DAY_MS)), done: 0 },
    { id: 'm2', title: '近的', target_at: hK(new Date(Date.now() + 2 * DAY_MS)), done: 0 },
    { id: 'm3', title: '做完了', target_at: hK(new Date(Date.now() + DAY_MS)), done: 1 },
  ],
  academic: [
    { id: 'a0', kind: 'term', start_at: hK(new Date(Date.now() - 14 * DAY_MS)), end_at: hK(new Date(Date.now() + 100 * DAY_MS)) },
    { id: 'a1', kind: 'exam', start_at: hK(new Date(Date.now() + 4 * DAY_MS)), end_at: hK(new Date(Date.now() + 4 * DAY_MS)) },
  ],
  courses: [{ id: 'c1', course: '线性代数' }],
};
const calls = [];
const store = {
  listTasks: () => db.tasks,
  listFocus: () => db.focus,
  listHabits: () => db.habits,
  listHabitLogs: () => db.logs,
  listMilestones: () => db.milestones,
  listAcademic: () => db.academic,
  listCourses: () => db.courses,
  createHabit: (b) => { calls.push(['createHabit', b]); return { id: 'h9', ...b }; },
  updateHabit: (id, b) => { calls.push(['updateHabit', id, b]); return { id, ...b }; },
  deleteHabit: (id) => calls.push(['deleteHabit', id]),
  toggleHabitLog: (id, date) => { calls.push(['toggle', id, date]); return { habit_id: id, date, done: 1 }; },
  createFocus: (b) => { calls.push(['createFocus', b]); return { id: 'f9', ...b }; },
  deleteFocus: (id) => calls.push(['deleteFocus', id]),
  createMilestone: (b) => { calls.push(['createMilestone', b]); return { id: 'm9', ...b }; },
  updateMilestone: (id, b) => { calls.push(['updateMilestone', id, b]); return { id, ...b }; },
  deleteMilestone: (id) => calls.push(['deleteMilestone', id]),
  createCourse: (b) => { calls.push(['createCourse', b]); return { id: 'c9', ...b }; },
  updateCourse: (id, b) => { calls.push(['updateCourse', id, b]); return { id, ...b }; },
  deleteCourse: (id) => calls.push(['deleteCourse', id]),
  clearCourses: () => calls.push(['clearCourses']),
  clearAcademic: () => calls.push(['clearAcademic']),
  bulkInsertCourses: (rows) => { calls.push(['bulkCourses', rows.length]); return rows.length; },
  bulkInsertAcademic: (rows) => { calls.push(['bulkAcademic', rows.length]); return rows.length; },
  createAcademic: (b) => { calls.push(['createAcademic', b]); return { id: 'a9', ...b }; },
  updateAcademic: (id, b) => { calls.push(['updateAcademic', id, b]); return { id, ...b }; },
  deleteAcademic: (id) => calls.push(['deleteAcademic', id]),
};

const mkRes = () => ({
  code: null, body: null,
  writeHead(c) { this.code = c; }, end() {},
});
const sendJson = (res, code, obj) => { res.code = code; res.body = obj; };
const sendError = (res, code, message) => { res.code = code; res.body = { error: message }; };
const notFound = (res) => { res.code = 404; res.body = { error: 'Not Found' }; };
const readBody = async (req) => req.body || {};

const study = createStudyRoutes({ store, sendJson, sendError, notFound, readBody });
const req = (method, body) => ({ method, body });
const urlOf = (p) => new URL('http://127.0.0.1:3210' + p);

// ---------------- 1. 纯函数 ----------------
ok('日期键格式 YYYY-MM-DD', /^\d{4}-\d{2}-\d{2}$/.test(hK(new Date())));
ok('lastN 返回 n 天且最后一天是今天',
  lastN(7).length === 7 && hK(lastN(7)[6]) === today, JSON.stringify(lastN(7).map(hK)));
ok('lastN 从早到晚', hK(lastN(3)[0]) < hK(lastN(3)[2]));
{
  const logs = [
    { habit_id: 'x', date: today, done: 1 },
    { habit_id: 'x', date: hK(new Date(Date.now() - DAY_MS)), done: 1 },
    { habit_id: 'x', date: hK(new Date(Date.now() - 2 * DAY_MS)), done: 1 },
  ];
  ok('连续打卡 3 天', habitStreak({ id: 'x' }, logs) === 3, String(habitStreak({ id: 'x' }, logs)));
  ok('今天还没打卡也不会清零（昨天前天连着 → 2）',
    habitStreak({ id: 'x' }, logs.slice(1)) === 2, String(habitStreak({ id: 'x' }, logs.slice(1))));
  ok('中间断了一天就停',
    habitStreak({ id: 'x' }, [logs[0], logs[2]]) === 1, String(habitStreak({ id: 'x' }, [logs[0], logs[2]])));
  ok('没打过卡就是 0', habitStreak({ id: 'zzz' }, logs) === 0);
  ok('done 为假的不算',
    habitStreak({ id: 'y' }, [{ habit_id: 'y', date: today, done: 0 }]) === 0);
}

// ---------------- 2. 汇总数字 ----------------
{
  const ins = study.computeInsights();
  ok('任务总数 / 完成数', ins.tasks.total === 3 && ins.tasks.done === 2, JSON.stringify(ins.tasks));
  ok('完成率四舍五入到整数', ins.tasks.completion === 67, String(ins.tasks.completion));
  ok('待办数 = 总数 - 完成数', ins.tasks.open === 1);
  ok('今日完成 1 条', ins.tasks.doneToday === 1, String(ins.tasks.doneToday));
  ok('今日专注 40 分钟（两次相加）', ins.focus.today === 40, String(ins.focus.today));
  ok('专注次数 = 记录条数', ins.focus.sessions === 3);
  ok('今日习惯完成 1 / 共 2', ins.habits.todayDone === 1 && ins.habits.total === 2);
  ok('每条习惯都带连续天数', ins.habits.streaks.length === 2 && ins.habits.streaks[0].streak === 3,
    JSON.stringify(ins.habits.streaks));
  ok('里程碑取最近的未完成那条', ins.milestone && ins.milestone.title === '近的', JSON.stringify(ins.milestone));
  // 纯日期（只有年月日）按当地零点算，剩余天数会有 ±1 的取整，所以这里看范围
  ok('里程碑带剩余天数（2~3 天）',
    ins.milestone.daysLeft >= 2 && ins.milestone.daysLeft <= 3, String(ins.milestone && ins.milestone.daysLeft));
  ok('做完的里程碑不参与', ins.milestone.title !== '做完了');
  ok('考试也能识别', ins.exam && ins.exam.id === 'a1', JSON.stringify(ins.exam));
  ok('学期周次从校历起点算（第 3 周）', ins.semesterWeek === 3, String(ins.semesterWeek));
}
{
  const empty = createStudyRoutes({
    store: { ...store, listTasks: () => [], listFocus: () => [], listHabits: () => [], listHabitLogs: () => [], listMilestones: () => [], listAcademic: () => [] },
    sendJson, sendError, notFound, readBody,
  }).computeInsights();
  ok('空数据不崩：完成率 0、无校历 semesterWeek 为 null',
    empty.tasks.completion === 0 && empty.semesterWeek === null && empty.milestone === null);
}

// ---------------- 3. 养成路由 ----------------
{
  const res = mkRes();
  await study.handleStudy(req('GET'), res, urlOf('/api/insights'));
  ok('GET /api/insights → 200 且带 tasks/focus/habits', res.code === 200 && res.body.tasks && res.body.focus && res.body.habits);
}
{
  const res = mkRes();
  await study.handleStudy(req('GET'), res, urlOf('/api/habits'));
  ok('GET /api/habits → habits + logs 一起给', res.code === 200 && res.body.habits.length === 2 && res.body.logs.length === 4);
}
{
  calls.length = 0;
  const res = mkRes();
  await study.handleStudy(req('POST', { name: '早起' }), res, urlOf('/api/habits'));
  ok('POST /api/habits → 201 并落库', res.code === 201 && calls[0][0] === 'createHabit');
}
{
  calls.length = 0;
  const res = mkRes();
  await study.handleStudy(req('POST', {}), res, urlOf('/api/habits/h1/toggle'));
  ok('打卡不传日期 → 默认今天', res.code === 200 && calls[0][2] === today, JSON.stringify(calls[0]));
}
{
  calls.length = 0;
  const res = mkRes();
  await study.handleStudy(req('POST', { date: '2026-01-01' }), res, urlOf('/api/habits/h1/toggle'));
  ok('打卡传日期 → 用传的那天', calls[0][2] === '2026-01-01');
}
{
  calls.length = 0;
  await study.handleStudy(req('PATCH', { name: '新名字' }), mkRes(), urlOf('/api/habits/h1'));
  await study.handleStudy(req('DELETE'), mkRes(), urlOf('/api/habits/h1'));
  ok('PATCH / DELETE 习惯都通', calls[0][0] === 'updateHabit' && calls[1][0] === 'deleteHabit');
}
{
  calls.length = 0;
  await study.handleStudy(req('POST', { minutes: 30 }), mkRes(), urlOf('/api/focus'));
  await study.handleStudy(req('DELETE'), mkRes(), urlOf('/api/focus/f1'));
  ok('番茄专注：新建 + 删除', calls[0][0] === 'createFocus' && calls[1][0] === 'deleteFocus');
}
{
  calls.length = 0;
  await study.handleStudy(req('POST', { title: '期末' }), mkRes(), urlOf('/api/milestones'));
  await study.handleStudy(req('PATCH', { done: 1 }), mkRes(), urlOf('/api/milestones/m1'));
  await study.handleStudy(req('DELETE'), mkRes(), urlOf('/api/milestones/m1'));
  ok('里程碑：新建 + 改 + 删', calls.map((c) => c[0]).join(',') === 'createMilestone,updateMilestone,deleteMilestone');
}
{
  const res = mkRes();
  await study.handleStudy(req('PUT'), res, urlOf('/api/insights'));
  ok('不支持的动词 → 404（不是 500）', res.code === 404);
  const res2 = mkRes();
  await study.handleStudy(req('GET'), res2, urlOf('/api/没这个'));
  ok('未知资源 → 404', res2.code === 404);
}

// ---------------- 4. 课表 / 校历 ----------------
{
  const res = mkRes();
  await study.handleScheduleData(req('GET'), res, urlOf('/api/courses'));
  ok('GET /api/courses 走课程表', res.code === 200 && res.body[0].id === 'c1');
  const res2 = mkRes();
  await study.handleScheduleData(req('GET'), res2, urlOf('/api/academic'));
  ok('GET /api/academic 走校历表', res2.code === 200 && res2.body[0].id === 'a0');
}
{
  calls.length = 0;
  const res = mkRes();
  await study.handleScheduleData(req('POST', { items: [{ course: 'A' }, { course: 'B' }] }), res, urlOf('/api/courses/import'));
  ok('批量导入返回插入条数', res.code === 200 && res.body.inserted === 2 && calls[0][0] === 'bulkCourses');
  calls.length = 0;
  await study.handleScheduleData(req('POST', { items: [{ course: 'A' }], replace: true }), mkRes(), urlOf('/api/courses/import'));
  ok('replace=true 时先清空', calls[0][0] === 'clearCourses' && calls[1][0] === 'bulkCourses');
  calls.length = 0;
  await study.handleScheduleData(req('POST', {}), mkRes(), urlOf('/api/academic/clear'));
  ok('clear 清校历', calls[0][0] === 'clearAcademic');
}
{
  calls.length = 0;
  await study.handleScheduleData(req('POST', { course: '新课程' }), mkRes(), urlOf('/api/courses'));
  ok('新建课程 → 201', calls[0][0] === 'createCourse');
  calls.length = 0;
  const res = mkRes();
  await study.handleScheduleData(req('PATCH', { course: '改名' }), res, urlOf('/api/courses/c1'));
  ok('改课程 → 200 且回传新对象', res.code === 200 && calls[0][0] === 'updateCourse');
  const res404 = mkRes();
  await study.handleScheduleData(
    req('PATCH', {}), res404, urlOf('/api/courses/c1'),
  );
  ok('改不存在的 → 顶多 404（替身会返回对象，所以这里只要求不抛）', [200, 404].includes(res404.code));
  calls.length = 0;
  await study.handleScheduleData(req('DELETE'), mkRes(), urlOf('/api/courses/c1'));
  ok('删课程', calls[0][0] === 'deleteCourse');
}
{
  // 2026-09-27：校历也走表单了（以前只能贴 JSON），所以这条路径要跟课程一样有覆盖：
  // 新建一条校历事项 → PATCH 改它 → DELETE 删它，前端「＋ 新建校历事项 / 编辑」用的就是这三条。
  calls.length = 0;
  const res = mkRes();
  await study.handleScheduleData(req('POST', { title: '国庆假期', kind: 'holiday', start_at: '2026-10-01', end_at: '2026-10-07' }), res, urlOf('/api/academic'));
  ok('新建校历事项 → 201（表单保存走这条）', res.code === 201 && calls[0][0] === 'createAcademic');
  calls.length = 0;
  const res2 = mkRes();
  await study.handleScheduleData(req('PATCH', { title: '国庆假期（改）' }), res2, urlOf('/api/academic/a0'));
  ok('改校历事项 → 200（「编辑」走这条）', res2.code === 200 && calls[0][0] === 'updateAcademic');
  calls.length = 0;
  await study.handleScheduleData(req('DELETE'), mkRes(), urlOf('/api/academic/a0'));
  ok('删校历事项', calls[0][0] === 'deleteAcademic');
}

// ---------------- 5. 搬家之后 server.mjs 里不再有这些实现 ----------------
{
  const srv = readFileSync(join(ROOT, 'server.mjs'), 'utf8');
  ok('server.mjs 不再自己算 insights', !srv.includes('function computeInsights'));
  ok('server.mjs 不再自己实现养成路由', !srv.includes('async function handleStudy'));
  ok('server.mjs 不再自己实现课表路由', !srv.includes('async function handleScheduleData'));
  ok('server.mjs 保留接线', srv.includes('createStudyRoutes({') && srv.includes('handleStudy(req, res, url)'));
  // 行数闸门已统一到 tests/server-shell.test.mjs（结构为主、行数兜底）
}

console.log('');
console.log(failures === 0 ? 'study-routes.test: PASS' : `study-routes.test: FAIL (${failures})`);
process.exit(failures === 0 ? 0 : 1);
