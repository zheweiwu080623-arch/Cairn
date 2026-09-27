// 模块系统（W2）：让"加一个功能 = 加一个目录 + 注册一行"真的成立。
//
// 一个模块就是 `<repo>/modules/<id>/` 里的一个目录：
//   module.json   描述符（见 contracts/module.v1.schema.json）
//   view.js       前端入口，导出 mount(el, ctx)（kind=view/gadget 时用）
//   run.js        **再处理入口**，导出 run(input, ctx) → actions[]（kind=processor 时用）
//   README.md     可选
//
// 本文件只做三件事：**发现**（扫描目录）、**校验**（描述符对不对）、**解析资源路径**（防目录穿越）。
// 具体的加载与挂载由 server（/api/modules 与 /modules/*）与前端（public/app.js）完成。
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join, resolve, sep } from 'node:path';

export const MODULE_SCHEMA = 'module.v1';
// processor = 「再处理功能」：吃 signal、吐 action（见 contracts/action.v1.schema.json）。
// 2026-09-23 新增 —— 这是"把再处理升格为一等公民"的那一步。
export const MODULE_KINDS = ['view', 'connector', 'job', 'gadget', 'processor'];
const ID_RE = /^[a-z][a-z0-9-]*$/;
const VERSION_RE = /^\d+\.\d+\.\d+$/;

/** 校验一份描述符。返回 { ok, errors[] }（errors 是人话，直接给界面显示）。 */
export function validateModule(descriptor) {
  const errors = [];
  const d = descriptor && typeof descriptor === 'object' ? descriptor : {};
  if (d.schema !== MODULE_SCHEMA) errors.push(`schema 必须是 ${MODULE_SCHEMA}`);
  if (!d.id || typeof d.id !== 'string') errors.push('缺少 id');
  else if (!ID_RE.test(d.id)) errors.push('id 只能是小写字母/数字/连字符，且以字母开头');
  if (!d.name || typeof d.name !== 'string') errors.push('缺少 name');
  if (!d.version || !VERSION_RE.test(String(d.version))) errors.push('version 要形如 1.0.0');
  if (!MODULE_KINDS.includes(d.kind)) errors.push(`kind 必须是 ${MODULE_KINDS.join(' / ')}`);
  if (d.kind === 'gadget' && !d.mount_into) errors.push('gadget 需要 mount_into（挂到哪个视图，如 connectors）');
  const entry = d.entry && typeof d.entry === 'object' ? d.entry : {};
  if ((d.kind === 'view' || d.kind === 'gadget') && !entry.view) errors.push('view/gadget 需要 entry.view');
  // processor 两种写法都算：写了代码的 entry.run（run(input, ctx) → actions[]），
  // 或**声明式**的 entry.flow（"功能 = 能力图"，M2：nodes + edges，不用写 JS）。
  if (d.kind === 'processor' && !entry.run && !entry.flow) {
    errors.push('processor 需要 entry.run（写代码）或 entry.flow（声明式能力图，M2）');
  }
  if (entry.run && entry.flow) errors.push('processor 的 entry.run 与 entry.flow 只能二选一');
  if (d.requires && Array.isArray(d.requires.capabilities)) {
    if (!d.requires.capabilities.every((c) => typeof c === 'string' && c)) errors.push('requires.capabilities 要是非空字符串数组');
  }
  if (d.permissions && !Array.isArray(d.permissions)) errors.push('permissions 要是数组');
  if (d.config && !Array.isArray(d.config)) errors.push('config 要是数组');
  // settings: true = 这个功能自己有"就地设置"，功能页右上角会出现「⚙ 功能设置」，
  // 抽屉里的内容由模块自己的 view.js 导出 `settings(el, ctx)` 画（2026-09-27）。
  if (d.settings !== undefined && typeof d.settings !== 'boolean') errors.push('settings 要么不写，要么写 true / false');
  // boot: true = 这个模块要在**应用启动时**跑一次 boot(ctx)（例如首次运行的配置向导）。
  // 这是 2026-09-25 加的：用户要求"五步上手要发生在能用应用之前"，所以需要一个
  // "开机就跑、而且能盖住界面"的模块钩子；写成平台能力，别的模块也能用。
  if (d.boot !== undefined && typeof d.boot !== 'boolean') errors.push('boot 要么不写，要么写 true / false');
  return { ok: errors.length === 0, errors };
}

/** 扫描 modules 目录。坏模块不会让整个列表失败，只带 error 字段返回。 */
export function scanModules(root) {
  const out = [];
  if (!root || !existsSync(root)) return out;
  let entries = [];
  try {
    entries = readdirSync(root).filter((name) => {
      try { return statSync(join(root, name)).isDirectory(); } catch { return false; }
    });
  } catch { return out; }

  for (const name of entries.sort()) {
    const dir = join(root, name);
    const file = join(dir, 'module.json');
    if (!existsSync(file)) continue;                        // 不是模块目录，跳过
    let descriptor = null;
    try {
      descriptor = JSON.parse(readFileSync(file, 'utf8'));
    } catch (e) {
      out.push({ id: name, dir, name, kind: 'unknown', error: `module.json 不是合法 JSON：${e.message}` });
      continue;
    }
    const { ok, errors } = validateModule(descriptor);
    const entryView = descriptor?.entry?.view;
    const entryRun = descriptor?.entry?.run;
    const entryFlow = descriptor?.entry?.flow;
    const missing = [];
    if (entryView && !existsSync(join(dir, entryView))) missing.push(entryView);
    if (entryRun && !existsSync(join(dir, entryRun))) missing.push(entryRun);
    if (entryFlow && !existsSync(join(dir, entryFlow))) missing.push(entryFlow);
    if (!ok || missing.length) {
      out.push({
        ...descriptor, id: descriptor.id || name, dir,
        error: [...errors, ...missing.map((f) => `缺少入口文件 ${f}`)].join('；'),
      });
      continue;
    }
    // 2026-09-26：给每个模块带上"入口文件的修改时间"，前端拿它当缓存版本号用。
    // 起因：浏览器按 URL 缓存模块脚本，no-store 也压不住；手动提 version 又会忘。
    // 现在 mtime 一变 URL 就变 ⇒ 改完模块刷新页面就自动生效。
    let newest = 0;
    for (const rel of [descriptor?.entry?.view, descriptor?.entry?.run, descriptor?.entry?.flow].filter(Boolean)) {
      try { newest = Math.max(newest, statSync(join(dir, rel)).mtimeMs); } catch { /* 忽略 */ }
    }
    out.push({ ...descriptor, dir, mtime: Math.round(newest) });
  }
  return out;
}

/**
 * 把模块内的相对路径解析成绝对路径；越界（../）返回 null。
 * 这是给静态资源服务用的安全闸门。
 */
export function moduleAssetPath(root, moduleId, relPath = '') {
  if (!root || !moduleId || !ID_RE.test(String(moduleId))) return null;
  const base = resolve(root, String(moduleId));
  const target = resolve(base, String(relPath || '').replace(/^[/\\]+/, ''));
  if (target !== base && !target.startsWith(base + sep)) return null;
  return target;
}
