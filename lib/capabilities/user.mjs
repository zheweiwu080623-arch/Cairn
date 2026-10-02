// capabilities/user.mjs —— **开发者自己的能力**（放在 <数据目录>/capabilities/ 下的单文件）。
//
// 用户 2026-09-26 的判据（原话）：「如果说新增能力意味着改动平台内核的话，说明平台本身的模块化不够强、
// 自由度不够高（如果我的理解正确的话），我预期的情况是新增能力开发者会新写一段程序实现数据的处理，
// 处于单立的能力文件夹中，不需要改动内核，不需要改动主程序」。
//
// 这个理解是对的，所以这里就是那个"单立的能力文件夹"：
//   * 一条能力 = 一个 .mjs 文件，导出 `meta`（描述）与 `run(input, ctx)`（干活）；
//   * **或者** = 一个 .json 文件：`meta` + `flow`（一张能力图）—— 2026-10-02 加的
//     「复合能力」：**一行 JS 都不写，把已有能力拼成一条新能力**（用户当场提的台阶 1）；
//   * 放在**数据目录**里（不在仓库里，不进版本控制，卸载就走）；
//   * 平台启动/请求时扫描它、校验它、登记它 —— **内核与主程序一行都不用改**；
//   * 写好的能力会出现在 `GET /api/capabilities` 与「能力搭建」的素材栏里，可以像自带能力一样被拼进功能。
//
// 安全边界（写在这里，也让界面能如实告诉开发者）：
//   * 能力的 `permissions` 必须能在 lib/permissions.mjs 的词表里查到（拼错会被拒收）；
//   * 不允许覆盖平台自带能力的 id（避免"偷偷换掉别人依赖的能力"）；
//   * 复合能力不许直接或间接调用它自己（否则一个文件就能把机器转死）；
//   * 校验失败的能力会被**如实列出来**（带错误原因），而不是静默丢掉。

import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve, sep } from 'node:path';
import { pathToFileURL } from 'node:url';

import { CAPABILITIES, validateCapability } from './index.mjs';
import { runFlow, summarizeFlow, validateFlow } from '../flow.mjs';

export const USER_CAP_DIR = 'capabilities';
/** 停用清单的文件名（放在同一个目录里，但**不是**一条能力 —— 以 `_` 开头，扫描时会跳过）。 */
export const DISABLED_FILE = '_disabled.json';
const ID_RE = /^[a-z][a-zA-Z0-9]*(\.[a-z][a-zA-Z0-9]*)+$/;

/**
 * 「本机版停用/隔离」（2026-10-02 · 台阶 D）：把某条能力关掉。
 *
 * 为什么不做成远端黑名单：Cairn 是本地优先、没有账号的 —— 远端开关既没必要，也违背它的定位。
 * 但**本地要能一键隔离**：坏掉的能力、或你暂时不想让它出现在素材栏的能力，
 * 停用后就不进工具表、图执行与直接调用都会明确报"已停用"（而不是静默不跑）。
 */
export function disabledPath(dataDir) { return join(userCapDir(dataDir), DISABLED_FILE); }

/** 读出停用清单（读不到就是空的；坏文件不会让能力层起不来）。 */
export function readDisabled(dataDir) {
  try {
    const j = JSON.parse(readFileSync(disabledPath(dataDir), 'utf8'));
    return Array.isArray(j && j.ids) ? j.ids.map(String) : [];
  } catch { return []; }
}

/** 写停用清单（覆盖写；返回回读到的清单）。 */
export function setDisabled(dataDir, ids = []) {
  const clean = [...new Set((Array.isArray(ids) ? ids : []).map((s) => String(s || '').trim()).filter(Boolean))];
  mkdirSync(userCapDir(dataDir), { recursive: true });
  writeFileSync(disabledPath(dataDir), JSON.stringify({
    schema: 'capabilities.disabled.v1',
    note: '被停用的能力：不进素材栏 / 不进工具表 / 调用会被明确拒绝。删掉这个文件等于全部启用。',
    updated_at: new Date().toISOString(),
    ids: clean,
  }, null, 2) + '\n', 'utf8');
  return readDisabled(dataDir);
}

export function userCapDir(dataDir) {
  return join(String(dataDir || ''), USER_CAP_DIR);
}

/** 一个能力文件的路径（顺便防目录穿越：id 只允许点分小写）。 */
export function userCapPath(dataDir, id) {
  return userCapPathExt(dataDir, id, '.mjs');
}

