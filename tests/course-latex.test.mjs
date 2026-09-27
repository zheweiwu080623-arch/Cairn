// 「PDF → LaTeX（公式还原）」（2026-09-27）
//
//   node tests/course-latex.test.mjs
//
// 用户原话：「没法读取数学公式这个点，能不能把 pdf 反向变成 LaTeX 的代码读取」。
//
// 这里的判据（也是这个功能敢接活的边界）：
//   * PDF 抽出来的文字是**有损**的（实测用户自己的 MATH1860J 习题解：空格全丢、¬∧∨→ 变成 :^_）；
//     所以"还原"只能靠模型按上下文重建 —— 提示词必须**禁止编造**、要求标注读不出来的地方；
//   * **扫描件（没有文字层）不许硬转**：如实说"要 OCR / 视觉模型"，绝不编一段公式；
//   * 转出来的东西只写进 `study/`（写文件走那条唯一的闸门）。

import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const TMP = process.env.PLANNER_TEST_TMP || '';
if (!TMP) {
  console.error('需要 PLANNER_TEST_TMP（run_all_suites.py 会设置）');
  process.exit(2);
}
const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

const {
  LATEX_MAX_CHARS, cleanLatexReply, isNoTextReply, latexOutName, latexPrompt,
  pickReadableMaterials, reviewExtract, visionPrompt,
} = await import('../lib/course-latex.mjs');
const { findRasterizer, renderPdfPages } = await import('../lib/pdf-pages.mjs');
const { buildRequest } = await import('../lib/llm.mjs');
const { createCourseStack } = await import('../lib/course-stack.mjs');
const { createCourseRoutes } = await import('../lib/routes/course.mjs');

let failures = 0;
const ok = (label, cond, detail = '') => {
  if (cond) console.log(`  PASS ${label}`);
  else { failures += 1; console.log(`  FAIL ${label}${detail ? ` -- ${detail}` : ''}`); }
};

console.log('course-latex.test.mjs');

// ---------------- ① 提示词：必须禁止编造 + 要求真 LaTeX + 只补空格不改意思 ----------------
{
  const p = latexPrompt({ course: 'MATH1860J 高等数学B1', file: 'sol.pdf', text: 'ProvethatA,B:(:A^B)_(:B^A)', truncated: true, chars: 1234 });
  ok('提示词里明确"不要编造"并要求标注读不出来的地方',
    p.includes('**不要编造**') && p.includes('读不出来'));
  ok('要求公式写成真 LaTeX（行内 $...$ / 独立 $$...$$，含逻辑符号写法）',
    p.includes('`$...$`') && p.includes('$$') && p.includes('\\neg') && p.includes('\\vdash'));
  ok('要求补空格但**不改意思**（不润色、不总结）',
    p.includes('补回来') && p.includes('不要改写句子的意思') && p.includes('不润色'));
  ok('原文照原样带进提示词，长文截断会说明', p.includes('ProvethatA,B') && p.includes('只给了前 1234 个字'));
  ok('LATEX_MAX_CHARS 是个有限值（防止一次塞爆上下文）', Number.isFinite(LATEX_MAX_CHARS) && LATEX_MAX_CHARS > 0);
}

