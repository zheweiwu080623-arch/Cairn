// server-shell.mjs —— 「服务器外壳」：跟"业务"无关、纯粹让进程活得像个服务的那些东西。
//
// 2026-09-24 拆出来的（用户定的拆分原则：**汇总 + 分析 + 接口表留在主程序，其余搬出去**）。
// 这里装四件事：
//   1) **文件日志**：后台模式没有控制台，出错/静默退出必须留痕；超 2 MB 自动滚成 .1；
//   2) **进程护栏**：未捕获异常与未处理的 Promise 拒绝只记一行，绝不让主循环停下来；
//   3) **静态资源与流式播放**：public/ 与 modules/<id>/ 的文件、视频 range 请求；
//   4) **打开浏览器**：只在 OPEN=1 时用（本机自用）。
//
// 两条"踩过的坑"原样带过来（别在重构时丢掉）：
//   * 视频/音频必须用 `pipeline` 而不是 `.pipe(res)`：浏览器对视频会反复 abort range 请求，
//     `.pipe` 在响应中断时**不销毁读流**，每次漏一个 fd，攒够就 EMFILE（2026-09-16 实测"应用像崩了"）；
//   * 静态读取失败**不能静默 404**：以前句柄耗尽时看起来像"页面不存在"，极难查 —— 现在记日志 + 500。

import { spawn as spawnChild } from 'node:child_process';
import { createReadStream, createWriteStream, existsSync, mkdirSync, renameSync, rmSync, statSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { pipeline } from 'node:stream';
import { dirname, extname, join, resolve } from 'node:path';
import { format } from 'node:util';

/** 静态资源类型（页面 / 脚本 / 样式）。 */
export const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  // 2026-09-26 踩过：模块页面若命名成 .mjs，浏览器会"Failed to fetch dynamically imported module"
  // —— 因为这张表里没有它。补上，别再让扩展名决定页面能不能打开。
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.svg': 'image/svg+xml',
};

/** 音视频类型（走 range 流式播放）。 */
export const MEDIA_MIME = {
  '.mp4': 'video/mp4', '.webm': 'video/webm', '.ogv': 'video/ogg', '.mov': 'video/mp4', '.gif': 'image/gif',
  '.mp3': 'audio/mpeg', '.flac': 'audio/flac', '.m4a': 'audio/mp4', '.aac': 'audio/aac', '.wav': 'audio/wav',
  '.ogg': 'audio/ogg', '.oga': 'audio/ogg', '.opus': 'audio/ogg', '.wma': 'audio/x-ms-wma',
};

/** 扩展名 → Content-Type（静态资源用；不认识就当二进制）。 */
export function mimeFor(ext) {
  return MIME[String(ext || '').toLowerCase()] || 'application/octet-stream';
}

/**
 * 后台运行日志：把 console 的 log/warn/error 同时写进文件；超限自动滚一份 `.1`。
 * 任何一步失败都**静默降级**（宁可没日志，也不能因为日志起不来）。
 */
export function initFileLogging({ logPath, maxBytes = 2 * 1024 * 1024, dataDir = null, consoleRef = console } = {}) {
  if (!logPath) return { ok: false, reason: '没有日志路径' };
  let stream = null;
  try {
    if (dataDir) mkdirSync(dataDir, { recursive: true });
    // 日志所在目录也确保存在（换台机器 / 新数据目录时常见）；路径创建不了 → 这里就同步失败
    mkdirSync(dirname(logPath), { recursive: true });
    try {
      if (statSync(logPath).size > maxBytes) {
        try { rmSync(`${logPath}.1`, { force: true }); } catch { /* ignore */ }
        renameSync(logPath, `${logPath}.1`);
      }
    } catch { /* 首次运行：还没有日志文件 */ }
    stream = createWriteStream(logPath, { flags: 'a' });
    stream.on('error', () => { stream = null; });
  } catch { stream = null; }
  if (!stream) return { ok: false, reason: '打不开日志文件' };
  const stamp = () => {
    const d = new Date();
    const p2 = (n) => String(n).padStart(2, '0');
    return `${d.getFullYear()}-${p2(d.getMonth() + 1)}-${p2(d.getDate())} ${p2(d.getHours())}:${p2(d.getMinutes())}:${p2(d.getSeconds())}`;
  };
  const wrap = (name, tag) => {
    const orig = consoleRef[name].bind(consoleRef);
    consoleRef[name] = (...args) => {
      const line = `[${stamp()}] ${tag}${format(...args)}`;
      try { if (stream) stream.write(`${line}\n`); } catch { /* ignore */ }
      orig(...args);
    };
  };
  wrap('log', '');
  wrap('warn', 'WARN ');
  wrap('error', 'ERROR ');
  return { ok: true };
}

/**
 * 进程护栏：未捕获异常 / 未处理的 Promise 拒绝**只记一行**，让主循环继续跑
 * （提醒调度不能因为一次异常就停掉）。注入 process 便于测试。
 */
