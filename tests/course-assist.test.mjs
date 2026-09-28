// 课程辅助的验证（D4）：资料扫描 → 读成文字 → 索引 → 写进数据目录。
//
//   node tests/course-assist.test.mjs
//
// 用**临时造出来的假课程目录**（不碰真课件）；真课件那批由"实盘复验"另外跑。
// 重点：不编内容（读不出来就标出来）、写文件的边界（只准写 <数据目录>/study）。

import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import {
  READABLE_KINDS, buildMaterialIndex, buildWeeklyPack, courseCodeOf, pickLines, readMaterials,
  resolveCourseDir, scanCourseMaterials, searchMaterials, summarizeIndex, weekNumberFrom, weekOf,
} from '../lib/course-assist.mjs';
import { createCourseStack, insideStudy, studyDirOf, studyPath, writeStudyFile } from '../lib/course-stack.mjs';
import { IMPLEMENTED_TYPES, canExecute, normalizeActions } from '../lib/processor.mjs';
import { createCourseRoutes } from '../lib/routes/course.mjs';

let failures = 0;
const ok = (label, cond, detail = '') => {
  if (cond) console.log(`  PASS ${label}`);
  else { failures += 1; console.log(`  FAIL ${label}${detail ? ` -- ${detail}` : ''}`); }
};

const TMP = process.env.PLANNER_TEST_TMP || '';
if (!TMP) {
  console.error('需要 PLANNER_TEST_TMP（run_all_suites.py 会设置）');
  process.exit(2);
}
console.log('course-assist.test.mjs');

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const root = mkdtempSync(join(TMP, 'course-assist-'));
const dataDir = join(root, 'data');
const courseRoot = join(root, 'FA26课程资料');
const mathDir = join(courseRoot, 'MATH1860J 高等数学B1');
const statDir = join(courseRoot, 'STAT1000J 数据科学入门');
mkdirSync(mathDir, { recursive: true });
mkdirSync(join(statDir, 'lec01'), { recursive: true });
mkdirSync(join(courseRoot, '__MACOSX'), { recursive: true });
mkdirSync(join(courseRoot, '_重名或重复（可删）'), { recursive: true });

const fakePdf = (lines) => Buffer.from([
  '%PDF-1.4',
  '1 0 obj << /Type /Page >> stream',
  ...lines.map((t) => `BT /F1 12 Tf (${t}) Tj ET`),
  'endstream endobj',
  '%%EOF',
].join('\n'), 'latin1');

writeFileSync(join(mathDir, 'FA26_MATH1860J_Week1_26_ex01-1.pdf'),
  fakePdf(['Exercise 3: compute the derivative of sin x using the limit definition']));
writeFileSync(join(mathDir, 'FA26_MATH1860J_Week1_all_lecture_slides.pdf'),
  fakePdf(['Week 1 lecture: limits, continuity and the epsilon delta definition']));
writeFileSync(join(mathDir, 'FA26_MATH1860J_Week1_thumbnail.png'), 'PNG-fake');   // 需 OCR
writeFileSync(join(mathDir, 'FA26_MATH1860J_Week2_rc1.pdf'),
  fakePdf(['Recitation 1: Taylor expansion and the Lagrange remainder']));
// 仿造"数学字体抽出来是字形编号"的真实现象（MATH1860J 的习题页就是这个样子）
writeFileSync(join(mathDir, 'FA26_MATH1860J_Week2_glyph_junk.pdf'),
  fakePdf(['IIII IIIIII II II IIIII PAB:=fx:x2Ax2BgAB1+2+1+n=n+1=:an;ann+1=2']));
writeFileSync(join(statDir, 'lec01', 'lecture 01.ipynb'), JSON.stringify({
  cells: [{ cell_type: 'markdown', source: ['# Association and Causality'] }],
}));
writeFileSync(join(courseRoot, '__MACOSX', '._junk.pdf'), 'junk');
writeFileSync(join(courseRoot, '_重名或重复（可删）', 'old.pdf'), 'junk');

// ---------------- 1. 名字里读周次 / 课程代码 ----------------
ok('文件名里读周次（_Week1_ / 第3周 / W12 都认）',
  weekOf('FA26_MATH1860J_Week1_x.pdf') === 1 && weekOf('第3周讲义.pdf') === 3
  && weekOf('W12 notes.pdf') === 12 && weekOf('随便.pdf') === null);
