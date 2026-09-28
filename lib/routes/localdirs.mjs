// routes/localdirs.mjs —— 「本机目录与本机工具」的三个接口
//
//   GET  /api/localdirs        → 每个目录 / 工具当前指向哪里、配没配、还在不在
//   POST /api/localdirs        → 改一个目录或一个工具路径（写回 <数据目录>\paths.json，**立刻生效**，不用重启）
//   POST /api/localdirs/pick   → 弹系统选择框（选文件夹 / 选文件），返回选中的路径（**只返回，不保存**）
//
// 为什么要有它：这些路径是"每台机器都不一样"的本机配置，以前只能开记事本改 JSON
// 或改环境变量。现在界面上能直接选 —— 而且**改完不需要重启应用**（用的时候现读当前值）。
//
// 两类东西（2026-09-28 把第二类也接进来）：
//   * **目录**（LOCAL_DIR_KEYS）：壁纸目录、课程资料目录 …
//   * **外部工具**（LOCAL_TOOL_KEYS）：pdftotext（PDF 取字）、pdftoppm（PDF 转图）——
//     这类是**可执行文件**，不是目录，所以校验、选择框、生效方式都单列一条线。
//
// 安全与诚实边界：
//   * 目录只接受**已存在的目录**；工具只接受**已存在的文件**（也可以写 PATH 里的命令名，会当场查一次）；
//     不存在 / 类型不对 → 400 并说清原因（不 silent 改成别的）；
//   * 传空字符串 = 清除配置（功能退回"未配置"状态），不是"删目录"；
//   * `pick` 只把路径**原样返回**给界面，落盘由界面确认后的 POST 完成；
//   * 这台机器上拿不到系统选择框（非 Windows / 策略限制）→ 如实报错，提示手动粘贴路径。

