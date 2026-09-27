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
