// routes/study.mjs —— 养成（习惯 / 番茄专注 / 里程碑）与课表校历的接口
// （R2：从 server.mjs 里拆出来的第二组）
//
// 为什么这组适合拆：它是**纯业务读写**，不碰文件系统、不碰外部网络、不碰窗口，
// 只依赖"一个存东西的地方"（store）和"怎么回话"（sendJson 这几个）。
// 拆出来之后，想知道"养成这块到底怎么算的"只要读这一个文件。
//
// 依赖全部从外面传进来（`ctx`），所以测试能塞一个替身 store，不需要真数据库。

export const DAY_MS = 86400000;

/** 本地日期键 YYYY-MM-DD（和前端 hk() 同一规则）。 */
export const hK = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;

/** 最近 n 天（含今天），从早到晚。 */
export function lastN(n, from = new Date()) {
  const a = [];
  for (let i = n - 1; i >= 0; i--) a.push(new Date(from.getTime() - i * DAY_MS));
  return a;
}

/**
 * 连续打卡天数。
 * 约定：**今天还没打卡不算断**（不然每天早上一睁眼连续天数就归零）。
 *
 * 2026-09-22 修掉一个真 bug：原来按 `lastN(365)` 的**从旧到新**顺序遍历，
 * 第一天（364 天前没打卡）就 break，于是**永远返回 0** —— 界面上"连续 X 天"一直是 0。
 * 现在改成**从今天往回数**，遇到第一个没打卡的日子停下。
 */
export function habitStreak(habit, logs, { now = new Date() } = {}) {
  const doneSet = new Set(logs.filter((l) => l.habit_id === habit.id && l.done).map((l) => l.date));
  let streak = 0;
  const startOfToday = hK(now);
  for (const d of lastN(365, now).reverse()) {   // 今天 → 昨天 → 前天 …
    const k = hK(d);
    if (doneSet.has(k)) { streak++; }
    else if (k === startOfToday) { continue; }   // 今天还没打卡：不算断
    else break;
  }
  return streak;
}