// ---------------- ② 产物名与回复清洗 ----------------
{
  ok('产物名：`Lecture05.pdf` → `Lecture05.公式.md`', latexOutName('Lecture05.pdf') === 'Lecture05.公式.md');
  ok('产物名只取文件名本身（带目录的输入不会穿越出去）',
    latexOutName('C:\\x\\y\\讲义.PDF') === '讲义.公式.md');
  ok('模型把整段包在 ```markdown 里 → 外壳被剥掉',
    cleanLatexReply('```markdown\n# 标题\n$x^2$\n```') === '# 标题\n$x^2$');
  ok('模型先说"好的" → 那行去掉', !cleanLatexReply('好的，下面是整理结果：\n\n公式 $a=b$').startsWith('好的'));
  ok('NO_TEXT 能被认出来（模型明说读不出）', isNoTextReply('NO_TEXT — 全是字形编号'));
  ok('视觉提示词也是"不编造 + 真 LaTeX + 保留题号"，并带上页码',
    visionPrompt({ course: 'C', file: 'f.pdf', page: 2, total: 3 }).includes('不要编造')
    && visionPrompt({}).includes('$...$') && visionPrompt({ page: 2, total: 3 }).includes('第 2 页'));

  // 发图能力：OpenAI 风格把图塞进 content 数组；不发图时与以前逐字节相同
  const cfg = { provider: 'openai', base_url: 'https://x/v1', model: 'm', api_key: 'k' };
  const noImg = JSON.stringify(buildRequest(cfg, 'hi', {}).body);
  const stillNoImg = JSON.stringify(buildRequest(cfg, 'hi', { images: [] }).body);
  ok('不传图时请求体与以前完全一样（老行为不受影响）', noImg === stillNoImg);
  const withImg = buildRequest(cfg, 'hi', { images: [{ mime: 'image/png', base64: 'AAA' }] }).body;
  const content = withImg.messages[0].content;
  ok('传图时用 OpenAI 的 content 数组（text + image_url data URL）',
    Array.isArray(content) && content[0].type === 'text' && content[1].image_url.url.startsWith('data:image/png;base64,AAA'),
    JSON.stringify(content).slice(0, 200));
  // Responses 接口（用户这台就走这条）：input 要变成带 input_image 的数组
  const resp = buildRequest({ provider: 'codex-config', base_url: 'http://127.0.0.1:1/v1', model: 'm', wire_api: 'responses' },
    'hi', { images: [{ mime: 'image/png', base64: 'AAA' }] });
  ok('Responses 通道也把图放进 input（input_text + input_image），并标 images_ok',
    resp.images_ok === true && Array.isArray(resp.body.input)
    && resp.body.input[0].content[1].type === 'input_image'
    && resp.body.input[0].content[1].image_url.startsWith('data:image/png;base64,AAA'),
    JSON.stringify(resp.body).slice(0, 240));
  ok('codex-cli 通道不认识 HTTP 请求体（images_ok 不会是 true）',
    buildRequest({ provider: 'codex-cli' }, 'hi', { images: [{ mime: 'image/png', base64: 'AAA' }] }) === null);
}

// ---------------- ②b PDF 渲染成图（视觉路线的前半截） ----------------
{
  ok('找不到渲染工具时如实说（并给"截图给 Codex"的退路）',
    findRasterizer({ candidates: ['C:\\没有这个\\pdftoppm.exe'], exists: () => false }) === '');
  ok('候选里有的就选它', findRasterizer({ candidates: ['C:\\a\\pdftoppm.exe'], exists: (p) => p === 'C:\\a\\pdftoppm.exe' }) === 'C:\\a\\pdftoppm.exe');
  ok('绝对路径都没有时会去扫 PATH（而不是直接回一个可能不存在的名字）',
    findRasterizer({ candidates: [], exists: () => false }) === '');

  const noBin = await renderPdfPages('C:\\x.pdf', { bin: 'C:\\none\\pdftoppm.exe', runner: (cmd, args, opts, cb) => cb(new Error('ENOENT')) });
  ok('渲染工具不存在 → ok:false + 说得清（不是抛异常）', !noBin.ok && /渲染失败/.test(noBin.error), JSON.stringify(noBin));

  // 有渲染工具就**真渲染一张**（手写一个最小 PDF）；没有就只验上面那条诚实报错
  const real = findRasterizer();
  if (real) {
    const root2 = mkdtempSync(join(TMP, 'pdf-pages-'));
    const pdf = join(root2, 'tiny.pdf');
    writeFileSync(pdf, Buffer.from(
      '%PDF-1.4\n'
      + '1 0 obj<</Type/Catalog/Pages 2 0 R>>endobj\n'
      + '2 0 obj<</Type/Pages/Kids[3 0 R]/Count 1>>endobj\n'
      + '3 0 obj<</Type/Page/Parent 2 0 R/MediaBox[0 0 200 100]/Contents 4 0 R/Resources<</Font<</F1 5 0 R>>>>>>endobj\n'
      + '4 0 obj<</Length 44>>stream\nBT /F1 24 Tf 20 40 Td (Hello x2) Tj ET\nendstream endobj\n'
      + '5 0 obj<</Type/Font/Subtype/Type1/BaseFont/Helvetica>>endobj\n'
      + 'trailer<</Root 1 0 R>>\n%%EOF\n', 'utf8'));
    const r = await renderPdfPages(pdf, { first: 1, last: 1 });
    ok(`真渲染一页 → 拿到 PNG（用 ${real.split('\\').pop()}）`,
      r.ok && r.pages.length === 1 && r.pages[0].png.length > 200, JSON.stringify({ ok: r.ok, n: r.pages.length, err: r.error }));
  } else {
    console.log('  SKIP 这台机器没有 pdftoppm，跳过"真渲染"那一条（诚实报错那条已经验过）');
  }
}

