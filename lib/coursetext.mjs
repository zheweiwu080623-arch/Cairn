// coursetext.mjs —— 把课程材料**读成文字**（课程辅助的地基，D4）
//
// 为什么要有它：课件、习题、讲义大多是 PDF / PPTX / DOCX / ipynb；要让机器"看懂里面有什么"，
// 第一步永远是把文件读成文本。这一层做好了，题单、巩固包、考前速览都只是"在文本上做加工"。
//
// 零依赖实现（这是这个项目的硬规矩），支持：
//   .txt/.md/.csv/.json/.tex/.py/.c/.cpp  → 直接读
//   .ipynb                               → 取 markdown 与代码单元
//   .pptx / .docx                        → 自研 zip 读 + 抽 XML 文字（复用 lib/zip.mjs）
//   .pdf                                 → 取内容流 → 解 Flate → 抽 Tj/TJ 文本（**尽力而为**）
//   其它（图片 / 扫描件 / 压缩包）        → 如实返回 needsOcr / unsupported，不假装读到了
//
// 一条重要的诚实原则：**读不出来就说读不出来**。PDF 用 CID 字体或扫描件时，抽出来的会是乱码，
// 这时 `quality` 会很低，调用方（课程辅助功能）应当据此标注"需要 OCR"，而不是硬编内容。

import { readFileSync } from 'node:fs';
import { existsSync } from 'node:fs';
import { extname } from 'node:path';
import { join } from 'node:path';
import { inflateRawSync, inflateSync } from 'node:zlib';
import { execFileSync } from 'node:child_process';

import { unzipSync } from './zip.mjs';

export const TEXT_EXT = ['.txt', '.md', '.markdown', '.csv', '.tsv', '.json', '.tex', '.py', '.c', '.cpp', '.h', '.m', '.r', '.sql', '.yml', '.yaml', '.log'];
export const NOTEBOOK_EXT = ['.ipynb'];
export const OFFICE_EXT = ['.pptx', '.docx'];
export const PDF_EXT = ['.pdf'];
export const IMAGE_EXT = ['.png', '.jpg', '.jpeg', '.gif', '.webp', '.bmp', '.avif', '.tif', '.tiff'];
export const ARCHIVE_EXT = ['.zip', '.rar', '.7z', '.tar', '.gz'];

/**
 * Poppler 的 `pdftotext`（**可选**外部工具，不是 npm 依赖）。
 *
 * 为什么要它：自研的 PDF 抽取只按**字面文本**抽，不解字体映射；LaTeX / PPT 导出的
 * 子集字体里存的不是字符而是**字形编号**，于是抽出来是 `IIII IIIIII`。pdftotext 会按
 * PDF 的 ToUnicode / CID 映射解码 —— 2026-09-28 实测：课程目录里**自研读不出来的 39 份，
 * 它能读成正常文字 30 份**（剩下 9 份是真没有文字层的扫描书，那才需要 OCR）。
 *
 * 找不到就保持原样（自研那条路），所以"零第三方依赖"这条承诺不受影响 ——
 * 和视觉路线用 `pdftoppm` 是同一个套路。
 */
export const PDFTOTEXT_CANDIDATES = [
  '',   // 交给 PATH
  join(process.env.USERPROFILE || '', '.cache', 'codex-runtimes', 'codex-primary-runtime',
    'dependencies', 'native', 'poppler', 'Library', 'bin', 'pdftotext.exe'),
  // 常见的"顺带装了 Poppler"的地方：scoop 的 shim、MiKTeX、独立安装的 Poppler
  join(process.env.USERPROFILE || '', 'scoop', 'shims', 'pdftotext.exe'),
  join(process.env.LOCALAPPDATA || '', 'Programs', 'MiKTeX', 'miktex', 'bin', 'x64', 'pdftotext.exe'),
  'C:\\Program Files\\poppler\\Library\\bin\\pdftotext.exe',
  'C:\\poppler\\Library\\bin\\pdftotext.exe',
  // macOS / Linux 的常见位置（Linux 基本都在 PATH 里，这里只是兜底）
  '/opt/homebrew/bin/pdftotext',
  '/usr/local/bin/pdftotext',
  '/usr/bin/pdftotext',
];

