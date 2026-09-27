// 应用显示名（品牌）的唯一来源。
//
// 为什么要有这一层：这个项目既是**作者自己在用**的应用，也是**准备开源发布**的项目。
// 两者的显示名不同：
//   * 作者本机：data/brand.json 里写自己的名字（data/ 已被 .gitignore 排除，不会进仓库）
//   * 别人 clone 下来：没有那个文件 → 用默认名 Cairn
//
// 解析优先级：
//   1) 环境变量 PLANNER_APP_NAME（临时覆盖，测试用）
//   2) <数据目录>/brand.json 里的 { "app_name": "..." }
//   3) 默认 'Cairn'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

export const DEFAULT_APP_NAME = 'Cairn';
/** 名字长度上限（太长会把顶栏撑坏；也顺手挡掉"粘贴一整段话"的情况）。 */
export const APP_NAME_MAX = 24;

/** 清洗用户填的名字：去掉控制字符、压掉首尾空白、限长。空字符串 = 恢复默认名。 */
export function normalizeAppName(raw) {
  return String(raw ?? '')
    .replace(/[\u0000-\u001f\u007f]/g, '')
    .trim()
    .slice(0, APP_NAME_MAX);
}

/** 解析应用显示名。dataDir 传运行时的数据目录；不传就只能拿到环境变量/默认值。 */
export function appName({ dataDir = '', env = process.env } = {}) {
  const fromEnv = env.PLANNER_APP_NAME;
  if (fromEnv && String(fromEnv).trim()) return String(fromEnv).trim();

  if (dataDir) {
    const file = join(dataDir, 'brand.json');
    if (existsSync(file)) {
      try {
        const value = JSON.parse(readFileSync(file, 'utf8')).app_name;
        if (value && String(value).trim()) return String(value).trim();
      } catch {
        // 文件坏了就当没有，回退默认名 —— 品牌名绝不能让应用起不来
      }
    }
  }
  return DEFAULT_APP_NAME;
}

/** 给界面用的一小包品牌信息。 */
export function brandInfo(opts) {
  const name = appName(opts);
  return {
    app_name: name,
    default_app_name: DEFAULT_APP_NAME,
    // 界面用它判断"起名字这一步做过没有"，也是入门清单的一步
    custom: name !== DEFAULT_APP_NAME,
  };
}

/**
 * 把显示名写进 `<数据目录>/brand.json` —— #1「个人对这个应用名称的自定义」的落点。
 *
 * 为什么写文件而不是数据库：解析优先级是 `环境变量 > brand.json > 默认 Cairn`，
 * 而 `data/` 已被 .gitignore 排除 ⇒ **每个人的本机名字永远不会进仓库**（当初就是这么设计的）。
 *
 * 传空字符串 = 清除自定义、回到默认名（写空值而不是删文件，避免用到删除类操作）。
 */
export function saveAppName(dataDir, raw) {
  const clean = normalizeAppName(raw);
  if (!dataDir) return { ok: false, error: '没有可写入的数据目录' };
  try {
    mkdirSync(dataDir, { recursive: true });
    writeFileSync(join(dataDir, 'brand.json'), `${JSON.stringify({ app_name: clean }, null, 2)}\n`, 'utf8');
    return { ok: true, app_name: clean || DEFAULT_APP_NAME, custom: !!clean };
  } catch (e) {
    return { ok: false, error: String((e && e.message) || e) };
  }
}
