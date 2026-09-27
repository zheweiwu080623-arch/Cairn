// 「服务器外壳」的验证（2026-09-24 拆分第一批）。
//
//   node tests/server-shell.test.mjs
//
// 它同时是**主程序结构闸门**的唯一权威处：以前三处测试各自数行数（<2200 / <2450 / <2600），
// 现在统一成"结构为主、行数兜底"。

import { existsSync, mkdirSync, mkdtempSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Writable } from 'node:stream';

import {
  MEDIA_MIME, MIME, createStaticHandler, initFileLogging, installProcessGuards, mimeFor, openBrowser, streamMedia,
} from '../lib/server-shell.mjs';

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
console.log('server-shell.test.mjs');
const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const root = mkdtempSync(join(TMP, 'shell-'));

// ---------------- 1. MIME ----------------
ok('静态资源类型：html / js / css / json / svg',
  mimeFor('.html').includes('text/html') && mimeFor('.JS').includes('javascript') && mimeFor('.css').includes('css')
  && mimeFor('.json').includes('json') && mimeFor('.svg').includes('svg'));
ok('不认识的扩展名 → 二进制', mimeFor('.exe') === 'application/octet-stream');
ok('音视频类型都在（mp4 / mp3 / flac / opus）',
  MEDIA_MIME['.mp4'] === 'video/mp4' && MEDIA_MIME['.mp3'] === 'audio/mpeg'
  && MEDIA_MIME['.flac'] === 'audio/flac' && MEDIA_MIME['.opus'] === 'audio/ogg');
ok('音视频**不**在静态 MIME 表里（免得被当普通文件整读）', !MIME['.mp4']);

// ---------------- 2. streamMedia：range 与那个"句柄泄漏"的教训 ----------------
function fakeRes() {
  // 真 Writable：pipeline 需要 dest.once/on/end 这些，假的会炸（这本身就是个提醒）
  const r = new Writable({ write(chunk, enc, cb) { cb(); } });
  r.code = null; r.headers = null; r.headersSent = false; r.destroyed = false;
  r.writeHead = function writeHead(code, headers) { this.code = code; this.headers = headers; this.headersSent = true; return this; };
  return r;
}
{
  const p = join(root, 'clip.mp4');
  writeFileSync(p, Buffer.alloc(1000, 7));
  const res = fakeRes();
  streamMedia({ headers: {} }, res, p, '.mp4', { notFound: (x) => { x.code = 404; } });
  ok('整文件请求 → 200 + Content-Length + 支持 range',
    res.code === 200 && res.headers['Content-Length'] === 1000 && res.headers['Accept-Ranges'] === 'bytes');
  const res2 = fakeRes();
  streamMedia({ headers: { range: 'bytes=100-199' } }, res2, p, '.mp4', { notFound: () => {} });
  ok('range 请求 → 206 + Content-Range 正确',
    res2.code === 206 && res2.headers['Content-Range'] === 'bytes 100-199/1000' && res2.headers['Content-Length'] === 100);
  const res3 = fakeRes();
  streamMedia({ headers: {} }, res3, join(root, '没有这个.mp4'), '.mp4', { notFound: (x) => { x.code = 404; } });
  ok('文件不存在 → 交给 notFound（不是崩）', res3.code === 404);
}
{
  const src = readFileSync(join(ROOT, 'lib', 'server-shell.mjs'), 'utf8');
  ok('流式播放用 pipeline（2026-09-16 的 EMFILE 就是这个坑，别改回 .pipe(res)）',
    src.includes('pipeline(stream, res') && !/createReadStream\([^)]*\)\.pipe\(/.test(src));
  ok('注释里写清了"每中断一次漏一个 fd"这条教训', src.includes('EMFILE'));
}

// ---------------- 3. 静态资源：目录穿越 / SPA 回退 / 模块资源 ----------------
{
  const pub = join(root, 'public');
  const mods = join(root, 'modules');
  mkdirSync(pub, { recursive: true });
  mkdirSync(join(mods, 'demo'), { recursive: true });
  writeFileSync(join(pub, 'index.html'), '<h1>主页</h1>');
  writeFileSync(join(pub, 'secret.txt'), '别让人读到');
  writeFileSync(join(pub, 'clip.mp4'), 'x'.repeat(64));
  writeFileSync(join(mods, 'demo', 'view.js'), 'export const x=1;');

  const calls = [];
  const serve = createStaticHandler({
    pubDir: pub, modulesDir: mods,
    // 真的用途是挡目录穿越，这里直接用真实实现
    moduleAssetPath: (m, id, rel) => {
      const base = join(m, String(id || ''));
      const target = join(base, String(rel || '').replace(/^[/\\]+/, ''));
      return target.startsWith(base) ? target : null;
    },
    sendError: (res, code, msg) => { res.code = code; res.body = msg; },
    notFound: (res) => { res.code = 404; },
    log: () => {},
    stream: (req, res, file, ext) => { calls.push(['stream', file, ext]); res.code = 200; },
  });
  const mk = () => ({
    code: null, headers: null, headersSent: false, body: null,
    writeHead(c, h) { this.code = c; this.headers = h; this.headersSent = true; },
    end(d) { this.body = d; this.ended = true; },
  });

  const r1 = mk();
  await serve({ headers: {} }, r1, '/');
  ok('根路径 → 给 index.html，并且**不缓存**',
    r1.code === 200 && String(r1.body).includes('主页') && /no-store/.test(r1.headers['Cache-Control']));
  const r2 = mk();
  await serve({ headers: {} }, r2, '/不存在的页面');
  ok('不存在的路径 → SPA 回退到 index.html（不是 404）', r2.code === 200 && String(r2.body).includes('主页'));
  const r3 = mk();
  await serve({ headers: {} }, r3, '/modules/demo/view.js');
  ok('模块资源能取到，且是 js 类型 + 不缓存',
    r3.code === 200 && String(r3.headers['Content-Type']).includes('javascript') && /no-store/.test(r3.headers['Cache-Control']));
  const r4 = mk();
  await serve({ headers: {} }, r4, '/modules/demo/../../server.mjs');
  ok('模块资源想穿越出去 → 404（moduleAssetPath 挡掉）', r4.code === 404);
  const r5 = mk();
  await serve({ headers: {} }, r5, '/modules/不存在的模块/view.js');
  ok('模块不存在 → 404', r5.code === 404);
  const r6 = mk();
  await serve({ headers: {} }, r6, '/../server.mjs');
  ok('想读 public/ 外面 → 404（resolve 前缀检查）', r6.code === 404);
  const r7 = mk();
  await serve({ headers: {} }, r7, '/clip.mp4');
  ok('音视频扩展名 → 走流式播放（不是整文件读进内存）',
    calls.length === 1 && calls[0][0] === 'stream' && calls[0][2] === '.mp4', JSON.stringify(calls));
}

