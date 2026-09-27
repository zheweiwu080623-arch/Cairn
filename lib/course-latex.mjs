// course-latex.mjs —— 「把课件的数学公式还原成 LaTeX」（2026-09-27）
//
// 用户的诉求原话：「没法读取数学公式这个点，能不能把 pdf 反向变成 LaTeX 的代码读取」。
//
// 先说清**能做到什么、做不到什么**（这是这个文件存在的理由）：
//   * PDF 里的文字是**排版指令**，不是公式结构。用纯 JavaScript 抽出来的东西必然有损：
//     LaTeX 排版的数学 PDF 会**丢掉所有空格**、把 ¬ ∧ ∨ → ⊢ 变成 `: ^ _` 之类近似 ASCII。
//     实测（用户自己的 MATH1860J 习题解）：`A,B:(:A^B)_(:B^A)` 其实是 `A,B ⊢ (¬A∨B)→(¬B∨A)`。
//   * 所以"PDF → LaTeX"**不可能**靠一个确定性函数做到 —— 真正的还原要靠**模型按上下文重建**。
//     这里负责的是：判断这份材料值不值得转 / 能转成什么样 / 风险有多大，然后把话说清楚。
//   * **扫描件（图片版 PDF）没有文字层**：直接如实拒绝（需要 OCR 或视觉模型），
//     绝不让模型对着空白硬编一段公式出来。
//
// 纯函数（可单测）：提示词、输出文件名、可信度分级、回复清洗、材料清单筛选。
// 真正调用模型与写文件在 lib/course-stack.mjs（那边有"只写 study 目录"的闸门）。

/** 一次喂给模型的原文上限（再长就截断，并在提示词里说明，免得它以为读完了）。 */
export const LATEX_MAX_CHARS = 12000;
/** 少于这么多字就不值得转（多半是抽取失败或只有页眉页脚）。 */
export const LATEX_MIN_CHARS = 120;

/**
 * 整理成 LaTeX 的提示词。
 * 三条硬要求：不编造 / 公式必须是真 LaTeX / 只补空格不改意思。
 */
export function latexPrompt({ course = '', file = '', text = '', truncated = false, chars = 0 } = {}) {
  return [
    '你在帮一个学生把他自己的课程资料（PDF 课件）整理成**能读、能搜**的 Markdown + LaTeX。',
    '',
    '注意：下面这段文字是从 PDF 里**抽取**出来的，抽取过程有损 —— LaTeX 排版的数学内容经常',
    '**整段丢失空格**，并且把逻辑/数学符号换成了近似 ASCII（例如 `:` 可能是 ¬，`^` 可能是 ∧，',
    '`_` 可能是 →，`v` 可能是 ∨）。请按上下文把这些还原成**真正的 LaTeX**。',
    '',
    '硬要求（请逐条遵守）：',
    '1. **不要编造**。只依据下面这段文字。看不清、缺内容的地方写一行 `<!-- 读不出来：原因 -->`，',
    '   不要猜一个"看起来合理"的公式或结论。',
    '2. 数学一律写成 LaTeX：行内 `$...$`，独立公式 `$$...$$`；上下标、分数、希腊字母、',
    '   逻辑符号用标准写法（\\neg \\land \\lor \\to \\leftrightarrow \\vdash \\frac{}{} \\sum 等）。',
    '3. 把丢掉的空格补回来（英文按单词、中文按词），但**不要改写句子的意思**：不润色、不总结、',
    '   不换标题、不加你自己的评论。',
    '4. 保留原文的题号与小节顺序（Exercise 1 / (1) / (2) 这种照原样）。',
    '5. 如果整段几乎都是无法辨认的字形编号，直接只回答一行：`NO_TEXT`。',
    '',
    `课程：${course || '(未知)'}`,
    `文件：${file || '(未知)'}`,
    truncated ? `（注意：原文较长，这里只给了前 ${chars || LATEX_MAX_CHARS} 个字，请在结尾用一行注明「（后略）」）` : '',
    '',
    '原文如下：',
    '---',
    String(text || ''),
    '---',
  ].filter((x) => x !== '').join('\n');
}

/** 产物文件名：`Lecture05.pdf` → `Lecture05.公式.md`（只留文件名本身，防目录穿越）。 */
export function latexOutName(fileName) {
  const base = String(fileName || '').split(/[\\/]/).pop() || '';
  const stem = base.replace(/\.[a-z0-9]{1,6}$/i, '').trim() || '未命名';
  return `${stem}.公式.md`;
}

/**
 * 这份材料**转出来的东西有多可信**（先看能不能转，再说风险）。
 * @returns {{level:'blocked'|'warn'|'ok', note:string, canConvert:boolean}}
 */
