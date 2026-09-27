// routes/localdirs.mjs —— 「本机目录」的三个接口（壁纸目录 / 课程资料目录 …）
//
//   GET  /api/localdirs        → 每个目录当前指向哪里、配没配、还在不在
//   POST /api/localdirs        → 改一个目录（写回 <数据目录>\paths.json，**立刻生效**，不用重启）
//   POST /api/localdirs/pick   → 弹系统选择框，返回选中的路径（**只返回，不保存**）
//
// 为什么要有它：这些路径是"每台机器都不一样"的本机配置，以前只能开记事本改 JSON。
// 现在界面上能直接选 —— 而且**改完不需要重启应用**（扫描的时候现读当前值）。
//
// 安全与诚实边界：
//   * 只接受**已存在的目录**；不存在 / 不是目录 → 400 并说清原因（不 silent 改成别的）；
//   * 传空字符串 = 清除配置（功能退回"未配置"状态），不是"删目录"；
//   * `pick` 只把路径**原样返回**给界面，落盘由界面确认后的 POST 完成；
//   * 这台机器上拿不到系统选择框（非 Windows / 策略限制）→ 如实报错，提示手动粘贴路径。

import { existsSync, statSync } from 'node:fs';
import { resolve } from 'node:path';

import { readLocalConfig, writeLocalConfig } from '../local-config.mjs';
import { pickFolder } from '../pick-folder.mjs';

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

export function createLocalDirRoutes({
  dataDir = '', sendJson, sendError, readBody,
  env = process.env, log = () => {},
  onChanged = () => {},                  // (key, dir) —— 让已经建好的东西（例如壁纸扫描）立刻跟上
  pick = pickFolder,
} = {}) {
  const listAll = () => {
    const dirs = {};
    for (const key of Object.keys(LOCAL_DIR_KEYS)) dirs[key] = describeLocalDir(key, { dataDir, env });
    return { schema: 'localdirs.v1', data_dir: dataDir, dirs };
  };

  async function handleLocalDirs(req, res, url) {
    const p = url.pathname;
    if (p === '/api/localdirs' && req.method === 'GET') return sendJson(res, 200, listAll());

    if (p === '/api/localdirs' && req.method === 'POST') {
      const body = (await readBody(req)) || {};
      const key = String(body.key || '');
      const spec = LOCAL_DIR_KEYS[key];
      if (!spec) return sendError(res, 400, `不认识的目录类别：${key || '（空）'}`);
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
