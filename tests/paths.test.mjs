// 数据目录 / 数据库路径解析测试（W1 Day2：路径与配置外置）
//
//   node tests/paths.test.mjs
//
// 最重要的一条：**老装机不能被惊动** —— 仓库里已经有 data/ 时，必须继续用它，
// 否则应用会看起来"数据全没了"。

import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import {
  APP_DIR_NAME, DB_FILE_NAME, describePaths, platformDataDir, resolveDataDir, resolveDbPath,
} from '../lib/paths.mjs';

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
const sandbox = mkdtempSync(join(TMP, 'paths-'));

console.log('paths.test.mjs');

ok('数据库文件名保持 codex-planner.db（改名等于丢数据）', DB_FILE_NAME === 'codex-planner.db', DB_FILE_NAME);
ok('平台默认目录名是 ' + APP_DIR_NAME, APP_DIR_NAME === 'Cairn', APP_DIR_NAME);

// ---- 1. 老装机：仓库里已有 data/ ----
const legacyRepo = join(sandbox, 'legacy-repo');
mkdirSync(join(legacyRepo, 'data'), { recursive: true });
const legacy = describePaths({ repoDir: legacyRepo, env: {}, platform: 'win32' });
ok('仓库里有 data/ 时继续用它（老装机零迁移）',
  legacy.mode === 'legacy-in-repo' && legacy.dataDir === join(legacyRepo, 'data'),
  JSON.stringify(legacy));
ok('对应的数据库仍是 <repo>/data/codex-planner.db',
  legacy.dbPath === join(legacyRepo, 'data', DB_FILE_NAME), legacy.dbPath);

// ---- 2. 新装机：仓库里没有 data/ → 平台默认 ----
const freshRepo = join(sandbox, 'fresh-repo');
mkdirSync(freshRepo, { recursive: true });
const win = describePaths({ repoDir: freshRepo, env: { APPDATA: 'C:\\Users\\x\\AppData\\Roaming' }, platform: 'win32' });
ok('Windows 新装机落到 %APPDATA%\\Cairn',
  win.mode === 'platform-default' && win.dataDir.endsWith(join('AppData', 'Roaming', 'Cairn')),
  win.dataDir);
const mac = describePaths({ repoDir: freshRepo, env: { HOME: '/Users/x' }, platform: 'darwin' });
ok('macOS 新装机落到 ~/Library/Application Support/Cairn',
  mac.dataDir === join('/Users/x', 'Library', 'Application Support', 'Cairn'), mac.dataDir);
const linux = describePaths({ repoDir: freshRepo, env: { HOME: '/home/x' }, platform: 'linux' });
ok('Linux 新装机落到 ~/.local/share/cairn',
  linux.dataDir === join('/home/x', '.local', 'share', 'cairn'), linux.dataDir);
const xdg = platformDataDir({ platform: 'linux', env: { XDG_DATA_HOME: '/xdg', HOME: '/home/x' } });
ok('Linux 尊重 XDG_DATA_HOME', xdg === join('/xdg', 'cairn'), xdg);

// ---- 3. 环境变量优先，并兼容"传的是 .db 文件"的老语义 ----
const asDir = describePaths({ repoDir: legacyRepo, env: { PLANNER_DATA_DIR: join(sandbox, 'custom') }, platform: 'win32' });
ok('PLANNER_DATA_DIR 是目录时按目录用',
  asDir.mode === 'env' && asDir.dataDir === join(sandbox, 'custom')
  && asDir.dbPath === join(sandbox, 'custom', DB_FILE_NAME), JSON.stringify(asDir));
const asFile = describePaths({
  repoDir: legacyRepo,
  env: { PLANNER_DATA_DIR: join(sandbox, 'custom2', 'my.db') },
  platform: 'win32',
});
ok('PLANNER_DATA_DIR 以 .db 结尾时按"数据库文件"处理（兼容老语义）',
  asFile.dataDir === join(sandbox, 'custom2') && asFile.dbPath === join(sandbox, 'custom2', 'my.db'),
  JSON.stringify(asFile));
ok('环境变量优先级高于仓库里的 data/',
  resolveDataDir({ repoDir: legacyRepo, env: { PLANNER_DATA_DIR: join(sandbox, 'x') } }) === join(sandbox, 'x'));

// ---- 4. 边界：没有 repoDir 也不要崩 ----
const noRepo = resolveDbPath({ repoDir: '', env: { HOME: '/home/x', XDG_DATA_HOME: '/xdg' }, platform: 'linux' });
ok('没有仓库目录时回退到平台默认而不是报错', noRepo === join('/xdg', 'cairn', DB_FILE_NAME), noRepo);

// ---- 5. 防回归：store.mjs 不再自己拼路径 ----
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname } from 'node:path';
const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const store = readFileSync(join(ROOT, 'lib', 'store.mjs'), 'utf8');
ok('store.mjs 用 resolveDbPath', store.includes('resolveDbPath('));
ok('store.mjs 不再自己判断 PLANNER_DATA_DIR', !/process\.env\.PLANNER_DATA_DIR/.test(store));
const srv = readFileSync(join(ROOT, 'server.mjs'), 'utf8');
ok('server.mjs 用 describePaths 取数据目录', srv.includes('describePaths({ repoDir: __dir })'));
ok('server.mjs 里不再有 join(__dir, \'data\') 的硬拼',
  !/join\(__dir, 'data'\)/.test(srv));

console.log('');
console.log(failures === 0 ? 'paths.test: PASS' : `paths.test: FAIL (${failures})`);
process.exit(failures === 0 ? 0 : 1);
