// routes/capabilities.mjs —— 能力层的只读接口（M1 · S3 / S6）
//
//   GET /api/capabilities            → 登记表全貌（含权限、能不能重放、谁在用、谁声明了它）
//   GET /api/capabilities?id=xxx     → 只要一条
//
// 只读、不落库、不改任何状态：这一层的意义是"让能力看得见" ——
// 命令行（`cairn cap list`）、可视化搭建（M3）与安装预览（S6）读的都是同一个出口。

import {
  CAPABILITIES, COST_LABELS, EXPOSE_LABELS, KIND_LABELS, capabilityGroups, getCapability, validateCapability,
  capabilityIdFromToolName, exposeOf, modelDescriptionOf, modelTools,
} from '../capabilities/index.mjs';
import { declaredCapabilities } from '../capabilities/host.mjs';
import {
  capabilityTemplate, compositeTemplate, flowCapabilities, saveUserCapability, saveUserCapabilityFlow,
  readDisabled, scanUserCapabilities, setDisabled, userCapabilityView, runUserCapability, userCapDir,
} from '../capabilities/user.mjs';
import { mkdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describePermission } from '../permissions.mjs';
import { openPath } from '../server-shell.mjs';

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
    // 给模型看的那一面（2026-10-02）：这条能力要不要交给外部 agent 调、又该怎么描述它
    expose: exposeOf(cap),
    expose_label: EXPOSE_LABELS[exposeOf(cap)] || '',
    model_description: modelDescriptionOf(cap),
    disabled: !!(cap && cap.disabled),
  };
}

/**
 * @param {{sendJson:Function, sendError:Function, listModules?:Function}} ctx
 *        listModules：() => 模块数组（用来算"哪些功能声明了这条能力"），可以不传。
 */
