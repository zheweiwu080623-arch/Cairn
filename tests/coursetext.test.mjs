// 文本抽取层的验证（D4 的地基）：课件 → 文字。
//
//   node tests/coursetext.test.mjs
//
// 测试用的 pdf / pptx / docx 都是**临时文件**（不是真课件），可以放心跑；
// 真课件（MATH1860J 那批）由"实盘复验"单独跑一次并记录证据。

import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  ARCHIVE_EXT, IMAGE_EXT, classifyFile, extractText, keywordsOf, locateText, looksGarbled, textQuality,
} from '../lib/coursetext.mjs';
import { zipSync } from '../lib/zip.mjs';

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
console.log('coursetext.test.mjs');

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const root = mkdtempSync(join(TMP, 'coursetext-'));
const write = (name, content) => { const p = join(root, name); writeFileSync(p, content); return p; };

// ---------------- 1. 分类 ----------------
ok('按扩展名分类：pdf / slides / doc / notebook / 图片 / 压缩包 / 文本 / 未知',
  classifyFile('a.pdf') === 'pdf' && classifyFile('a.PPTX') === 'slides' && classifyFile('a.docx') === 'doc'
  && classifyFile('a.ipynb') === 'notebook' && classifyFile('a.PNG') === 'image'
  && classifyFile('a.zip') === 'archive' && classifyFile('a.md') === 'text' && classifyFile('a.exe') === 'unknown');
ok('图片/压缩包扩展名清单非空', IMAGE_EXT.includes('.jpg') && ARCHIVE_EXT.includes('.zip'));

// ---------------- 2. "像不像人话" ----------------
ok('正常中英文 → 质量高', textQuality('这是高等数学的讲义 Lecture 3 about derivatives.') > 0.9);
ok('乱码 → 质量低', textQuality('\u0001\u0002\u0007\u0000\u001b\u0003\u0004\u0006') < 0.2, String(textQuality('\u0001\u0002\u0007')));
ok('空字符串 → 0', textQuality('') === 0);

// 2026-09-24 真课件踩到：数学字体抽出来是"字形编号"，按字符种类算 quality 反而很高，
// 所以必须有一层"像不像乱码"的判断（否则索引看起来有内容、其实搜不到）。
ok('真课件里那种"字形编号"被认出是乱码',
  looksGarbled('IIII IIIIII II II IIIII IIIIIII IIII PAB:=fx:x2Ax2BgAB1+2+1+n=n(n+1)2=:an;ann(n+1)=2 1+2++n'));
ok('符号堆（PPT 导出常见）也认得出',
  looksGarbled('!"#$%&"\'()*+*,---.!"#"$%&"\'()&($*+,$-.#.,($/)0\')((,12)1#,.&#+,34\'5\')67")08"\'5\')9:7")0;1<#.9(=.9&)'));
ok('正常英文讲义不会被误判',
  !looksGarbled('ENGR1010J: Introduction to Computers and Programming Lecture 01 Jigang Wu Outline Course information and homework are managed by Canvas.'));
ok('中文讲义不会被误判（中文不靠空格分词）',
  !looksGarbled('高等数学第一周讲义：极限的定义与性质，连续性与一致连续的区别，课后习题第三题要求用定义证明。'));
ok('正常但很短的文字不参与判断（避免误伤）', !looksGarbled('Exercise 3: derivative'));

// ---------------- 3. 纯文本 / notebook ----------------
{
  const p = write('note.md', '# 第 3 周\n导数的定义：f\'(x) = lim ...\n');
  const r = extractText(p);
  ok('markdown 直接读出来', r.ok && r.kind === 'text' && r.text.includes('导数的定义'));
}
{
  const nb = { cells: [
    { cell_type: 'markdown', source: ['# Lecture 01\n', 'Association and Causality'] },
    { cell_type: 'code', source: ['print("hello")'] },
    { cell_type: 'markdown', source: [''] },
  ] };
  const p = write('lec01.ipynb', JSON.stringify(nb));
  const r = extractText(p);
  ok('ipynb 取 markdown 与代码单元（空单元跳过）',
    r.ok && r.text.includes('Association and Causality') && r.text.includes('print("hello")') && r.text.includes('```'));
}
ok('坏 ipynb（不是 JSON）→ 如实报错，不抛异常',
  extractText(write('bad.ipynb', '{oops')).ok === false);

