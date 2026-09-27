// routes/capabilities.mjs —— 能力层的只读接口（M1 · S3 / S6）
//
//   GET /api/capabilities            → 登记表全貌（含权限、能不能重放、谁在用、谁声明了它）
//   GET /api/capabilities?id=xxx     → 只要一条
//
// 只读、不落库、不改任何状态：这一层的意义是"让能力看得见" ——
// 命令行（`cairn cap list`）、可视化搭建（M3）与安装预览（S6）读的都是同一个出口。

import { CAPABILITIES, KIND_LABELS, COST_LABELS, capabilityGroups, getCapability, validateCapability } from '../capabilities/index.mjs';
import { declaredCapabilities } from '../capabilities/host.mjs';
import { capabilityTemplate, saveUserCapability, scanUserCapabilities, userCapabilityView, runUserCapability } from '../capabilities/user.mjs';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { userCapDir } from '../capabilities/user.mjs';
import { describePermission } from '../permissions.mjs';

/** 一条能力 → 给外面看的形状（比登记表多几样"翻译成人话"的东西）。 */
export function capabilityView(cap, { declaredBy = [] } = {}) {
  return {
    schema: 'capability.v1',
    id: cap.id,
    name: cap.name,
    version: cap.version,
    kind: cap.kind,
    kind_label: KIND_LABELS[cap.kind] || cap.kind,
    permissions: cap.permissions || [],
    permission_labels: (cap.permissions || []).map((p) => ({ code: p, ...describePermission(p) })),
    idempotent: cap.idempotent,
    cost: cap.cost,
    cost_label: COST_LABELS[cap.cost] || cap.cost,
    group: (cap.ui && cap.ui.group) || '未分组',
    label: (cap.ui && cap.ui.label) || cap.name,
    icon: (cap.ui && cap.ui.icon) || null,
    entry: cap.entry || null,
    tests: cap.tests || null,
    used_by: cap.used_by || [],
    declared_by: declaredBy,
    notes: cap.notes || null,
    bind: cap.bind || null,
  };
}

/**
 * @param {{sendJson:Function, sendError:Function, listModules?:Function}} ctx
 *        listModules：() => 模块数组（用来算"哪些功能声明了这条能力"），可以不传。
 */
export function createCapabilityRoutes({ sendJson, sendError, listModules = () => [], dataDir = '', readBody = async () => ({}) } = {}) {
  /** 哪些模块声明了哪条能力 → { capabilityId: [moduleId…] } */
  function declarations() {
    const out = {};
    let modules = [];
    try { modules = listModules() || []; } catch { modules = []; }
    for (const m of modules) {
      const { known } = declaredCapabilities(m);
      for (const id of known) {
        if (!out[id]) out[id] = [];
        out[id].push(m.id);
      }
    }
    return out;
  }

  /** 开发者自己写的能力 → 与自带能力同一种展示形状（source: 'user'）。 */
  async function userViews() {
    if (!dataDir) return [];
    const all = await scanUserCapabilities(dataDir);
    return all.map((c) => ({
      schema: 'capability.v1',
      id: c.id,
      name: c.name || c.id,
      version: '1.0.0',
      kind: c.kind || 'compute',
      kind_label: KIND_LABELS[c.kind] || c.kind || '',
      permissions: (c.meta && c.meta.permissions) || [],
      permission_labels: ((c.meta && c.meta.permissions) || []).map((p) => ({ code: p, ...describePermission(p) })),
      idempotent: c.meta ? c.meta.idempotent : true,
      cost: c.meta ? c.meta.cost : 'none',
      cost_label: COST_LABELS[c.meta ? c.meta.cost : 'none'] || '',
      group: ((c.meta && c.meta.ui) || {}).group || '自写',
      label: ((c.meta && c.meta.ui) || {}).label || c.name || c.id,
      icon: ((c.meta && c.meta.ui) || {}).icon || '🧩',
      entry: c.file,
      tests: null,
      used_by: [],
      declared_by: [],
      notes: c.error ? `⚠️ 这条自写能力有问题：${c.error}` : '开发者自己写的能力（在数据目录的 capabilities/ 下）',
      bind: null,
      source: 'user',
    }));
  }

  async function list() {
    const declaredBy = declarations();
    const items = CAPABILITIES.map((c) => capabilityView(c, { declaredBy: declaredBy[c.id] || [] })).concat(await userViews());
    const checked = CAPABILITIES.map((c) => validateCapability(c));
    return {
      schema: 'capabilities.v1',
      count: items.length,
      builtin_count: CAPABILITIES.length,
      user_count: items.length - CAPABILITIES.length,
      groups: capabilityGroups(),
      kinds: KIND_LABELS,
      costs: COST_LABELS,
      validation: { checked: checked.length, failed: checked.filter((r) => !r.ok).length },
      capabilities: items,
    };
  }

  async function handleCapabilities(req, res, url) {
    const method = req.method;
    // ---- 开发：写能力 / 读文件 / 试跑（放同一个文件里，接口都归"能力"这一层） ----
    if (url.pathname === '/api/capabilities/dev') {
      if (method !== 'GET') return sendError(res, 405, '这个接口只读（GET）');
      if (!dataDir) return sendError(res, 503, '这台服务器没有数据目录，用不了自写能力');
      const id = url.searchParams && url.searchParams.get('id');
      const all = await scanUserCapabilities(dataDir);
      if (!id) return sendJson(res, 200, { ok: true, capabilities: all.map(userCapabilityView), template: capabilityTemplate() });
      const hit = all.find((c) => c.id === id || c.file === `${id}.mjs`);
      if (!hit) return sendError(res, 404, `没有这条自写能力：${id}`);
      let code = '';
      try { code = readFileSync(join(userCapDir(dataDir), hit.file), 'utf8'); } catch { code = ''; }
      return sendJson(res, 200, { ok: !hit.error, id: hit.id, name: hit.name, kind: hit.kind, code, error: hit.error || '' });
    }
    if (url.pathname === '/api/capabilities/dev/save' && method === 'POST') {
      const body = (await readBody(req)) || {};
      const r = await saveUserCapability(dataDir, { id: body.id, code: body.code, name: body.name, kind: body.kind });
      return sendJson(res, r.ok ? 200 : 400, r);
    }
    if (url.pathname === '/api/capabilities/dev/run' && method === 'POST') {
      const body = (await readBody(req)) || {};
      const r = await runUserCapability(dataDir, body.id, body.input || {}, {});
      return sendJson(res, r.ok ? 200 : 400, r);
    }
    if (method !== 'GET') return sendError(res, 405, '这个接口只读（GET）');
    const id = url.searchParams && url.searchParams.get ? url.searchParams.get('id') : null;
    if (id) {
      const cap = getCapability(id);
      if (!cap) {
        const u = (await userViews()).find((c) => c.id === id);
        if (!u) return sendError(res, 404, `没有这个能力：${id}`);
        return sendJson(res, 200, u);
      }
      return sendJson(res, 200, capabilityView(cap, { declaredBy: declarations()[id] || [] }));
    }
    return sendJson(res, 200, await list());
  }

  return { handleCapabilities, list, capabilityView };
}
