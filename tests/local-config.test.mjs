// 本机路径外置测试（W1 收尾）。
//
//   node tests/local-config.test.mjs
//
// 规则：环境变量 > 本机配置 <数据目录>/paths.json > 空字符串（功能降级，不报错）。
// 目的：`D:\SteamLibrary\...`（壁纸引擎）与外部邮件桥的安装目录不再出现在代码里。

import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { LOCAL_CONFIG_FILE, localPath, readLocalConfig } from '../lib/local-config.mjs';

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
const dir = mkdtempSync(join(TMP, 'localcfg-'));
console.log('local-config.test.mjs');

ok('没有配置文件 → 空对象', JSON.stringify(readLocalConfig(dir, {})) === '{}');
ok('没有配置 → 路径解析为空（功能降级）',
  localPath({ envKey: 'WALLPAPER_ENGINE_DIR', configKey: 'wallpaper_engine_dir', dataDir: dir, env: {} }) === '');

mkdirSync(dir, { recursive: true });
writeFileSync(join(dir, LOCAL_CONFIG_FILE),
  JSON.stringify({ wallpaper_engine_dir: 'X:\\example-wallpapers', mail_bridge_dir: 'X:\\example-bridge' }), 'utf8');
ok('读得到本机配置',
  readLocalConfig(dir, {}).mail_bridge_dir === 'X:\\example-bridge');
ok('配置里的路径会被用上',
  localPath({ envKey: 'WALLPAPER_ENGINE_DIR', configKey: 'wallpaper_engine_dir', dataDir: dir, env: {} }) === 'X:\\example-wallpapers');
ok('环境变量优先级更高',
  localPath({ envKey: 'WALLPAPER_ENGINE_DIR', configKey: 'wallpaper_engine_dir', dataDir: dir, env: { WALLPAPER_ENGINE_DIR: '/opt/example-other' } }) === '/opt/example-other');
ok('配置里缺某个键 → 只有那个键为空',
  localPath({ envKey: 'X', configKey: 'does_not_exist', dataDir: dir, env: {} }) === '');
ok('空白字符串视为没配置',
  localPath({ envKey: 'X', configKey: 'mail_bridge_dir', dataDir: dir, env: { X: '   ' } }) === 'X:\\example-bridge');

writeFileSync(join(dir, LOCAL_CONFIG_FILE), '{ 坏掉的 JSON', 'utf8');
ok('配置文件坏了 → 回退为空（不影响启动）',
  JSON.stringify(readLocalConfig(dir, {})) === '{}'
  && localPath({ envKey: 'X', configKey: 'mail_bridge_dir', dataDir: dir, env: {} }) === '');

// ---- 防回归：代码里不该再写死这两条路径 ----
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname } from 'node:path';
const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const files = ['server.mjs', 'lib/mail-bridge.mjs', 'lib/course-sync.mjs', 'public/app.js'];
for (const rel of files) {
  const src = readFileSync(join(ROOT, rel), 'utf8');
  ok(`${rel} 里不再写死 SteamLibrary 路径`, !/SteamLibrary/.test(src));
  ok(`${rel} 里不再写死"某台机器的邮件桥路径"`, !/[A-Za-z]:\\\\[A-Za-z0-9_\\-]*bridge/i.test(src));
}
const srv = readFileSync(join(ROOT, 'server.mjs'), 'utf8');
// 壁纸目录的解析随 R2 搬到了 lib/media.mjs；server.mjs 只负责传 dataDir 进去
const mediaSrc = readFileSync(join(ROOT, 'lib', 'media.mjs'), 'utf8');
ok('lib/media.mjs 用 localPath 取壁纸目录（并同时认新老键名）',
  mediaSrc.includes("envKey: ['PLANNER_WALLPAPER_DIR', 'WALLPAPER_ENGINE_DIR']")
  && mediaSrc.includes("configKey: ['wallpaper_dir', 'wallpaper_engine_dir']"));
ok('server.mjs 把 dataDir 传给媒体模块（本机配置仍然生效）',
  srv.includes('createMedia(') && /createMedia\(\{[\s\S]{0,200}dataDir: DATA_DIR/.test(srv));
ok('/api/state 下发 mail_bridge_dir_default', srv.includes('mail_bridge_dir_default'));

console.log('');
console.log(failures === 0 ? 'local-config.test: PASS' : `local-config.test: FAIL (${failures})`);
process.exit(failures === 0 ? 0 : 1);