// ---------------- ③ 可信度分级：三档，扫描件绝不硬转 ----------------
{
  const blocked = reviewExtract({ ok: false, error: '图片没有文字层，需要 OCR', needsOcr: true });
  ok('没有文字层（扫描件）→ blocked，并给"截图给 Codex"的退路',
    blocked.level === 'blocked' && blocked.canConvert === false && blocked.note.includes('截图'));
  const tiny = reviewExtract({ ok: true, text: 'x', chars: 3, quality: 1, garbled: false });
  ok('抽出来的字太少 → blocked（不硬转）', tiny.level === 'blocked' && !tiny.canConvert);
  const garbled = reviewExtract({ ok: true, text: 'x'.repeat(200), chars: 200, quality: 0.97, garbled: true });
  ok('文字层有损（数学 PDF 常见）→ 能转，但**明说是模型重建的、要对着原 PDF 核**',
    garbled.level === 'warn' && garbled.canConvert && garbled.note.includes('核'));
  const clean = reviewExtract({ ok: true, text: 'y'.repeat(300), chars: 300, quality: 1, garbled: false });
  ok('文字层干净 → ok', clean.level === 'ok' && clean.canConvert);
}

// ---------------- ④ 材料清单（给界面下拉） ----------------
{
  const scan = {
    ok: true,
    courses: [
      { name: 'MATH1860J 高等数学B1', code: 'MATH1860J', files: [
        { name: 'sol.pdf', kind: 'pdf', size: 100, week: 2 },
        { name: 'notes.png', kind: 'image', size: 50, week: 2 },
      ] },
    ],
  };
  const items = pickReadableMaterials(scan);
  ok('清单里有材料，且标出"能不能读文字"（图片类 readable=false）',
    items.length === 2 && items[0].readable === true && items.some((x) => x.file === 'notes.png' && x.readable === false));
}

// ---------------- ④b 回归：材料在子文件夹里也要能找到（2026-09-27 真机撞到的 ENOENT） ----------------
{
  const items = pickReadableMaterials({
    ok: true,
    courses: [{
      name: 'MATH1860J 高等数学B1',
      code: 'MATH1860J',
      files: [{ name: 'ex01.pdf', rel: 'MATH1860J 高等数学B1/Week01/ex01.pdf', abs: 'C:\\x\\Week01\\ex01.pdf', kind: 'pdf', size: 10 }],
    }],
  });
  ok('清单带着 rel / abs（否则子文件夹里的材料会被拼成错路径）',
    items[0].rel.endsWith('Week01/ex01.pdf') && items[0].abs.includes('Week01'), JSON.stringify(items[0]));
}

// ---------------- ⑤ 接 stack 跑一遍（假模型 + 临时目录）：真的写进 study/ ----------------
{
  const root = mkdtempSync(join(TMP, 'course-latex-'));
  const dataDir = join(root, 'data');
  const courseDir = join(root, 'course');
  const mathDir = join(courseDir, 'MATH1860J 高等数学B1');
  const weekDir = join(mathDir, 'Week01');          // 故意放进子文件夹（真机的目录就是这样）
  mkdirSync(join(dataDir, 'study'), { recursive: true });
  mkdirSync(weekDir, { recursive: true });
  // 用 .txt 当材料（真读得到）；写够 LATEX_MIN_CHARS 以上的长度，否则会被"字太少"挡下（那是预期行为）
  writeFileSync(join(weekDir, 'sol.txt'), [
    'Exercise 1: Logic Operations. ProvethatA,B:(:A^B)_(:B^A).',
    'Writethenegationofeachofthefollowingformulasandsimplifytheresult.',
    '(a) A^(:B)  (b) :(A_B)  (c) (A_B)_(:C)  (d) :(A^B)vC',
    'Exercise 2: Sets. Show that (A u B) n C = (A n C) u (B n C).',
  ].join('\n'), 'utf8');
  const prompts = [];
  const stack = createCourseStack({
    dataDir, env: { PLANNER_COURSE_DIR: courseDir },
    askAgent: async (prompt) => { prompts.push(prompt); return { ok: true, text: '```markdown\n(1) $A,B \\vdash (\\neg A \\lor B) \\to (\\neg B \\lor A)$\n```' }; },
    log: () => {},
  });
  const mats = stack.materials();
  ok('材料清单能从课程目录扫出来', mats.ok && mats.items.some((m) => m.file === 'sol.txt'), JSON.stringify(mats.items));

  // 走"界面传上来的那两个字段"：rel（唯一）+ file（文件名）—— 子文件夹里也要能找到
  const rel = mats.items.find((m) => m.file === 'sol.txt').rel;
  const r = await stack.convertToLatex({ file: 'sol.txt', rel, course: 'MATH1860J' });
  // 注意：这份夹具故意写成"没有空格"的数学原文（就是真 PDF 抽出来的样子）⇒ 会被判成 warn
  ok('转成功，并且回传产物名 / 路径 / 可信度等级 / 正文（这类"没空格"的原文判 warn）',
    r.ok && r.out === 'sol.公式.md' && r.level === 'warn' && r.markdown.includes('\\vdash'), JSON.stringify(r).slice(0, 240));
  const written = readFileSync(join(dataDir, 'study', 'sol.公式.md'), 'utf8');
  ok('文件真的写进了 <数据目录>/study/，且带来源与"抽取有损"的说明',
    written.includes('\\vdash') && written.includes('抽取有损') && written.includes('sol.txt'));
  ok('提示词里带上了原文（模型不是凭空写的）', prompts[0].includes('ProvethatA,B'));

  const miss = await stack.convertToLatex({ file: '没有这份.pdf' });
  ok('材料不存在 → 如实报错（不是编一个结果）', !miss.ok && /找不到/.test(miss.error), JSON.stringify(miss));

  const noAgent = createCourseStack({ dataDir, env: { PLANNER_COURSE_DIR: courseDir } });
  const r2 = await noAgent.convertToLatex({ file: 'sol.txt' });
  ok('没有配 agent → 明说做不了（并指路去哪配）', !r2.ok && /Agent 接入/.test(r2.error), JSON.stringify(r2));

  // 视觉路线：非 PDF 会被挡下（这条不需要渲染工具，跨机器都能测）
  const r3 = await stack.convertToLatex({ file: 'sol.txt', mode: 'vision' });
  ok('视觉路线只对 PDF 有效（对 .txt 如实挡下）', !r3.ok && /只对 PDF/.test(r3.error), JSON.stringify(r3));
}