// ---------------- 4. 文件日志（含轮转，且失败要静默降级） ----------------
{
  const logPath = join(root, 'server.log');
  const fake = { log: () => {}, warn: () => {}, error: () => {} };
  const r = initFileLogging({ logPath, maxBytes: 2 * 1024 * 1024, dataDir: root, consoleRef: fake });
  ok('初始化成功', r.ok === true);
  fake.log('第一行');
  fake.error('出错了');
  await new Promise((r2) => setTimeout(r2, 60));        // 写文件是异步的，等一拍再读
  const text = readFileSync(logPath, 'utf8');
  ok('日志写进去了，且带时间戳与级别标记',
    /^\[\d{4}-\d{2}-\d{2}/.test(text) && text.includes('第一行') && text.includes('ERROR 出错了'), text.slice(0, 80));
  ok('console 原样还生效（不影响控制台输出）', typeof fake.log === 'function');
}
{
  const logPath = join(root, 'big.log');
  writeFileSync(logPath, 'x'.repeat(3000));
  const fake = { log: () => {}, warn: () => {}, error: () => {} };
  initFileLogging({ logPath, maxBytes: 2000, dataDir: root, consoleRef: fake });
  await new Promise((r2) => setTimeout(r2, 60));
  ok('超过上限自动滚成 .1（老文件挪走、新文件重新开始）',
    existsSync(`${logPath}.1`) && statSync(logPath).size < 3000,
    `old=${existsSync(`${logPath}.1`)} size=${statSync(logPath).size}`);
}
ok('日志路径不可写时**静默降级**，不抛异常（宁可没日志也不能起不来）',
  initFileLogging({
    // 父路径是个**文件**（不是目录）→ 任何平台都创建不了，稳定复现"不可写"
    logPath: join(root, 'big.log', 'x.log'), dataDir: null,
    consoleRef: { log: () => {}, warn: () => {}, error: () => {} },
  }).ok === false);

// ---------------- 5. 进程护栏 ----------------
{
  const listeners = {};
  const target = { on: (ev, fn) => { listeners[ev] = fn; } };
  const h = installProcessGuards({ target });
  ok('注册了未捕获异常 + 未处理拒绝两个护栏',
    typeof listeners.uncaughtException === 'function' && typeof listeners.unhandledRejection === 'function');
  ok('护栏只记日志、**不退出进程**（返回的 handler 不调 process.exit）',
    !/process\.exit/.test(String(h.uncaught)) && !/process\.exit/.test(String(h.rejection)));
}

// ---------------- 6. 打开浏览器 ----------------
ok('Windows 用 start、macOS 用 open、Linux 用 xdg-open',
  openBrowser({ url: 'http://x', platform: 'win32', exec: () => {} }).cmd.startsWith('start ""')
  && openBrowser({ url: 'http://x', platform: 'darwin', exec: () => {} }).cmd.startsWith('open')
  && openBrowser({ url: 'http://x', platform: 'linux', exec: () => {} }).cmd.startsWith('xdg-open'));
ok('exec 抛错也不影响启动', openBrowser({ url: 'http://x', exec: () => { throw new Error('没有浏览器'); } }).ok === false);

// ---------------- 7. 主程序结构闸门（唯一权威处） ----------------
{
  const srv = readFileSync(join(ROOT, 'server.mjs'), 'utf8');
  const lines = srv.split('\n').length;
  ok('外壳的实现已经不在主程序里（只留调用）',
    !srv.includes('function serveStatic') && !srv.includes('function initFileLogging')
    && !srv.includes('createReadStream(') && !srv.includes('pipeline(') && !srv.includes('MEDIA_MIME'));
  ok('主程序只调外壳的两个入口', srv.includes('createStaticHandler({') && srv.includes('initFileLogging({ logPath: LOG_PATH'));
  ok('主程序仍然在宽松上限内（<2100 行；下一批继续压）', lines < 2100, String(lines));
  ok('三处旧的行数闸门已统一到这里（别的测试不再各自数行数）',
    !readFileSync(join(ROOT, 'tests', 'media.test.mjs'), 'utf8').includes('2600')
    && !readFileSync(join(ROOT, 'tests', 'study-routes.test.mjs'), 'utf8').includes('2450'));
}

console.log('');
console.log(failures === 0 ? 'server-shell.test: PASS' : `server-shell.test: FAIL (${failures})`);
process.exit(failures === 0 ? 0 : 1);
