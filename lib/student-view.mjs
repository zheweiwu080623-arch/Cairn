// 学生卡片（2026-09-26 晚：用户说"学生模式就上面四个全都做好了"）。
//
// 一张卡把四件事说清（只在学生模式下显示）：
//   ① 未交作业（Canvas 的 submit_state = unsubmitted）
//   ② 今天的课（按"第 N 周"过滤课程自己的 weeks 区间）
//   ③ 考试周（学期最后两周，醒目提示）
//   ④ 学期进度（第 N 周 / 共 M 周 + 本学期完成的任务数）
//
// 纯函数：只吃数据、吐结构，不碰存储也不碰 DOM —— 好测。

/** 课程 weeks 字段可能是 "1-14" / "1,3,5" / "全部" / ""：判断第 week 周上不上。 */
export function weekMatches(weeks, week) {
  const s = String(weeks || '').trim();
  if (!s || /全部|all/i.test(s)) return true;
  if (!week || week < 1) return true;                 // 没设学期就不筛
  const parts = s.split(/[,，、\s]+/).filter(Boolean);
  for (const p of parts) {
    const m = /^(\d+)\s*[-~到至]\s*(\d+)$/.exec(p);
    if (m) { if (week >= Number(m[1]) && week <= Number(m[2])) return true; continue; }
    if (/^\d+$/.test(p) && Number(p) === week) return true;
  }
  return false;
}

/** 今天星期几：1=周一 … 7=周日（课程表用的就是这套）。 */
export function weekdayOf(d = new Date()) {
  return ((d.getDay() + 6) % 7) + 1;
}

/**
 * @param {{semester?: object, courses?: object[], connectorRows?: object[], tasks?: object[], now?: Date}} input
 * @returns {{active: boolean, week: number, total: number, finals: boolean,
 *            undone: object[], todayCourses: object[], doneCount: number, hasSemester: boolean}}
 */
export function buildStudentView({ semester = {}, courses = [], connectorRows = [], tasks = [], now = new Date() } = {}) {
  const hasSemester = !!semester.configured;
  const week = hasSemester ? (semester.week || 0) : 0;
  const finals = semester.phase === 'finals';

  // ① 未交作业：只认 Canvas 的作业（payload.submit_state = unsubmitted），按截止时间排
  const undone = connectorRows
    .filter((r) => String(r.source || '').split('@')[0] === 'canvas')
    .map((r) => { let p = {}; try { p = JSON.parse(r.payload || '{}'); } catch { /* ignore */ } return { ...r, submit_state: p.submit_state, course: p.course }; })
    .filter((r) => r.submit_state === 'unsubmitted')
    .sort((a, b) => String(a.due_at || '9999').localeCompare(String(b.due_at || '9999')))
    .map((r) => ({ title: r.title, due_at: r.due_at || null, course: r.course || '', url: r.url || null }));

  // ② 今天的课：周几对上 + 这一周在课程的 weeks 区间里
  const wd = weekdayOf(now);
  const todayCourses = courses
    .filter((c) => Number(c.weekday) === wd && weekMatches(c.weeks, week))
    .sort((a, b) => String(a.start_at || '').localeCompare(String(b.start_at || '')))
    .map((c) => ({ course: c.course, start_at: c.start_at || '', end_at: c.end_at || '', location: c.location || '' }));

  // ④ 学期进度：完成的任务数（没有学期就报全部已完成的）
  const doneCount = tasks.filter((t) => t.done || t.status === 'done').length;

  return {
    active: undone.length > 0 || todayCourses.length > 0 || finals,
    week, total: semester.total || 18, finals, hasSemester, undone, todayCourses, doneCount,
  };
}
