// 数据目录与数据库路径的唯一来源（W1 Day2：路径与配置外置）。
//
// 目标：同一份代码在 Windows / macOS / Linux 上都知道"数据该放哪"，同时**不惊动老装机**。
//
// 解析顺序（数据目录）：
//   1) 环境变量 PLANNER_DATA_DIR
//      · 以 .db 结尾 → 按"数据库文件路径"的老语义处理，目录取其父目录
//      · 否则         → 按"数据目录"处理
//   2) 仓库里已有 <repo>/data/  → 继续用它（**老装机零迁移**，你现在的数据就在这）
//   3) 平台默认目录：
//      Windows  %APPDATA%\Cairn
//      macOS    ~/Library/Application Support/Cairn
//      Linux    $XDG_DATA_HOME/cairn（默认 ~/.local/share/cairn）
//
// 数据库文件名保持 codex-planner.db 不变 —— 改文件名等于让你丢数据，没必要。
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';

export const DB_FILE_NAME = 'codex-planner.db';
export const APP_DIR_NAME = 'Cairn';

const isDbFile = (value) => String(value).toLowerCase().endsWith('.db');

/** 平台默认数据目录。传给测试用的 env/platform 可以覆盖真实环境。 */
export function platformDataDir({ platform = process.platform, env = process.env } = {}) {
  if (platform === 'win32') {
    const appData = env.APPDATA || join(env.USERPROFILE || homedir(), 'AppData', 'Roaming');
    return join(appData, APP_DIR_NAME);
  }
  if (platform === 'darwin') {
    return join(env.HOME || homedir(), 'Library', 'Application Support', APP_DIR_NAME);
  }
  const xdg = env.XDG_DATA_HOME || join(env.HOME || homedir(), '.local', 'share');
  return join(xdg, APP_DIR_NAME.toLowerCase());
}

/** 数据目录（日志、导出、计划、本地覆盖配置都放这里）。 */
export function resolveDataDir({ repoDir, env = process.env, platform = process.platform } = {}) {
  const explicit = env.PLANNER_DATA_DIR;
  if (explicit) return isDbFile(explicit) ? dirname(explicit) : explicit;

  const legacy = repoDir ? join(repoDir, 'data') : '';
  if (legacy && existsSync(legacy)) return legacy;   // 老装机：继续用原地

  return platformDataDir({ platform, env });
}

/** 数据库文件路径。 */
export function resolveDbPath({ repoDir, env = process.env, platform = process.platform } = {}) {
  const explicit = env.PLANNER_DATA_DIR;
  if (explicit) return isDbFile(explicit) ? explicit : join(explicit, DB_FILE_NAME);
  return join(resolveDataDir({ repoDir, env, platform }), DB_FILE_NAME);
}

/** 顺带给上层一个说明：这次解析是"老装机原地"还是"平台默认"。 */
export function describePaths({ repoDir, env = process.env, platform = process.platform } = {}) {
  const dataDir = resolveDataDir({ repoDir, env, platform });
  const legacy = repoDir ? join(repoDir, 'data') : '';
  const mode = env.PLANNER_DATA_DIR ? 'env'
    : (legacy && dataDir === legacy) ? 'legacy-in-repo' : 'platform-default';
  return { dataDir, dbPath: resolveDbPath({ repoDir, env, platform }), mode };
}