ok('课程代码：从文件夹名或文件名里都能读',
  courseCodeOf('MATH1860J 高等数学B1') === 'MATH1860J'
  && courseCodeOf('ENGR1010J 计算机导论') === 'ENGR1010J' && courseCodeOf('没有代码') === null);

// ---------------- 2. 扫目录 ----------------
const scan = scanCourseMaterials(courseRoot);
ok('扫到 2 门课（_ 开头与 __MACOSX 跳过）',
  scan.ok && scan.courses.length === 2, JSON.stringify(scan.courses.map((c) => c.name)));
ok('被跳过的目录有记录（不偷偷忽略）',
  scan.skipped.includes('__MACOSX') && scan.skipped.includes('_重名或重复（可删）'));
{
  const math = scan.courses.find((c) => c.name.startsWith('MATH1860J'));
  ok('课程代码来自文件夹名', math.code === 'MATH1860J');
  ok('材料都扫到（5 份）', math.files.length === 5, String(math.files.length));
  ok('周次去重并排好（W1、W2）', JSON.stringify(math.weeks) === '[1,2]', JSON.stringify(math.weeks));
  ok('相对路径统一用 /（不写死 Windows 反斜杠）',
    math.files.every((f) => !f.rel.includes('\\')), JSON.stringify(math.files.map((f) => f.rel)));
}
ok('子文件夹里（lec01/）的文件也能扫到',
  scan.courses.find((c) => c.name.startsWith('STAT1000J')).files.some((f) => f.name === 'lecture 01.ipynb'));
ok('没配置目录 → ok:false 且有人话原因',
  scanCourseMaterials('').ok === false && scanCourseMaterials('').error.includes('还没配置'));
ok('目录不存在 → ok:false 且说清哪个路径',
  scanCourseMaterials(join(root, '没这个')).error.includes('不存在'));

// ---------------- 3. 读成文字 ----------------
const materials = readMaterials(scan.courses);
ok('每份材料都有一条记录', materials.length === 6, String(materials.length));
{
  const ex = materials.find((m) => m.name.endsWith('26_ex01-1.pdf'));
  ok('PDF 读成文字并抽出关键词',
    ex && ex.status === 'ok' && ex.chars > 0 && ex.keywords.some((k) => k.toLowerCase().includes('derivative')),
    JSON.stringify(ex && ex.keywords));
}
ok('图片 → needs_ocr，不假装读到', materials.some((m) => m.status === 'needs_ocr' && m.kind === 'image'));
ok('抽出来是字形编号的 → 标 garbled（不冒充"可读"）',
  materials.some((m) => m.status === 'garbled' && m.name.includes('glyph_junk')
    && m.note.includes('乱码')), JSON.stringify(materials.find((m) => m.name.includes('glyph_junk'))?.status));
{
  // 乱码文件里"正常字体的那几段"要能救回来（标题常常是标准字体），否则搜索一点机会都没有
  const salvaged = Object.assign({}, materials.find((m) => m.name.includes('glyph_junk')));
  ok('乱码文件里救不出可读段落时不硬凑（不塞 text）', !salvaged.text || Array.isArray(salvaged.segments));
  const mixed = readMaterials([{ name: '混合字体', files: [{
    name: 'mixed.pdf', abs: join(mathDir, 'FA26_MATH1860J_Week2_rc1.pdf'), kind: 'pdf', ext: '.pdf', size: 1, week: 2,
  }] }]);
  ok('正常 PDF 不会被误标成乱码', mixed[0].status === 'ok', mixed[0].status);
}
ok('ipynb 也读', materials.some((m) => m.kind === 'notebook' && m.status === 'ok' && m.text.includes('Causality')));
ok('读过的材料带着段落（供定位用）',
  Array.isArray(materials.find((m) => m.name.endsWith('all_lecture_slides.pdf')).segments));
ok('可读格式清单与 coursetext 的分类对得上',
  READABLE_KINDS.includes('pdf') && READABLE_KINDS.includes('slides') && READABLE_KINDS.includes('doc'));

