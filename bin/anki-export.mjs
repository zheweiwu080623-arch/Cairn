#!/usr/bin/env node
// bin/anki-export.mjs —— 把复习包导出成 Anki 可导入的 CSV。
//
// 用法：
//   node bin/anki-export.mjs MATH1860J            # 单门课
//   node bin/anki-export.mjs --all                # 三门课都导
//   node bin/anki-export.mjs MATH1860J --out D:\x # 指定输出目录
//
// 输出：<项目>/data/course-tools/anki/<CODE>_anki_<日期>.csv
// 导入 Anki：文件 → 导入 → 选这个 csv → 字段对应「正面 / 背面 / 标签」→ 导入。

import { existsSync, mkdirSync, readdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { cardsFromCourseDir, toCsv } from '../lib/anki-export.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..');
const TEX_DIR = join(ROOT, 'data', 'course-tools', 'tex');

const args = process.argv.slice(2);
const wantAll = args.includes('--all');
const outIdx = args.indexOf('--out');
const outDir = outIdx >= 0 ? args[outIdx + 1] : join(ROOT, 'data', 'course-tools', 'anki');
const courses = wantAll
  ? readdirSync(TEX_DIR).filter((d) => existsSync(join(TEX_DIR, d, 'exercises.tex')))
  : args.filter((a) => !a.startsWith('--') && a !== outDir);

if (!courses.length) {
  console.log('用法：node bin/anki-export.mjs <课程代码> [--all] [--out 目录]');
  process.exit(1);
}

mkdirSync(outDir, { recursive: true });
const stamp = new Date().toISOString().slice(0, 10);
let total = 0;
for (const code of courses) {
  const dir = join(TEX_DIR, code);
  if (!existsSync(dir)) {
    console.log(`跳过 ${code}：没有 ${dir}`);
    continue;
  }
  const cards = cardsFromCourseDir(dir, { course: code });
  const file = join(outDir, `${code}_anki_${stamp}.csv`);
  writeFileSync(file, toCsv(cards), 'utf8');
  total += cards.length;
  console.log(`${code}: ${cards.length} 张卡片 -> ${file}`);
}
console.log(`合计 ${total} 张。导入 Anki：文件 → 导入 → 选 csv → 字段对「正面/背面/标签」。`);