// ---------------- 4. Office（真 zip 结构） ----------------
{
  const slide = (t) => Buffer.from(`<?xml version="1.0"?><p:sld xmlns:a="x" xmlns:p="y"><a:p><a:t>${t}</a:t></a:p></p:sld>`, 'utf8');
  const buf = zipSync([
    { name: '[Content_Types].xml', data: Buffer.from('<Types/>') },
    { name: 'ppt/slides/slide2.xml', data: slide('第二页：泰勒展开') },
    { name: 'ppt/slides/slide1.xml', data: slide('First page: limits') },
  ]);
  const p = join(root, 'deck.pptx');
  writeFileSync(p, buf);
  const r = extractText(p);
  ok('pptx 按 slide 顺序抽文字（slide1 在 slide2 之前）',
    r.ok && r.text.indexOf('First page') >= 0 && r.text.indexOf('First page') < r.text.indexOf('第二页') && r.pages === 2, r.text);
  ok('pptx 页标记能对上', r.text.includes('【第 1 页】') && r.text.includes('【第 2 页】'));
}
{
  const buf = zipSync([{
    name: 'word/document.xml',
    data: Buffer.from('<w:document xmlns:w="x"><w:p><w:t>学习指南</w:t></w:p><w:p><w:t>第二段</w:t></w:p></w:document>', 'utf8'),
  }]);
  const p = join(root, 'guide.docx');
  writeFileSync(p, buf);
  const r = extractText(p);
  ok('docx 抽正文（段落之间换行）', r.ok && r.text.includes('学习指南') && r.text.includes('第二段') && r.text.includes('\n'));
}
ok('不是 Office 包的 .docx → 如实报错', extractText(write('fake.docx', 'not a zip at all')).ok === false);

// ---------------- 5. PDF（自己造一个带文字流的） ----------------
{
  const pdf = [
    '%PDF-1.4',
    '1 0 obj << /Type /Page >> stream',
    'BT /F1 12 Tf (Week 1 exercise 3: compute the derivative of sin x) Tj ET',
    'endstream endobj',
    '2 0 obj << /Type /Page >> stream',
    'BT /F1 12 Tf (Hint: use the limit definition ) Tj [(and ) -250 (simplify) ] TJ ET',
    'endstream endobj',
    '%%EOF',
  ].join('\n');
  const p = join(root, 'ex01.pdf');
  writeFileSync(p, Buffer.from(pdf, 'latin1'));
  const r = extractText(p);
  ok('PDF 能抽出文字（Tj + TJ 两种写法都认）',
    r.ok && r.text.includes('compute the derivative of sin x') && r.text.includes('simplify'), JSON.stringify(r.text));
  ok('PDF 按内容流给出段落（用来定位"第几段≈第几页"）',
    Array.isArray(r.segments) && r.segments.length === 2, JSON.stringify(r.segments));
  ok('文字清楚 → 不是低质量', r.lowQuality === false, String(r.quality));
}
{
  // 真实情形：数学字体抽出来是字形编号。extractText 必须在**入口**就把它标出来
  const p = join(root, 'glyph-junk.pdf');
  writeFileSync(p, Buffer.from([
    '%PDF-1.4', '1 0 obj << /Type /Page >> stream',
    'BT /F1 12 Tf (IIII IIIIII II II IIIII PAB:=fx:x2Ax2BgAB1+2+1+n=n+1=:an;ann+1=2) Tj ET',
    'endstream endobj', '%%EOF',
  ].join('\n'), 'latin1'));
  const r = extractText(p);
  ok('字形编号的 PDF：ok:true 但 garbled:true、lowQuality:true（不假装读到了）',
    r.ok === true && r.garbled === true && r.lowQuality === true, JSON.stringify({ ok: r.ok, garbled: r.garbled, lowQuality: r.lowQuality }));
}
{
  const p = join(root, 'scan.pdf');
  writeFileSync(p, Buffer.from('%PDF-1.4\n1 0 obj << /Type /Page >> stream\nq 612 0 0 792 0 0 cm /Im0 Do Q\nendstream endobj\n%%EOF', 'latin1'));
  const r = extractText(p);
  ok('扫描版 PDF（没有文字层）→ 标 needsOcr，不假装读到', r.ok === false && r.needsOcr === true, JSON.stringify(r));
}
{
  // 回归：2026-09-24 在真课件上踩到的坑 —— PDF 里全是"有 [ 但没有 TJ"的二进制流时，
  // 一个写得不小心的正则会让匹配**指数级回溯**，读一份课件几分钟不返回（CPU 咬死）。
  // 这条测试只要求"必须很快返回"，就是防止有人把那个写法改回来。
  const junk = '['.repeat(4000) + 'x'.repeat(4000) + ']'.repeat(4000);
  const pdf = ['%PDF-1.4', '1 0 obj << /Type /Page >> stream', junk, 'endstream endobj', '%%EOF'].join('\n');
  const p = join(root, 'nasty-streams.pdf');
  writeFileSync(p, Buffer.from(pdf, 'latin1'));
  const t0 = Date.now();
  const r = extractText(p, { maxChars: 500 });
  const ms = Date.now() - t0;
  ok('含大量方括号/二进制流的 PDF 必须"很快出结果"（不能指数级回溯卡死）', ms < 2000, `耗时 ${ms}ms`);
  ok('这种 PDF 不会假装读到文字（没有 Tj/TJ 就没有文本）', r.ok === false && r.needsOcr === true, JSON.stringify(r));
}

