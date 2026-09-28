// 可选路线：Poppler 的 pdftotext（2026-09-28）
//
//   node tests/pdftotext-route.test.mjs
//
// 背景：自研的 PDF 抽取只按**字面文本**抽、不解字体映射，LaTeX/PPT 的子集字体抽出来是
// 字形编号。装上 Poppler 的 pdftotext 就能按 ToUnicode/CID 解码 —— 实测课程目录里
// 「读不出来」的 39 份，它能救回 30 份。但它是**可选**外部工具：没装就保持原样，
// 所以这里不依赖机器上真的有它（用注入的 runner 测）。
import { mkdtempSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import {
  PDFTOTEXT_CANDIDATES, extractText, findPdftotext, looksGarbled,
} from '../lib/coursetext.mjs';

const TMP = process.env.PLANNER_TEST_TMP || '';
if (!TMP) {
  console.error('需要 PLANNER_TEST_TMP（run_all_tests 会设置）');
  process.exit(2);
}
const dir = mkdtempSync(join(TMP, 'pdftotext-'));

let failures = 0;
const ok = (label, cond, detail = '') => {
  if (cond) console.log(`  PASS ${label}`);
  else { failures += 1; console.log(`  FAIL ${label}${detail ? ` -- ${detail}` : ''}`); }
};

console.log('pdftotext-route.test.mjs');

// 手写一个最小 PDF：内容流里是"字形编号"那种乱码（自研路线会判 garbled）
const GIBBERISH = 'IIII IIIIII II II IIIII PAB:=fx:x2Ax2BgAB1+2+1+n=n+1=:an;ann+1=2';
function fakePdf(text) {
  return Buffer.from(
    '%PDF-1.4\n1 0 obj<</Type/Catalog/Pages 2 0 R>>endobj\n'
    + '2 0 obj<</Type/Pages/Kids[3 0 R]/Count 1>>endobj\n'
    + '3 0 obj<</Type/Page/Parent 2 0 R/MediaBox[0 0 200 100]/Contents 4 0 R>>endobj\n'
    + `4 0 obj<</Length ${text.length}>>stream\nBT /F1 12 Tf (${text}) Tj ET\nendstream endobj\n`
    + 'trailer<</Root 1 0 R>>\n%%EOF\n', 'utf8');
}
const pdf = join(dir, 'garbled.pdf');
writeFileSync(pdf, fakePdf(GIBBERISH));

const CLEAN_P1 = 'Honors Mathematics II — Lecture 01. In this lecture we introduce the notion of a '
  + 'function of a single variable, and we discuss the properties of the real numbers that we shall need.';
const CLEAN_P2 = 'Exercise 1: prove that the sum of the first n natural numbers is equal to n times '
  + 'n plus one, divided by two. You may use induction if you wish, or a direct argument.';
const CLEAN_OUT = CLEAN_P1 + '\f' + CLEAN_P2 + '\f';

// ---------------- ① 找工具 ----------------
{
  ok('环境变量指定优先（显式最优先，机器专属路径不写进代码）',
    findPdftotext({ env: { PLANNER_PDFTOTEXT: 'D:\\tools\\pdftotext.exe' },
      exists: (p) => p === 'D:\\tools\\pdftotext.exe', cache: false }) === 'D:\\tools\\pdftotext.exe');
  ok('环境变量指向的文件不存在 → 继续按候选找，不报错',
    findPdftotext({ env: { PLANNER_PDFTOTEXT: 'D:\\nope.exe', PATH: '' },
      candidates: [], exists: () => false, cache: false }) === '');
  ok('候选里有就用它',
    findPdftotext({ candidates: ['X:\\a\\pdftotext.exe', 'X:\\b\\pdftotext.exe'], env: { PATH: '' },
      exists: (p) => p === 'X:\\b\\pdftotext.exe', cache: false }) === 'X:\\b\\pdftotext.exe');
  ok('候选都没有 → 扫 PATH（不能直接返回一个可能不存在的名字）',
    findPdftotext({ candidates: [], env: { PATH: 'X:\\bin;Y:\\bin' },
      exists: (p) => p === 'Y:\\bin\\pdftotext.exe', platform: 'win32', cache: false }) === 'Y:\\bin\\pdftotext.exe');
  ok('哪儿都没有 → 返回空串（调用方就退回自研）',
    findPdftotext({ candidates: [], env: { PATH: '' }, exists: () => false, cache: false }) === '');
  ok('候选清单里带上了 Codex 运行时的 Poppler 和常见安装位置',
    PDFTOTEXT_CANDIDATES.some((c) => c.includes('codex-runtimes'))
    && PDFTOTEXT_CANDIDATES.some((c) => c.includes('Program Files'))
    && PDFTOTEXT_CANDIDATES.some((c) => c === '/usr/bin/pdftotext'));
}

// ---------------- ② 读不出来时换它 ----------------
{
  const self = extractText(pdf, { pdftotext: '' });
  ok('没有 pdftotext：保持原样（ok 但 garbled，走了自研那条路）',
    self.ok === true && self.garbled === true && self.via === 'text-layer',
    JSON.stringify({ ok: self.ok, garbled: self.garbled, via: self.via }));

  const calls = [];
  const runner = (exe, args) => { calls.push({ exe, args }); return Buffer.from(CLEAN_OUT, 'utf8'); };
  const r = extractText(pdf, { pdftotext: 'X:\\poppler\\pdftotext.exe', runner });
  ok('给了 pdftotext 且自研读不干净 → 换用它', r.via === 'pdftotext', JSON.stringify({ via: r.via }));
  ok('正文是 pdftotext 读出来的干净文字（不再是字形编号）',
    r.text.includes('Honors Mathematics II') && !looksGarbled(r.text) && r.garbled === false);
  ok('参数是 -layout -enc UTF-8 -q <文件> -（输出到 stdout，不落临时文件）',
    calls.length === 1 && calls[0].exe === 'X:\\poppler\\pdftotext.exe'
    && calls[0].args.join(' ') === `-layout -enc UTF-8 -q ${pdf} -`, JSON.stringify(calls[0] && calls[0].args));
  ok('按换页符分页 → 段落数是 2（比自研的近似页码更准）',
    Array.isArray(r.segments) && r.segments.length === 2
    && r.segments[0].includes('Lecture 01') && r.segments[1].includes('Exercise 1'),
    JSON.stringify((r.segments || []).map((s) => s.slice(0, 24))));
  ok('质量分与低质量标记跟着更新（不再是 lowQuality）',
    (r.quality ?? 0) >= 0.75 && r.lowQuality === false);
}

// ---------------- ③ 它自己失败也要如实退回 ----------------
{
  const boom = () => { throw new Error('pdftotext 起不来'); };
  const r = extractText(pdf, { pdftotext: 'X:\\poppler\\pdftotext.exe', runner: boom });
  ok('pdftotext 跑不起来 → 老实退回自研那份结果（不抛、不假装）',
    r.ok === true && r.via === 'text-layer' && r.garbled === true);
  const empty = () => Buffer.from('   \n', 'utf8');
  const r2 = extractText(pdf, { pdftotext: 'X:\\poppler\\pdftotext.exe', runner: empty });
  ok('pdftotext 读出来是空的 → 同样退回自研（不会用空结果覆盖）',
    r2.ok === true && r2.via === 'text-layer');
  const short = () => Buffer.from('cover page only', 'utf8');
  const r3 = extractText(pdf, { pdftotext: 'X:\\poppler\\pdftotext.exe', runner: short });
  ok('pdftotext 只读出封面几个字 → 不采纳（太短，不如原样）',
    r3.via === 'text-layer', JSON.stringify({ via: r3.via, len: (r3.text || '').length }));
}

// ---------------- ④ 已经读得好的文件不折腾 ----------------
{
  const good = join(dir, 'good.pdf');
  const clean = 'This lecture introduces functions of a single variable, and we discuss the properties '
    + 'of the real numbers that we shall need. We also prove that the sum of the first n natural numbers '
    + 'is equal to n times n plus one, divided by two.';
  writeFileSync(good, fakePdf(clean));
  const self = extractText(good, { pdftotext: '' });
  ok('干净的文字层：自研就能读好', self.ok === true && self.garbled === false && self.via === 'text-layer',
    JSON.stringify({ ok: self.ok, garbled: self.garbled }));
  let spawned = 0;
  const r = extractText(good, { pdftotext: 'X:\\poppler\\pdftotext.exe', runner: () => { spawned += 1; return Buffer.from(clean, 'utf8'); } });
  ok('读得好就不去起子进程（省时间）', spawned === 0 && r.via === 'text-layer', `spawned=${spawned}`);
}

console.log('');
console.log(failures === 0 ? 'pdftotext-route.test: PASS' : `pdftotext-route.test: FAIL (${failures})`);
process.exit(failures === 0 ? 0 : 1);
