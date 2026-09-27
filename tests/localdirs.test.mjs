// 「本机目录」的验证：壁纸目录可以**在界面上改**（不用重启、不用手改 JSON）。
//
//   node tests/localdirs.test.mjs
//
// 重点：
//   * 校验（不存在 / 不是文件夹 / 空 = 清除）不能放水；
//   * 改完**立刻生效**（media 的扫描读的是当前值，不是启动时的快照）；
//   * 写回 paths.json 是**合并**的（不会冲掉别人手写的键），而且是原子写；
//   * 系统选择框：只测"拼出来的脚本对不对"，**不真的弹窗**（会打断使用者）。

import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { createMedia } from '../lib/media.mjs';
import { readLocalConfig, writeLocalConfig } from '../lib/local-config.mjs';
import { buildPickerScript, decodePowerShell, encodePowerShell, pickFolder } from '../lib/pick-folder.mjs';
import { LOCAL_DIR_KEYS, checkDirInput, createLocalDirRoutes, describeLocalDir } from '../lib/routes/localdirs.mjs';

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
console.log('localdirs.test.mjs');

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const root = mkdtempSync(join(TMP, 'localdirs-'));
const dataDir = join(root, 'data');
mkdirSync(dataDir, { recursive: true });

// 本机真实环境变量会让这条测试不稳定（不同装机不一样）→ 显式清掉，用配置文件来测
delete process.env.PLANNER_WALLPAPER_DIR;
delete process.env.WALLPAPER_ENGINE_DIR;
const env = {};                                        // 传给被测算法的"假环境"

const wallA = join(root, 'walls-a');
const wallB = join(root, 'walls-b');
mkdirSync(wallA, { recursive: true });
mkdirSync(wallB, { recursive: true });
writeFileSync(join(wallB, '我的新壁纸.jpg'), 'x');
writeFileSync(join(root, 'not-a-dir.txt'), 'x');

// ---------------- 1. 输入校验 ----------------
ok('空字符串 = 清除配置（不是错误）', checkDirInput('').ok === true && checkDirInput('').dir === '');
ok('null / undefined 也当清除', checkDirInput(null).ok === true && checkDirInput(undefined).ok === true);
ok('存在且是文件夹 → 通过，并给出绝对路径',
  checkDirInput(wallA).ok === true && checkDirInput(wallA).dir === wallA, JSON.stringify(checkDirInput(wallA)));
ok('从资源管理器复制来的带引号路径会被去掉引号',
  checkDirInput(`"${wallA}"`).ok === true && checkDirInput(`"${wallA}"`).dir === wallA);
ok('不存在的路径 → 拒绝，并说清是哪个路径',
  checkDirInput(join(root, '没这个')).ok === false && checkDirInput(join(root, '没这个')).error.includes('不存在'));
ok('是文件不是文件夹 → 拒绝', checkDirInput(join(root, 'not-a-dir.txt')).ok === false);

// ---------------- 2. 写回 paths.json：合并 + 原子 ----------------
  writeFileSync(join(dataDir, 'paths.json'), JSON.stringify({ mail_bridge_dir: 'X:\\example-bridge', _note: '别删我' }, null, 2), 'utf8');
{
  const w = writeLocalConfig({ wallpaper_dir: wallA }, { dataDir, env });
  const cfg = readLocalConfig(dataDir, env);
  ok('改一个键不会冲掉别的键（mail_bridge_dir 与 _note 还在）',
    w.ok && cfg.mail_bridge_dir === 'X:\\example-bridge' && cfg._note === '别删我' && cfg.wallpaper_dir === wallA, JSON.stringify(cfg));
  ok('写的是原子改名（不会留下半个文件）', !existsSync(join(dataDir, 'paths.json.tmp')));
}
ok('传 null = 把这个键删掉（不是写个 null 进去）',
  writeLocalConfig({ wallpaper_dir: null }, { dataDir, env }).ok
  && !('wallpaper_dir' in readLocalConfig(dataDir, env)));

// ---------------- 3. 当前值解析：环境变量 > 配置文件 ----------------
writeLocalConfig({ wallpaper_dir: wallA }, { dataDir, env });
ok('没环境变量时读配置文件', describeLocalDir('wallpaper', { dataDir, env }).dir === wallA);
ok('环境变量优先（它的用途就是临时压过配置文件）',
  describeLocalDir('wallpaper', { dataDir, env: { PLANNER_WALLPAPER_DIR: wallB } }).dir === wallB);
ok('另一个 data 目录（没有配置文件）→ 未配置，不是报错',
  describeLocalDir('wallpaper', { dataDir: dirname(dataDir), env: {} }).configured === false);
