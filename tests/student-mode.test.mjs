// 学生模式（2026-09-26 晚第二版）与 Canvas 作业状态的学生特化。
//
//   node tests/student-mode.test.mjs
//
// 用户要求："不要在设置里面加（学期），因为这个还有非学生会用，所以找一个地方做选择（是否学生），
// 然后尽可能做到如果在写分析偏好的时候有学生倾向就设置为学生模式"。
// 所以这里钉两件事：① 判断规则别太敏感也别太木；② 判断结果一定要能解释（why/hits）。

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { modeLabel, studentSignals, STUDENT_WORDS } from '../lib/student.mjs';
import { submitStateText } from '../lib/connectors/canvas.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
let failures = 0;
const ok = (label, cond, detail = '') => {
  if (cond) console.log(`  PASS ${label}`);
  else { failures += 1; console.log(`  FAIL ${label}${detail ? ` -- ${detail}` : ''}`); }
};

console.log('student-mode.test.mjs');

// ---------------- 1. 从分析偏好里认出学生 ----------------
{
  ok('什么都没写、也没配 Canvas/课表 ⇒ 不是学生',
    studentSignals({ notes: '' }).student === false
    && studentSignals({ notes: '我关心健身和记账' }).student === false);
  ok('只提一个词不算（"作业"也可能是工作里的作业）',
    studentSignals({ notes: '把作业按时交了' }).student === false,
    JSON.stringify(studentSignals({ notes: '把作业按时交了' })));
  const s1 = studentSignals({ notes: '这学期先把两门专业课的作业和考试时间盯住' });
  ok('提了两个以上学生词 ⇒ 认成学生', s1.student === true, JSON.stringify(s1));
  ok('并且把"依据"说出来（界面要显示，别让用户莫名其妙）',
    s1.hits.length >= 2 && /课程|作业|考试|学期/.test(s1.why), JSON.stringify(s1));
  ok('英文也认（course / assignment / deadline）',
    studentSignals({ notes: 'check course assignments and deadline' }).student === true);
  ok('配了 Canvas 就算学生（哪怕没写分析偏好）',
    studentSignals({ hasCanvas: true }).student === true
    && /Canvas/.test(studentSignals({ hasCanvas: true }).why));
  ok('本地已经有课表也算',
    studentSignals({ courseCount: 6 }).student === true
    && /6 门课/.test(studentSignals({ courseCount: 6 }).why));
  ok('词表本身不太小（够覆盖日常说法）', STUDENT_WORDS.length >= 20);
  ok('模式名是人话', modeLabel('student') === '学生模式' && modeLabel('general') === '通用模式');
}

// ---------------- 2. Canvas 作业状态（学生特化） ----------------
{
  ok('没交 → 明确写"还没交"（带提醒符）', submitStateText({ workflow_state: 'unsubmitted' }) === '⚠️ 还没交');
  ok('交了 → "已提交"', submitStateText({ workflow_state: 'submitted' }) === '已提交');
  ok('评分了 → 带上分数', submitStateText({ workflow_state: 'graded', score: 88 }) === '已评 88 分');
  ok('评了但没给分（Canvas 会给 null）→ 不硬塞 null',
    submitStateText({ workflow_state: 'graded', score: null }) === '已评 分');
  ok('待批改 → "待批改"', submitStateText({ workflow_state: 'pending_review' }) === '待批改');
  ok('拿不到状态就**不猜**（空串）',
    submitStateText({}) === '' && submitStateText(null) === '' && submitStateText({ workflow_state: '奇怪的值' }) === '');
}

// ---------------- 3. 源码守卫：学生模式不是一个独立页签 ----------------
{
  const panel = readFileSync(join(ROOT, 'modules', 'settings', 'panel.js'), 'utf8');
  ok('设置里**没有**单独的「学期」页签（用户明确要求：非学生也要用）',
    !/id: 'semester'/.test(panel) && panel.includes("{ id: 'prefs', name: '偏好'"));
  ok('"是不是学生"是偏好页里的一次选择（学生 / 不是 / 回到自动）',
    panel.includes('data-set-student="student"') && panel.includes('data-set-student="general"')
    && panel.includes('data-set-student="auto"'));
  ok('学期设置只在学生模式下才画出来',
    /isStudent \? `/.test(panel) && panel.includes('id="set-sem-start"'));
  const canvas = readFileSync(join(ROOT, 'lib', 'connectors', 'canvas.mjs'), 'utf8');
  ok('Canvas 拉作业时带上子任务状态（include[]=submission）',
    canvas.includes('include[]=submission'));
  ok('提交状态会跟着条目存进库（payload.submit_state）',
    readFileSync(join(ROOT, 'lib', 'connectors', 'index.mjs'), 'utf8').includes('submit_state'));
  const app = readFileSync(join(ROOT, 'public', 'app.js'), 'utf8');
  ok('页头那行只在学生模式里出现', app.includes("if (STUDENT_MODE !== 'student')"));
}

console.log('');
console.log(failures === 0 ? 'student-mode.test: PASS' : `student-mode.test: FAIL (${failures})`);
process.exit(failures === 0 ? 0 : 1);