// ---------------- ⑥ 接口：POST /api/course/latex ----------------
{
  const routes = createCourseRoutes({
    sendJson: (res, code, body) => { res.code = code; res.body = body; },
    sendError: (res, code, msg) => { res.code = code; res.body = { error: msg }; },
    readBody: async (req) => req.body || {},
    materials: () => ({ ok: true, items: [{ file: 'a.pdf', course: 'C', readable: true }] }),
    convert: async ({ file }) => ({ ok: true, file, out: 'a.公式.md', level: 'ok', markdown: '$x$' }),
  });
  const res = {};
  await routes.handleCourse({ method: 'POST', body: { file: 'a.pdf' } }, res, new URL('http://x/api/course/latex'));
  ok('POST /api/course/latex → 200 且带上转换结果', res.code === 200 && res.body.ok && res.body.out === 'a.公式.md');
  const res2 = {};
  await routes.handleCourse({ method: 'GET' }, res2, new URL('http://x/api/course'));
  ok('GET /api/course 里带上了材料清单（给下拉用）',
    res2.code === 200 && Array.isArray(res2.body.materials) && res2.body.materials[0].file === 'a.pdf');
  const res3 = {};
  await routes.handleCourse({ method: 'POST', body: {} }, res3, new URL('http://x/api/course/latex'));
  ok('没给 file 时不炸（转换器自己会说"没说转哪一份"）', res3.code === 200);
}

// ---------------- ⑦ 接线守卫 ----------------
{
  const app = readFileSync(join(ROOT, 'public', 'app.js'), 'utf8');
  const view = readFileSync(join(ROOT, 'modules', 'course-assist-view', 'view.js'), 'utf8');
  const srv = readFileSync(join(ROOT, 'server.mjs'), 'utf8');
  ok('课程辅助页有「公式转 LaTeX」卡片与接线',
    view.includes('公式转 LaTeX') && view.includes("api('POST', '/api/course/latex'"));
  ok('页面会把"扫描件转不了"如实显示出来，并给截图的退路',
    view.includes('扫描件') && view.includes('截图'));
  ok('主程序把 askAgent 接进课程 stack（模型出口）', srv.includes('askAgent,                        // 「公式转 LaTeX」用'));
  // 2026-09-27 真机撞到的：stack 里用了 findRasterizer / renderPdfPages / visionPrompt，
  // 但 import 漏了 ⇒ 只有真机点"用视觉读"才会 500（单测走不到那一步）。这里钉住。
  {
    const stack = readFileSync(join(ROOT, 'lib', 'course-stack.mjs'), 'utf8');
    ok('course-stack 真的 import 了视觉路线要用的三样（findRasterizer / renderPdfPages / visionPrompt）',
      /import \{ findRasterizer, renderPdfPages \} from '\.\/pdf-pages\.mjs'/.test(stack)
      && /visionPrompt/.test(stack.split('\n').slice(0, 30).join('\n')),
      stack.split('\n').slice(12, 22).join(' | '));
  }
  ok('main 程序仍在 <2100 行闸门内', srv.split('\n').length < 2100, String(srv.split('\n').length));
}

console.log('');
console.log(failures === 0 ? 'course-latex.test: PASS' : `course-latex.test: FAIL (${failures})`);
process.exit(failures === 0 ? 0 : 1);