ok('老键名 wallpaper_engine_dir 继续认（老装机不用改配置）',
  (() => { writeLocalConfig({ wallpaper_dir: null, wallpaper_engine_dir: wallB }, { dataDir, env });
    return describeLocalDir('wallpaper', { dataDir, env }).dir === wallB; })());
ok('课程资料目录也在清单里（同一套机制）', Boolean(LOCAL_DIR_KEYS.course) && describeLocalDir('course', { dataDir, env }).key === 'course');
ok('不认识的键返回 null（白名单）', describeLocalDir('乱写的', { dataDir, env }) === null);
ok('配了但目录不在了 → 如实标 exists=false',
  (() => { writeLocalConfig({ wallpaper_dir: join(root, '被搬走了') }, { dataDir, env });
    const d = describeLocalDir('wallpaper', { dataDir, env }); return d.configured === true && d.exists === false; })());

// ---------------- 4. 路由 ----------------
writeLocalConfig({ wallpaper_dir: wallA }, { dataDir, env });
const json = { code: null, body: null };
const sendJson = (res, code, obj) => { res.code = code; res.body = obj; };
const sendError = (res, code, message) => { res.code = code; res.body = { error: message }; };
const changed = [];
const routes = createLocalDirRoutes({
  dataDir, env, sendJson, sendError,
  readBody: async (req) => req.body || {},
  onChanged: (k, d) => changed.push([k, d]),
  pick: async (o) => ({ ok: true, dir: wallB, ...o }),        // 假选择框：绝不真弹窗
});
const req = (method, body) => ({ method, body });
const urlOf = (p) => new URL('http://127.0.0.1:3210' + p);

{
  const res = { ...json };
  await routes.handleLocalDirs(req('GET'), res, urlOf('/api/localdirs'));
  ok('GET 列出所有可改的目录', res.code === 200 && res.body.dirs.wallpaper.dir === wallA && Boolean(res.body.dirs.course));
}
{
  const res = { ...json };
  await routes.handleLocalDirs(req('POST', { key: '乱写的', dir: wallA }), res, urlOf('/api/localdirs'));
  ok('POST 不认识的 key → 400（白名单）', res.code === 400);
}
{
  const res = { ...json };
  await routes.handleLocalDirs(req('POST', { key: 'wallpaper', dir: join(root, '没这个') }), res, urlOf('/api/localdirs'));
  ok('POST 不存在的目录 → 400 且人话解释', res.code === 400 && res.body.error.includes('不存在'));
}
{
  const res = { ...json };
  await routes.handleLocalDirs(req('POST', { key: 'wallpaper', dir: wallB }), res, urlOf('/api/localdirs'));
  ok('POST 合法目录 → 200，写进配置，并通知"已经建好的东西"',
    res.code === 200 && readLocalConfig(dataDir, env).wallpaper_dir === wallB
    && changed.some(([k, d]) => k === 'wallpaper' && d === wallB));
}
{
  const res = { ...json };
  await routes.handleLocalDirs(req('POST', { key: 'wallpaper', dir: '' }), res, urlOf('/api/localdirs'));
  ok('POST 空 = 清除配置（不是删目录）',
    res.code === 200 && readLocalConfig(dataDir, env).wallpaper_dir === undefined && existsSync(wallB));
}
{
  const res = { ...json };
  await routes.handleLocalDirs(req('POST', {}), res, urlOf('/api/localdirs/pick'));
  ok('pick 只返回路径、**不落盘**', res.code === 200 && res.body.dir === wallB && readLocalConfig(dataDir, env).wallpaper_dir === undefined);
}
{
  const res = { ...json };
  await routes.handleLocalDirs(req('GET'), res, urlOf('/api/localdirs/别的'));
  ok('不认识的路径 → 404（不抢别的路由）', res.code === 404);
}

