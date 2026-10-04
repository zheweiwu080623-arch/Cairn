// 复习包 → Anki CSV 的验证（lib/anki-export.mjs）。
//
//   node tests/anki-export.test.mjs

import { cardsFromCourseDir, parseAnkiCards, parseExercises, toCsv } from '../lib/anki-export.mjs';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

let failures = 0;
const ok = (label, cond, detail = '') => {
  if (cond) console.log(`  PASS ${label}`);
  else {
    failures += 1;
    console.log(`  FAIL ${label}${detail ? ` -- ${detail}` : ''}`);
  }
};

console.log('anki-export.test.mjs');

// ---------------- ① exercises.tex 的「题目/解答」配对 ----------------
const exercises = String.raw`
\section{精选练习与解答}

\subsection*{Ex 01（P0 · 逻辑）}
\textbf{题目}：证明 $A\Leftrightarrow B$ 与异或的关系。

\textbf{解答}：内层就是 $A\oplus B$，所以这条恒等式说的是\textbf{双条件 = 异或的否定}。

\emph{点评}：不要背，画真值表。

\subsection*{Ex 02（P2 · 集合）}
\textbf{题目}：判断 $A\times C=B\times C$ 能否推出 $A=B$。

\textbf{解答}：可以，前提是 $C\neq\varnothing$。
`;

const rows = parseExercises(exercises, { course: 'MATH1860J' });
ok('抽出 2 张卡', rows.length === 2, String(rows.length));
ok('正面去掉「题目」前缀、保留公式', rows[0].front.startsWith('证明') && rows[0].front.includes('$A\\Leftrightarrow B$'), rows[0].front);
ok('背面保留完整解答与点评', rows[0].back.includes('异或') && rows[0].back.includes('真值表'));
ok('标签带课程与优先级', rows[0].tags.join(' ').includes('MATH1860J') && rows[0].tags.includes('P0'), rows[0].tags.join(' '));
ok('「\textbf{}」被清掉但内容保留', !rows[0].back.includes('\\textbf'), rows[0].back.slice(0, 40));

// ---------------- ② 显式标记 \ankicard ----------------
const marked = String.raw`\ankicard{德摩根律}{$\neg(A\wedge B)\equiv\neg A\vee\neg B$}`;
const mc = parseAnkiCards(marked);
ok('\\ankicard 能解析（含嵌套花括号）', mc.length === 1 && mc[0].front === '德摩根律' && mc[0].back.includes('\\neg A\\vee\\neg B'), JSON.stringify(mc));
ok('嵌套花括号不会截断', parseAnkiCards(String.raw`\ankicard{f}{a{b}c}`)[0].back === 'a{b}c');

// ---------------- ③ CSV 形态 ----------------
const csv = toCsv([
  { front: '含,逗号', back: '带"引号"\n和换行', tags: ['A', 'B'] },
]);
ok('CSV 有表头与 BOM', csv.startsWith('\uFEFF正面,背面,标签'));
ok('逗号与引号被正确转义', csv.includes('"含,逗号"') && csv.includes('""引号""'));
ok('多行字段整体被引号包住', /"带""引号""\n和换行"/.test(csv));

// ---------------- ④ 目录级：只吃 exercises.tex，不吃没结构的 knowledge.tex ----------------
{
  const dir = mkdtempSync(join(process.env.PLANNER_TEST_TMP || tmpdir(), 'cairn-anki-tex-'));
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'exercises.tex'), exercises, 'utf8');
  writeFileSync(join(dir, 'knowledge.tex'), '\\section{知识点讲解}\n\\subsection{X}\n一堆没有结构的正文。', 'utf8');
  const cards = cardsFromCourseDir(dir, { course: 'MATH1860J' });
  ok('目录级只导出有结构的卡片（knowledge 的散文本不出卡）', cards.length === 2, String(cards.length));
}

console.log('');
console.log(failures === 0 ? 'anki-export.test: PASS' : `anki-export.test: FAIL (${failures})`);
process.exit(failures === 0 ? 0 : 1);