let cachedPdftotext = null;

/**
 * 界面上配的 pdftotext 路径（`设置 → 本机 → PDF 取字工具`，存在 `<数据目录>\paths.json` 的
 * `pdftotext_path`）。宿主（server.mjs）在启动时和用户改完时把它注入进来 ——
 * 于是"改完立刻生效"不用重启，也**不需要**这个模块自己去猜数据目录在哪。
 * 优先级仍然是：环境变量 `PLANNER_PDFTOTEXT` > 这里注入的配置 > 自动找。
 */
let configuredPdftotext = '';

/** 宿主注入/更新"界面上配的 pdftotext 路径"（传空 = 回到自动找）。顺带把缓存作废。 */
export function setPdftotextPath(p) {
  configuredPdftotext = String(p == null ? '' : p).trim();
  cachedPdftotext = null;
  return configuredPdftotext;
}

/** 现在生效的"界面上配的"路径（没配就是空串）。 */
export function getConfiguredPdftotext() { return configuredPdftotext; }

/** 把"找到没找到"的缓存清掉（改了配置/换了机器后想重新找一次时用）。 */
export function resetPdftotextCache() { cachedPdftotext = null; }

/**
 * Git for Windows **自带** Poppler 的 pdftotext（`<git>\mingw64\bin\pdftotext.exe`）。
 * 从 `git --exec-path` 反推安装目录 —— 不把任何一台机器的路径写进代码，
 * 而装了 Git 的 Windows 机器基本都能白捡到这个工具（2026-09-28 实测本机就是这样找到的）。
 */
function pdftotextFromGit(runner = execFileSync, exists = existsSync) {
  try {
    const execPath = String(runner('git', ['--exec-path'], { encoding: 'utf8', timeout: 5000 }) || '').trim();
    if (!execPath) return '';
    const root = execPath.replace(/[\\/]libexec[\\/]git-core[\\/]?$/, '').replace(/[\\/]+$/, '');
    if (!root) return '';
    for (const name of ['pdftotext.exe', 'pdftotext']) {
      for (const p of [`${root}/bin/${name}`, `${root}\\bin\\${name}`]) {
        if (exists(p)) return p;
      }
    }
  } catch { /* 没装 git / 跑不起来 -> 算了 */ }
  return '';
}

/**
 * 找 pdftotext。顺序：`PLANNER_PDFTOTEXT` 环境变量（显式指定最优先）→ 界面上配的路径
 * （`setPdftotextPath` 注入，见设置页「本机」）→ 固定候选 → Git 自带 → 扫 PATH。
 * 找不到返回 ''（结果会缓存）。**机器专属路径不写进代码** —— 要用环境变量指。
 */
export function findPdftotext({ candidates = PDFTOTEXT_CANDIDATES, exists = existsSync,
  platform = process.platform, env = process.env, cache = true, runner = execFileSync,
  configured = configuredPdftotext } = {}) {
  if (cache && cachedPdftotext !== null) return cachedPdftotext;
  const explicit = String(env.PLANNER_PDFTOTEXT || '').trim();
  if (explicit) {
    try { if (exists(explicit)) { if (cache) cachedPdftotext = explicit; return explicit; } } catch { /* 继续找 */ }
  }
  // 界面上配的（设置 → 本机）：和环境变量一样是"用户明说的"，所以排在自动找之前
  const fromUi = String(configured || '').trim();
  if (fromUi) {
    try { if (exists(fromUi)) { if (cache) cachedPdftotext = fromUi; return fromUi; } } catch { /* 继续找 */ }
  }
  const win = platform === 'win32';
  const names = win ? ['pdftotext.exe'] : ['pdftotext'];
  let found = '';
  for (const c of candidates) {
    if (!c) continue;
    try { if (exists(c)) { found = c; break; } } catch { /* 继续找 */ }
  }
  // Git for Windows 自带的 poppler（本机实测就是靠这条找到的；纯 ASCII 推导，不写死路径）
  if (!found && win) {
    const fromGit = pdftotextFromGit(runner, exists);
    if (fromGit) found = fromGit;
  }
  if (!found) {
    for (const dir of String(env.PATH || '').split(win ? ';' : ':')) {
      if (!dir) continue;
      for (const n of names) {
        const p = `${dir.replace(/[\\/]+$/, '')}${win ? '\\' : '/'}${n}`;
        try { if (exists(p)) { found = p; break; } } catch { /* 继续 */ }
      }
      if (found) break;
    }
  }
  if (cache) cachedPdftotext = found;
  return found;
}

