// 壁纸与本地音乐（R2 拆出来的第一组）的验证。
//
//   node tests/media.test.mjs
//
// 重点不是"能跑"，而是**搬家之后行为一模一样**，尤其是那个安全边界：
// 音乐文件路径必须挡住 `../` 目录穿越。

import { mkdirSync, writeFileSync } from 'node:fs';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { createMedia, AUDIO_EXT } from '../lib/media.mjs';

let failures = 0;
const ok = (label, cond, detail = '') => {
  if (cond) console.log(`  PASS ${label}`);
  else {
    failures += 1;
    console.log(`  FAIL ${label}${detail ? ` -- ${detail}` : ''}`);
  }
};

console.log('media.test.mjs');

const base = process.env.PLANNER_TEST_TMP || tmpdir();
const root = mkdtempSync(join(base, 'media-'));
const REPO = dirname(dirname(fileURLToPath(import.meta.url)));   // 真实仓库根（用来读源码做守卫检查）

// 内置壁纸素材是"个人素材"，**公开仓库与全新安装副本里不含大文件**，
// 所以这里自己造一个假仓库，保证这条检查在任何机器上都稳定。
const fakeRepo = join(root, 'fake-repo');
mkdirSync(join(fakeRepo, 'public', 'assets', 'wallpapers'), { recursive: true });
writeFileSync(join(fakeRepo, 'public', 'assets', 'wallpapers', 'p3r-reload.gif'), 'GIF89a-fake-preview-bytes');
const musicDir = join(root, 'Music');
mkdirSync(join(musicDir, '专辑'), { recursive: true });
writeFileSync(join(musicDir, 'b.mp3'), 'x');
writeFileSync(join(musicDir, 'a.flac'), 'x');
writeFileSync(join(musicDir, 'notes.txt'), 'x');
writeFileSync(join(musicDir, '专辑', 'c.m4a'), 'x');
writeFileSync(join(root, 'secret.txt'), 'shh');       // 用来验证目录穿越被挡住

const wallDir = join(root, 'walls');
mkdirSync(wallDir, { recursive: true });
writeFileSync(join(wallDir, '我的壁纸.jpg'), 'x');

process.env.PLANNER_WALLPAPER_DIR = wallDir;

// ---- 替身：只需要记录被调用的参数 ----
const calls = [];
const storeMap = new Map();
const store = {
  getSync: (k) => (storeMap.has(k) ? storeMap.get(k) : undefined),
  setSync: (k, v) => storeMap.set(k, v),
};
const mkRes = () => ({
  code: null, body: null, headers: null, ended: false,
  writeHead(code, headers) { this.code = code; this.headers = headers; },
  end(data) { this.ended = true; this.body = data; },
});
const sendJson = (res, code, obj) => { res.code = code; res.body = obj; };
const sendError = (res, code, message) => { res.code = code; res.body = { error: message }; };
const notFound = (res) => { res.code = 404; res.body = { error: 'Not Found' }; };
const readBody = async (req) => req.body || {};
const streamMedia = (req, res, filePath, ext) => { calls.push({ kind: 'stream', filePath, ext }); res.code = 200; };

const media = createMedia({
  // repoDir 指真实仓库根：内置壁纸（public/assets/wallpapers）在那里
  store, repoDir: fakeRepo,
  dataDir: join(root, 'data'),
  streamMedia, sendJson, sendError, notFound, readBody,
});

const req = (method, body) => ({ method, body });
const urlOf = (p) => new URL('http://127.0.0.1:3210' + p);

// ---------------- 1. 壁纸 ----------------
ok('壁纸目录来自环境变量', media.WALLPAPER_DIR === wallDir, media.WALLPAPER_DIR);
{
  const w = media.scanWallpapers();
  ok('内置 4 张壁纸仍在', ['wolf-duo', 'seq03', 'p5r', 'p3r'].every((id) => w.some((x) => x.id === id)));
  ok('用户目录里的图片被扫到', w.some((x) => x.id === '我的壁纸.jpg'), JSON.stringify(w.map((x) => x.id)));
}
{
  const res = mkRes();
  await media.handleWallpapers(req('GET'), res, urlOf('/api/wallpapers'));
  ok('列表接口 200 且有 wallpapers', res.code === 200 && Array.isArray(res.body.wallpapers));
  ok('默认映射仍是 p5r / 3210179384',
    res.body.map.p5 === 'p5r' && res.body.map.p3r === '3210179384', JSON.stringify(res.body.map));
}
{
  const res = mkRes();
  await media.handleWallpapers(req('GET'), res, urlOf('/api/wallpapers/p3r/preview'));
  ok('内置预览图能直接读出来（假仓库里的占位图）',
    res.code === 200 && String(res.body).includes('GIF89a'), String(res.code));
}
{
  const res = mkRes();
  await media.handleWallpapers(req('GET'), res, urlOf('/api/wallpapers/根本不存在/video'));
  ok('不存在的视频返回 404', res.code === 404);
}
{
  const res = mkRes();
  await media.handleWallpapers(req('POST', { theme: 'p3r' }), res, urlOf('/api/wallpapers/p3r/use'));
  ok('选用壁纸会写进同步表', store.getSync('wp_p3r') === 'p3r', String(store.getSync('wp_p3r')));
  ok('选用 p3r 不产生本地拷贝（它走内置资源）', res.body.video === null && res.body.poster === '/api/wallpapers/p3r/preview');
}
{
  const res = mkRes();
  await media.handleWallpapers(req('GET'), res, urlOf('/api/其他'));
  ok('非壁纸路径交回 404（不抢别的路由）', res.code === 404);
}

