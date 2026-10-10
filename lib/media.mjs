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

import {
  normalizeWallpaperPrefs, periodIndex, pickRotate, scanWallpaperDir, wallpaperFilePaths,
} from './wallpapers.mjs';
// 2026-10-09：按**颜色风格**把壁纸分成 P5R（黑红）/ P3R（克莱因蓝）两类，再按类轮换。
// 取色走本机的 ImageMagick（视频先 ffmpeg 抽一帧）；没装工具就退化成"按名字猜"，绝不报错。
import { colorsOfFile, decideStyle, WALLPAPER_STYLES } from './wallpaper-style.mjs';
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
    // 2026-10-09：带上"颜色风格"（p5 黑红 / p3r 克莱因蓝 / other），供"分类轮换"用。
    // 值来自本机 wp_styles_json（自动判色 + 手工标注），没判过就是 other。
    const styles = readStyles();
    for (const w of out) {
      const s = styles[w.id] || {};
      w.style = WALLPAPER_STYLES.includes(s.style) ? s.style : 'other';
      w.style_source = s.source || '';
      w.style_detail = s.detail || '';
    }
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

  // ---------- 壁纸风格（P5R 黑红 / P3R 克莱因蓝）：分类结果与手工标注都只存本机 ----------
  // 存在 sync_state.wp_styles_json 里（随 data/ 一起被 gitignore 与打包规则排除）。
  function readStyles() {
    try { return JSON.parse(store.getSync('wp_styles_json') || '{}') || {}; } catch { return {}; }
  }
  function writeStyles(map) {
    store.setSync('wp_styles_json', JSON.stringify(map || {}));
    return map;
  }
  /** 取某个壁纸用来判色的文件：优先预览图；没有预览就退回视频（交给 ffmpeg 抽帧）。 */
  function styleSourceFile(id) {
    const preview = wallpaperPreviewPath(id);
    if (preview && existsSync(preview) && !/\.(mp4|webm|mov|m4v)$/i.test(preview)) return preview;
    const video = wallpaperVideoPath(id);
    if (video && existsSync(video)) return video;
    return preview && existsSync(preview) ? preview : '';
  }
  /** 给一批壁纸判颜色风格（只判"还没手工标过"的；force=true 时全部重判）。 */
  function classifyWallpapers({ force = false } = {}) {
    const styles = readStyles();
    const list = scanWallpapers();
    const changed = []; const skipped = []; const failed = [];
    for (const w of list) {
      const before = styles[w.id] || {};
      if (!force && before.source === 'manual') { skipped.push(w.id); continue; }
      const file = styleSourceFile(w.id);
      if (!file) { failed.push({ id: w.id, error: '找不到可判色的文件' }); continue; }
      const got = colorsOfFile(file, { tmpFile: join(dataDir, 'tmp', `wp-frame-${Buffer.from(w.id).toString('hex').slice(0, 12)}.jpg`) });
      const verdict = decideStyle({ manual: before.source === 'manual' ? before.style : '', name: `${w.name || ''} ${w.id}`, colors: got.ok ? got.colors : null });
      styles[w.id] = {
        style: verdict.style, source: verdict.source, detail: verdict.detail,
        via: got.via || '', error: got.ok ? '' : got.error, at: Date.now(),
      };
      changed.push(w.id);
    }
    writeStyles(styles);
    return { ok: true, total: list.length, judged: changed.length, manual_kept: skipped.length, failed };
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

    // 「壁纸模式」的本地配置（2026-10-09）。存在本机 sync_state 里 —— 属于**私人化配置**，
    // 不进公开仓库、也不进体验包；代码本身是通用的三选一（theme / rotate / random）。
    const readWpPrefs = () => {
      let raw = null;
      try { raw = JSON.parse(store.getSync('wp_prefs_json') || 'null'); } catch { raw = null; }
      return normalizeWallpaperPrefs(raw);
    };
    const wallpaperIds = () => scanWallpapers().map((w) => w.id);

    if (seg.length === 2 && method === 'GET') {
      refreshWallpaperDir();                     // 现读一次：界面改完、或手动改了 paths.json 都立刻生效
      const prefs = readWpPrefs();
      const wallpapers = scanWallpapers();
      // 按风格分池：p5（黑红）/ p3r（克莱因蓝）/ other。轮换时"在同类里轮"。
      const pools = { p5: [], p3r: [], other: [], all: wallpapers.map((w) => w.id) };
      for (const w of wallpapers) (pools[w.style] || pools.other).push(w.id);
      // rotate：由服务端按"时间片"算好这一片该用哪张 —— 刷新/换设备都一致。
      // 2026-10-09：**分类轮换** —— P5 主题从 p5 池里轮、P3R 主题从 p3r 池里轮；某一类空就退回全部。
      const currentFor = (key) => {
        const pool = (pools[key] && pools[key].length) ? pools[key] : pools.all;
        return pickRotate(pool, periodIndex(prefs.period, Date.now(), prefs.offset));
      };
      const current = prefs.mode === 'rotate' ? { p5: currentFor('p5'), p3r: currentFor('p3r') } : null;
      return sendJson(res, 200, {
        dir: WALLPAPER_DIR,
        wallpapers,
        map: { p5: store.getSync('wp_p5') || 'p5r', p3r: store.getSync('wp_p3r') || '3210179384' },
        prefs,
        current,
        pools,
      });
    }
    // 按颜色风格分类（一次判完；只判没手工标过的，force=true 时全部重判）
    if (seg.length === 3 && seg[2] === 'classify' && method === 'POST') {
      const b = await readBody(req).catch(() => ({}));
      const report = classifyWallpapers({ force: !!(b && b.force) });
      const wallpapers = scanWallpapers();
      const pools = { p5: [], p3r: [], other: [], all: wallpapers.map((w) => w.id) };
      for (const w of wallpapers) (pools[w.style] || pools.other).push(w.id);
      return sendJson(res, 200, { ...report, pools, wallpapers });
    }
    // 手工标注某一张的风格（style 传空 = 取消标注、下次重新自动判）
    if (seg.length === 3 && seg[2] === 'style' && method === 'POST') {
      const b = await readBody(req).catch(() => ({}));
      const id = String((b && b.id) || '');
      const want = String((b && b.style) || '');
      const styles = readStyles();
      if (!id || !styles) return sendError(res, 400, '缺少 id');
      if (WALLPAPER_STYLES.includes(want)) {
        styles[id] = { style: want, source: 'manual', detail: '你手工标的', via: '', error: '', at: Date.now() };
      } else {
        delete styles[id];                        // 取消 → 下次 classify 重新看图
      }
      writeStyles(styles);
      const wallpapers = scanWallpapers();
      const pools = { p5: [], p3r: [], other: [], all: wallpapers.map((w) => w.id) };
      for (const w of wallpapers) (pools[w.style] || pools.other).push(w.id);
      return sendJson(res, 200, { ok: true, id, style: want || 'auto', pools });
    }
    // 改模式（mode：theme / rotate / random；period：open / hour / day）
    if (seg.length === 3 && seg[2] === 'prefs' && method === 'POST') {
      const b = await readBody(req).catch(() => ({}));
      const before = readWpPrefs();
      const next = normalizeWallpaperPrefs({ ...before, ...(b || {}) });
      store.setSync('wp_prefs_json', JSON.stringify(next));
      const pool = wallpaperIds();
      return sendJson(res, 200, {
        ok: true,
        prefs: next,
        current: next.mode === 'rotate'
          ? pickRotate(pool, periodIndex(next.period, Date.now(), next.offset))
          : '',
      });
    }
    // 「现在换一张」：把 offset 推一格 —— 立刻跳到下一张（rotate 模式下才有效）
    if (seg.length === 3 && seg[2] === 'shuffle' && method === 'POST') {
      const before = readWpPrefs();
      const next = normalizeWallpaperPrefs({ ...before, offset: before.offset + 1 });
      store.setSync('wp_prefs_json', JSON.stringify(next));
      const pool = wallpaperIds();
      return sendJson(res, 200, {
        ok: true,
        prefs: next,
        current: pickRotate(pool, periodIndex(next.period, Date.now(), next.offset)),
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
