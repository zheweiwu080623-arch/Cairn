// 本机专属配置（W1：把"某台机器才有的路径"从代码里搬出来）。
//
// 为什么要有它：`D:\SteamLibrary\...`（壁纸引擎）、外部邮件桥的安装目录这类路径
// 只对**作者这台机器**有意义，写进代码就会跟着仓库公开。现在改成：
//   1) 环境变量优先（临时覆盖 / 测试）
//   2) `<数据目录>/paths.json`（本机配置，**data/ 已被 .gitignore 排除**）
//   3) 都没有 → 空字符串：功能自动降级为"未配置"，不会报错
//
// 文件形如：
//   { "wallpaper_engine_dir": "<你的壁纸目录>", "mail_bridge_dir": "<邮件桥装在哪>" }
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { resolveDataDir } from './paths.mjs';

const __dir = dirname(fileURLToPath(import.meta.url));
const REPO_DIR = dirname(__dir);

export const LOCAL_CONFIG_FILE = 'paths.json';

/** 读本机配置（读不到就返回空对象，绝不抛）。 */
export function readLocalConfig(dataDir = '', env = process.env) {
  const dir = dataDir || resolveDataDir({ repoDir: REPO_DIR, env });
  const file = join(dir, LOCAL_CONFIG_FILE);
  if (!existsSync(file)) return {};
  try {
    const parsed = JSON.parse(readFileSync(file, 'utf8'));
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch {
    return {};
  }
}

/**
 * 改本机配置（**只改传进来的那几个键，其它键原样留着**）。
 *
 * 为什么需要它：以前 `paths.json` 只能手改文件 —— 壁纸目录、课程资料目录这种
 * "每个人都不一样"的路径，让用户去开记事本改 JSON 是不合理的。
 *
 * 三条规矩：
 *   1) **合并**而不是覆盖（手写在里面的 `_note` 之类不会被冲掉）；
 *   2) **原子写**：先写 `paths.json.tmp`、再改名过去 —— 中途断电/被杀不会留下半个文件；
 *   3) 值传 `null` 表示"删掉这个键"（清空配置），不是写一个 null 进去。
 *
 * @returns {{ok:boolean, file:string, config:object, error?:string}}
 */
export function writeLocalConfig(patch = {}, { dataDir = '', env = process.env } = {}) {
  const dir = dataDir || resolveDataDir({ repoDir: REPO_DIR, env });
  const file = join(dir, LOCAL_CONFIG_FILE);
  const cfg = readLocalConfig(dir, env);
  for (const [k, v] of Object.entries(patch || {})) {
    if (v === null) delete cfg[k];
    else cfg[k] = v;
  }
  try {
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    const tmp = `${file}.tmp`;
    writeFileSync(tmp, `${JSON.stringify(cfg, null, 2)}\n`, 'utf8');
    renameSync(tmp, file);                       // 原子改名：读的人要么看到旧版、要么看到新版
    return { ok: true, file, config: cfg };
  } catch (e) {
    return { ok: false, file, config: cfg, error: `写不进本机配置：${e.message}` };
  }
}

/**
 * 解析一个本机路径：环境变量 > 本机配置 > 空字符串。
 * envKey 例如 'WALLPAPER_ENGINE_DIR'；configKey 例如 'wallpaper_engine_dir'。
 */
export function localPath({ envKey, configKey, dataDir = '', env = process.env } = {}) {
  // envKey / configKey 都可以传数组：前者用于"改名后同时认新老环境变量"，后者同理
  const envKeys = Array.isArray(envKey) ? envKey : (envKey ? [envKey] : []);
  const configKeys = Array.isArray(configKey) ? configKey : (configKey ? [configKey] : []);
  for (const k of envKeys) {
    const v = env[k];
    if (v && String(v).trim()) return String(v).trim();
  }
  const cfg = readLocalConfig(dataDir, env);
  for (const k of configKeys) {
    const v = cfg[k];
    if (v && String(v).trim()) return String(v).trim();
  }
  return '';
}