// ---------------- 4. 生成索引 ----------------
const built = buildMaterialIndex({ root: courseRoot, materials, generatedAt: '2026-09-24T18:00:00.000Z' });
ok('索引有标题与大小统计',
  built.markdown.startsWith('# 课程资料索引') && built.markdown.includes('共 2 门课 / 6 份材料')
  && built.markdown.includes('2026-09-24T18:00:00.000Z'));
ok('按课程分节、按周次分组',
  built.markdown.includes('## MATH1860J 高等数学B1') && built.markdown.includes('### Week 1')
  && built.markdown.includes('### Week 2'));
ok('每份材料一行（类型 / 大小 / 文字 / 关键词）',
  built.markdown.includes('FA26_MATH1860J_Week1_26_ex01-1.pdf') && built.markdown.includes('| pdf |'));
ok('读不进去的单列一节，写清是"需 OCR"',
  built.markdown.includes('机器读不进去的') && built.markdown.includes('thumbnail.png'));
ok('统计数字对得上（6 份：可读 4 · 乱码 1 · 需 OCR 1）',
  built.stats.files === 6 && built.stats.ok === 4 && built.stats.garbled === 1 && built.stats.needs_ocr === 1,
  JSON.stringify(built.stats));
ok('乱码的也在"要你自己翻"那一节里，且写了"看原文"',
  built.markdown.includes('glyph_junk.pdf') && built.markdown.includes('乱码·看原文'));
ok('一句话汇总（给通知用）',
  summarizeIndex(built.stats).includes('6 份材料') && summarizeIndex(built.stats).includes('乱码 1'));
{
  const only = buildMaterialIndex({ root: courseRoot, materials, courseFilter: 'STAT1000J' });
  ok('可以只看一门课', only.markdown.includes('## STAT1000J') && !only.markdown.includes('## MATH1860J'));
}
{
  const piped = buildMaterialIndex({
    root: courseRoot,
    materials: [{ course: 'A|B', name: 'x|y.pdf', kind: 'pdf', size: 10, status: 'ok', chars: 5 }],
  });
  ok('文件名里的竖线会被转义（不把表格撑坏）', piped.markdown.includes('x\\|y.pdf'));
}
{
  const withEmpty = buildMaterialIndex({
    root: courseRoot, materials,
    courseNames: ['MATH1860J 高等数学B1', 'MARX1224 思想文化素养'],
  });
  ok('还没材料的课也如实列出来（不悄悄消失）',
    withEmpty.markdown.includes('## MARX1224 思想文化素养') && withEmpty.markdown.includes('这个文件夹里还没有材料'));
  ok('课程数按真实课程数算（含空文件夹）', withEmpty.markdown.includes('共 3 门课'), withEmpty.markdown.split('\n')[2]);
}

// ---------------- 5. 在材料里找一段话 ----------------
{
  const hits = searchMaterials(materials, 'Lagrange remainder');
  ok('说得清"哪门课、哪个文件、第几段附近"',
    hits.length === 1 && hits[0].course.startsWith('MATH1860J') && hits[0].name.endsWith('rc1.pdf')
    && hits[0].segment === 1 && hits[0].where === '正文' && hits[0].context.includes('Lagrange'), JSON.stringify(hits));
  const byName = searchMaterials(materials, '26_ex01-1');
  ok('正文抽不出来的材料，靠文件名也能被搜到（并如实说命中的是文件名）',
    byName.length === 1 && byName[0].where === '文件名' && byName[0].name.includes('26_ex01-1'), JSON.stringify(byName));
  ok('找不到就是空数组（不猜）', searchMaterials(materials, '量子力学').length === 0);
  ok('空查询 → 空数组', searchMaterials(materials, '  ').length === 0);
}

// ---------------- 6. 写文件的边界 ----------------
const studyDir = studyDirOf(dataDir);
ok('studyPath 只接受干净的文件名',
  studyPath(studyDir, 'material-index.md') === join(studyDir, 'material-index.md')
  && studyPath(studyDir, '../跑出去.md') === null && studyPath(studyDir, 'a/b.md') === null
  && studyPath(studyDir, '.hidden') === null && studyPath(studyDir, '') === null);