import { existsSync, statSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

import { readLocalConfig, writeLocalConfig } from '../local-config.mjs';
import { pickFile, pickFolder } from '../pick-folder.mjs';

/** 允许在界面上修改的本机目录（**白名单**：不在这里的键一律拒绝）。 */
export const LOCAL_DIR_KEYS = {
  wallpaper: {
    label: '壁纸目录',
    configKey: 'wallpaper_dir',
    alsoReads: ['wallpaper_engine_dir'],            // 老装机写的是这个名字，继续认
    envKeys: ['PLANNER_WALLPAPER_DIR', 'WALLPAPER_ENGINE_DIR'],
    hint: 'Wallpaper Engine 创意工坊目录，或任何放着图片/视频的文件夹都行',
  },
  course: {
    label: '课程资料目录',
    configKey: 'course_dir',
    alsoReads: ['course_materials_dir'],
    envKeys: ['PLANNER_COURSE_DIR'],
    hint: '放课程材料的总目录（下面按课程分子文件夹），课程辅助会读这里',
  },
};

/**
 * 允许在界面上改的**外部工具**（白名单；同样是"每台机器都不一样"的本机配置）。
 *
 * 为什么单列一张表：这些不是目录而是**可执行文件**（校验、选择框都不同），
 * 而且它们是**可选**的 —— 没配也照样能用，只是相关能力降级或走不了：
 *   * pdftotext：装了就多认出一批"文字层是字形编号"的 PDF（PPT / LaTeX 导出那类）；
 *   * pdftoppm：装了才能把 PDF 渲染成图，走视觉模型那条路线。
 * `detect` 由宿主注入（就是应用自己找工具的那两个函数）—— 这里只负责"显示现在的状态"，
 * 不在路由里再抄一份查找逻辑。
 */
export const LOCAL_TOOL_KEYS = {
  pdftotext: {
    label: 'PDF 取字工具（pdftotext）',
    configKey: 'pdftotext_path',
    alsoReads: [],
    envKeys: ['PLANNER_PDFTOTEXT'],
    commands: ['pdftotext', 'pdftotext.exe'],
    hint: 'Poppler 的 pdftotext。装了它，PPT / LaTeX 导出的 PDF 也能读出正常文字；不装也行，读不出来的会如实标注',
    effect: '装了：能读的课件更多（实测那批 54 份从 20 份到 51 份）；不装：退回应用自带的取字，字体特殊的那批会标「需要 OCR」',
  },
  pdftoppm: {
    label: 'PDF 转图工具（pdftoppm）',
    configKey: 'pdftoppm_path',
    alsoReads: [],
    envKeys: ['PLANNER_PDFTOPPM'],
    commands: ['pdftoppm', 'pdftoppm.exe'],
    hint: 'Poppler 的 pdftoppm。装了才能用「视觉路线」把页面渲染成图交给视觉模型',
    effect: '装了：能用视觉路线还原公式（会调用你自己配的视觉模型）；不装：只剩文字路线',
  },
};

/** 一个目录的当前状态（环境变量 > paths.json > 未配置）。 */
export function describeLocalDir(key, { dataDir = '', env = process.env } = {}) {
  const spec = LOCAL_DIR_KEYS[key];
  if (!spec) return null;
  let dir = '';
  for (const k of spec.envKeys) if (env[k] && String(env[k]).trim()) dir = String(env[k]).trim();
  let from = dir ? 'env' : '';
  if (!dir) {
    const cfg = readLocalConfig(dataDir, env);
    for (const k of [spec.configKey, ...spec.alsoReads]) {
      if (cfg[k] && String(cfg[k]).trim()) { dir = String(cfg[k]).trim(); from = 'config'; break; }
    }
  }
  let exists = false;
  let isDir = false;
  if (dir) {
    exists = existsSync(dir);
    try { isDir = exists && statSync(dir).isDirectory(); } catch { isDir = false; }
  }
  return { key, label: spec.label, hint: spec.hint, dir, configured: Boolean(dir), from, exists, is_dir: isDir };
}

/**
 * 一个外部工具的当前状态。取值顺序和目录一致（环境变量 > paths.json > 没配），
 * 另外多给一份"**自动找到的**"（宿主注进来的 detect）—— 因为这类工具本来就是可选的：
 * 没配不代表不能用，可能应用自己就找到了（例如跟着 Git for Windows 装的 poppler）。
 */
export function describeLocalTool(key, {
  dataDir = '', env = process.env, detect = null, exists = existsSync,
} = {}) {
  const spec = LOCAL_TOOL_KEYS[key];
  if (!spec) return null;
  let path = '';
  let from = '';
  for (const k of spec.envKeys) {
    const v = env[k];
    if (v && String(v).trim()) { path = String(v).trim(); from = 'env'; }
  }
  if (!path) {
    const cfg = readLocalConfig(dataDir, env);
    for (const k of [spec.configKey, ...spec.alsoReads]) {
      if (cfg[k] && String(cfg[k]).trim()) { path = String(cfg[k]).trim(); from = 'config'; break; }
    }
  }
  let ok = false;
  if (path) { try { ok = exists(path); } catch { ok = false; } }
  let auto = '';
  if (typeof detect === 'function') { try { auto = String(detect() || '').trim(); } catch { auto = ''; } }
  return {
    key, label: spec.label, hint: spec.hint, effect: spec.effect,
    path, configured: Boolean(path), from, exists: ok,
    auto, auto_available: Boolean(auto),
    effective: path || auto,
    effective_from: path ? from : (auto ? 'auto' : ''),
  };
}

/** 校验"要设成这个目录"能不能接受；返回 { ok, dir, error }。 */
export function checkDirInput(raw) {
  const s = String(raw == null ? '' : raw).trim().replace(/^"|"$/g, '');   // 顺手去掉用户从资源管理器复制来的引号
  if (!s) return { ok: true, dir: '' };                                    // 空 = 清除配置
  if (s.includes('\0')) return { ok: false, error: '路径里有非法字符' };
  const abs = resolve(s);
  if (!existsSync(abs)) return { ok: false, error: `这个路径不存在：${abs}` };
  let isDir = false;
  try { isDir = statSync(abs).isDirectory(); } catch { isDir = false; }
  if (!isDir) return { ok: false, error: `这不是一个文件夹：${abs}` };
  return { ok: true, dir: abs };
}

/**
 * 「只写了个命令名」（`pdftotext`，没有路径分隔符）时的兜底：**当场去 PATH 里查一次**。
 * 查到了就存**绝对路径**（以后 PATH 变了也不影响），查不到就如实说查不到 ——
 * 绝不把 `pdftotext` 这种光杆名字直接存进配置（那样"配好了"只是看起来配好了）。
 */
export function resolveCommandInPath(name, { env = process.env, exists = existsSync, platform = process.platform } = {}) {
  const cmd = String(name || '').trim();
  if (!cmd) return '';
  const win = platform === 'win32';
  const names = win && !/\.[a-z0-9]+$/i.test(cmd) ? [cmd, `${cmd}.exe`, `${cmd}.cmd`, `${cmd}.bat`] : [cmd];
  for (const dir of String(env.PATH || '').split(win ? ';' : ':')) {
    if (!dir) continue;
    for (const n of names) {
      const p = `${dir.replace(/[\\/]+$/, '')}${win ? '\\' : '/'}${n}`;
      try { if (exists(p)) return p; } catch { /* 继续找 */ }
    }
  }
  return '';
}

/**
 * 校验"要设成这个工具路径"能不能接受；返回 `{ ok, path, resolved, error }`。
 *
 * 三种输入都认（都在这里说清，而不是让用户猜）：
 *   * 空 → 清除配置（功能退回"自动找"）；
 *   * 完整路径（带分隔符）→ 必须**已存在**且**是一个文件**（是目录就明确说"这是个文件夹"）；
 *   * 光一个命令名（`pdftotext`）→ 去 PATH 里查，查到就存绝对路径，查不到就报错。
 */
export function checkToolInput(raw, { env = process.env, exists = existsSync, platform = process.platform } = {}) {
  const s = String(raw == null ? '' : raw).trim().replace(/^"|"$/g, '');
  if (!s) return { ok: true, path: '' };                                   // 空 = 清除配置
  if (s.includes('\0')) return { ok: false, error: '路径里有非法字符' };
  const looksBare = !/[\\/]/.test(s);
  if (looksBare) {
    const found = resolveCommandInPath(s, { env, exists, platform });
    if (found) return { ok: true, path: found, resolved: true };
    return { ok: false, error: `在 PATH 里没找到「${s}」这个命令；要么把完整路径贴进来（点「选择…」也行），要么先把它装好` };
  }
  const abs = resolve(s);
  if (!existsSync(abs)) return { ok: false, error: `这个文件不存在：${abs}` };
  let isDir = false;
  let isFile = false;
  try { isDir = statSync(abs).isDirectory(); isFile = statSync(abs).isFile(); } catch { /* 下面按"读不到"处理 */ }
  if (isDir) return { ok: false, error: `这是一个文件夹，不是一个可执行文件：${abs}` };
  if (!isFile) return { ok: false, error: `这个路径不是普通文件：${abs}` };
  return { ok: true, path: abs };
}

export function createLocalDirRoutes({
  dataDir = '', sendJson, sendError, readBody,
  env = process.env, log = () => {},
  onChanged = () => {},                  // (key, dir) —— 让已经建好的东西（例如壁纸扫描）立刻跟上
  pick = pickFolder,
  pickFileFn = pickFile,                 // 选"文件"（外部工具路径）；测试里注入假的，绝不真弹窗
  detectTools = {},                      // { pdftotext: () => '找到的路径' } —— 宿主注入，只用于显示
  platform = process.platform,
} = {}) {
  /** 弹文件选择框时的"从哪儿开始找"：现在配的那个文件所在目录（它还在的话）。 */
  const startDirOf = (file) => {
    const s = String(file || '').trim();
    if (!s) return '';
    try { return existsSync(s) ? dirname(s) : ''; } catch { return ''; }
  };
  const listAll = () => {
    const dirs = {};
    for (const key of Object.keys(LOCAL_DIR_KEYS)) dirs[key] = describeLocalDir(key, { dataDir, env });
    const tools = {};
    for (const key of Object.keys(LOCAL_TOOL_KEYS)) {
      tools[key] = describeLocalTool(key, { dataDir, env, detect: detectTools[key] });
    }
    return { schema: 'localdirs.v1', data_dir: dataDir, dirs, tools };
  };

  async function handleLocalDirs(req, res, url) {
    const p = url.pathname;
    if (p === '/api/localdirs' && req.method === 'GET') return sendJson(res, 200, listAll());

    if (p === '/api/localdirs' && req.method === 'POST') {
      const body = (await readBody(req)) || {};
      const key = String(body.key || '');
      // ---- 外部工具（可执行文件）：校验、落盘、生效方式都和目录不一样 ----
      const toolSpec = LOCAL_TOOL_KEYS[key];
      if (toolSpec) {
        const check = checkToolInput(body.path !== undefined ? body.path : body.dir, { env, platform });
        if (!check.ok) return sendError(res, 400, check.error);
        const w = writeLocalConfig({ [toolSpec.configKey]: check.path || null }, { dataDir, env });
        if (!w.ok) return sendError(res, 400, w.error);
        log(`[localdirs] ${toolSpec.label} → ${check.path || '（改回自动找）'}`);
        try { onChanged(key, check.path); } catch (e) { log(`[localdirs] onChanged 出错：${(e && e.message) || e}`); }
        return sendJson(res, 200, { ...listAll(), changed: { key, path: check.path, resolved: Boolean(check.resolved) } });
      }
      const spec = LOCAL_DIR_KEYS[key];
      if (!spec) {
        const known = [...Object.keys(LOCAL_DIR_KEYS), ...Object.keys(LOCAL_TOOL_KEYS)].join(' / ');
        return sendError(res, 400, `不认识的本机项：${key || '（空）'}（可改的有：${known}）`);
      }
      const check = checkDirInput(body.dir);
      if (!check.ok) return sendError(res, 400, check.error);
      // 清空时把新老两个键一起清掉，避免"界面显示未配置、扫描却读老键"
      const patch = { [spec.configKey]: check.dir || null };
      for (const k of spec.alsoReads) patch[k] = null;
      const w = writeLocalConfig(patch, { dataDir, env });
      if (!w.ok) return sendError(res, 400, w.error);
      log(`[localdirs] ${spec.label} → ${check.dir || '（未配置）'}`);
      try { onChanged(key, check.dir); } catch (e) { log(`[localdirs] onChanged 出错：${(e && e.message) || e}`); }
      return sendJson(res, 200, { ...listAll(), changed: { key, dir: check.dir } });
    }

    if (p === '/api/localdirs/pick' && req.method === 'POST') {
      const body = (await readBody(req)) || {};
      const key = String(body.key || '');
      // 选**文件**：外部工具路径（pdftotext.exe 这类）
      const toolSpec = LOCAL_TOOL_KEYS[key];
      if (toolSpec) {
        const cur = describeLocalTool(key, { dataDir, env });
        const isWin = platform === 'win32';
        const r = await pickFileFn({
          title: body.title || `选择${toolSpec.label}`,
          initial: body.initial || startDirOf(cur.path),
          filter: isWin ? '可执行文件 (*.exe)|*.exe|所有文件 (*.*)|*.*' : '',
        });
        if (r && r.ok && r.file) {
          const check = checkToolInput(r.file, { env, platform });
          if (!check.ok) return sendError(res, 400, check.error);
          return sendJson(res, 200, { ok: true, path: check.path, key });
        }
        return sendJson(res, 200, { ok: !!r?.ok, cancelled: !!r?.cancelled, path: null, key, error: r?.error || null });
      }
      const spec = LOCAL_DIR_KEYS[key];
      const cur = spec ? describeLocalDir(key, { dataDir, env }) : null;
      const r = await pick({
        title: body.title || `选择${spec ? spec.label : '文件夹'}`,
        initial: body.initial || (cur && cur.is_dir ? cur.dir : ''),
      });
      // 选到的东西同样要过一遍校验（用户可能在框里手打了一个不存在的路径）
      if (r && r.ok && r.dir) {
        const check = checkDirInput(r.dir);
        if (!check.ok) return sendError(res, 400, check.error);
        return sendJson(res, 200, { ok: true, dir: check.dir, key });
      }
      return sendJson(res, 200, { ok: !!r?.ok, cancelled: !!r?.cancelled, dir: null, key, error: r?.error || null });
    }

    return sendError(res, 404, '没有这个接口');
  }

  return { handleLocalDirs, listAll };
}