export function installProcessGuards({ target = process } = {}) {
  const handles = {};
  handles.uncaught = (e) => console.error('[fatal] 未捕获异常：', (e && e.stack) || e);
  handles.rejection = (e) => console.error('[fatal] 未处理的 Promise 拒绝：', (e && e.stack) || e);
  target.on('uncaughtException', handles.uncaught);
  target.on('unhandledRejection', handles.rejection);
  return handles;
}

/**
 * 流式返回音视频文件（支持 HTTP range）。**必须用 pipeline** —— 见文件头的坑。
 * @param {{notFound:Function, log?:Function}} deps
 */
export function streamMedia(req, res, filePath, ext, { notFound, log = console.log } = {}) {
  let size = 0;
  try { size = statSync(filePath).size; } catch { return notFound ? notFound(res) : res.writeHead(404).end(); }
  const mime = MEDIA_MIME[ext] || 'application/octet-stream';
  const range = req.headers.range;
  let stream;
  if (range) {
    const m = range.match(/bytes=(\d+)-(\d*)/);
    const start = m && m[1] ? parseInt(m[1], 10) : 0;
    const end = m && m[2] ? parseInt(m[2], 10) : size - 1;
    res.writeHead(206, {
      'Content-Range': `bytes ${start}-${end}/${size}`,
      'Accept-Ranges': 'bytes',
      'Content-Length': end - start + 1,
      'Content-Type': mime,
      'Cache-Control': 'no-cache',
    });
    stream = createReadStream(filePath, { start, end });
  } else {
    res.writeHead(200, { 'Content-Length': size, 'Content-Type': mime, 'Accept-Ranges': 'bytes', 'Cache-Control': 'no-cache' });
    stream = createReadStream(filePath);
  }
  pipeline(stream, res, (err) => {
    if (!err) return;
    const code = err.code || err.message;
    if (code !== 'ERR_STREAM_PREMATURE_CLOSE' && code !== 'EPIPE' && code !== 'ECONNRESET') {
      log(`[media] 传输中断（${code}）：${filePath}`);
    }
    try { stream.destroy(); } catch { /* ignore */ }
    try { res.destroy(); } catch { /* ignore */ }
  });
}

/**
 * 静态资源handler：`public/` 下的文件 + `modules/<id>/` 下的模块资源（挡住目录穿越）+ SPA 回退。
 * 依赖全部注入，方便离线测。
 */
export function createStaticHandler({
  pubDir, modulesDir, moduleAssetPath, sendError, notFound, log = console.log,
  stream = streamMedia,                     // 可注入：测试里不用真读文件
} = {}) {
  return async function serveStatic(req, res, pathname) {
    // 模块静态资源（W2）：/modules/<id>/<文件…> —— 只允许读 modules/<id>/ 里面
    if (pathname.startsWith('/modules/')) {
      const parts = pathname.slice('/modules/'.length).split('/').filter(Boolean);
      const [moduleId, ...rest] = parts;
      const target = moduleAssetPath(modulesDir, moduleId, rest.join('/'));
      if (!target || !existsSync(target) || !statSync(target).isFile()) return notFound(res);
      try {
        const ext = extname(target);
        if (MEDIA_MIME[ext]) return stream(req, res, target, ext, { notFound, log });
        const data = await readFile(target);
        res.writeHead(200, {
          'Content-Type': ext === '.js' ? 'text/javascript; charset=utf-8' : mimeFor(ext),
          'Cache-Control': 'no-store, must-revalidate',
        });
        return res.end(data);
      } catch (e) {
        return sendError(res, 500, String(e.message || e));
      }
    }
    let filePath = resolve(pubDir, '.' + (pathname === '/' ? '/index.html' : pathname));
    if (!filePath.startsWith(resolve(pubDir))) return notFound(res);
    if (!existsSync(filePath)) {
      filePath = join(pubDir, 'index.html');                       // SPA fallback
    }
    try {
      const ext = extname(filePath);
      if (MEDIA_MIME[ext]) return stream(req, res, filePath, ext, { notFound, log });
      const data = await readFile(filePath);
      // 2026-09-26：index.html 里的 app.js / styles.css / vm-bridge.js 一律**按文件修改时间自动带版本号**。
      // 起因：浏览器对静态资源的缓存比 no-store 更顽固（实测：改了 app.js 仍跑旧逻辑），
      // 手动改版本号又总会忘记 ⇒ 干脆由服务器在发送时注入 `?v=<mtime>`，改完文件就自动失效。
      let body = data;
      if (ext === '.html') {
        let html = data.toString('utf8');
        const stamp = (rel) => {
          try { return String(Math.round(statSync(join(pubDir, rel)).mtimeMs)); } catch { return '0'; }
        };
        html = html.replace(/(src|href)="(app\.js|vm-bridge\.js|styles\.css)(\?[^"]*)?"/g,
          (m0, attr, rel) => `${attr}="${rel}?v=${stamp(rel)}"`);
        body = Buffer.from(html, 'utf8');
      }
      res.writeHead(200, {
        'Content-Type': mimeFor(ext),
        'Content-Length': body.length,
        // 不缓存，保证每次打开都用最新代码（避免旧页面继续跑旧逻辑）
        'Cache-Control': 'no-store, must-revalidate',
      });
      res.end(body);
    } catch (e) {
      // 以前这里静默返回 404，句柄耗尽（EMFILE）时看起来像"页面不存在"，非常难查。
      log(`[static] 读取失败：${pathname} —— ${e.code || e.message}`);
      if (!res.headersSent) sendError(res, 500, `读取静态文件失败：${e.code || e.message}`);
      else { try { res.destroy(); } catch { /* ignore */ } }
    }
  };
}