ok('insideStudy 挡住"写到别人家里去"',
  insideStudy(studyDir, join(studyDir, 'x.md')) && !insideStudy(studyDir, join(root, 'x.md'))
  && !insideStudy(studyDir, join(studyDir, '..', 'x.md')));
{
  const r = writeStudyFile({ target: { path: join(studyDir, 'ok.md') }, payload: { text: '# 好' } }, { studyDir });
  ok('正常写入产物目录',
    r.ok === true && existsSync(join(studyDir, 'ok.md')) && readFileSync(join(studyDir, 'ok.md'), 'utf8') === '# 好');
}
{
  const r = writeStudyFile({ target: { path: join(root, '越过界.md') }, payload: { text: 'x' } }, { studyDir });
  ok('想写到产物目录外面 → 拒绝，并说清只允许写哪', r.ok === false && r.error.includes('只允许往'));
}
ok('没有内容 / 没有路径 → 拒绝',
  writeStudyFile({ payload: { text: 'x' } }, { studyDir }).ok === false
  && writeStudyFile({ target: { path: join(studyDir, 'a.md') }, payload: {} }, { studyDir }).ok === false);

// ---------------- 7. 功能本体（真跑一遍） ----------------
const stack = createCourseStack({ dataDir, env: { PLANNER_COURSE_DIR: courseRoot } });
const mod = await import(pathToFileURL(join(ROOT, 'modules', 'course-assist', 'run.js')).href);
const ctxOf = (s = stack) => ({ ...s.extraContext(), log: () => {}, module: { id: 'course-assist' } });

{
  const actions = await mod.run({ mode: 'index' }, ctxOf());
  ok('跑出来一条 file 动作（写资料索引）',
    actions.length === 1 && actions[0].type === 'file'
    && actions[0].target.path === join(studyDir, 'material-index.md'),
    JSON.stringify(actions.map((a) => a.type)));
  ok('动作里带着要写的正文（不是空壳）', actions[0].payload.text.includes('# 课程资料索引'));
  ok('演练：规范化之后停在 planned',
    normalizeActions(actions, { moduleId: 'course-assist', dryRun: true })[0].status === 'planned');

  const real = normalizeActions(actions, { moduleId: 'course-assist', dryRun: false })[0];
  ok('真跑：file 是"有执行能力"的类型（不是未实现）',
    IMPLEMENTED_TYPES.includes('file') && canExecute(real, { dryRun: false }).ok === true,
    JSON.stringify(canExecute(real, { dryRun: false })));
  const w = stack.writeFile(real);
  ok('真写：文件落在 <数据目录>/study/，内容就是索引',
    w.ok === true && readFileSync(join(studyDir, 'material-index.md'), 'utf8').includes('## MATH1860J'),
    JSON.stringify(w));
}
ok('还不知道的 mode → 什么都不做（返回空数组，不硬造产物）',
  (await mod.run({ mode: 'cram' }, ctxOf())).length === 0);
{
  // 能力③：每周巩固包（mode=weekly）
  const withWeek = createCourseStack({
    dataDir, env: { PLANNER_COURSE_DIR: courseRoot },
      // 2026-09-28：学期起点也按**本地时间**给（不带 +08:00）。下面 expectedWeek 是按
      // 本地日期各算各的，两边必须用同一套解释；写死 +08:00 会在 UTC 的 runner 上差一周。
      termStart: () => '2026-09-14T00:00:00',
  });
  const actions = await mod.run({ mode: 'weekly', week: 1 }, ctxOf(withWeek));
  ok('weekly：产出一条 file 动作，文件名是 week-1-巩固.md',
    actions.length === 1 && actions[0].type === 'file'
    && actions[0].target.path === join(studyDir, 'week-1-巩固.md'),
    JSON.stringify(actions.map((a) => a.target && a.target.path)));
  ok('weekly：正文是巩固包（不是空壳）', actions[0].payload.text.includes('第 1 周巩固包'));
  const real2 = normalizeActions(actions, { moduleId: 'course-assist', dryRun: false })[0];
  const w = withWeek.writeFile(real2);
  ok('weekly：真写落在 <数据目录>/study/ 里', w.ok === true && existsSync(join(studyDir, 'week-1-巩固.md')), JSON.stringify(w));

  // 不指定 week 时按校历自己算；没有校历时如实提醒，不硬编一个周次
  const byTerm = await mod.run({ mode: 'weekly' }, ctxOf(withWeek));
  // 2026-09-28 修：这里原来写死「现在是第 2 周 / week-2」——一旦真实日期往前走一天就会假失败。
  // 现在按"第 1 周周一 = 2026-09-14"自己算一次周次（和被测代码各算各的），测试不再依赖当天日期。
  const TERM_MONDAY = new Date(2026, 8, 14);
  const mondayOf = (d) => { const x = new Date(d); x.setHours(0, 0, 0, 0); x.setDate(x.getDate() - ((x.getDay() + 6) % 7)); return x; };
  const expectedWeek = Math.floor((mondayOf(new Date()) - mondayOf(TERM_MONDAY)) / (7 * 86400000)) + 1;
  ok(`weekly：不指定周次时按校历算（今天是第 ${expectedWeek} 周）`,
    byTerm.length === 1 && String(byTerm[0].target.path).includes(`week-${expectedWeek}`),
    JSON.stringify(byTerm[0].target));
  const noTerm = createCourseStack({ dataDir, env: { PLANNER_COURSE_DIR: courseRoot }, termStart: () => null });
  const askWeek = await mod.run({ mode: 'weekly' }, ctxOf(noTerm));
  ok('weekly：没有校历时提醒一次（不猜第几周）',
    askWeek.length === 1 && askWeek[0].type === 'notify' && askWeek[0].idempotency_key === 'course-assist:no-week');
}