export function createCapabilityRoutes({
  sendJson, sendError, listModules = () => [], dataDir = '', readBody = async () => ({}),
  capabilities = null, openDir = null,
} = {}) {
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
    return all.map((c) => {
      // 形状对齐自带能力：meta 是"身份证"，坏条目也要能展示出它坏在哪
      const meta = c.meta || { id: c.id, kind: c.kind || 'compute' };
      const expose = exposeOf(meta);
      return {
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
      composite: !!c.composite,
      capabilities: c.composite ? flowCapabilities({ flow: c.flow }) : [],
      summary: c.composite ? (c.meta && c.meta.notes) || '' : '',
      expose,
      expose_label: EXPOSE_LABELS[expose] || '',
      model_description: modelDescriptionOf(meta),
      notes: c.error ? `⚠️ 这条自写能力有问题：${c.error}`
        : (c.composite ? '复合能力：把已有能力连成一张小图（在这个页面的「搭功能」里拼好，点「存成新能力」）'
          : '开发者自己写的能力（在数据目录的 capabilities/ 下）'),
      bind: null,
      source: 'user',
      };
    });
  }

  /**
   * 自带 + 自写，合成一张"能给模型看的"能力表（写类也在里面，但调用只会拿到计划）。
   * `includeDisabled` 只给"解析 id"用 —— 停用的能力不进工具表，但**调用时要能认出它并明确拒绝**，
   * 而不是回一句"没有这个能力"（那样看起来像拼错了名字）。
   */
  async function allForModel({ includeDisabled = false } = {}) {
    if (!dataDir) return CAPABILITIES.slice();
    let user = [];
    try { user = await scanUserCapabilities(dataDir); } catch { user = []; }
    const all = CAPABILITIES.concat(user.filter((c) => !c.error && c.meta).map((c) => ({ ...c.meta, source: 'user' })));
    // 停用的不进工具表（台阶 D）—— 列表里不出现，调用也会被宿主拒掉
    const off = new Set(dataDir ? readDisabled(dataDir) : []);
    if (includeDisabled || !off.size) return all;
    return all.filter((c) => !off.has(c.id));
  }

  async function list() {
    const declaredBy = declarations();
    const off = new Set(dataDir ? readDisabled(dataDir) : []);
    const items = CAPABILITIES
      .map((c) => capabilityView({ ...c, disabled: off.has(c.id) }, { declaredBy: declaredBy[c.id] || [] }))
      .concat((await userViews()).map((c) => ({ ...c, disabled: off.has(c.id) })));
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
      const dir = userCapDir(dataDir);
      if (!id) {
        return sendJson(res, 200, {
          ok: true,
          capabilities: all.map(userCapabilityView),
          template: capabilityTemplate(),
          flow_template: compositeTemplate(),
          dir,
          note: '平台每次读取都会重新扫这个目录 —— 用你惯用的编辑器改完文件，回到页面点「重新扫描」就生效，不用重启服务。',
        });
      }
      const hit = all.find((c) => c.id === id || c.file === `${id}.mjs` || c.file === `${id}.json`);
      if (!hit) return sendError(res, 404, `没有这条自写能力：${id}`);
      let code = '';
      try { code = readFileSync(join(dir, hit.file), 'utf8'); } catch { code = ''; }
      return sendJson(res, 200, {
        ok: !hit.error, id: hit.id, name: hit.name, kind: hit.kind, code,
        composite: !!hit.composite,
        flow: hit.composite ? (hit.flow || null) : null,
        file: hit.file, dir,
        error: hit.error || '',
      });
    }
    // 「打开目录」：在文件管理器里打开这个文件夹，用你自己的编辑器改（台阶 0）
    if (url.pathname === '/api/capabilities/dev/open' && method === 'POST') {
      if (!dataDir) return sendError(res, 503, '这台服务器没有数据目录');
      const dir = userCapDir(dataDir);
      try { mkdirSync(dir, { recursive: true }); } catch { /* 建不出来就让 openPath 去报错 */ }
      const r = await (openDir || openPath)(dir);
      return sendJson(res, r && r.ok ? 200 : 500, { ok: !!(r && r.ok), dir, via: (r && r.cmd) || null, error: (r && r.error) || null });
    }
    if (url.pathname === '/api/capabilities/dev/save' && method === 'POST') {
      const body = (await readBody(req)) || {};
      // 拼出来的能力（post 的是 flow）与手写的（post 的是 code）走同一个入口
      if (body.flow) {
        const r = await saveUserCapabilityFlow(dataDir, { id: body.id, name: body.name, kind: body.kind, spec: { ...body.spec, flow: body.flow } });
        return sendJson(res, r.ok ? 200 : 400, r);
      }
      const r = await saveUserCapability(dataDir, { id: body.id, code: body.code, name: body.name, kind: body.kind });
      return sendJson(res, r.ok ? 200 : 400, r);
    }
    if (url.pathname === '/api/capabilities/dev/run' && method === 'POST') {
      const body = (await readBody(req)) || {};
      const invoke = capabilities && typeof capabilities.invoke === 'function'
        ? (id, i, c) => capabilities.invoke(id, i, c)
        : null;
      const r = await runUserCapability(dataDir, body.id, body.input || {}, {}, { invoke });
      return sendJson(res, r.ok ? 200 : 400, r);
    }

    // ---- 给外部 AI agent 的工具面（2026-10-02 · 台阶 A/C）----
    // GET  /api/capabilities/model-tools           → 自动生成的工具表（MCP 的 tools/list 读它）
    // POST /api/capabilities/invoke { id, input }  → 调一条能力；**写类只回"计划"，不执行**
    // POST /api/capabilities/disabled { id, disabled } → 本机停用/启用一条能力（台阶 D）
    if (url.pathname === '/api/capabilities/disabled' && method === 'POST') {
      if (!dataDir) return sendError(res, 503, '这台服务器没有数据目录，改不了停用清单');
      const body = (await readBody(req)) || {};
      const id = String(body.id || '').trim();
      if (!id) return sendError(res, 400, '要停用哪条能力（id）');
      const want = body.disabled !== false;                      // 默认是"停用"
      const now = readDisabled(dataDir);
      const next = want ? [...new Set([...now, id])] : now.filter((x) => x !== id);
      const ids = setDisabled(dataDir, next);
      return sendJson(res, 200, { ok: true, id, disabled: ids.includes(id), disabled_capabilities: ids });
    }
    if (url.pathname === '/api/capabilities/disabled' && method === 'GET') {
      return sendJson(res, 200, { ok: true, disabled_capabilities: dataDir ? readDisabled(dataDir) : [] });
    }
    if (url.pathname === '/api/capabilities/model-tools' && method === 'GET') {
      const all = await allForModel();
      const tools = modelTools({ caps: all, includeConfirm: true });
      return sendJson(res, 200, {
        schema: 'capabilities.model-tools.v1',
        count: tools.length,
        // 写类工具会出现在表里，但调用只会得到计划（这条由后端保证，不靠调用方自觉）
        note: 'expose=tool 的能力可以直接调；expose=tool_with_confirm 的调用只返回计划，真执行要用户在应用里确认。',
        tools,
      });
    }
    if (url.pathname === '/api/capabilities/invoke' && method === 'POST') {
      const body = (await readBody(req)) || {};
      const id = String(body.id || '').trim();
      if (!id) return sendError(res, 400, '要调哪条能力（id）');
      // 工具名允许点分写法或下划线别名（两条路都指向同一条能力）—— 能力 id 里不许有下划线，所以不会撞
      const all = await allForModel({ includeDisabled: true });
      const realId = capabilityIdFromToolName(id, all.map((c) => c.id));
      if (!realId) return sendError(res, 404, `没有这个能力：${id}`);
      if (!capabilities || typeof capabilities.invoke !== 'function') return sendError(res, 503, '这台服务器没有接能力宿主，调不了');
      const cap = getCapability(realId) || all.find((c) => c.id === realId) || {};
      const expose = exposeOf(cap);
      if (dataDir && readDisabled(dataDir).includes(realId)) {
        return sendError(res, 403, `能力「${realId}」已被停用 —— 在「能力搭建 → 🛠 开发 · 能力」里可以重新启用`);
      }
      if (expose === 'none') return sendError(res, 403, `能力「${realId}」没有对外开放（model.expose = none）`);
      const t0 = Date.now();
      const r = await capabilities.invoke(realId, body.input || {}, null);
      if (!r || r.ok === false) return sendJson(res, 400, { ok: false, id: realId, error: (r && r.error) || '未知原因' });
      const actions = Array.isArray(r.actions) ? r.actions : [];
      if (actions.length) {
        // 写类：只把"本来会做什么"回给调用方，**绝不在这里执行**（执行要走用户在应用里的确认）
        return sendJson(res, 200, {
          ok: true, id: realId, expose, requires_confirmation: true, ms: Date.now() - t0,
          planned: actions.map((a) => ({ type: a.type, summary: a.summary || '', path: (a.target && a.target.path) || null })),
          note: '这是"计划"，还没有真的执行。要执行请在 Cairn 里确认（或跑对应的功能）。',
        });
      }
      return sendJson(res, 200, { ok: true, id: realId, expose, requires_confirmation: false, ms: Date.now() - t0, output: r.output });
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