/** 同上，但可以指定扩展名（.mjs = 手写能力 / .json = 复合能力）。 */
export function userCapPathExt(dataDir, id, ext = '.mjs') {
  const key = String(id || '').trim();
  if (!ID_RE.test(key)) return null;
  const root = resolve(userCapDir(dataDir));
  const rel = key + ext;
  const full = resolve(join(root, rel));
  if (full !== join(root, rel) || !full.startsWith(root + sep)) return null;
  return full;
}

/** 模板：给界面的"新建能力"用（也方便人照着写）。 */
export function capabilityTemplate(id = 'demo.upper', name = '把文字转成大写') {
  return `// 一条能力 = 一个文件。导出 meta（描述）与 run（干活）。
export const meta = {
  id: '${id}',            // 点分「域.动作」；不能和平台自带的重名
  name: '${name}',
  kind: 'compute',             // read | compute | write | outbound
  permissions: [],             // 要动磁盘/网络才需要，例如 ['fs:read:data']
  idempotent: true,
  cost: 'none',
  ui: { label: '${name}', group: '自写' },
};

export async function run(input = {}) {
  return { upper: String(input.text || '').toUpperCase() };
}

`;
}

/** 模板：给界面的"拼一条能力"用（一张最小的图：取网址 → 取字段 → 拼一段话）。 */
export function compositeTemplate(id = 'demo.headline', name = '把接口的头条拼成一句话') {
  return {
    schema: 'capability.v1',
    id,
    name,
    version: '1.0.0',
    kind: 'compute',
    permissions: [],
    idempotent: true,
    cost: 'none',
    ui: { label: name, group: '自写', icon: '🧩' },
    notes: '由「能力搭建」拼出来的复合能力：一行 JS 都没有，只是把已有能力连成一张小图。',
    flow: {
      schema: 'flow.v1',
      nodes: [
        { id: 'get', capability: 'http.get', input: { url: '$input.url' } },
        { id: 'pick', capability: 'json.pick', input: { data: '$get.json', path: 'title' } },
        { id: 'line', capability: 'text.template', input: { template: '头条：{{value}}', data: '$pick' } },
      ],
      edges: [['get', 'pick'], ['pick', 'line']],
      out: 'line',
    },
  };
}

/** 一个复合能力引用的其它能力 id（去重、保序）。 */
export function flowCapabilities(spec) {
  const ids = ((spec && spec.flow && spec.flow.nodes) || []).map((n) => String((n && n.capability) || '').trim()).filter(Boolean);
  return [...new Set(ids)];
}

/**
 * 校验一条复合能力（**纯函数**，不碰磁盘）：
 * 形状走 capability.v1，图走 flow.v1，另外加三条"复合"才有的规矩。
 * @param {object} spec 文件内容
 * @param {{id?:string, known?:string[], permissionsOf?:Function}} opts
 *        known：这次扫描里已知的全部能力 id（自带 + 别的自写）；permissionsOf(id) → 该能力的权限数组
 */
export function validateComposite(spec, { id = '', known = null, permissionsOf = null } = {}) {
  const errors = [];
  const d = spec && typeof spec === 'object' ? spec : {};
  const own = String(d.id || '').trim();
  const fileId = String(id || '').trim();
  // 手写 JSON 时这几样可以省（写错了类型照样拦得住：`||` 只兜"没写"，不兜"写错"）
  const v = validateCapability({
    ...d,
    schema: 'capability.v1',
    version: d.version || '1.0.0',
    kind: d.kind || 'compute',
    cost: d.cost || 'none',
    idempotent: d.idempotent === undefined ? true : d.idempotent,
    permissions: d.permissions === undefined ? [] : d.permissions,   // 权限本来就由引用推导，可以不手写
  });
  if (!v.ok) errors.push(...v.errors);
  if (fileId && own && own !== fileId) errors.push(`meta.id（${own}）要和文件名（${fileId}）一致`);
  if (CAPABILITIES.some((c) => c.id === own)) errors.push(`id「${own}」和平台自带的能力重名了，换一个`);
  if (!d.flow || typeof d.flow !== 'object' || Array.isArray(d.flow)) {
    errors.push('复合能力要有 flow（一张 { nodes, edges } 的图）');
  } else {
    const fv = validateFlow({ schema: 'flow.v1', ...d.flow });
    if (!fv.ok) errors.push(...fv.errors.map((e) => `图：${e}`));
  }
  const used = flowCapabilities(d);
  if (!used.length && d.flow) errors.push('图里至少要用到一条能力');
  if (own && used.includes(own)) errors.push('一条能力不能（直接）调用它自己 —— 会转不出来');
  if (known) {
    const unknown = used.filter((cid) => !known.includes(cid));
    if (unknown.length) errors.push(`图里用了不存在的能力：${unknown.join('、')}`);
  } else if (permissionsOf) {
    const unknown = used.filter((cid) => !permissionsOf(cid));
    if (unknown.length) errors.push(`图里用了不存在的能力：${unknown.join('、')}`);
  }
  // 产出节点：默认最后一个跑完的节点；写了就必须是图里真有的节点
  const outRef = d.flow && d.flow.out;
  if (outRef !== undefined) {
    const ids = ((d.flow && d.flow.nodes) || []).map((n) => String(n && n.id));
    if (!ids.includes(String(outRef))) errors.push(`flow.out 指向的节点不存在：${outRef}`);
  }
  return { ok: errors.length === 0, errors, used };
}