{
  const empty = createCourseStack({ dataDir: join(root, '空数据目录'), env: {} });
  const actions = await mod.run({}, ctxOf(empty));
  ok('还没设置资料目录 → 提醒一次（带幂等键，不会刷屏）',
    actions.length === 1 && actions[0].type === 'notify' && actions[0].idempotency_key === 'course-assist:no-dir');
  ok('这时不会写任何文件', !existsSync(join(root, '空数据目录', 'study')));
}
ok('没注入能力时（别人手动 import 也一样）→ 返回空数组，不崩', (await mod.run({}, {})).length === 0);

// ---------------- 8. 接线与守卫 ----------------
{
  const srv = readFileSync(join(ROOT, 'server.mjs'), 'utf8');
  const desc = JSON.parse(readFileSync(join(ROOT, 'modules', 'course-assist', 'module.json'), 'utf8'));
  const viewDesc = JSON.parse(readFileSync(join(ROOT, 'modules', 'course-assist-view', 'module.json'), 'utf8'));
  const appSrc = readFileSync(join(ROOT, 'public', 'app.js'), 'utf8');
  const viewSrc = readFileSync(join(ROOT, 'modules', 'course-assist-view', 'view.js'), 'utf8');
  ok('功能声明了"读课程资料 + 写数据目录"这两项能力',
    desc.kind === 'processor' && desc.permissions.includes('fs:read:course') && desc.permissions.includes('fs:write:data'));
  ok('server.mjs 接上了课程能力与 file 执行能力',
    srv.includes('createCourseStack') && srv.includes('writeFile: (a) => course.writeFile(a)')
    && readFileSync(join(ROOT, 'lib', 'processor-executors.mjs'), 'utf8').includes('file: (a)'));
  ok('课程辅助有**自己的一页**（kind=view，不是塞进今日页的小卡）',
    viewDesc.kind === 'view' && viewDesc.entry.view === 'view.js' && !viewDesc.mount_into);
  ok('主界面会挂载 kind=view 的模块页（今天才补上的能力）',
    /function mountGadgets\(viewId\)[\s\S]{0,600}x\.kind === 'view' && x\.id === viewId/.test(appSrc));
  ok('切到模块页时才挂载（懒加载，不给启动添负担）',
    appSrc.includes("MODULE_REGISTRY.some((x) => x.kind === 'view' && x.id === tab)"));
  ok('模块页会把自己的名字写进导航与页面标题',
    appSrc.includes('TITLE_L[l][m.id] = m.name') && appSrc.includes('NAV_L[l][m.id] = m.name'));
  ok('这一页走的是同一套本机目录接口 + 课程状态接口',
    viewSrc.includes("'/api/localdirs'") && viewSrc.includes("'/api/course'")
    && viewSrc.includes("'/api/modules/course-assist/run'"));
  ok('页面上写清了"演练不写文件"与六项能力的真实进度',
    viewSrc.includes('演练不写任何文件') && viewSrc.includes('计划中'));
}
ok('resolveCourseDir 没配置时返回空串（功能优雅降级）',
  resolveCourseDir({ dataDir: join(root, '没配'), env: {} }) === '');