/** 用 pdftotext 读一个 PDF（`-` = 输出到 stdout）。读失败返回 null，不抛。 */
function fromPdftotext(exe, filePath, { runner = execFileSync, timeoutMs = 60_000 } = {}) {
  let out;
  try {
    out = runner(exe, ['-layout', '-enc', 'UTF-8', '-q', filePath, '-'],
      { timeout: timeoutMs, maxBuffer: 12 * 1024 * 1024, windowsHide: true });
  } catch {
    return null;
  }
  // pdftotext 用 \f（换页符）分页 —— 正好当"第几段（≈第几页）"用，比自研的近似页码还准。
  const raw = String(out || '').replace(/\r\n?/g, '\n');
  const segments = raw.split('\f').map((s) => s.replace(/[ \t]+\n/g, '\n').trim()).filter(Boolean);
  const text = segments.join('\n\n');
  if (!text) return null;
  return { ok: true, text, quality: textQuality(text), via: 'pdftotext', segments };
}

/** 这份抽取结果"能用"吗（给两条路线比大小用）。 */
function usable(text, quality) {
  return !!text && text.length >= 80 && !looksGarbled(text) && quality >= 0.6;
}

/** 文件类型分类（给索引用）。 */
export function classifyFile(name) {
  const e = extname(String(name || '')).toLowerCase();
  if (TEXT_EXT.includes(e)) return 'text';
  if (NOTEBOOK_EXT.includes(e)) return 'notebook';
  if (e === '.pptx') return 'slides';
  if (e === '.docx') return 'doc';
  if (PDF_EXT.includes(e)) return 'pdf';
  if (IMAGE_EXT.includes(e)) return 'image';
  if (ARCHIVE_EXT.includes(e)) return 'archive';
  return 'unknown';
}