/** 复合能力用到的权限（从它引用的能力推出来，人不用手写）。 */
function permissionsOfFlow(spec, lookup) {
  const perms = new Set();
  for (const cid of flowCapabilities(spec)) {
    const list = lookup(cid);
    for (const p of Array.isArray(list) ? list : []) perms.add(String(p));
  }
  return [...perms];
}

/** 复合能力最终登记的形状：permissions 一律从图里推导，不靠人写。 */
export function normalizeComposite(spec, { id, name = '', kind = '', lookup = () => [] } = {}) {
  const derived = permissionsOfFlow(spec, lookup);
  const declared = Array.isArray(spec.permissions) ? spec.permissions.map(String) : [];
  const permissions = [...new Set([...derived, ...declared])];
  return {
    schema: 'capability.v1',
    id,
    name: name || spec.name || id,
    version: spec.version || '1.0.0',
    kind: kind || spec.kind || 'compute',
    permissions,
    idempotent: spec.idempotent !== false,
    cost: spec.cost || 'none',
    ui: { label: (spec.ui && spec.ui.label) || name || spec.name || id, group: (spec.ui && spec.ui.group) || '自写', icon: (spec.ui && spec.ui.icon) || '🧩' },
    notes: spec.notes || `复合能力：${summarizeFlow({ nodes: spec.flow.nodes, edges: spec.flow.edges })}`,
    // 给模型看的那一面：拼出来的能力默认沿用它的 notes 当"什么时候用我"；
    // 想细分就在文件里写 model: { description, expose }（不写 expose 就按 kind 推）。
    model: (spec.model && typeof spec.model === 'object')
      ? { ...spec.model }
      : { description: spec.notes || `${name || spec.name || id}：由别的能力拼出来的一条能力` },
    flow: { schema: 'flow.v1', ...spec.flow },
    source: 'user',
    composite: true,
  };
}

/**
 * 扫一遍用户能力目录，逐条校验（坏的要带 error 报出来，不静默丢）。
 *
 * 分两遍走：先把文件都读进来，再拿"自带 + 所有自写"的 id 全集去校验复合能力 ——
 * 否则 A 引用了 B、而 B 排在 A 后面时，A 会被误判成"用了不存在的能力"。
 */