// ---------------- 8.5 能力③：每周巩固包（只摘不编） ----------------
ok('学期第几周：按校历开学日算，没有校历返回 null（不猜）',
    weekNumberFrom('2026-09-14T00:00:00', new Date(2026, 8, 24, 12).getTime()) === 2
  && weekNumberFrom(null) === null && weekNumberFrom('乱写') === null);
{
  const lines = pickLines('这是一个足够长的正常句子\nExercise 3: compute the derivative\n\nx\nExercise 3: compute the derivative\n', { pattern: /exercise/i, max: 5 });
  ok('摘录：只留匹配的行、去掉太短的、去重', lines.length === 1 && lines[0].startsWith('Exercise 3'), JSON.stringify(lines));
  ok('摘录有上限（不会把整份讲义搬进来）',
    pickLines(Array.from({ length: 20 }, (_, i) => `Exercise ${i}: something long enough`).join('\n'), { pattern: /exercise/i, max: 3 }).length === 3);
}
{
  const pack = buildWeeklyPack({
    course: 'MATH1860J', week: 1, materials, generatedAt: '2026-09-24T18:00:00.000Z',
    practice: [{ text: '积分换元总忘记换上下限' }],
  });
  ok('巩固包标题带周次与课程', pack.markdown.startsWith('# 第 1 周巩固包 · MATH1860J'));
  ok('只统计这一周的材料（第 1 周 3 份：2 份可读 + 1 张图）',
    pack.stats.materials === 3 && pack.stats.readable === 2 && pack.stats.unreadable === 1, JSON.stringify(pack.stats));
  ok('按课程分开写（多门课时各成一节）',
    pack.markdown.includes('## MATH1860J 高等数学B1') && pack.markdown.includes('### ① 考点'));
  ok('考点来自材料里的标题行', pack.markdown.includes('考点 / 讲了什么') && pack.markdown.includes('Week 1 lecture'), pack.markdown.slice(0, 300));
  ok('例题/自测题是**原文摘录并带出处**',
    pack.markdown.includes('compute the derivative') && pack.markdown.includes('26_ex01-1.pdf'));
  ok('自测题做成可勾的小方框（用来检验"做不做得出来"）', /- \[ \] 1\./.test(pack.markdown));
  ok('易错点接的是练习反馈（有就写，没有就说没有）', pack.markdown.includes('积分换元总忘记换上下限'));
  ok('读不出来的材料单列"要自己翻的"', pack.markdown.includes('### ④ 要自己翻的') && pack.markdown.includes('thumbnail.png'));
  ok('统计里带上摘了多少条', pack.stats.questions >= 1 && pack.stats.topics >= 1, JSON.stringify(pack.stats));
}
{
  const empty = buildWeeklyPack({ course: 'MATH1860J', week: 99, materials });
  ok('这周没材料时如实说"没找到"，不编题也不编考点',
    empty.markdown.includes('第 99 周巩固包') && empty.stats.materials === 0 && empty.stats.questions === 0);
  ok('没有练习反馈时明说"还没有错题记录"', empty.markdown.includes('还没有错题'));
}
ok('真正的"编题"不会发生：自测题只可能来自材料原文',
  buildWeeklyPack({ course: 'X', week: 1, materials: [{ course: 'X', name: 'a.pdf', week: 1, status: 'garbled', note: '乱码' }] })
    .markdown.includes('与其编几道假的'));