export function createStudyRoutes(ctx) {
  const { store, sendJson, sendError, notFound, readBody } = ctx;

  /**
   * 「统计」页与今日概览用的汇总数字。
   * 注意：**这些数字是服务端算的**，界面（网页/原生外壳/邮件/Markdown）只负责显示，
   * 这样换界面的时候不会出现"网页 3 条、邮件 5 条"。
   */
  function computeInsights(now = new Date()) {
    const today = hK(now);
    const mon = new Date(now); mon.setHours(0, 0, 0, 0); mon.setDate(mon.getDate() - ((mon.getDay() + 6) % 7));
    const weekStart = hK(mon);
    const tasks = store.listTasks();
    const done = tasks.filter((t) => t.status === 'done');
    const doneToday = done.filter((t) => t.updated_at && hK(new Date(t.updated_at)) === today).length;
    const doneWeek = done.filter((t) => t.updated_at && hK(new Date(t.updated_at)) >= weekStart).length;
    const completion = tasks.length ? Math.round((tasks.filter((t) => t.status === 'done').length / tasks.length) * 100) : 0;

    const focus = store.listFocus();
    const focusToday = focus.filter((f) => hK(new Date(f.started_at)) === today).reduce((a, f) => a + f.minutes, 0);
    const focusWeek = focus.filter((f) => hK(new Date(f.started_at)) >= weekStart).reduce((a, f) => a + f.minutes, 0);

    const habits = store.listHabits();
    const logs = store.listHabitLogs();
    const habitsToday = habits.filter((h) => logs.some((l) => l.habit_id === h.id && l.date === today && l.done)).length;

    const milestones = store.listMilestones();
    const upcomingM = milestones.filter((m) => !m.done && m.target_at >= today).sort((a, b) => a.target_at < b.target_at ? -1 : 1)[0] || null;

    const academic = store.listAcademic();
    const term = academic.find((a) => a.kind === 'term');
    const nextExam = academic.filter((a) => a.kind === 'exam' && a.end_at >= today).sort((a, b) => (a.start_at < b.start_at ? -1 : 1))[0] || null;

    let semesterWeek = null;
    if (term) semesterWeek = Math.floor((new Date(today) - new Date(term.start_at)) / (7 * DAY_MS)) + 1;
    const countdownOf = (t) => Math.max(0, Math.ceil((new Date(t) - new Date()) / DAY_MS));

    return {
      today, weekStart,
      tasks: { total: tasks.length, done: done.length, doneToday, doneWeek, completion, open: tasks.length - done.length },
      focus: { today: focusToday, week: focusWeek, sessions: focus.length },
      habits: { total: habits.length, todayDone: habitsToday, streaks: habits.map((h) => ({ id: h.id, name: h.name, streak: habitStreak(h, logs) })) },
      milestone: upcomingM ? { ...upcomingM, daysLeft: countdownOf(upcomingM.target_at) } : null,
      exam: nextExam ? { ...nextExam, daysLeft: countdownOf(nextExam.start_at) } : null,
      semesterWeek,
    };
  }

  /** /api/insights /api/habits /api/focus /api/milestones */
  async function handleStudy(req, res, url) {
    const seg = url.pathname.split('/').filter(Boolean);
    const method = req.method;
    const resource = seg[1];
    const id = seg[2];
    const action = seg[3];

    if (resource === 'insights') {
      if (method === 'GET') return sendJson(res, 200, computeInsights());
      return notFound(res);
    }
    if (resource === 'habits') {
      if (seg.length === 2 && method === 'GET') return sendJson(res, 200, { habits: store.listHabits(), logs: store.listHabitLogs() });
      if (!id && method === 'POST') return sendJson(res, 201, store.createHabit(await readBody(req)));
      if (action === 'toggle' && method === 'POST') { const b = await readBody(req); return sendJson(res, 200, store.toggleHabitLog(id, b.date || hK(new Date()))); }
      if (id && method === 'PATCH') return sendJson(res, 200, store.updateHabit(id, await readBody(req)));
      if (id && method === 'DELETE') { store.deleteHabit(id); return sendJson(res, 200, { ok: true }); }
    }
    if (resource === 'focus') {
      if (seg.length === 2 && method === 'GET') return sendJson(res, 200, store.listFocus());
      if (!id && method === 'POST') return sendJson(res, 201, store.createFocus(await readBody(req)));
      if (id && method === 'DELETE') { store.deleteFocus(id); return sendJson(res, 200, { ok: true }); }
    }
    if (resource === 'milestones') {
      if (seg.length === 2 && method === 'GET') return sendJson(res, 200, store.listMilestones());
      if (!id && method === 'POST') return sendJson(res, 201, store.createMilestone(await readBody(req)));
      if (id && method === 'PATCH') return sendJson(res, 200, store.updateMilestone(id, await readBody(req)));
      if (id && method === 'DELETE') { store.deleteMilestone(id); return sendJson(res, 200, { ok: true }); }
    }
    return notFound(res);
  }

  /** /api/courses* 与 /api/academic*（两者结构一样，只是换一张表） */
  async function handleScheduleData(req, res, url) {
    const seg = url.pathname.split('/').filter(Boolean); // ['api', 'courses'|'academic', id?, action?]
    const method = req.method;
    const kind = seg[1];
    const isCourse = kind === 'courses';
    const list = () => (isCourse ? store.listCourses() : store.listAcademic());
    const create = (b) => (isCourse ? store.createCourse(b) : store.createAcademic(b));
    const update = (id, b) => (isCourse ? store.updateCourse(id, b) : store.updateAcademic(id, b));
    const del = (id) => (isCourse ? store.deleteCourse(id) : store.deleteAcademic(id));

    if (seg.length === 2 && method === 'GET') return sendJson(res, 200, list());

    const seg2 = seg[2];
    const action = (seg2 === 'import' || seg2 === 'clear') ? seg2 : seg[3];
    const id = action ? null : seg2;

    if (action === 'import' && method === 'POST') {
      const body = await readBody(req);
      const rows = Array.isArray(body.items) ? body.items : (body.items ? [body.items] : []);
      if (body.replace) {
        if (isCourse) store.clearCourses(); else store.clearAcademic();
      }
      const n = isCourse ? store.bulkInsertCourses(rows) : store.bulkInsertAcademic(rows);
      return sendJson(res, 200, { inserted: n });
    }

    if (action === 'clear' && method === 'POST') {
      if (isCourse) store.clearCourses(); else store.clearAcademic();
      return sendJson(res, 200, { ok: true });
    }

    if (!id && method === 'POST') { return sendJson(res, 201, create(await readBody(req))); }
    if (id && method === 'PATCH') { const r = update(id, await readBody(req)); return r ? sendJson(res, 200, r) : sendError(res, 404, 'not found'); }
    if (id && method === 'DELETE') { del(id); return sendJson(res, 200, { ok: true }); }
    return notFound(res);
  }

  return { computeInsights, handleStudy, handleScheduleData };
}
