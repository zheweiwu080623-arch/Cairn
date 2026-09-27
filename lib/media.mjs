// media.mjs —— 壁纸与本地音乐（R2：从 2600 行的 server.mjs 里拆出来的第一组）
//
// 为什么先拆这组：
//   * 它**自成一块**（壁纸目录扫描 + 音乐扫描 + 音频流式播放），与业务数据耦合最少；
//   * 它包含一个**安全点**（音乐文件的目录穿越防护），单独放一个文件更容易被审阅；
//   * 拆出去之后 server.mjs 不再需要知道"壁纸长什么样"。
//
// 拆的原则（和后面每一步一样）：**只搬位置，不改行为**。
// 所有外部依赖从外面传进来（`ctx`），不在这里 import store —— 这样测试能塞替身。
import { copyFileSync, existsSync, readdirSync, statSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { extname, join, resolve } from 'node:path';

import { scanWallpaperDir, wallpaperFilePaths } from './wallpapers.mjs';
import { localPath } from './local-config.mjs';

export const AUDIO_EXT = ['.mp3', '.flac', '.m4a', '.aac', '.wav', '.ogg', '.oga', '.opus', '.wma'];

/**
 * @param {object} ctx
 * @param {object} ctx.store        同步键值存储（getSync / setSync）
 * @param {string} ctx.repoDir      仓库根目录（找内置壁纸资源）
 * @param {string} ctx.dataDir      数据目录（读本机路径配置）
 * @param {(req,res,filePath,ext)=>void} ctx.streamMedia  流式返回媒体文件（仍在 server 里）
 * @param {(res,code,obj)=>void} ctx.sendJson
 * @param {(res,code,message)=>void} ctx.sendError
 * @param {(res)=>void} ctx.notFound
 * @param {(req)=>Promise<any>} ctx.readBody
 */
export function createMedia(ctx) {
  const {
    store, repoDir, dataDir, streamMedia, sendJson, sendError, notFound, readBody,
  } = ctx;

  // 壁纸目录（W4-4：不再只认 Wallpaper Engine）：环境变量 > 本机配置 data\paths.json > 空。
  // 新名字是 PLANNER_WALLPAPER_DIR / wallpaper_dir，老名字继续认（改名不破坏老装机）。
  //
  // 注意这里是 **let 而不是 const**：界面上可以「选一个文件夹」改壁纸目录（见
  // routes/localdirs.mjs），改完要**立刻生效**、不用重启应用。优先顺序不变 ——
  // 环境变量仍然最优先（它的用途就是"临时压过配置文件"）。
  let WALLPAPER_DIR = localPath({
    envKey: ['PLANNER_WALLPAPER_DIR', 'WALLPAPER_ENGINE_DIR'],
    configKey: ['wallpaper_dir', 'wallpaper_engine_dir'],
    dataDir,
  });

  /** 重新解析一次壁纸目录（手动改了 paths.json、或界面刚改过，都能跟上）。 */
  function refreshWallpaperDir() {
    WALLPAPER_DIR = localPath({
      envKey: ['PLANNER_WALLPAPER_DIR', 'WALLPAPER_ENGINE_DIR'],
      configKey: ['wallpaper_dir', 'wallpaper_engine_dir'],
      dataDir,
    });
    return WALLPAPER_DIR;
  }

  /** 界面改了壁纸目录之后叫一下这里（空字符串 = 清掉配置）。 */
  function setWallpaperDir(dir) {
    WALLPAPER_DIR = dir ? String(dir) : '';
    return WALLPAPER_DIR;
  }
  const WP_ASSET_DIR = join(repoDir, 'public', 'assets', 'wallpapers');

  function scanWallpapers() {
    // 扫描用户配置的壁纸目录：Wallpaper Engine 风格与"直接放图片/视频"两种布局都支持（W4-4）
    const out = scanWallpaperDir(WALLPAPER_DIR);
    out.push({ id: 'wolf-duo', name: '双狼 · 深暗(蓝)', has_video: true, has_scene: false, preview_url: '/api/wallpapers/wolf-duo/preview' });
    out.push({ id: 'seq03', name: '序列03 · 青蓝', has_video: true, has_scene: false, preview_url: '/api/wallpapers/seq03/preview' });
    out.push({ id: 'p5r', name: 'P5R · 雨宫莲(黑红)', has_video: true, has_scene: false, preview_url: '/api/wallpapers/p5r/preview' });
    out.push({ id: 'p3r', name: 'P3R · 4K 日夜(克莱因蓝)', has_video: false, has_scene: false, preview_url: '/api/wallpapers/p3r/preview' });
    return out;
  }

  function wallpaperPreviewPath(id) {
    if (id === 'wolf-duo') return join(WP_ASSET_DIR, 'wolf-duo.gif');
    if (id === 'seq03') return join(WP_ASSET_DIR, 'seq03.jpg');
    if (id === 'p5r') return join(WP_ASSET_DIR, 'p5r-joker.jpg');
    if (id === 'p3r') return join(WP_ASSET_DIR, 'p3r-reload.gif');
    return wallpaperFilePaths(WALLPAPER_DIR, id).preview;
  }

  function wallpaperVideoPath(id) {
    if (id === 'wolf-duo') return join(WP_ASSET_DIR, 'wolf-duo.mp4');
    if (id === 'seq03') return join(WP_ASSET_DIR, 'seq03.mp4');
    if (id === 'p5r') return join(WALLPAPER_DIR, '2714977723', '202201172203.mp4');
    return wallpaperFilePaths(WALLPAPER_DIR, id).video;
  }

  // ---------- 本地音乐（扫描本机文件夹 + 流式播放） ----------
  function defaultMusicDir() {
    const home = process.env.USERPROFILE || process.env.HOME || '';
    return home ? join(home, 'Music') : '';
  }

  function currentMusicDir() { return store.getSync('music_dir') || defaultMusicDir(); }

  let musicCache = { dir: currentMusicDir(), tracks: [], scanned_at: 0 };

  function scanMusic(dir) {
    const out = [];
    if (!dir || !existsSync(dir)) return out;
    const walk = (d, depth) => {
      if (depth > 6 || out.length > 5000) return;
      let entries; try { entries = readdirSync(d, { withFileTypes: true }); } catch { return; }
      for (const e of entries) {
        const full = join(d, e.name);
        if (e.isDirectory()) { if (!e.name.startsWith('.')) walk(full, depth + 1); continue; }
        const ext = extname(e.name).toLowerCase();
        if (!AUDIO_EXT.includes(ext)) continue;
        let st; try { st = statSync(full); } catch { continue; }
        out.push({ name: e.name.replace(/\.[^.]+$/, ''), file: full.slice(dir.length + 1).split('\\').join('/'), ext, size: st.size });
      }
    };
    try { walk(dir, 0); } catch { /* ignore */ }
    out.sort((a, b) => a.name.localeCompare(b.name, 'zh'));
    return out;
  }

  function rescanMusic(dir) {
    const d = dir != null ? dir : currentMusicDir();
    musicCache = { dir: d, tracks: scanMusic(d), scanned_at: Date.now() };
    return musicCache;
  }

  function getMusic() { return musicCache; }

  /** 取音乐文件的绝对路径；**挡掉目录穿越**（这个函数是安全边界，别改成"看着更短"的写法）。 */
  function musicFilePath(rel) {
    const dir = currentMusicDir();
    if (!dir) return null;
    const base = resolve(dir);
    const full = resolve(join(dir, String(rel || '')));
    if (full !== base && !full.startsWith(base + (process.platform === 'win32' ? '\\' : '/'))) return null;
    if (!existsSync(full)) return null;
    // 只认**文件**：空文件名会解到目录本身，目录不是能播的东西，直接当没有
    try { return statSync(full).isFile() ? full : null; } catch { return null; }
  }

  async function handleWallpapers(req, res, url) {
    const seg = url.pathname.split('/').filter(Boolean);
    const method = req.method;
    if (seg[1] !== 'wallpapers') return notFound(res);
    if (seg.length === 2 && method === 'GET') {
      refreshWallpaperDir();                     // 现读一次：界面改完、或手动改了 paths.json 都立刻生效
      return sendJson(res, 200, {
        dir: WALLPAPER_DIR,
        wallpapers: scanWallpapers(),
        map: { p5: store.getSync('wp_p5') || 'p5r', p3r: store.getSync('wp_p3r') || '3210179384' },
      });
    }
    const id = seg[2];
    if (id && seg[3] === 'video' && method === 'GET') {
      const v = wallpaperVideoPath(id);
      if (!v || !existsSync(v)) return sendError(res, 404, 'no video');
      return streamMedia(req, res, v, extname(v).toLowerCase());
    }
    if (id && seg[3] === 'preview' && method === 'GET') {
      const p = wallpaperPreviewPath(id);
      if (!p || !existsSync(p)) return sendError(res, 404, 'no preview');
      const e = extname(p).toLowerCase();
      const mime = e === '.gif' ? 'image/gif' : e === '.png' ? 'image/png' : 'image/jpeg';
      const data = await readFile(p);
      res.writeHead(200, { 'Content-Type': mime }); res.end(data); return;
    }
    if (id && seg[3] === 'use' && method === 'POST') {
      const b = await readBody(req); const theme = b.theme || 'p3r';
      const video = wallpaperVideoPath(id); const poster = wallpaperPreviewPath(id);
      let videoUrl = null, posterUrl = null;
      if (id === 'p5r' || id === 'p3r') {
        videoUrl = id === 'p5r' ? '/api/wallpapers/p5r/video' : null;
        posterUrl = `/api/wallpapers/${id}/preview`;
      } else {
        if (video && extname(video).toLowerCase() === '.mp4') {
          try { copyFileSync(video, join(WP_ASSET_DIR, id + '.mp4')); videoUrl = `/assets/wallpapers/${id}.mp4`; } catch {}
        }
        if (poster) {
          const e = extname(poster).toLowerCase();
          try { copyFileSync(poster, join(WP_ASSET_DIR, id + e)); posterUrl = `/assets/wallpapers/${id}${e}`; } catch {}
        }
      }
      store.setSync('wp_' + theme, id);
      return sendJson(res, 200, { theme, id, video: videoUrl, poster: posterUrl });
    }
    return notFound(res);
  }

  /** 「本地音乐」的三个接口：列表 / 扫描 / 流式播放。 */
  async function handleMusic(req, res, url) {
    const p = url.pathname;
    const method = req.method;
    if (p === '/api/music' && method === 'GET') return sendJson(res, 200, getMusic());
    if (p === '/api/music/scan' && method === 'POST') {
      const b = await readBody(req);
      // 记住用户选的目录（下次启动还用它）
      if (b.dir != null) store.setSync('music_dir', String(b.dir || ''));
      return sendJson(res, 200, rescanMusic(b.dir != null ? String(b.dir || '') : undefined));
    }
    if (p === '/api/music/stream' && method === 'GET') {
      const fp = musicFilePath(url.searchParams.get('f') || '');
      if (!fp) return sendError(res, 404, 'not found');
      return streamMedia(req, res, fp, extname(fp).toLowerCase());
    }
    return notFound(res);
  }

  return {
    // 用取值器而不是快照：外部任何时候读到的都是"当前"的壁纸目录
    get WALLPAPER_DIR() { return WALLPAPER_DIR; },
    refreshWallpaperDir,
    setWallpaperDir,
    scanWallpapers,
    wallpaperPreviewPath,
    wallpaperVideoPath,
    scanMusic,
    rescanMusic,
    getMusic,
    musicFilePath,
    currentMusicDir,
    handleWallpapers,
    handleMusic,
  };
}
