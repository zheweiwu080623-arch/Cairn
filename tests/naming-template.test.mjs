// 命名模板：默认值必须与"当年写死的那条规则"逐字相同（2026-09-27）
//
//   node tests/naming-template.test.mjs
//
// 为什么先测"等价"再说别的：这次改动的名义是"把名字变成可改的模板"，
// 但只要默认模板与老规则差一个字，老装机升级后整个课程文件夹的名字会集体漂移一次。
// 所以下面第一段用的就是**老公式的原样复刻**（不是新函数），逐条对比。

import { basename, extname } from 'node:path';

import {
  COLLEGE_CODE, DEFAULT_NAME_TEMPLATE, NAME_VARS, SEMESTER_TAG, analyzeNameTemplate,
  buildCourseFileName, cleanStem, nameFor, normalizeCourseCode, standardFileNameFor, weekTag,
} from '../lib/naming.mjs';

let failures = 0;
const ok = (label, cond, detail = '') => {
  if (cond) console.log(`  PASS ${label}`);
  else { failures += 1; console.log(`  FAIL ${label}${detail ? ` -- ${detail}` : ''}`); }
};

console.log('naming-template.test.mjs');

/** 2026-09-27 之前 buildCourseFileName 的原样逻辑（对照用，别改它）。 */
const legacy = (courseCode, filename, week) => {
  const code = normalizeCourseCode(courseCode) || COLLEGE_CODE;
  const ext = extname(String(filename || ''));
  const stem = basename(String(filename || ''), ext);
  const cleaned = cleanStem(stem, code);
  const tag = code === COLLEGE_CODE ? '' : weekTag(week);
  return [SEMESTER_TAG, code, tag, cleaned].filter(Boolean).join('_') + ext;
};

// ---------------- 1. 默认模板 = 老规则（逐字） ----------------
const cases = [
  ['MATH1860J', 'math186_all_lecture_slides.pdf', 1],
  ['MATH1860J', 'FA26_MATH1860J_Week1_lec_1.pdf', 1],
  ['MATH1860J', 'FA26_MATH1860J_Week2_FA26_math186_Week2_x.pdf', 2],
  ['ENGR1010J', 'lec 1.pdf', 3],
  ['(2026-2027-1)-STAT1000J-01', 'chapter 2 slides.pptx', 5],
  ['Undergraduate Students', '学院通知.pdf', 4],
  ['Undergraduate Students', 'Undergraduate Students 2026 秋季学期选课.pdf', null],
  ['PUM1201', '学习指南2026秋季.docx', 14],
  ['MATH1860J', 'no_extension_file', 2],
  ['MATH1860J', '第3周讲义.pdf', 3],
  ['MATH1860J', 'a.pdf', 99],
  ['MATH1860J', 'b.pdf', 0],
  ['MATH1860J', 'c.pdf', null],
  ['', 'orphan material.pdf', 2],
  ['STAT1000J', '课程群二维码.png', null],
];
{
  const diffs = cases
    .map(([code, name, week]) => ({ code, name, week, want: legacy(code, name, week), got: buildCourseFileName({ courseCode: code, filename: name, week }) }))
    .filter((x) => x.want !== x.got);
  ok(`默认模板与老规则逐字相同（${cases.length} 个样例）`, diffs.length === 0,
    diffs.map((d) => `${d.name}: ${d.want} != ${d.got}`).join(' | '));
  ok('默认模板就是那条老规则本身', DEFAULT_NAME_TEMPLATE === '{学期}_{课程号}_Week{周次}_{原名}', DEFAULT_NAME_TEMPLATE);
}

// ---------------- 2. 「学院文件没有周次」⇒ Week 段整段消失 ----------------
{
  const got = buildCourseFileName({ courseCode: 'Undergraduate Students', filename: '通知.pdf', week: 5 });
  ok('学院口径材料不加 Week（有日期也不加，和老规则一致）', got === 'FA26_学院文件_通知.pdf', got);
  // 「没有课程号」= 学院口径材料（老规则一直这么判），所以它也没有周次 → 含周次的段整段消失，
  // 不会留下一个孤零零的「第周」。
  ok('没有课程号 / 学院文件 + 自定义"第N周"模板 → 整段消失，不留下"第周"',
    buildCourseFileName({ courseCode: '', filename: 'x.pdf', week: 3, template: '第{周次}周_{原名}' }) === 'x.pdf'
    && buildCourseFileName({ courseCode: 'Undergraduate Students', filename: 'x.pdf', week: 3, template: '第{周次}周_{原名}' }) === 'x.pdf'
    && buildCourseFileName({ courseCode: 'MATH1860J', filename: 'x.pdf', week: 3, template: '第{周次}周_{原名}' }) === '第3周_x.pdf');
}

