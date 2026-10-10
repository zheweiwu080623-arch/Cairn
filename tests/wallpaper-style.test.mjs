// 壁纸"按颜色风格分类"的验证（2026-10-09）。
//
// 用户原话："把壁纸按颜色风格分类为 P5R 与 P3R 风格，并分类轮换。"
// 这里验三块：
//   ① 颜色判定（HSL → 红系 p5 / 蓝系 p3r / 不明显 other）；
//   ② 优先级（手工标注 > 颜色分析 > 文件名线索）；
//   ③ 接线（接口能分类、能手工改、轮换按风格池走）。

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  WALLPAPER_STYLES, classifyColors, decideStyle, nameStyleHint, parseHistogram, rgbToHsl,
} from '../lib/wallpaper-style.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const read = (p) => readFileSync(join(ROOT, p), 'utf8');
let failures = 0;
const ok = (label, cond, detail = '') => {
  if (cond) console.log(`  PASS ${label}`);
  else { failures += 1; console.log(`  FAIL ${label}${detail ? ` -- ${detail}` : ''}`); }
};

console.log('wallpaper-style.test.mjs');

// ---------- ① 颜色判定 ----------
console.log('\n① 颜色 → 风格');
ok('三种风格', WALLPAPER_STYLES.join() === 'p5,p3r,other');
{
  const red = rgbToHsl(200, 20, 20);
  const blue = rgbToHsl(20, 60, 200);
  const gray = rgbToHsl(128, 128, 128);
  ok('纯红 → 色相在红区', red.h < 25 || red.h > 330, String(red.h));
  ok('纯蓝 → 色相在蓝区', blue.h >= 180 && blue.h <= 265, String(blue.h));
  ok('灰 → 饱和度为 0', gray.s === 0);
}
// 真机实测取到的两组主色（P5R 那张 / P3R 那张）
ok('真机样本：P5R 的主色判成 p5',
  classifyColors([{ r: 147, g: 7, b: 9, weight: 834 }, { r: 22, g: 16, b: 16, weight: 1153 }]).style === 'p5',
  JSON.stringify(classifyColors([{ r: 147, g: 7, b: 9, weight: 834 }])));
ok('真机样本：P3R 的主色判成 p3r',
  classifyColors([{ r: 1, g: 31, b: 186, weight: 1184 }]).style === 'p3r');
ok('一黑一白 → other（不硬猜）', classifyColors([{ r: 0, g: 0, b: 0, weight: 90 }, { r: 255, g: 255, b: 255, weight: 10 }]).style === 'other');
ok('绿/黄这种"都不是" → other', classifyColors([{ r: 20, g: 180, b: 40, weight: 500 }]).style === 'other');
ok('青/靛/紫也算蓝（放宽过一次窗口：真机里"克莱因蓝+青紫"的壁纸原来判不出来）',
  classifyColors([{ r: 90, g: 200, b: 210, weight: 500 }]).style === 'p3r'      // 青
  && classifyColors([{ r: 150, g: 120, b: 220, weight: 500 }]).style === 'p3r'); // 紫
ok('空输入不炸', classifyColors([]).style === 'other' && classifyColors(null).style === 'other');
ok('红蓝都有时看谁占主导',
  classifyColors([{ r: 200, g: 0, b: 0, weight: 400 }, { r: 0, g: 60, b: 220, weight: 100 }]).style === 'p5'
  && classifyColors([{ r: 200, g: 0, b: 0, weight: 100 }, { r: 0, g: 60, b: 220, weight: 400 }]).style === 'p3r');

// ---------- ② 直方图解析 + 名字线索 + 优先级 ----------
console.log('\n② 解析与优先级');
const hist = '  1184: (1.07652,30.7671,185.89) #011FBA srgb(0.4%,12.1%,72.9%)\n   834: (146.8,6.69,8.5) #930709 srgb(57.6%,2.6%,3.3%)';
const parsed = parseHistogram(hist);
ok('能解析 ImageMagick 的直方图', parsed.length === 2 && parsed[0].weight === 1184 && Math.round(parsed[0].b) === 186, JSON.stringify(parsed[0]));
ok('坏文本不炸', parseHistogram('不是直方图').length === 0 && parseHistogram('').length === 0);
ok('名字线索：Persona 5 / Joker → p5', nameStyleHint('P5R雨宫莲') === 'p5' && nameStyleHint('Joker&Arsène') === 'p5');
ok('名字线索：Persona 3 / reload → p3r', nameStyleHint('Persona 3 Reload [4K]') === 'p3r' && nameStyleHint('克莱因蓝') === 'p3r');
ok('名字里没有线索 → 空', nameStyleHint('双狼完成壁纸5') === '' && nameStyleHint('序列 03') === '');

ok('手工标注最优先（哪怕颜色说反了）',
  decideStyle({ manual: 'p3r', colors: [{ r: 200, g: 0, b: 0, weight: 900 }], name: 'P5R' }).style === 'p3r');
ok('没有手工标注时看颜色', decideStyle({ colors: [{ r: 0, g: 60, b: 220, weight: 900 }] }).style === 'p3r');
ok('颜色判不出来时用名字线索兜底（并标明来源）',
  decideStyle({ name: 'Persona 3 Reload', colors: [{ r: 128, g: 128, b: 128, weight: 900 }] }).source === 'name');
ok('什么都没有 → other', decideStyle({}).style === 'other' && decideStyle({}).source === 'none');

// ---------- ③ 接线 ----------
console.log('\n③ 接线');
const media = read('lib/media.mjs');
const app = read('public/app.js');
ok('media.mjs 用了取色模块', /from '\.\/wallpaper-style\.mjs'/.test(media));
ok('分类接口挂了', /seg\[2\] === 'classify'/.test(media));
ok('手工改风格接口挂了', /seg\[2\] === 'style'/.test(media));
ok('按风格分池（p5 / p3r / other / all）', /pools = \{ p5: \[\], p3r: \[\], other: \[\], all:/.test(media));
ok('轮换在同类里挑（空类退回全部）', /pools\[key\] && pools\[key\]\.length/.test(media));
ok('前端有"按颜色重新分类"按钮', /wp-classify/.test(app));
ok('前端格子上的风格标签可点（循环标注）', /wp-style\[data-style-for\]/.test(app));
ok('rotate 模式按主题取对应风格那张', /wpCurrent\[key\]/.test(app));
ok('分类结果只存本机（sync_state）', /wp_styles_json/.test(media));

console.log(`\nwallpaper-style.test: ${failures === 0 ? 'PASS' : `FAIL (${failures})`}`);
process.exit(failures ? 1 : 0);