// ---------------- 5. 改完立刻生效（不重启） ----------------
writeLocalConfig({ wallpaper_dir: wallA }, { dataDir, env });
const storeMap = new Map();
const media = createMedia({
  store: { getSync: (k) => storeMap.get(k), setSync: (k, v) => storeMap.set(k, v) },
  repoDir: join(ROOT, 'tmp-repo-不存在'),          // 内置素材目录故意不存在：只看用户目录
  dataDir,
  streamMedia: () => {}, notFound: () => {},
  sendJson: (res, code, obj) => { res.code = code; res.body = obj; },
  sendError: (res, code, message) => { res.code = code; res.body = { error: message }; },
  readBody: async () => ({}),
});
ok('启动时读到配置文件里的壁纸目录', media.WALLPAPER_DIR === wallA, media.WALLPAPER_DIR);
media.setWallpaperDir(wallB);
ok('界面改完 → setWallpaperDir 之后当前值是新的',
  media.WALLPAPER_DIR === wallB && media.scanWallpapers().some((w) => w.id === '我的新壁纸.jpg'));
{
  // 手动改了 paths.json（没走界面）也能跟上：列表接口会现读一次
  writeLocalConfig({ wallpaper_dir: wallA }, { dataDir, env });
  const res = { code: null, body: null, writeHead() {}, end() {} };
  await media.handleWallpapers(req('GET'), res, urlOf('/api/wallpapers'));
  ok('列表接口现读配置（手动改 JSON 也立刻生效）', res.body.dir === wallA, JSON.stringify(res.body.dir));
  ok('没有用户的目录时只有内置壁纸（功能优雅降级）', res.body.wallpapers.length === 4, String(res.body.wallpapers.length));
}

// ---------------- 6. 系统选择框：只测脚本，不弹窗 ----------------
{
  const s = buildPickerScript({ title: '选择壁纸文件夹', initial: wallA });
  ok('脚本里带上标题与初始目录', s.includes('选择壁纸文件夹') && s.includes(wallA));
  ok('脚本用 FolderBrowserDialog、且需要一个 TopMost 的拥有者窗体（不然会藏在窗口后面）',
    s.includes('System.Windows.Forms.FolderBrowserDialog') && s.includes('$owner.TopMost = $true'));
  ok('标题里有单引号也不会把脚本弄坏',
    buildPickerScript({ title: "it's ok" }).includes("'it''s ok'"));
  ok('中文标题能原样还原（走 UTF-16LE 编码，绕开命令行编码问题）',
    decodePowerShell(encodePowerShell(s)).includes('选择壁纸文件夹'));
}
{
  // 2026-09-27：macOS 现在**真的支持**了（走 osascript，见 tests/cross-platform.test.mjs），
  // 所以这里只断言"确实不支持的平台要如实说 + 给手动粘贴的退路"。
  const r = await pickFolder({ platform: 'linux' });
  ok('不支持的平台 → 如实说"只有 Windows 与 macOS 上有"，并提示手动粘贴',
    r.ok === false && r.error.includes('Windows') && r.error.includes('macOS') && r.error.includes('粘贴'));
}
{
  let spawned = false;
  const r = await pickFolder({
    platform: 'win32',
    runner: (cmd, args, opts, cb) => { spawned = true; cb(null, `${wallB}\r\n`); },
  });
  ok('Windows 上会用 powershell -STA -EncodedCommand 调起选择框',
    spawned && r.ok === true && r.dir === wallB, JSON.stringify(r));
}
{
  const r = await pickFolder({ platform: 'win32', runner: (cmd, args, opts, cb) => cb(null, '') });
  ok('用户取消（没有输出）→ 当作取消，不算错误', r.ok === true && r.dir === null && r.cancelled === true);
}
{
  const r = await pickFolder({ platform: 'win32', runner: (cmd, args, opts, cb) => cb(new Error('受限语言模式')) });
  ok('powershell 被策略限制 → 如实报错并给出退路',
    r.ok === false && r.error.includes('受限语言模式') && r.error.includes('粘贴'));
}

// ---------------- 7. 接线守卫 ----------------
const srv = readFileSync(join(ROOT, 'server.mjs'), 'utf8');
const mediaSrc = readFileSync(join(ROOT, 'lib', 'media.mjs'), 'utf8');
const appSrc = readFileSync(join(ROOT, 'public', 'app.js'), 'utf8');
ok('server.mjs 接上了 /api/localdirs', srv.includes("createLocalDirRoutes") && srv.includes('/api/localdirs'));
ok('壁纸目录不再是启动时的快照（media 里是 let + 取值器）',
  mediaSrc.includes('let WALLPAPER_DIR') && mediaSrc.includes('get WALLPAPER_DIR()'));
ok('server.mjs 不再用快照判断"配没配壁纸"', !srv.includes('Boolean(WALLPAPER_DIR)'));
ok('界面上有壁纸目录输入框与两个按钮',
  appSrc.includes('id="wp-dir"') && appSrc.includes('id="wp-dir-apply"') && appSrc.includes('id="wp-dir-pick"'));
ok('界面走的是同一套接口（没有另开小路）',
  appSrc.includes("'/api/localdirs'") && appSrc.includes("'/api/localdirs/pick'"));

console.log('');
console.log(failures === 0 ? 'localdirs.test: PASS' : `localdirs.test: FAIL (${failures})`);
process.exit(failures === 0 ? 0 : 1);