export async function scanUserCapabilities(dataDir) {
  const dir = userCapDir(dataDir);
  if (!existsSync(dir)) return [];
  let names = [];
  // `_` 开头的不是能力（例如 `_disabled.json` 是停用清单），跳过
  try { names = readdirSync(dir).filter((n) => (n.endsWith('.mjs') || n.endsWith('.json')) && !n.startsWith('_')).sort(); } catch { return []; }
  const entries = [];
  for (const name of names) {
    const file = join(dir, name);
    if (name.endsWith('.json')) {
      let spec = null; let error = '';
      try { spec = JSON.parse(readFileSync(file, 'utf8')); }
      catch (e) { error = `读不出这个 JSON：${(e && e.message) || e}`; }
      entries.push({ file, name, spec, error, composite: true });
      continue;
    }
    let meta = null;
    let run = null;
    let error = '';
    try {
      const mod = await import(pathToFileURL(file).href + '?t=' + Date.now());
      meta = mod.meta || null;
      run = typeof mod.run === 'function' ? mod.run : null;
    } catch (e) { error = `加载失败：${(e && e.message) || e}`; }
    if (!error && !meta) error = '文件里没有导出 meta';
    if (!error && !run) error = '文件里没有导出 run(input, ctx)';
    entries.push({ file, name, meta, run, error, composite: false });
  }

  // 已知能力全集（自带 + 自写里"至少 id 是合法的"那些），给复合能力校验用
  const known = new Map(CAPABILITIES.map((c) => [c.id, c]));
  for (const e of entries) {
    const id = (e.spec && e.spec.id) || (e.meta && e.meta.id) || '';
    if (id && !e.error) known.set(id, { id, permissions: (e.spec || e.meta).permissions || [] });
  }
  const permissionsOf = (cid) => (known.get(cid) ? known.get(cid).permissions : null);

  const out = [];
  const seenIds = new Map();
  for (const e of entries) {
    const baseId = e.composite ? (e.spec && e.spec.id) : (e.meta && e.meta.id);
    const id = String(baseId || e.name.replace(/\.(mjs|json)$/, ''));
    let error = e.error || '';
    let meta = e.meta || e.spec || null;
    if (!error) {
      if (CAPABILITIES.some((c) => c.id === id)) error = `id「${id}」和平台自带的能力重名了，换一个`;
      else if (seenIds.has(id)) {
        error = `id「${id}」和 ${seenIds.get(id)} 撞了（两条自写能力不能同名）`;
        const prev = out.find((o) => o.id === id);
        if (prev) prev.error = prev.error || error;
      } else seenIds.set(id, e.name);
    }
    if (!error && e.composite) {
      const v = validateComposite({ ...e.spec, id }, { id, known: [...known.keys()], permissionsOf });
      if (!v.ok) error = v.errors.join('；');
      else meta = normalizeComposite(e.spec, { id, lookup: permissionsOf });
    } else if (!error) {
      const v = validateCapability({ ...e.meta, schema: 'capability.v1', version: e.meta.version || '1.0.0' });
      if (!v.ok) error = v.errors.join('；');
    }
    out.push({
      file: e.name, id,
      name: (meta && meta.name) || '',
      kind: (meta && meta.kind) || '',
      error, meta, run: e.run || null,
      composite: !!e.composite,
      flow: e.composite && e.spec ? { schema: 'flow.v1', ...(e.spec.flow || {}) } : null,
    });
  }
  return out;
}

/** 只取"好的"那些（给注册表/接口用）。 */
export async function loadUserCapabilities(dataDir) {
  const all = await scanUserCapabilities(dataDir);
  return all.filter((c) => !c.error);
}

/** 保存一条能力（写好文件 → 立刻回读校验，保证"注册"这一步是真的过了校验）。 */
export async function saveUserCapability(dataDir, { id, code, name = '', kind = 'compute' }) {
  const file = userCapPath(dataDir, id);
  if (!file) return { ok: false, error: '能力 id 只能是小写字母/数字 + 点，例如 demo.upper' };
  if (CAPABILITIES.some((c) => c.id === id)) return { ok: false, error: `id「${id}」和平台自带的能力重名了` };
  const text = String(code || '').trim();
  if (!text) return { ok: false, error: '代码是空的' };
  if (!/export\s+const\s+meta/.test(text)) return { ok: false, error: '代码里要有 export const meta = {…}' };
  if (!/export\s+(async\s+)?function\s+run|export\s+const\s+run/.test(text)) return { ok: false, error: '代码里要有 export function run(input, ctx)' };
  try {
    mkdirSync(userCapDir(dataDir), { recursive: true });
    writeFileSync(file, text.endsWith('\n') ? text : text + '\n', 'utf8');
  } catch (e) { return { ok: false, error: `写不进去：${(e && e.message) || e}` }; }
  const all = await scanUserCapabilities(dataDir);
  const mine = all.find((c) => c.file === `${id}.mjs`);
  const fail = (why) => {
    // 没通过校验的**不留在盘上**（否则能力清单里会一直挂一条坏条目，用户还得自己去删文件）
    try { rmSync(file, { force: true }); } catch { /* 删不掉就留着，扫描时会带着 error 报出来 */ }
    return { ok: false, error: why };
  };
  if (!mine || mine.error) return fail(`没通过校验：${mine ? mine.error : '读不回来'}`);
  if (mine.meta.id !== id) return fail(`meta.id（${mine.meta.id}）要和文件名（${id}）一致`);
  return { ok: true, id, name: mine.name, kind: mine.kind, file };
}

/**
 * 保存一条**复合能力**（把一张能力图存成 `capabilities/<id>.json`）。
 * 与 `saveUserCapability` 一样：先写文件，再整体回读校验，没过就把半成品删掉。
 */