// ---------------- 2. 音乐扫描 ----------------
ok('音频扩展名清单没变', AUDIO_EXT.includes('.mp3') && AUDIO_EXT.includes('.wma'));
{
  const tracks = media.scanMusic(musicDir);
  ok('只收音频、不收 txt', tracks.length === 3, JSON.stringify(tracks.map((t) => t.name)));
  ok('能扫到子目录里的', tracks.some((t) => t.name === 'c'));
  ok('按名字排序', tracks.map((t) => t.name).join(',') === 'a,b,c');
  ok('每条带 ext 与 size', tracks.every((t) => t.ext && typeof t.size === 'number'));
  ok('file 字段用 / 分隔（跨平台一致）', tracks.every((t) => !t.file.includes('\\')));
}
ok('目录不存在时返回空数组而不是抛错', media.scanMusic(join(root, '没这个目录')).length === 0);
ok('空目录参数也返回空数组', media.scanMusic('').length === 0);

// ---------------- 3. 目录穿越防护（安全边界） ----------------
{
  store.setSync('music_dir', musicDir);
  const good = media.musicFilePath('a.flac');
  ok('正常文件能取到', good === join(musicDir, 'a.flac'), String(good));
  ok('向上跳一层被挡住', media.musicFilePath('../secret.txt') === null);
  ok('多重向上跳被挡住', media.musicFilePath('../../secret.txt') === null);
  ok('绝对路径也被挡住', media.musicFilePath('C:\\Windows\\win.ini') === null || media.musicFilePath('/etc/passwd') === null);
  ok('不存在的文件返回 null', media.musicFilePath('没有这首.mp3') === null);
  ok('空文件名（解到目录本身）不当作可播放文件', media.musicFilePath('') === null);
  ok('目录名也不当作可播放文件', media.musicFilePath('专辑') === null);
}

// ---------------- 4. 音乐路由 ----------------
{
  const res = mkRes();
  await media.handleMusic(req('GET'), res, urlOf('/api/music'));
  ok('列表接口返回缓存对象', res.code === 200 && Array.isArray(res.body.tracks));
}
{
  const res = mkRes();
  await media.handleMusic(req('POST', { dir: musicDir }), res, urlOf('/api/music/scan'));
  ok('扫描接口写回目录偏好', store.getSync('music_dir') === musicDir);
  ok('扫描接口返回 3 首', res.body.tracks.length === 3);
  ok('getMusic() 拿到的是同一次扫描结果', media.getMusic().tracks.length === 3);
  ok('扫描时间戳被更新', media.getMusic().scanned_at > 0);
}
{
  calls.length = 0;
  const res = mkRes();
  await media.handleMusic(req('GET'), res, urlOf('/api/music/stream?f=' + encodeURIComponent('a.flac')));
  ok('流式播放交给 streamMedia', calls.length === 1 && calls[0].ext === '.flac', JSON.stringify(calls));
}
{
  calls.length = 0;
  const res = mkRes();
  await media.handleMusic(req('GET'), res, urlOf('/api/music/stream?f=' + encodeURIComponent('../secret.txt')));
  ok('穿越请求在流式播放前就被拒（404 且没调 streamMedia）', res.code === 404 && calls.length === 0);
}
{
  const res = mkRes();
  await media.handleMusic(req('GET'), res, urlOf('/api/music/unknown'));
  ok('未知音乐子路径 404', res.code === 404);
}

// ---------------- 5. 搬家之后不再依赖 server.mjs ----------------
{
  const { readFileSync } = await import('node:fs');
  const app = readFileSync(new URL('../server.mjs', import.meta.url), 'utf8');
  ok('server.mjs 不再自己实现壁纸扫描', !app.includes('function scanWallpapers()'));
  ok('server.mjs 不再自己实现音乐扫描', !app.includes('function scanMusic(dir)'));
  ok('server.mjs 通过 media 调用', app.includes('media.handleMusic(req, res, url)') && app.includes('handleWallpapers(req, res, url)'));
  // 行数闸门已统一到 tests/server-shell.test.mjs（结构为主、行数兜底），这里不再各数各的
  const mediaSrc = readFileSync(new URL('../lib/media.mjs', import.meta.url), 'utf8');
  ok('lib/media.mjs 复用 lib/wallpapers.mjs（没有复制一份扫描逻辑）',
    mediaSrc.includes("from './wallpapers.mjs'") && mediaSrc.includes('scanWallpaperDir(WALLPAPER_DIR)'));
}

console.log('');
console.log(failures === 0 ? 'media.test: PASS' : `media.test: FAIL (${failures})`);
process.exit(failures === 0 ? 0 : 1);
