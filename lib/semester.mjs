// 学期（学生特化第一刀，2026-09-26 晚）。
//
// 用户说"做学生特化，因为这个产品对于工业界有概率用处不大"。
// 第一件挑的是**学期周次**：学生看日程/作业时最常问的是"现在第几周了 / 离期末还有多久"，
// 而"第 N 周"只有把**开学日**和**学期长度**配进来才算得出来 —— 所以这里只做纯计算，
// 配置存在偏好里（`semester`），显示交给界面。

/** 把 'YYYY-MM-DD' 解析成"本地时区的当天 0 点"，避免时区把日期算歪。 */
export function parseDay(s) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(s || '').trim());
  if (!m) return null;
  const d = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
  return Number.isNaN(d.getTime()) ? null : d;
}

/** 两个日期之间差几天（按本地日历天算，忽略时分秒）。 */
export function daysBetween(from, to) {
  const a = new Date(from.getFullYear(), from.getMonth(), from.getDate());
  const b = new Date(to.getFullYear(), to.getMonth(), to.getDate());
  return Math.round((b - a) / 86400000);
}

/** 把任意一天对齐到它所在那一周的周一。 */
export function mondayOf(d) {
  const x = new Date(d.getFullYear(), d.getMonth(), d.getDate());
  const wd = (x.getDay() + 6) % 7;          // 周一 = 0
  x.setDate(x.getDate() - wd);
  return x;
}

/**
 * 算学期状态。
 *
 * @param {{start?: string, weeks?: number}} sem 开学日（第一周的周一）+ 学期周数（默认 18）
 * @param {Date} now
 * @returns {{configured: boolean, week: number, total: number, phase: string,
 *            days_to_end: number|null, label: string, end: string|null}}
 *   phase: not-yet（还没开学）/ classes（上课）/ finals（考试周，最后两周）/ over（已结束）
 */
export function semesterInfo(sem = {}, now = new Date()) {
  const start = parseDay(sem.start);
  const total = Math.max(1, Math.min(60, Number(sem.weeks) || 18));
  if (!start) {
    return { configured: false, week: 0, total, phase: 'none', days_to_end: null, label: '学期未设置', end: null };
  }
  const startMonday = mondayOf(start);
  const diff = daysBetween(startMonday, now);
  const end = new Date(startMonday.getTime() + total * 7 * 86400000);   // 最后一周的周一之后
  const endStr = `${end.getFullYear()}-${String(end.getMonth() + 1).padStart(2, '0')}-${String(end.getDate()).padStart(2, '0')}`;

  if (diff < 0) {
    const back = -diff;
    return {
      configured: true, week: 0, total, phase: 'not-yet', days_to_end: daysBetween(now, end),
      label: `还没开学 · 还有 ${back} 天`, end: endStr,
    };
  }
  const week = Math.floor(diff / 7) + 1;
  if (week > total) {
    return {
      configured: true, week: 0, total, phase: 'over', days_to_end: daysBetween(now, end),
      label: `学期已结束（共 ${total} 周）`, end: endStr,
    };
  }
  const finals = total - week < 2;                 // 最后两周当考试周
  const left = total - week + 1;
  return {
    configured: true, week, total, phase: finals ? 'finals' : 'classes',
    days_to_end: daysBetween(now, end),
    label: `第 ${week} 周 / 共 ${total} 周 · ${finals ? '考试周' : '还剩 ' + left + ' 周'}`,
    end: endStr,
  };
}