// ---------------- 3. 自定义模板 ----------------
{
  const base = { courseCode: 'MATH1860J', filename: 'math186_all_lecture_slides.pdf', week: 3, course: '(2026-2027-1)-MATH1860J-01-高等数学B1', date: '2026-09-15' };
  const table = [
    ['{课程号}_{原名}', 'MATH1860J_all_lecture_slides.pdf'],
    ['第{周次}周_{原名}', '第3周_all_lecture_slides.pdf'],
    ['{学期}-{课程号}-W{周次}-{原名}', 'FA26-MATH1860J-W3-all_lecture_slides.pdf'],
    ['{原名}', 'all_lecture_slides.pdf'],
    ['{课程名}_{日期} {类型}_{原名}', '01-高等数学B1_20260915 pdf_all_lecture_slides.pdf'],
    // 2026-09-27 实测撞出来的：横杠分隔 + 中文字包着的周次，学院文件那时候冒出一个「第周」。
    // 规则改成"变量全空的段连分隔符一起去掉"，所以这里两种分隔符都要对。
    ['{课程号}-第{周次}周-{原名}', 'MATH1860J-第3周-all_lecture_slides.pdf'],
    ['{课程号} - {原名}', 'MATH1860J - all_lecture_slides.pdf'],
  ];
  for (const [tpl, want] of table) {
    const got = buildCourseFileName({ ...base, template: tpl });
    ok(`模板 ${tpl}`, got === want, `want ${want} / got ${got}`);
  }
  ok('扩展名自动保留（模板里不用写）', buildCourseFileName({ ...base, template: '{原名}' }).endsWith('.pdf'));
  ok('写错的变量被忽略，不炸也不留花括号',
    buildCourseFileName({ ...base, template: '{课程号}_{没有这个变量}_{原名}' }) === 'MATH1860J_all_lecture_slides.pdf');
  ok('模板是空的 → 用默认模板', buildCourseFileName({ ...base, template: '   ' }) === buildCourseFileName(base));
  {
    const got = buildCourseFileName({ ...base, courseCode: 'Undergraduate Students', template: '{课程号}-第{周次}周-{原名}' });
    ok('学院口径 + 带中文外壳的周次 → 外壳整段消失，不留下「第周」',
      got === '学院文件-math186_all_lecture_slides.pdf' && !got.includes('第周'), got);
  }
}

// ---------------- 4. 幂等：默认模板反复过一遍不长胖 ----------------
{
  const once = buildCourseFileName({ courseCode: 'MATH1860J', filename: 'math186_all_lecture_slides.pdf', week: 1 });
  const twice = buildCourseFileName({ courseCode: 'MATH1860J', filename: once, week: 1 });
  ok('同一份材料再算一次名字不变（不会滚成 FA26_X_Week1_Week1_…）', once === twice, `${once} / ${twice}`);
}

// ---------------- 5. 文件名安全 + 与老规则的唯一差异 ----------------
{
  const got = buildCourseFileName({ courseCode: 'MATH1860J', filename: 'weird *with* bad?chars.pdf', week: 6 });
  ok('Windows 不能出现的字符被替成下划线（老规则会把 * / ? 原样写进路径 ⇒ 建文件必失败）',
    got === 'FA26_MATH1860J_Week6_weird _with_ bad_chars.pdf' && !/[*?]/.test(got), got);
  ok('结尾的点与空格会被去掉（Windows 上非法）',
    !/[. ]$/.test(nameFor('{原名}', { 原名: 'x.' })) && nameFor('{原名} ', { 原名: 'x' }) === 'x');
}

// ---------------- 6. 变量表与"用到了哪些变量" ----------------
{
  ok('八个变量一个不少', NAME_VARS.map((v) => v.key).join(',') === '学期,课程号,课程名,周次,原名,日期,类型,序号', NAME_VARS.map((v) => v.key).join(','));
  const a = analyzeNameTemplate('{学期}_{课程号}_Week{周次}_{原名}{课程号}');
  ok('analyzeNameTemplate：用到的去重、顺序按出现', a.used.join(',') === '学期,课程号,周次,原名', a.used.join(','));
  ok('analyzeNameTemplate：写错的变量单独列出来', analyzeNameTemplate('{不存在的}_{原名}').unknown.join(',') === '不存在的');
}

// ---------------- 7. 邮件/通知用的"标准名" ----------------
{
  const row = { local_name: 'FA26_MATH1860J_Week1_all_lecture_slides.pdf', course_code: 'MATH1860J', filename: 'math186_all_lecture_slides.pdf', file_date: '2026-09-16' };
  ok('台账里已经是标准名 → 原样用', standardFileNameFor(row) === row.local_name);
  ok('老记录（没有 local_name）→ 按规则现算',
    standardFileNameFor({ course_code: 'MATH1860J', filename: 'math186_all_lecture_slides.pdf', file_date: '2026-09-16' })
      === 'FA26_MATH1860J_Week1_all_lecture_slides.pdf');
  ok('老记录（local_name 是教授原话的名字）→ 仍按规则现算',
    standardFileNameFor({ local_name: 'math186_all_lecture_slides.pdf', course_code: 'MATH1860J', filename: 'math186_all_lecture_slides.pdf', file_date: '2026-09-16' })
      === 'FA26_MATH1860J_Week1_all_lecture_slides.pdf');
  ok('自定义模板下，按新模板落盘的名字也算标准名（不会每次重算）',
    standardFileNameFor(
      { local_name: 'MATH1860J_all_lecture_slides.pdf', course_code: 'MATH1860J', filename: 'math186_all_lecture_slides.pdf' },
      { template: '{课程号}_{原名}' },
    ) === 'MATH1860J_all_lecture_slides.pdf');
}

console.log('');
console.log(failures === 0 ? 'naming-template.test: PASS' : `naming-template.test: FAIL (${failures})`);
process.exit(failures === 0 ? 0 : 1);
