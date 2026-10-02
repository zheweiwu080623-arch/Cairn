// anki-export.mjs —— 把 Cairn 的复习包变成 Anki 能直接导入的 CSV。
//
// 为什么做这件事：复习包（LaTeX PDF）负责"把内容讲清楚"，Anki 负责"让你记牢"。
// 两者之间原来要手工抄卡片；这里把复习包里**已经写好的题目与解答**直接导成 CSV，
// 每周导入一次，学习闭环就接上了：Cairn 生成材料 → Anki 负责间隔重复。
//
// 只认两种**明确**的来源，不做"猜"：
//   1) `\ankicard{正面}{背面}`  —— 想手写卡片时用这个标记；
//   2) `exercises.tex` 里的 `\textbf{题目}：…` + `\textbf{解答}：…` 配对。
// （knowledge.tex 里那种由 PDF 自动抽取的长文本**刻意不导出**——质量不够，宁缺毋滥。）

import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

/** 从一段 LaTeX 里抽出所有 `\ankicard{f}{b}`（支持一层花括号嵌套）。 */
export function parseAnkiCards(tex) {
  const out = [];
  const re = /\\ankicard\s*\{/g;
  let m;
  while ((m = re.exec(tex))) {
    const a = readBraced(tex, m.index + m[0].length - 1);
    if (!a) break;
    const bStart = tex.indexOf('{', a.end);
    const b = bStart >= 0 ? readBraced(tex, bStart) : null;
    if (!b) break;
    out.push({ front: cleanTex(a.text), back: cleanTex(b.text) });
    re.lastIndex = b.end;
  }
  return out;
}

/** 从 pos（指向 `{`）读一对配平的花括号，返回 { text, end }。 */
function readBraced(s, pos) {
  if (s[pos] !== '{') return null;
  let depth = 0;
  for (let i = pos; i < s.length; i += 1) {
    const c = s[i];
    if (c === '\\') { i += 1; continue; }
    if (c === '{') depth += 1;
    else if (c === '}') {
      depth -= 1;
      if (depth === 0) return { text: s.slice(pos + 1, i), end: i + 1 };
    }
  }
  return null;
}

/** 从 exercises.tex 抽出「题目 → 解答」配对。 */
export function parseExercises(tex, { course = '' } = {}) {
  const out = [];
  const blocks = tex.split(/\\(?:sub)*section\*?\{/).slice(1);
  for (const raw of blocks) {
    const end = raw.indexOf('}');
    if (end < 0) continue;
    const heading = cleanTex(raw.slice(0, end));
    const body = raw.slice(end + 1);
    const qi = body.indexOf('\\textbf{题目}');
    const ai = body.indexOf('\\textbf{解答}');
    if (qi < 0 || ai < 0 || ai < qi) continue;
    const front = cleanTex(body.slice(body.indexOf('：', qi) + 1, ai));
    const back = cleanTex(body.slice(body.indexOf('：', ai) + 1));
    if (!front || !back) continue;
    const pMatch = /P[0-3]/.exec(heading);
    const tags = [course, '复习包', pMatch ? pMatch[0] : '', heading.split('·').slice(-1)[0].trim()]
      .filter(Boolean);
    out.push({ front, back, tags });
  }
  return out;
}

/** 去掉 LaTeX 里的排版噪音，但**保留数学公式原样**（Anki/AnkiDroid 都认 $…$ 与 \[…\]）。 */
export function cleanTex(s) {
  return String(s || '')
    .replace(/\\textbf\{([^{}]*)\}/g, '$1')
    .replace(/\\emph\{([^{}]*)\}/g, '$1')
    .replace(/\\noindent|\\small|\\vspace\*?\{[^}]*\}|\\hfill/g, '')
    .replace(/\r\n?/g, '\n')
    .replace(/[ \t]+/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function csvCell(v) {
  const s = String(v == null ? '' : v);
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

/** 生成 Anki 导入用的 CSV（UTF-8 BOM，Excel 与 Anki 都不会乱码）。 */
export function toCsv(rows) {
  const head = '正面,背面,标签';
  const lines = rows.map((r) => [csvCell(r.front), csvCell(r.back), csvCell((r.tags || []).join(' '))].join(','));
  return '\uFEFF' + [head, ...lines].join('\r\n') + '\r\n';
}

/** 一次性：读复习包目录 → 卡片数组。 */
export function cardsFromCourseDir(dir, { course = '' } = {}) {
  const files = [];
  for (const name of ['exercises.tex', 'knowledge.tex']) {
    const p = join(dir, name);
    if (existsSync(p)) files.push([name, p]);
  }
  const cards = [];
  for (const [name, p] of files) {
    const tex = readFileSafe(p);
    if (!tex) continue;
    const explicit = parseAnkiCards(tex).map((c) => ({ ...c, tags: [course, '手写卡片'] }));
    if (explicit.length) cards.push(...explicit);
    if (name === 'exercises.tex') cards.push(...parseExercises(tex, { course }));
  }
  return cards;
}

function readFileSafe(p) {
  try { return readFileSync(p, 'utf8'); } catch { return ''; }
}
