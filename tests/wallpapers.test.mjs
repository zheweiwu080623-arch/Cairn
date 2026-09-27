// 壁纸目录测试（W4-4）：两种布局 + 路径安全。
//
//   node tests/wallpapers.test.mjs

import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import {
  WALLPAPER_IMAGE_EXT, WALLPAPER_VIDEO_EXT, prettyName, safeWallpaperId,
  scanWallpaperDir, wallpaperFilePaths,
} from '../lib/wallpapers.mjs';

let failures = 0;
const ok = (label, cond, detail = '') => {
  if (cond) console.log(`  PASS ${label}`);
  else {
    failures += 1;
    console.log(`  FAIL ${label}${detail ? ` -- ${detail}` : ''}`);
  }
};

const TMP = process.env.PLANNER_TEST_TMP || '';
if (!TMP) {
  console.error('需要 PLANNER_TEST_TMP（run_all_suites.py 会设置）');
  process.exit(2);
}
console.log('wallpapers.test.mjs');

// ---------- 1. 小工具 ----------
ok('图片/视频扩展名清单合理',
  WALLPAPER_IMAGE_EXT.includes('.jpg') && WALLPAPER_IMAGE_EXT.includes('.png') && WALLPAPER_VIDEO_EXT.includes('.mp4'));
ok('文件名转展示名（去扩展名、下划线转空格）',
  prettyName('my_wallpaper-01.jpg') === 'my wallpaper 01', prettyName('my_wallpaper-01.jpg'));
ok('路径安全：正常 id 通过', safeWallpaperId('2714977723') && safeWallpaperId('我的壁纸') && safeWallpaperId('a.b.png'));
ok('路径安全：../ 与奇怪字符被拒',
  !safeWallpaperId('../etc/passwd') && !safeWallpaperId('..') && !safeWallpaperId('a/b') && !safeWallpaperId(''));

// ---------- 2. 两种布局 ----------
const root = mkdtempSync(join(TMP, 'wallpapers-'));
const userDir = join(root, 'my-wallpapers');
mkdirSync(userDir, { recursive: true });

// 布局 A：Wallpaper Engine 风格
mkdirSync(join(userDir, '2714977723'), { recursive: true });
writeFileSync(join(userDir, '2714977723', 'project.json'), JSON.stringify({ title: '示例动态壁纸' }), 'utf8');
writeFileSync(join(userDir, '2714977723', 'preview.jpg'), 'x');
writeFileSync(join(userDir, '2714977723', 'wall.mp4'), 'x');
mkdirSync(join(userDir, 'scene-only'), { recursive: true });
writeFileSync(join(userDir, 'scene-only', 'scene.pkg'), 'x');

// 布局 B：直接放文件
writeFileSync(join(userDir, 'sunset.jpg'), 'x');
writeFileSync(join(userDir, 'aurora.mp4'), 'x');
writeFileSync(join(userDir, '说明.txt'), 'x');        // 非图片/视频 → 忽略

const items = scanWallpaperDir(userDir);
const ids = items.map((i) => i.id);
ok('发现 4 个壁纸（2 个 WE 风格目录 + 2 个直接放的图片/视频）', items.length === 4, JSON.stringify(ids));
ok('WE 风格：用 project.json 里的标题当名字、认得视频与 .pkg',
  items.find((i) => i.id === '2714977723')?.name === '示例动态壁纸'
  && items.find((i) => i.id === '2714977723')?.has_video === true
  && items.find((i) => i.id === 'scene-only')?.has_scene === true);
ok('文件风格：图片有预览、视频有预览+视频地址',
  items.find((i) => i.id === 'sunset.jpg')?.preview_url === '/api/wallpapers/sunset.jpg/preview'
  && items.find((i) => i.id === 'aurora.mp4')?.video_url === '/api/wallpapers/aurora.mp4/video'
  && items.find((i) => i.id === 'aurora.mp4')?.has_video === true);
ok('文件风格：名字去掉扩展名',
  items.find((i) => i.id === 'sunset.jpg')?.name === 'sunset');
ok('无关文件被忽略', !ids.includes('说明.txt'));
ok('标记了来源类型（we / file）',
  items.find((i) => i.id === 'sunset.jpg')?.kind === 'file'
  && items.find((i) => i.id === '2714977723')?.kind === 'we');

// ---------- 3. 取实际文件路径 ----------
const wePaths = wallpaperFilePaths(userDir, '2714977723');
ok('WE 风格：预览与视频路径都解析到', wePaths.preview?.endsWith('preview.jpg') === true && wePaths.video?.endsWith('wall.mp4') === true,
  JSON.stringify(wePaths));
const imgPaths = wallpaperFilePaths(userDir, 'sunset.jpg');
ok('文件风格-图片：预览=文件本身，且没有视频', imgPaths.preview?.endsWith('sunset.jpg') === true && imgPaths.video === null);
const vidPaths = wallpaperFilePaths(userDir, 'aurora.mp4');
ok('文件风格-视频：预览与视频都是文件本身', vidPaths.preview?.endsWith('aurora.mp4') === true && vidPaths.video?.endsWith('aurora.mp4') === true);
ok('不存在的 id 返回空', wallpaperFilePaths(userDir, 'nope').preview === null);
ok('../ 想跑出去会被拒（不会读到目录外的文件）',
  wallpaperFilePaths(userDir, '../../server.mjs').preview === null);

// ---------- 4. 边界 ----------
ok('目录不存在 → 空数组', scanWallpaperDir(join(root, 'nope')).length === 0);
ok('空目录 → 空数组', scanWallpaperDir(mkdtempSync(join(TMP, 'wallpapers-empty-'))).length === 0);
ok('没配置目录 → 空数组（功能降级，不报错）', scanWallpaperDir('').length === 0 && scanWallpaperDir(null).length === 0);

// ---------- 5. 防回归：壁纸那一组代码在 lib/media.mjs（R2 之后），server 只做接线 ----------
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname } from 'node:path';
const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const srv = readFileSync(join(ROOT, 'server.mjs'), 'utf8');
const mediaSrc = readFileSync(join(ROOT, 'lib', 'media.mjs'), 'utf8');
ok('lib/media.mjs 用 scanWallpaperDir / wallpaperFilePaths',
  mediaSrc.includes('scanWallpaperDir(WALLPAPER_DIR)') && mediaSrc.includes('wallpaperFilePaths(WALLPAPER_DIR, id)'));
ok('壁纸目录同时认新老两个键名（已随代码搬进 lib/media.mjs）',
  mediaSrc.includes("envKey: ['PLANNER_WALLPAPER_DIR', 'WALLPAPER_ENGINE_DIR']")
  && mediaSrc.includes("configKey: ['wallpaper_dir', 'wallpaper_engine_dir']"));
ok('server.mjs 仍然把壁纸接口接上（没有漏接线）',
  srv.includes('createMedia(') && srv.includes('handleWallpapers(req, res, url)'));
ok('注释里已经不再叫"Wallpaper Engine wallpapers"',
  !/Wallpaper Engine wallpapers/i.test(srv) && !/Wallpaper Engine wallpapers/i.test(mediaSrc));

console.log('');
console.log(failures === 0 ? 'wallpapers.test: PASS' : `wallpapers.test: FAIL (${failures})`);
process.exit(failures === 0 ? 0 : 1);