export function reviewExtract(extract = {}) {
  if (!extract.ok) {
    const needsOcr = extract.needsOcr || /OCR|没有文字层/.test(String(extract.error || ''));
    return {
      level: 'blocked', canConvert: false,
      note: needsOcr
        ? '这份材料没有文字层（扫描件 / 图片版 PDF）—— 转不出公式。要读它得用 OCR 或视觉模型：把这几页截图发给 Codex，让它看着图转。'
        : `读不出来：${extract.error || '未知原因'}`,
    };
  }
  const chars = Number(extract.chars) || 0;
  if (chars < LATEX_MIN_CHARS) {
    return { level: 'blocked', canConvert: false, note: `只抽到 ${chars} 个字，太少了（多半是抽取失败或只有页眉页脚）—— 先确认这份文件本身有内容。` };
  }
  if (extract.garbled) {
    return {
      level: 'warn', canConvert: true,
      note: '这份 PDF 的文字层有损（LaTeX 排版常见：空格全丢、符号变成近似 ASCII）。下面转出来的公式是**模型按上下文重建的**，关键结论请对着原 PDF 核一遍。',
    };
  }
  if (extract.lowQuality) {
    return { level: 'warn', canConvert: true, note: '这份材料的文字层质量偏低，转出来的公式可能有偏差；建议对着原 PDF 抽查几处。' };
  }
  return { level: 'ok', canConvert: true, note: '文字层干净，公式按原文排版还原。' };
}

/** 模型有时候会把整段包在 ```markdown 里，或者先说一句"好的" —— 这里清掉外壳。 */
export function cleanLatexReply(reply) {
  let s = String(reply == null ? '' : reply).trim();
  const fence = s.match(/^```[a-zA-Z]*\s*\n([\s\S]*?)\n?```$/);
  if (fence) s = fence[1].trim();
  s = s.replace(/^(好的|好，|下面是|以下是)[^\n]*\n+/, '');
  return s;
}

/** 模型明确说读不出来（约定的一句话）。 */
export function isNoTextReply(markdown) {
  return /^NO_TEXT\b/i.test(String(markdown || '').trim());
}

/**
 * 视觉路线的提示词：给的是**这一页的图片**（不是文字层）。
 * 为什么需要另一套：文字层是字形编号的 PDF（LaTeX / PPT 导出）只能看图 —— 看图就没有"丢空格"的问题，
 * 但同样要禁止编造：看不清的公式宁可标出来。
 */
export function visionPrompt({ course = '', file = '', page = 1, total = 1 } = {}) {
  return [
    '这是某个学生自己课程课件的一页**截图**（PDF 渲染出来的图，不是文字）。请把它整理成 Markdown + LaTeX。',
    '',
    '硬要求：',
    '1. **不要编造**：只写图里真正有的内容。看不清的符号、被裁掉的公式，写 `<!-- 读不出来：原因 -->`。',
    '2. 所有数学写成 LaTeX：行内 `$...$`，独立公式 `$$...$$`；上下标、分数、根号、求和、',
    '   希腊字母、逻辑符号都用标准写法。',
    '3. 保留图里的结构：标题、小节、题号（Exercise 1 / (1) / (2)）、列表、表格按原样。',
    '4. 中文/英文之间该有的空格补上；**不要改写意思**，不要加你自己的解释。',
    '5. 如果是纯图片页（只有照片 / 插画、没有可读文字），直接回答 `NO_TEXT`。',
    '',
    `课程：${course || '(未知)'}`,
    `文件：${file || '(未知)'}`,
    `页码：第 ${page} 页${total > 1 ? `（本次共 ${total} 页）` : ''}`,
  ].join('\n');
}

/**
 * 从课件目录扫描结果里挑出"能被转换的材料"，给界面做下拉。
 * 不读文件内容（只看扩展名与大小），所以很便宜；能不能转由 reviewExtract 在真读之后判。
 */
export function pickReadableMaterials(scan, { limit = 60 } = {}) {
  const out = [];
  for (const c of (scan && scan.courses) || []) {
    for (const f of c.files || []) {
      out.push({
        course: c.name,
        code: c.code || '',
        file: f.name,
        // rel/abs 必须带着走：材料常放在 Week01/ 这种子文件夹里，
        // 只拿文件名去拼路径会 ENOENT（2026-09-27 真机撞到的）。
        rel: f.rel || f.name,
        abs: f.abs || '',
        kind: f.kind,
        size: f.size || 0,
        week: f.week == null ? null : f.week,
        readable: (f.kind === 'text' || f.kind === 'notebook' || f.kind === 'slides' || f.kind === 'doc' || f.kind === 'pdf'),
      });
    }
  }
  out.sort((a, b) => Number(b.readable) - Number(a.readable) || String(a.course).localeCompare(String(b.course), 'zh'));
  return out.slice(0, limit);
}
