// 壁纸目录扫描（W4-4：从"只认 Wallpaper Engine"改成"任意壁纸目录都行"）。
//
// 支持两种布局，可以混在一起：
//   A) Wallpaper Engine 创意工坊风格：每个子目录一个壁纸（project.json + preview.* + 视频/.pkg）
//   B) 普通目录：直接把图片/视频丢进去（id 用文件名，预览就是文件本身）
//
// 返回的对象形状与原来一致（外层 API 与前端都不用改），只多一个 kind 字段。
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

export const WALLPAPER_IMAGE_EXT = ['.jpg', '.jpeg', '.png', '.gif', '.webp', '.bmp', '.avif'];
export const WALLPAPER_VIDEO_EXT = ['.mp4', '.webm', '.mov', '.m4v'];

// ---------------- 「壁纸模式」：让它自己会换（2026-10-09）----------------
//
// 用户原话："调整 cairn 的壁纸，将其设置为可以自主改动的模式"（并补充：这是**私人化改动**）。
// 所以：**代码保持通用**（谁都能用这三个模式），**具体选了哪张、换得多快只存在本机 data\ 里**
//（`sync_state.wp_prefs_json`），不进公开仓库、也不进体验包。
//
// 三个模式：
//   theme  —— 按主题固定（默认，= 原来的行为：P5 一张、P3R 一张，点格子上的标签换）
//   rotate —— **自动轮换**：按时间片（每小时 / 每天）换下一张；同一个时间片里所有客户端看到同一张
//   random —— **每次打开随机**：每次打开应用随机一张（同一页面内保持不变）
export const WALLPAPER_MODES = ['theme', 'rotate', 'random'];
export const WALLPAPER_PERIODS = ['open', 'hour', 'day'];
const PERIOD_MS = { open: 1, hour: 3600000, day: 86400000 };

/** 配置清洗：不认识的值一律回到"按主题固定"（绝不因为配置坏了就黑屏）。 */
export function normalizeWallpaperPrefs(raw) {
  const r = raw && typeof raw === 'object' ? raw : {};
  const mode = WALLPAPER_MODES.includes(String(r.mode)) ? String(r.mode) : 'theme';
  const period = WALLPAPER_PERIODS.includes(String(r.period)) ? String(r.period) : 'day';
  const offset = Number.isFinite(Number(r.offset)) ? Math.trunc(Number(r.offset)) : 0;
  return { schema: 'wallpaper-prefs.v1', mode, period, offset };
}

/**
 * 第几个时间片（rotate 用）。**同一个时间片内返回值不变** —— 这样刷新页面、
 * 换设备看到的都是同一张；"现在换一张"= 把 offset 加一，立刻跳到下一张。
 */
export function periodIndex(period, nowMs, offset = 0) {
  const p = WALLPAPER_PERIODS.includes(String(period)) ? String(period) : 'day';
  if (p === 'open') return Math.trunc(offset);      // 每次打开：由调用方（前端）随机，这里不带时间
  const ms = PERIOD_MS[p];
  return Math.floor(Number(nowMs) / ms) + Math.trunc(offset);
}

/** 轮换选图：按时间片取模，保证"同一时间片同一张"。空列表返回 ''。 */
export function pickRotate(pool, index) {
  const list = Array.isArray(pool) ? pool.filter(Boolean) : [];
  if (!list.length) return '';
  const n = list.length;
  const i = ((Math.trunc(index) % n) + n) % n;       // 负数也要落到合法下标
  return String(list[i]);
}

/** 随机选图（默认用 Math.random；测试里可以传自己的随机源）。 */
export function pickRandom(pool, rnd = Math.random) {
  const list = Array.isArray(pool) ? pool.filter(Boolean) : [];
  if (!list.length) return '';
  const x = Number(rnd());
  const i = Math.min(list.length - 1, Math.max(0, Math.floor((Number.isFinite(x) ? x : 0) * list.length)));
  return String(list[i]);
}

const isImage = (name) => WALLPAPER_IMAGE_EXT.some((e) => String(name).toLowerCase().endsWith(e));
const isVideo = (name) => WALLPAPER_VIDEO_EXT.some((e) => String(name).toLowerCase().endsWith(e));

/** 文件名 → 展示名（去扩展名、下划线/连字符转空格）。 */
export function prettyName(fileName) {
  return String(fileName).replace(/\.[^.]+$/, '').replace(/[_-]+/g, ' ').trim();
}

/** id 会拼进 URL，必须挡住 ../ 与奇怪字符。 */
export function safeWallpaperId(id) {
  const s = String(id || '');
  return /^[A-Za-z0-9._\u4e00-\u9fff-]{1,80}$/.test(s) && !s.includes('..');
}

/** 扫描一个壁纸目录（不存在或读不到就返回空数组，绝不抛）。 */
export function scanWallpaperDir(dir) {
  const out = [];
  if (!dir || !existsSync(dir)) return out;
  let entries = [];
  try { entries = readdirSync(dir); } catch { return out; }

  for (const name of entries.sort()) {
    if (!safeWallpaperId(name)) continue;
    const full = join(dir, name);
    let isDir = false;
    try { isDir = statSync(full).isDirectory(); } catch { continue; }

    if (isDir) {
      // 布局 A：Wallpaper Engine 风格（子目录 + project.json / preview / 视频 / .pkg）
      let files = [];
      try { files = readdirSync(full); } catch { continue; }
      const hasPreview = ['preview.jpg', 'preview.png', 'preview.gif'].some((x) => files.includes(x));
      out.push({
        id: name,
        name: projectTitle(full) || name,
        has_video: files.some(isVideo),
        has_scene: files.some((x) => x.endsWith('.pkg')),
        preview_url: hasPreview ? `/api/wallpapers/${encodeURIComponent(name)}/preview` : null,
        video_url: null,
        kind: 'we',
      });
      continue;
    }

    // 布局 B：目录里直接放图片/视频
    if (isImage(name) || isVideo(name)) {
      out.push({
        id: name,
        name: prettyName(name),
        has_video: isVideo(name),
        has_scene: false,
        preview_url: `/api/wallpapers/${encodeURIComponent(name)}/preview`,
        video_url: isVideo(name) ? `/api/wallpapers/${encodeURIComponent(name)}/video` : null,
        kind: 'file',
      });
    }
  }
  return out;
}

/** 解析某个 id 的真实文件路径（两种布局都支持）。 */
export function wallpaperFilePaths(dir, id) {
  if (!dir || !safeWallpaperId(id)) return { preview: null, video: null };
  const full = join(dir, id);
  if (!existsSync(full)) return { preview: null, video: null };
  let isDir = false;
  try { isDir = statSync(full).isDirectory(); } catch { return { preview: null, video: null }; }

  if (!isDir) {
    // 布局 B：这个 id 本身就是一个文件
    return isVideo(id) ? { preview: full, video: full } : { preview: full, video: null };
  }
  let files = [];
  try { files = readdirSync(full); } catch { return { preview: null, video: null }; }
  let preview = null;
  for (const cand of ['preview.jpg', 'preview.png', 'preview.gif']) {
    if (files.includes(cand)) { preview = join(full, cand); break; }
  }
  const videoName = files.find(isVideo);
  return { preview, video: videoName ? join(full, videoName) : null };
}

function projectTitle(dir) {
  try {
    const j = JSON.parse(readFileSync(join(dir, 'project.json'), 'utf8'));
    return j.title || j.name || null;
  } catch { return null; }
}
