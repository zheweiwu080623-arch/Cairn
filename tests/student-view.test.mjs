// 学生卡片：未交作业 / 今天的课 / 考试周 / 学期进度（2026-09-26 晚）。
//
//   node tests/student-view.test.mjs

import { buildStudentView, weekMatches, weekdayOf } from '../lib/student-view.mjs';

let failures = 0;
const ok = (label, cond, detail = '') => {
  if (cond) console.log(`  PASS ${label}`);
  else { failures += 1; console.log(`  FAIL ${label}${detail ? ` -- ${detail}` : ''}`); }
};

console.log('student-view.test.mjs');

// ---------------- 1. 周次区间 ----------------
{
  ok('"1-14" 这类区间认得', weekMatches('1-14', 3) && weekMatches('1-14', 14) && !weekMatches('1-14', 15));
  ok('单周列举也认得', weekMatches('1,3,5', 3) && !weekMatches('1,3,5', 4));
  ok('"全部" / 空 ⇒ 每周都上', weekMatches('全部', 9) && weekMatches('', 9) && weekMatches(null, 9));
  ok('没设学期（week=0）⇒ 不筛', weekMatches('1-14', 0));
  ok('破格式不炸（当周次列表处理，匹配不上就是不上）', weekMatches('第1-2周', 3) === false);
}

// ---------------- 2. 周几 ----------------
{
  ok('2026-09-26 是周六 → 6', weekdayOf(new Date(2026, 8, 26)) === 6);
  ok('2026-09-28 是周一 → 1', weekdayOf(new Date(2026, 8, 28)) === 1);
}

// ---------------- 3. 整张卡 ----------------
{
  const now = new Date(2026, 8, 28, 9, 0);            // 周一
  const semester = { configured: true, week: 3, total: 18, phase: 'classes' };
  const courses = [
    { course: '离散数学', weekday: 1, start_at: '08:00', end_at: '09:40', weeks: '1-14', location: '上院 103' },
    { course: '大学物理', weekday: 1, start_at: '10:00', end_at: '11:40', weeks: '2-16', location: '' },
    { course: '体育', weekday: 1, start_at: '14:00', end_at: '15:40', weeks: '9-16', location: '操场' },   // 第 3 周不上
    { course: '英语', weekday: 3, start_at: '08:00', end_at: '09:40', weeks: '1-16', location: '' },        // 不是今天
  ];
  const rows = [
    { source: 'canvas', title: '离散数学 · 作业 3', due_at: '2026-09-29T23:59', payload: JSON.stringify({ submit_state: 'unsubmitted', course: '离散数学' }) },
    { source: 'canvas', title: '大学物理 · 实验报告', due_at: '2026-09-30T23:59', payload: JSON.stringify({ submit_state: 'unsubmitted' }) },
    { source: 'canvas', title: '英语 · 作文', due_at: '2026-09-27T23:59', payload: JSON.stringify({ submit_state: 'submitted' }) },   // 交了，不算
    { source: 'email', title: '邮件附件', due_at: '2026-09-29T09:00', payload: '{}' },                                                // 不是 Canvas
  ];
  const tasks = [{ done: true }, { done: false }, { status: 'done' }, {}];
  const sv = buildStudentView({ semester, courses, connectorRows: rows, tasks, now });
  ok('未交作业：只算 Canvas 且状态是 unsubmitted 的（交了的不算、别的源不算）',
    sv.undone.length === 2 && sv.undone.every((u) => /作业 3|实验报告/.test(u.title)), JSON.stringify(sv.undone));
  ok('未交作业按截止时间从早到晚', sv.undone[0].title.includes('作业 3'));
  ok('今天的课：周几对上 + 本周边次对得上（第 3 周不上体育）',
    sv.todayCourses.length === 2 && sv.todayCourses[0].course === '离散数学' && !sv.todayCourses.some((c) => c.course === '体育'),
    JSON.stringify(sv.todayCourses));
  ok('课按时间排序', sv.todayCourses[0].start_at === '08:00' && sv.todayCourses[1].start_at === '10:00');
  ok('学期进度：完成 2 项', sv.doneCount === 2);
  ok('有内容 ⇒ active', sv.active === true);
  ok('考试周：最后两周 phase=finals 时 finals=true',
    buildStudentView({ semester: { ...semester, phase: 'finals', week: 17 }, now }).finals === true);
  ok('没设学期：hasSemester=false，但仍然给课和作业（只是不筛周次）',
    buildStudentView({ semester: {}, courses, connectorRows: rows, tasks, now }).hasSemester === false);
}

console.log('');
console.log(failures === 0 ? 'student-view.test: PASS' : `student-view.test: FAIL (${failures})`);
process.exit(failures === 0 ? 0 : 1);
