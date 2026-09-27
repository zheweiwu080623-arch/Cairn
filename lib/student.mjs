// 学生模式（2026-09-26 晚第二版用户要求）。
//
// 用户原话："不要在设置里面加，因为这个还有非学生会用，所以找一个地方做选择（是否学生），
// 然后尽可能做到如果在写分析偏好的时候有学生倾向就设置为学生模式"。
//
// 所以：**学生模式是一个可自动判断的开关**，不是一页设置。
//   * 用户自己点过 → 听用户的（explicit，存偏好）；
//   * 没点过 → 按信号猜：分析偏好里写了学生腔 / 配了 Canvas / 本地已有课表 都算倾向；
//   * 猜出来的结果**只用来"打开"**：一旦开了就保持，不会因为后来没提这些词又自己关掉。
//
// 这个文件只做纯判断，不碰存储；谁来存、谁来用由调用方决定。

/** 一眼就是学生腔的词（不是关键词表，是"这段话像学生在说"的信号）。 */
export const STUDENT_WORDS = [
  '课程', '课表', '上课', '选课', '退课', '学分', '绩点', 'GPA', '期末考试', '期中', '期末',
  '作业', '实验报告', '论文', '毕设', '导师', '助教', '课题组', '文献', '复习', '预习',
  '考试周', '学期', '开学', '放假', '宿舍', '社团', '保研', '考研', '留学', '暑研', '暑校',
  'assignment', 'deadline', 'course', 'semester', 'homework', 'lecture', 'final exam',
];

/**
 * 从"信号"里判断是不是学生。
 *
 * @param {{notes?: string, hasCanvas?: boolean, courseCount?: number, hasSyllabus?: boolean}} sig
 * @returns {{student: boolean, hits: string[], why: string}}
 *   student：该不该按学生模式走；hits：命中的词（给界面显示，别让用户觉得莫名其妙）；
 *   why：一句人话，界面直接可用。
 */
export function studentSignals({ notes = '', hasCanvas = false, courseCount = 0, hasSyllabus = false } = {}) {
  const text = String(notes || '');
  const lower = text.toLowerCase();
  const hits = STUDENT_WORDS.filter((w) => (w === w.toUpperCase() ? text.includes(w) : lower.includes(w.toLowerCase())));
  // 词命中 ≥2 个不同词才算"像学生在写"（单个"作业"可能是工作里的作业，别太敏感）
  const byWords = hits.length >= 2;
  const student = byWords || hasCanvas || courseCount > 0 || hasSyllabus;
  const why = hasCanvas || courseCount > 0
    ? `你这边已经有课程数据（${courseCount > 0 ? `${courseCount} 门课` : 'Canvas 已配'}），所以按学生模式走`
    : (byWords ? `你在分析偏好里提到了「${hits.slice(0, 3).join('、')}」这些，所以按学生模式走` : '还没看出学生倾向');
  return { student, hits, why };
}

/** 界面上给用户看的模式名。 */
export function modeLabel(mode) {
  return mode === 'student' ? '学生模式' : '通用模式';
}