// ---------------- 9. 「这一页」的接口与渲染 ----------------
{
  const routes = createCourseRoutes({
    dataDir, sendJson: (res, code, obj) => { res.code = code; res.body = obj; },
    sendError: (res, code, message) => { res.code = code; res.body = { error: message }; },
    runsOf: () => ({ at: '2026-09-24T18:00:00.000Z', summary: '1 条动作', dry_run: false }),
    search: (q) => ({ ok: true, query: q, scanned: materials.length, hits: searchMaterials(materials, q) }),
  });
  const req = (method) => ({ method });
  const urlOf = (p) => new URL('http://127.0.0.1:3210' + p);

  const res1 = {};
  await routes.handleCourse(req('GET'), res1, urlOf('/api/course'));
  ok('GET /api/course 给目录状态 / 产物清单 / 上次运行',
    res1.code === 200 && typeof res1.body.study_dir === 'string' && Array.isArray(res1.body.outputs)
    && res1.body.last_run.summary === '1 条动作');
  ok('产物清单里能看到刚写出来的资料索引',
    res1.body.outputs.some((o) => o.name === 'material-index.md' && o.size > 0), JSON.stringify(res1.body.outputs));

  const res2 = {};
  await routes.handleCourse(req('GET'), res2, urlOf('/api/course/search?q=Lagrange%20remainder'));
  ok('GET /api/course/search 能找到"在第几段附近"',
    res2.code === 200 && res2.body.hits.length === 1 && res2.body.hits[0].segment === 1, JSON.stringify(res2.body.hits));

  const res3 = {};
  await routes.handleCourse(req('GET'), res3, urlOf('/api/course/search'));
  ok('不给搜索词 → 400 且说清要什么', res3.code === 400 && res3.body.error.includes('q='));

  const res4 = {};
  await routes.handleCourse(req('GET'), res4, urlOf('/api/course/别的'));
  ok('不认识的路径 → 404（不抢别的路由）', res4.code === 404);
}
{
  const view = await import(pathToFileURL(join(ROOT, 'modules', 'course-assist-view', 'view.js')).href);
  ok('这一页导出纯函数 renderPage / renderHits / studyDirOf',
    typeof view.renderPage === 'function' && typeof view.renderHits === 'function' && typeof view.studyDirOf === 'function');
  const page = view.renderPage({
    dir: { dir: 'C:\\课件', exists: true }, study_dir: 'C:\\数据\\study',
    outputs: [{ name: 'material-index.md', size: 11_140, mtime: '2026-09-24T18:28:00.000Z' }],
    last_run: { at: '2026-09-24T18:28:00.000Z', summary: '1 条动作（1 file）', dry_run: false },
  });
  ok('页面上有目录 / 演练 / 真写 / 打开文件夹 / 搜索 / 产物 / 能力 七块',
    page.includes('id="ca-dir"') && page.includes('id="ca-dry"') && page.includes('id="ca-run"')
    && page.includes('id="ca-open"') && page.includes('id="ca-q"') && page.includes('已生成的文件') && page.includes('六项能力'));
  ok('产物与上次运行如实显示', page.includes('material-index.md') && page.includes('11 KB') && page.includes('1 条动作'));
  ok('六项能力里只把①标成已有', page.includes('已有') && page.includes('计划中'));
  ok('页面上有「生成第 N 周巩固包」的两颗按钮（③ 能力③ 的入口）',
    page.includes('id="ca-week-dry"') && page.includes('id="ca-week-run"'));
  ok('搜索结果会标出"第几段（≈第几页）附近"',
    view.renderHits([{ course: 'MATH1860J', name: 'rc1.pdf', segment: 2, context: 'Taylor expansion' }])
      .includes('第 2 段（≈第 2 页）附近'));
  ok('命中文件名时也如实标出来（不假装是正文命中）',
    view.renderHits([{ course: 'STAT1000J', name: 'Lec 02 - Association.pdf', where: '文件名', context: 'x' }])
      .includes('命中的是'));
  ok('搜不到就说搜不到（不编）', view.renderHits([]).includes('没找到'));
  ok('studyDirOf 跟着数据目录的分隔符走',
    view.studyDirOf('C:\\a') === 'C:\\a\\study' && view.studyDirOf('/home/x/') === '/home/x/study');
}

console.log('');
console.log(failures === 0 ? 'course-assist.test: PASS' : `course-assist.test: FAIL (${failures})`);
process.exit(failures === 0 ? 0 : 1);