export async function saveUserCapabilityFlow(dataDir, { id, name = '', kind = '', spec = {} } = {}) {
  const file = userCapPathExt(dataDir, id, '.json');
  if (!file) return { ok: false, error: '能力 id 只能是小写字母/数字 + 点，例如 demo.headline' };
  if (CAPABILITIES.some((c) => c.id === id)) return { ok: false, error: `id「${id}」和平台自带的能力重名了` };
  const before = await scanUserCapabilities(dataDir);
  const clash = before.find((c) => c.id === id && c.file !== `${id}.json`);
  if (clash) return { ok: false, error: `已经有一条叫「${id}」的能力了（${clash.file}）` };
  const lookup = (cid) => {
    const b = CAPABILITIES.find((c) => c.id === cid);
    if (b) return b.permissions || [];
    const u = before.find((c) => c.id === cid && !c.error);
    return u ? (u.meta && u.meta.permissions) || [] : null;
  };
  const body = normalizeComposite(
    { ...spec, flow: spec.flow || { schema: 'flow.v1', nodes: [], edges: [] } },
    { id, name, kind, lookup },
  );
  const v = validateComposite(body, { id, permissionsOf: lookup });
  if (!v.ok) return { ok: false, error: v.errors.join('；') };
  try {
    mkdirSync(userCapDir(dataDir), { recursive: true });
    writeFileSync(file, JSON.stringify(body, null, 2) + '\n', 'utf8');
  } catch (e) { return { ok: false, error: `写不进去：${(e && e.message) || e}` }; }
  const all = await scanUserCapabilities(dataDir);
  const mine = all.find((c) => c.file === `${id}.json`);
  const fail = (why) => {
    try { rmSync(file, { force: true }); } catch { /* 删不掉就留着，扫描时会带着 error 报出来 */ }
    return { ok: false, error: why };
  };
  if (!mine || mine.error) return fail(`没通过校验：${mine ? mine.error : '读不回来'}`);
  return { ok: true, id, name: mine.name, kind: mine.kind, file, permissions: (mine.meta && mine.meta.permissions) || [], capabilities: v.used };
}

/**
 * 拿一条用户能力来跑（试跑与图执行都走这里）。
 * @param {{invoke?:Function}} [opts] 复合能力要靠它调别的能力（宿主在 lib/capabilities/host.mjs）
 */
export async function runUserCapability(dataDir, id, input = {}, ctx = {}, opts = {}) {
  const all = await scanUserCapabilities(dataDir);
  const hit = all.find((c) => (c.meta && c.meta.id === id) || c.id === id);
  if (!hit) return { ok: false, error: `没有这条自写能力：${id}` };
  if (hit.error) return { ok: false, error: hit.error };
  if (hit.composite) {
    const invoke = opts && opts.invoke;
    if (typeof invoke !== 'function') return { ok: false, error: `「${id}」是复合能力，需要一个能力调用器（invoke）才能跑` };
    const spec = hit.flow;
    const r = await runFlow(spec, {
      invoke: (cid, ci, c) => invoke(cid, ci, c || ctx || {}),
      ctx: ctx || {},
      input,
      log: (ctx && typeof ctx.log === 'function') ? ctx.log : () => {},
    });
    if (!r.ok) return { ok: false, error: `复合能力「${id}」没跑通：${r.error}` };
    const order = r.nodes.filter((n) => !n.skipped).map((n) => n.id);
    const outId = spec.out !== undefined ? String(spec.out) : order[order.length - 1];
    const output = outId === undefined ? {} : r.outputs[outId];
    return { ok: true, output, actions: r.actions, nodes: r.nodes, skipped: r.skipped || [] };
  }
  try {
    const output = await hit.run(input, ctx);
    return { ok: true, output };
  } catch (e) {
    return { ok: false, error: `能力「${id}」跑出错：${(e && e.message) || e}` };
  }
}

/** 给接口用的展示形状（不含 is run，避免把函数塞进 JSON）。 */
export function userCapabilityView(cap) {
  return {
    id: cap.id,
    name: cap.name,
    kind: cap.kind,
    file: cap.file,
    error: cap.error || '',
    permissions: (cap.meta && cap.meta.permissions) || [],
    idempotent: cap.meta ? cap.meta.idempotent : undefined,
    cost: cap.meta ? cap.meta.cost : undefined,
    ui: (cap.meta && cap.meta.ui) || null,
    composite: !!cap.composite,
    capabilities: cap.composite ? flowCapabilities({ flow: cap.flow }) : [],
    summary: cap.composite ? summarizeFlow(cap.flow || {}) : '',
    notes: (cap.meta && cap.meta.notes) || '',
    source: 'user',
  };
}
