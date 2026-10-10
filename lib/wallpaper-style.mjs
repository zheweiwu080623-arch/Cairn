// wallpaper-style.mjs —— 把壁纸按**颜色风格**分成 P5R（黑红）与 P3R（克莱因蓝）两类（2026-10-09）
//
// 用户原话："把壁纸按颜色风格分类为 P5R 与 P3R 风格，并分类轮换。"
//
// 怎么判：不靠文件名猜，而是**真的去看图**——
//   * 静态图片 / Wallpaper Engine 的 preview：直接交给 ImageMagick 取主色直方图；
//   * 只有视频的：先用 ffmpeg 抽第 1 秒的一帧，再取色。
// 判定规则（对"主色"加权投票，饱和的颜色说话更响）：
//   红系（色相 ≈ 330°~360° / 0°~25°）→ p5；蓝系（色相 ≈ 180°~265°）→ p3r；
//   两边都不明显 → other（灰、白、杂色都归这里）。
// 手工标注永远优先：用户在格子上点一下就能改，改完不再被自动分析覆盖。
//
// 这个模块只做"看图 → 给个风格"，不碰存储、不碰轮换（那些在 lib/media.mjs / lib/wallpapers.mjs）。

import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';

export const WALLPAPER_STYLES = ['p5', 'p3r', 'other'];

/** 把 RGB（0-255）转成 HSL（h 0-360，s/l 0-1）。 */
export function rgbToHsl(r, g, b) {
  const R = Number(r) / 255; const G = Number(g) / 255; const B = Number(b) / 255;
  const max = Math.max(R, G, B); const min = Math.min(R, G, B);
  const l = (max + min) / 2;
  const d = max - min;
  if (d === 0) return { h: 0, s: 0, l };
  const s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
  let h;
  if (max === R) h = ((G - B) / d) % 6;
  else if (max === G) h = (B - R) / d + 2;
  else h = (R - G) / d + 4;
  h *= 60;
  if (h < 0) h += 360;
  return { h, s, l };
}

/**
 * 一组颜色（带权重）→ 风格。
 * @param {Array<{r:number,g:number,b:number,weight?:number}>} colors
 * @returns {{style:'p5'|'p3r'|'other', red:number, blue:number, why:string}}
 */
export function classifyColors(colors) {
  let red = 0; let blue = 0; let neutral = 0;
  for (const c of Array.isArray(colors) ? colors : []) {
    const { h, s, l } = rgbToHsl(c.r, c.g, c.b);
    const w = Math.max(1, Number(c.weight) || 1) * s;      // 越鲜艳越算数
    if (s < 0.12 || l < 0.04 || l > 0.96) { neutral += w; continue; }   // 灰/纯黑/纯白不表态
    // 2026-10-09：窗口按真机样本放宽过一次 —— 原来蓝只收 180~265°，结果"克莱因蓝 + 青/紫"
    // 的壁纸大片像素落在窗口外，被判成"颜色看不出来"（实测两张 P3R 只能靠名字兜底）。
    // 现在：红 = 320°~30°，蓝 = 165°~285°（含青、靛、紫），仍然不碰黄/绿。
    const isRed = h >= 320 || h <= 30;
    const isBlue = h >= 165 && h <= 285;
    if (isRed) red += w;
    else if (isBlue) blue += w;
    else neutral += w;
  }
  const total = red + blue + neutral;
  if (!total) return { style: 'other', red, blue, why: '没有任何可用颜色' };
  const share = Math.max(red, blue) / total;
  if (share < 0.35) return { style: 'other', red, blue, why: `红 ${red.toFixed(1)} / 蓝 ${blue.toFixed(1)} 都不占主导` };
  return red >= blue
    ? { style: 'p5', red, blue, why: `红系占 ${(red / total * 100).toFixed(0)}%` }
    : { style: 'p3r', red, blue, why: `蓝系占 ${(blue / total * 100).toFixed(0)}%` };
}

/** 文件名/标题里的提示（颜色看不出来时的兜底；**不覆盖**颜色结论）。 */
export function nameStyleHint(name) {
  const s = String(name || '');
  if (/persona\s*5|p5r?\b|joker|黑红|雨宫莲/i.test(s)) return 'p5';
  if (/persona\s*3|p3r\b|克莱因|水蓝|reload/i.test(s)) return 'p3r';
  return '';
}