/** 用系统默认浏览器打开本机地址（只在 OPEN=1 时被调用；跨三平台）。 */
export function openBrowser({ url, platform = process.platform, exec = null } = {}) {
  const cmd = platform === 'win32' ? `start "" "${url}"`
    : platform === 'darwin' ? `open "${url}"` : `xdg-open "${url}"`;
  try {
    if (typeof exec === 'function') { exec(cmd); return { ok: true, cmd }; }
    import('node:child_process').then(({ exec: real }) => real(cmd)).catch(() => {});
    return { ok: true, cmd };
  } catch { return { ok: false, cmd }; }
}

// ---------- 打开"外部链接 / 本机文件夹"（跨三平台，2026-09-27）----------
// 起因：以前这两件事各自写死 Windows（一个写死 Edge/Chrome 的 C:\ 路径 + rundll32，
// 一个写死 explorer.exe 还忽略错误恒回成功）—— macOS / Linux 上要么打不开、要么谎报成功。
// 现在统一放这里：**返回真实结果**（打不开就 ok:false，界面才有机会给退路）。

/** 可能存在的 Edge / Chrome 可执行文件（Windows / macOS；Linux 交给 PATH 与 xdg-open）。 */
export function browserExeCandidates(platform = process.platform) {
  if (platform === 'win32') {
    return [
      'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
      'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
      'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
      'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
    ];
  }
  if (platform === 'darwin') {
    return [
      '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
      '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    ];
  }
  return [];
}

/**
 * 用外部浏览器打开一个链接（有 Edge/Chrome 就复用它，否则退回系统默认浏览器）。
 * 返回 Promise：**真的起来了才 ok:true**（子进程 ENOENT 会以 ok:false 回来）。
 */
export function openExternalUrl({ url, platform = process.platform, exists = existsSync, spawnFn = spawnChild } = {}) {
  const target = String(url || '').trim();
  if (!/^https?:\/\//i.test(target)) return Promise.resolve({ ok: false, error: '只支持 http/https 链接' });
  const exe = browserExeCandidates(platform).find((p) => { try { return exists(p); } catch { return false; } });
  const cmd = exe || (platform === 'win32' ? 'rundll32.exe' : platform === 'darwin' ? 'open' : 'xdg-open');
  const args = exe ? [target]
    : platform === 'win32' ? ['url.dll,FileProtocolHandler', target] : [target];
  return runDetached(spawnFn, cmd, args, exe ? 'browser' : 'default');
}

/**
 * 打开一个本机文件夹 / 文件（Windows explorer / macOS open / Linux xdg-open）。
 * 注：Windows 的 explorer 成功时也可能返回退出码 1，所以这里以"进程起来了"为准。
 */
export function openPath(target, { platform = process.platform, spawnFn = spawnChild } = {}) {
  const p = String(target || '').trim();
  if (!p) return Promise.resolve({ ok: false, error: '没有要打开的路径' });
  const cmd = platform === 'win32' ? 'explorer' : platform === 'darwin' ? 'open' : 'xdg-open';
  if (!['win32', 'darwin', 'linux'].includes(platform)) {
    return Promise.resolve({ ok: false, error: `这个平台（${platform}）暂时不支持打开文件夹` });
  }
  return runDetached(spawnFn, cmd, [p], 'opener');
}

/** 起一个"不阻塞、不接管"的子进程，并以真实结果 resolve。 */
function runDetached(spawnFn, cmd, args, via) {
  return new Promise((resolve) => {
    let child;
    try {
      child = spawnFn(cmd, args, { detached: true, stdio: 'ignore' });
    } catch (e) {
      return resolve({ ok: false, error: (e && e.message) || String(e), cmd, args, via });
    }
    let done = false;
    const finish = (result) => { if (!done) { done = true; resolve(result); } };
    child.once('error', (e) => finish({ ok: false, error: (e && e.message) || String(e), cmd, args, via }));
    child.once('spawn', () => {
      try { child.unref(); } catch { /* ignore */ }
      finish({ ok: true, cmd, args, via });
    });
    setTimeout(() => finish({ ok: false, error: '启动外部程序超时', cmd, args, via }), 8000).unref?.();
  });
}