/** 抽出文本的"像不像人话"程度（0~1）：够低就说明需要 OCR 或字体编码特殊。 */
export function textQuality(text) {
  const s = String(text || '');
  if (!s) return 0;
  let good = 0;
  for (const ch of s) {
    if (/[\u4e00-\u9fff]/.test(ch)) good += 1;                       // 中文
    else if (/[A-Za-z0-9]/.test(ch)) good += 1;                      // 字母数字
    else if (/[ \t\r\n，。；：、（）()\[\]{}<>《》.,;:!?%+\-*/=_"'’“”]/.test(ch)) good += 1;  // 常见标点
  }
  return good / s.length;
}

/**
 * 这段文字**是不是乱码**？
 *
 * 为什么单列一个判断：2026-09-24 在真课件上发现，数学类 PDF（LaTeX 特殊字体、PPT 导出的
 * 子集字体）能"抽出文字"，但抽出来是 `IIII IIIIII PAB:=fx:x2Ax2B` 这种**字形编号**；
 * 按字符种类统计它反而"像人话"（全是字母，quality 很高）。只看 quality 就会把乱码当读到了 ——
 * 那是最坏的一种错：索引看起来有内容，你照着搜却什么都搜不到。
 *
 * 判据都是"乱码长什么样"的经验特征（宁可漏判，也不要把正常材料误判成乱码）：
 *   A) 同一个字母/数字连着 6 个以上（`IIIIII`）—— 正常文字几乎不会；
 *   B) 一到两个字母的"词"占比过高（`II II IIII A B C`）—— 正常英文里很少；
 *   C) 字母很多却几乎没有空格；
 *   D) 符号占比过高（`!"#$%&"'(%')*+*,---.`）；
 *   E) 通篇数字、几乎没有字母与汉字（图表数值）。
 * 中文（含全角标点）占比高的直接当正常 —— 中文本来就不靠空格分词。
 */
export function looksGarbled(text) {
  const s = String(text || '');
  if (s.length < 40) return false;
  let cjk = 0; let alpha = 0; let digit = 0; let space = 0; let symbol = 0;
  for (const ch of s) {
    if (/\s/.test(ch)) space += 1;
    else if (/[\u3000-\u303f\u4e00-\u9fff\uff00-\uffef]/.test(ch)) cjk += 1;
    else if (/[A-Za-z]/.test(ch)) alpha += 1;
    else if (/[0-9]/.test(ch)) digit += 1;
    else symbol += 1;
  }
  const n = s.length;
  if (cjk / n > 0.25) return false;                       // 中文为主 → 正常
  // 2026-09-28 补：正常英文有大量虚词（the/of/and/to/in/is…），乱码没有。
  // 先认虚词，能拦掉一类误判 —— 实测 `Wonder`、`Lecture02` 这种正常英文讲义
  // 曾因为"一两个字母的词太多"被判成乱码（英文本来就一堆 a/of/in/to）。
  const toks = tokens_of(s);
  if (toks.length >= 12) {
    const low = s.toLowerCase();
    const stop = (low.match(/\b(?:the|of|and|to|in|is|a|are|for|that|with|you|it|as|on|be|this|by|or|from|at|an|not|we|can|will|if|but|they|has|have|was|were|which|their|there|these|those|its|our|your)\b/g) || []).length;
    // 正常英文的虚词占比大约 0.35+；阈值取 0.22，既能救正常材料，又不会把
    // 数学记号里零星出现的 in / a / to 误当成"像人话"。
    if (stop / toks.length >= 0.22) return false;
  }
  if (/([A-Za-z0-9])\1{5,}/.test(s)) return true;         // A
  const tokens = toks;
  // B：一两个字母的"词"占比过高（短碎片由上面那条 <40 兜着；别再加长度门槛 ——
  //    2026-09-28 试过加 ≥160，结果把一条**短但确实是乱码**的用例放过去了，
  //    真正要修的误判是正常英文，那由上面的虚词判据解决）
  if (tokens.length >= 8 && tokens.filter((t) => t.length <= 2).length / tokens.length > 0.55) return true;
  if (alpha / n > 0.6 && space / n < 0.03) return true;   // C
  if (symbol / n > 0.4) return true;                      // D
  if (alpha / n < 0.05 && digit / n > 0.5) return true;   // E
  return false;
}

/** 取英文"词"（连续字母）。抽出来给上面几条判据共用。 */
function tokens_of(s) {
  return String(s).match(/[A-Za-z]+/g) || [];
}

// ---------------------------------------------------------------- 各格式
function fromPlainText(text) {
  return { ok: true, text: String(text || '').replace(/\r\n?/g, '\n') };
}

function fromNotebook(raw) {
  let nb;
  try { nb = JSON.parse(raw); } catch (e) { return { ok: false, error: `ipynb 不是合法 JSON：${e.message}` }; }
  const parts = [];
  for (const cell of nb.cells || []) {
    const src = Array.isArray(cell.source) ? cell.source.join('') : String(cell.source || '');
    if (!src.trim()) continue;
    if (cell.cell_type === 'markdown') parts.push(src.trim());
    else if (cell.cell_type === 'code') parts.push('```\n' + src.trim() + '\n```');
  }
  return { ok: true, text: parts.join('\n\n') };
}

/** 从 OOXML（pptx/docx）的 XML 里抠文字：所有 <a:t>/<w:t> 内容，段落边界补换行。 */
function textFromOoxmlXml(xml) {
  const s = String(xml || '');
  const withBreaks = s
    .replace(/<\/a:p>|<\/w:p>/g, '\n')
    .replace(/<a:br\s*\/>|<w:br\s*\/>/g, '\n');
  const out = [];
  for (const m of withBreaks.matchAll(/<(?:a|w):t(?:\s[^>]*)?>([\s\S]*?)<\/(?:a|w):t>|\n/g)) {
    if (m[0] === '\n') { out.push('\n'); continue; }
    out.push(decodeEntities(m[1]));
  }
  return out.join('').replace(/\n{3,}/g, '\n\n').trim();
}

function decodeEntities(s) {
  return String(s || '')
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'").replace(/&amp;/g, '&')
    .replace(/&#(\d+);/g, (m, d) => String.fromCodePoint(Number(d)))
    .replace(/&#x([0-9a-f]+);/gi, (m, h) => String.fromCodePoint(parseInt(h, 16)));
}

function fromOffice(buf) {
  let files;
  try { files = unzipSync(buf); } catch (e) { return { ok: false, error: `打不开 Office 包：${e.message}` }; }
  const names = Object.keys(files);
  // pptx：按 slide1..N 顺序；docx：word/document.xml
  const slides = names.filter((n) => /^ppt\/slides\/slide\d+\.xml$/.test(n))
    .sort((a, b) => Number(a.match(/(\d+)/)[1]) - Number(b.match(/(\d+)/)[1]));
  const targets = slides.length ? slides : names.filter((n) => n === 'word/document.xml');
  if (!targets.length) return { ok: false, error: '包里没找到幻灯片或正文（可能不是标准 OOXML）' };
  const parts = targets.map((n, i) => {
    const t = textFromOoxmlXml(files[n].toString('utf8'));
    if (!t) return '';
    return slides.length ? `【第 ${i + 1} 页】\n${t}` : t;
  }).filter(Boolean);
  return { ok: true, text: parts.join('\n\n'), pages: targets.length };
}

/**
 * PDF：取内容流 → 解压 → 抽 Tj/TJ 里的字符串。**尽力而为**，读不出就如实说。
 *
 * 两个"会卡死"的坑（2026-09-24 在真课件上踩到并修掉，写在注释里免得以后改回去）：
 *   1) **别用 `\[(?:[^\][]|\\.)*\]\s*TJ` 这种写法** —— `[^\][]` 与 `\\.` 能匹配同一个字符，
 *      匹配失败时回溯组合是**指数级**的；而 PDF 里充满"有 `[` 但没有 `TJ`"的二进制流，
 *      一遇上就会把 CPU 咬死（表现：读一份课件几分钟不返回）。现在改成
 *      `\[[^\[\]]*\]\s*TJ`（字符串里出现真方括号时才可能漏抽，换来的是**线性**匹配）。
 *   2) 解压要有**输出上限**（`maxOutputLength`）：图片流解出来可能是几十 MB 的像素数据，
 *      对文本抽取毫无用处，白白占内存与时间。
 */
function fromPdf(buf, { maxStreams = 400, maxInflate = 4_000_000 } = {}) {
  const streams = [];
  const raw = buf.toString('latin1');
  const re = /stream\r?\n?([\s\S]*?)endstream/g;
  let m;
  while ((m = re.exec(raw)) !== null && streams.length < maxStreams) {
    const start = m.index;
    const dict = raw.slice(Math.max(0, start - 300), start);
    const body = Buffer.from(m[1], 'latin1');
    let text = null;
    if (/FlateDecode/.test(dict)) {
      const opt = { maxOutputLength: maxInflate };
      try { text = inflateSync(body, opt).toString('latin1'); } catch { try { text = inflateRawSync(body, opt).toString('latin1'); } catch { text = null; } }
    } else {
      text = body.toString('latin1');
    }
    if (text) streams.push(text);
  }
  if (!streams.length) return { ok: false, error: '没有可读的内容流（可能是扫描件）', needsOcr: true };

  // 按"内容流"分段（PDF 里通常一页一个流）：这样搜索时能说"在第几段（≈第几页）附近"，
  // 而不是只能给一个整本文件。段号只是近似 —— 所以对外一律写"第 N 段"，不冒充精确页码。
  const segTexts = [];
  for (const s of streams) {
    // 换行标记
    const withLines = s.replace(/T\*|TD|Td/g, '\n');
    const pieces = [];
    for (const mm of withLines.matchAll(/\((?:\\.|[^()\\])*\)\s*Tj|\[[^\[\]]*\]\s*TJ/g)) {
      const chunk = mm[0];
      if (chunk.endsWith('Tj')) {
        pieces.push(pdfString(chunk.slice(0, chunk.lastIndexOf(')') + 1)));
      } else {
        for (const lit of chunk.matchAll(/\((?:\\.|[^()\\])*\)/g)) pieces.push(pdfString(lit[0]));
      }
    }
    const seg = pieces.join('').replace(/[ \t]{2,}/g, ' ').trim();
    if (seg) segTexts.push(seg);
  }
  const text = segTexts.join('\n\n').trim();
  if (!text) return { ok: false, error: '内容流里没有文本（可能是扫描件或矢量图）', needsOcr: true };
  const quality = textQuality(text);
  return { ok: true, text, quality, lowQuality: quality < 0.75, segments: segTexts };
}

/** PDF 字符串字面量 → 文本（处理 \( \) \\ \n \ddd 这些转义）。 */
function pdfString(lit) {
  const inner = String(lit).replace(/^\(/, '').replace(/\)$/, '');
  return inner.replace(/\\([nrtbf()\\]|[0-7]{1,3})/g, (m, g) => {
    if (/^[0-7]+$/.test(g)) return String.fromCharCode(parseInt(g, 8));
    return { n: '\n', r: '\r', t: '\t', b: '\b', f: '\f', '(': '(', ')': ')', '\\': '\\' }[g] || g;
  });
}

// ---------------------------------------------------------------- 主入口
/**
 * 读一个文件 → 文本。
 * @param {string} filePath 绝对路径
 * @param {{maxChars?:number}} [opts] 超过上限会截断（索引不需要整本书）
 * @returns {{ok:boolean, kind:string, text?:string, chars?:number, pages?:number, quality?:number,
 *           lowQuality?:boolean, needsOcr?:boolean, truncated?:boolean, error?:string}}
 */
export function extractText(filePath, { maxChars = 200_000, pdftotext = null, runner = execFileSync } = {}) {
  const kind = classifyFile(filePath);
  let buf;
  try { buf = readFileSync(filePath); } catch (e) { return { ok: false, kind, error: `读不到文件：${e.message}` }; }

  let r;
  try {
    if (kind === 'text') r = fromPlainText(buf.toString('utf8'));
    else if (kind === 'notebook') r = fromNotebook(buf.toString('utf8'));
    else if (kind === 'slides' || kind === 'doc') r = fromOffice(buf);
    else if (kind === 'pdf') {
      r = { ...fromPdf(buf), via: 'text-layer' };
      // 自研那条路读得不理想时，试一下 Poppler 的 pdftotext（有就用，没有就保持原样）。
      // 「理想」= ok && 够长 && 不像乱码 && 质量分够 —— 任何一条不满足都值得试试另一条。
      const selfOk = r.ok && usable(r.text || '', Number.isFinite(r.quality) ? r.quality : textQuality(r.text || ''));
      if (!selfOk) {
        const exe = pdftotext === null ? findPdftotext() : pdftotext;
        if (exe) {
          const better = fromPdftotext(exe, filePath, { runner });
          // 换用 pdftotext 时，**丢掉自研那份段落**（那是乱码切出来的，指过去只会误导）
          if (better && usable(better.text, better.quality)) r = better;
        }
      }
    }
    else if (kind === 'image') return { ok: false, kind, needsOcr: true, error: '图片没有文字层，需要 OCR' };
    else if (kind === 'archive') return { ok: false, kind, error: '压缩包请先解开再索引（里面可能是 zip 形式的课件包）' };
    else return { ok: false, kind, error: '不认识的格式' };
  } catch (e) {
    return { ok: false, kind, error: `解析失败：${e.message}` };
  }
  if (!r.ok) return { kind, ...r };

  let text = r.text || '';
  const quality = Number.isFinite(r.quality) ? r.quality : textQuality(text);
  const garbled = looksGarbled(text);
  let truncated = false;
  if (text.length > maxChars) { text = text.slice(0, maxChars); truncated = true; }
  return {
    ok: true, kind, text, chars: text.length, pages: r.pages,
    quality, garbled,
    lowQuality: garbled || quality < 0.75 || !!r.lowQuality,
    truncated,
    // 这份文字是**哪条路**读出来的：'text-layer'（自研，只按字面抽）或 'pdftotext'（Poppler，按字体映射解码）
    via: r.via || 'text-layer',
    // PDF 才有：按内容流切开的段落（用于"在第几段附近"这类定位）。条数封顶，免得整本书把内存吃光。
    segments: Array.isArray(r.segments) ? r.segments.slice(0, 500) : undefined,
  };
}

/**
 * 在文本里找一段话，返回它在第几段（≈第几页）附近 + 一小段上下文。
 * 只做字面查找（大小写无关），**不做模糊匹配、不猜**：找不到就如实说找不到。
 *
 * @returns {{found:boolean, segment?:number, context?:string}}
 */
export function locateText(text, query, { segments = null, context = 120 } = {}) {
  const needle = String(query || '').trim();
  if (!needle) return { found: false };
  const lower = needle.toLowerCase();

  if (Array.isArray(segments) && segments.length) {
    for (let i = 0; i < segments.length; i += 1) {
      const seg = String(segments[i] || '');
      const at = seg.toLowerCase().indexOf(lower);
      if (at < 0) continue;
      const from = Math.max(0, at - Math.floor(context / 2));
      return { found: true, segment: i + 1, context: seg.slice(from, from + context).replace(/\s+/g, ' ').trim() };
    }
    return { found: false };
  }

  const flat = String(text || '');
  const at = flat.toLowerCase().indexOf(lower);
  if (at < 0) return { found: false };
  const from = Math.max(0, at - Math.floor(context / 2));
  return { found: true, context: flat.slice(from, from + context).replace(/\s+/g, ' ').trim() };
}

/** 从一段文本里抽"关键词/术语"（索引用；纯启发式，不调用模型）。 */
export function keywordsOf(text, { max = 12 } = {}) {
  const s = String(text || '');
  const counts = new Map();
  const bump = (w) => {
    const k = String(w).trim();
    if (k.length < 2) return;
    counts.set(k, (counts.get(k) || 0) + 1);
  };
  for (const m of s.matchAll(/\b[A-Z]{2,6}\d{3,4}[A-Z]?\b/g)) bump(m[0]);            // 课程代码
  for (const m of s.matchAll(/[A-Za-z][A-Za-z-]{3,}/g)) bump(m[0].toLowerCase());     // 英文词
  for (const chunk of s.split(/[^\u4e00-\u9fff]+/)) {                                  // 中文 3~6 字词组
    const t = chunk.trim();
    if (t.length < 3) continue;
    for (let i = 0; i + 2 < t.length && i < 40; i += 1) bump(t.slice(i, i + 3));
  }
  return [...counts.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).slice(0, max).map(([w]) => w);
}