/** ImageMagick 的 `-colors N -format %c histogram:info:-` 输出 → [{r,g,b,weight}]。 */
export function parseHistogram(text) {
  const out = [];
  for (const line of String(text || '').split(/\r?\n/)) {
    // 形如：  1184: (1.07,30.7,185.9) #011FBA srgb(0.42%,12.06%,72.89%)
    const m = line.match(/^\s*(\d+):\s*\(([\d.]+)(?:,[\d.]+)?,([\d.]+)(?:,[\d.]+)?,([\d.]+)/);
    if (!m) continue;
    out.push({ weight: Number(m[1]), r: Number(m[2]), g: Number(m[3]), b: Number(m[4]) });
  }
  if (out.length) return out;
  // 兜底：解析 #RRGGBB + srgb(百分比)
  for (const line of String(text || '').split(/\r?\n/)) {
    const w = line.match(/^\s*(\d+):/);
    const hex = line.match(/#([0-9A-Fa-f]{6})/);
    if (w && hex) {
      const v = hex[1];
      out.push({ weight: Number(w[1]), r: parseInt(v.slice(0, 2), 16), g: parseInt(v.slice(2, 4), 16), b: parseInt(v.slice(4, 6), 16) });
    }
  }
  return out;
}

/** 找一个可执行文件：先看 PATH，再看候选绝对路径。找不到返回 ''。 */
export function findTool(names, candidates = []) {
  for (const name of names) {
    try {
      execFileSync(name, ['-version'], { stdio: 'ignore', timeout: 8000 });
      return name;
    } catch { /* 继续找 */ }
  }
  for (const c of candidates) {
    if (c && existsSync(c)) return c;
  }
  return '';
}

export const MAGICK_CANDIDATES = [
  String.raw`C:\Users\75424\scoop\apps\imagemagick\current\magick.exe`,
  String.raw`C:\Program Files\ImageMagick-7.1.1-Q16-HDRI\magick.exe`,
  '/usr/bin/magick', '/usr/local/bin/magick', '/opt/homebrew/bin/magick',
];
export const FFMPEG_CANDIDATES = [
  String.raw`C:\Users\75424\scoop\apps\ffmpeg-shared\current\bin\ffmpeg.exe`,
  '/usr/bin/ffmpeg', '/usr/local/bin/ffmpeg', '/opt/homebrew/bin/ffmpeg',
];

/**
 * 给一个壁纸文件取主色。
 * @param {string} file 图片或视频的绝对路径
 * @param {{magick?:string, ffmpeg?:string, runner?:Function, tmpFile?:string, colors?:number}} opts
 * @returns {{ok:boolean, colors?:Array, error?:string, via?:string}}
 */
export function colorsOfFile(file, opts = {}) {
  const run = opts.runner || ((cmd, args) => execFileSync(cmd, args, { encoding: 'utf8', timeout: 30000, maxBuffer: 4 * 1024 * 1024 }));
  const magick = opts.magick || findTool(['magick'], MAGICK_CANDIDATES);
  if (!magick) return { ok: false, error: '这台机器上没有 ImageMagick（magick）' };
  const isVideo = /\.(mp4|webm|mov|m4v)$/i.test(file);
  let target = file;
  let via = 'image';
  if (isVideo) {
    const ffmpeg = opts.ffmpeg || findTool(['ffmpeg'], FFMPEG_CANDIDATES);
    if (!ffmpeg) return { ok: false, error: '这是视频，但这台机器上没有 ffmpeg（抽不了帧）' };
    target = opts.tmpFile || '';
    if (!target) return { ok: false, error: '视频取色需要先给一个临时文件路径' };
    try {
      run(ffmpeg, ['-y', '-ss', '1', '-i', file, '-frames:v', '1', '-vf', 'scale=64:-1', target]);
    } catch (e) {
      return { ok: false, error: `抽帧失败：${String(e.message || e).slice(0, 120)}` };
    }
    via = 'video-frame';
  }
  try {
    const text = run(magick, [target, '-resize', '64x64', '-colors', String(opts.colors || 6),
      '-format', '%c', 'histogram:info:-']);
    const colors = parseHistogram(text);
    if (!colors.length) return { ok: false, error: '没解析出色值' };
    return { ok: true, colors, via };
  } catch (e) {
    return { ok: false, error: `取色失败：${String(e.message || e).slice(0, 120)}` };
  }
}

/**
 * 综合判断一张壁纸的风格。
 * 优先级：**手工标注** > 颜色分析 > 文件名提示 > other。
 * @returns {{style:'p5'|'p3r'|'other', source:'manual'|'color'|'name'|'none', detail:string}}
 */
export function decideStyle({ manual = '', name = '', colors = null } = {}) {
  if (WALLPAPER_STYLES.includes(manual)) return { style: manual, source: 'manual', detail: '你手工标的' };
  if (Array.isArray(colors) && colors.length) {
    const v = classifyColors(colors);
    if (v.style !== 'other') return { style: v.style, source: 'color', detail: v.why };
    const hint = nameStyleHint(name);
    if (hint) return { style: hint, source: 'name', detail: `颜色判不出来（${v.why}），按名字里的线索算` };
    return { style: 'other', source: 'color', detail: v.why };
  }
  const hint = nameStyleHint(name);
  return hint ? { style: hint, source: 'name', detail: '没取到颜色，按名字里的线索算' } : { style: 'other', source: 'none', detail: '没有可用信息' };
}