// ---------------- 6. 图片 / 压缩包 / 未知格式 ----------------
ok('图片 → needsOcr（没有文字层）', extractText(write('shot.png', 'PNG')).needsOcr === true);
ok('压缩包 → 如实说"先解开再索引"',
  (() => { const r = extractText(write('pack.zip', 'PK')); return r.ok === false && r.error.includes('解开'); })());
ok('不认识的格式 → 如实说', extractText(write('thing.exe', 'MZ')).error.includes('不认识'));
ok('文件不存在 → 如实报错（不抛）', extractText(join(root, '没有这个.pdf')).ok === false);

// ---------------- 7. 关键词与定位 ----------------
{
  const kws = keywordsOf('MATH1860J Math1860J derivative derivative derivative integral limits matrix', { max: 5 });
  ok('关键词按出现次数排序、能认出课程代码', kws.includes('MATH1860J') && kws[0] === 'derivative', JSON.stringify(kws));
  ok('短词与单字被过滤', !keywordsOf('a 我 the of', { max: 5 }).includes('the'));
}
{
  const r = { segments: ['第一段：极限', '第二段：导数的定义与泰勒展开'] };
  const hit = locateText('', '泰勒', { segments: r.segments });
  ok('能在第几段里定位（不给就别乱指）', hit.found === true && hit.segment === 2, JSON.stringify(hit));
  ok('找不到 → found:false（不猜）', locateText('', '拉格朗日', { segments: r.segments }).found === false);
  ok('没有段落信息时退回整篇查找',
    locateText('abc 泰勒展开 def', '泰勒').found === true && locateText('abc 泰勒展开 def', '泰勒').segment === undefined);
}

// ---------------- 8. 零依赖守卫 ----------------
{
  const src = readFileSync(join(ROOT, 'lib', 'coursetext.mjs'), 'utf8');
  ok('只用 Node 自带能力（没有第三方依赖）',
    src.includes("from 'node:zlib'") && src.includes("from './zip.mjs'")
    && !/from '(?!node:|\.\/)/.test(src));
  ok('注释里写清了"读不出来就说读不出来"这条原则', src.includes('读不出来就说读不出来'));
}

console.log('');
console.log(failures === 0 ? 'coursetext.test: PASS' : `coursetext.test: FAIL (${failures})`);
process.exit(failures === 0 ? 0 : 1);
