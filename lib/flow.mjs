// flow.mjs —— 「功能 = 能力图」的执行引擎（M2）
//
// 一个**声明式功能**长这样（模块目录里的 flow.json）：
//
//   {
//     "schema": "flow.v1",
//     "nodes": [
//       { "id": "scan",  "capability": "course.scan",      "input": {} },
//       { "id": "read",  "capability": "course.text",      "input": { "courses": "$scan.courses" } },
//       { "id": "index", "capability": "course.artifacts", "input": { "materials": "$read.materials" } },
//       { "id": "save",  "capability": "file.write",       "input": { "path": "$index.path", "text": "$index.markdown" } }
//     ],
//     "edges": [["scan", "read"], ["read", "index"], ["index", "save"]]
//   }
//
// 三条设计约束（都对着"敢让别人拼"这件事）：
//   1) **纯函数**：本文件只做校验 / 排序 / 取值替换，不碰磁盘、不发通知 —— 好测、好审；
//   2) **值只能来自上游**：节点入参里的 `"$节点.路径"` 只能引用**在它之前**执行过的节点（拓扑序），
//      引用不到就报错，而不是塞个 undefined 让下游炸；
//   3) **写类能力照样走 action**：图里的 file.write / notify.app 不直接动手，
//      而是产出一条动作交给老那套执行器（所以 dry-run、审计、权限闸门全都照旧生效）。

export const FLOW_SCHEMA = 'flow.v1';

/** `$input.xxx` 是保留命名空间：指这次运行的入参，不是某个节点的产出。 */
export const INPUT_NS = 'input';

/** 从 `$scan.courses` 里取 `scan` 与 `['courses']`。 */
export function parseRef(ref) {
  const s = String(ref || '').trim();
  if (!s.startsWith('$')) return null;
  const [node, ...rest] = s.slice(1).split('.');
  return { node, path: rest };
}

/** 校验一张图。返回 { ok, errors[] }（人话，直接给界面/命令行显示）。 */
export function validateFlow(spec) {
  const errors = [];
  const s = spec && typeof spec === 'object' ? spec : {};
  if (s.schema && s.schema !== FLOW_SCHEMA) errors.push(`schema 必须是 ${FLOW_SCHEMA}`);
  const nodes = Array.isArray(s.nodes) ? s.nodes : [];
  if (!nodes.length) errors.push('至少要有一个节点');
  const ids = nodes.map((n) => String((n && n.id) || '').trim());
  nodes.forEach((n, i) => {
    if (!n || typeof n !== 'object') { errors.push(`第 ${i + 1} 个节点不是对象`); return; }
    if (!ids[i]) errors.push(`第 ${i + 1} 个节点缺少 id`);
    if (!n.capability) errors.push(`节点 ${ids[i] || i + 1} 缺少 capability`);
    if (n.input !== undefined && (typeof n.input !== 'object' || n.input === null || Array.isArray(n.input))) {
      errors.push(`节点 ${ids[i] || i + 1} 的 input 要是对象`);
    }
  });
  if (new Set(ids.filter(Boolean)).size !== ids.filter(Boolean).length) errors.push('节点 id 不能重复');
  const edges = normalizeEdges(s.edges, errors);
  for (const e of edges) {
    if (!ids.includes(e.from)) errors.push(`连线的起点不存在：${e.from}`);
    if (!ids.includes(e.to)) errors.push(`连线的终点不存在：${e.to}`);
  }
  if (!errors.length && topoOrder({ nodes, edges }).error) errors.push(topoOrder({ nodes, edges }).error);
  // 引用只能指向"在这个节点之前会跑完"的节点
  if (!errors.length) {
    const order = topoOrder({ nodes, edges }).order;
    const pos = new Map(order.map((id, i) => [id, i]));
    for (const n of nodes) {
      for (const ref of refsIn(n.input)) {
        if (ref.node === INPUT_NS) continue;                 // $input.* 是运行入参，不算节点
        if (!pos.has(ref.node)) { errors.push(`节点 ${n.id} 引用了不存在的节点：$${ref.node}`); continue; }
        if (pos.get(ref.node) >= pos.get(n.id)) {
          errors.push(`节点 ${n.id} 引用了"排在它后面（或自己）"的节点 $${ref.node} —— 值只能来自上游`);
        }
      }
    }
  }
  return { ok: errors.length === 0, errors };
}

/** 连线两种写法都收：`["a","b"]` 或 `{from,to}`。 */
export function normalizeEdges(raw, errors = []) {
  const list = Array.isArray(raw) ? raw : [];
  const out = [];
  for (const e of list) {
    if (Array.isArray(e) && e.length === 2) out.push({ from: String(e[0]), to: String(e[1]) });
    else if (e && typeof e === 'object' && e.from && e.to) out.push({ from: String(e.from), to: String(e.to) });
    else errors.push(`连线看不懂：${JSON.stringify(e)}（要 ["起点","终点"] 或 {from,to}）`);
  }
  return out;
}

/** 拓扑排序（Kahn）。有环就返回 error，不抛。 */
export function topoOrder({ nodes = [], edges = [] }) {
  const ids = nodes.map((n) => n.id);
  const indeg = new Map(ids.map((id) => [id, 0]));
  const next = new Map(ids.map((id) => [id, []]));
  for (const e of edges) {
    if (!indeg.has(e.from) || !indeg.has(e.to)) continue;
    indeg.set(e.to, indeg.get(e.to) + 1);
    next.get(e.from).push(e.to);
  }
  const queue = ids.filter((id) => indeg.get(id) === 0);
  const order = [];
  while (queue.length) {
    const id = queue.shift();
    order.push(id);
    for (const to of next.get(id) || []) {
      indeg.set(to, indeg.get(to) - 1);
      if (indeg.get(to) === 0) queue.push(to);
    }
  }
  if (order.length !== ids.length) {
    const stuck = ids.filter((id) => !order.includes(id));
    return { order, error: `图里有环（或连不上）：${stuck.join(' → ')} —— "功能 = 能力图"必须是能从头跑到尾的` };
  }
  return { order, error: null };
}

/** 从 node.input 里挖出所有 `$ref`（递归找字符串与数组）。 */
export function refsIn(input, found = []) {
  if (typeof input === 'string') {
    const r = parseRef(input);
    if (r) found.push(r);
  } else if (Array.isArray(input)) {
    for (const v of input) refsIn(v, found);
  } else if (input && typeof input === 'object') {
    for (const v of Object.values(input)) refsIn(v, found);
  }
  return found;
}

/**
 * 把 `$节点.路径` 换成上游产出。整个字符串就是一个引用时**保留原类型**（数组还是数组），
 * 夹在别的东西里时按字符串拼接。
 */
export function resolveInput(input, outputs = {}) {
  if (typeof input === 'string') {
    const r = parseRef(input);
    if (!r) return input;
    let cur = outputs[r.node];
    for (const seg of r.path) {
      if (cur == null) return undefined;
      cur = cur[seg];
    }
    return cur;
  }
  if (Array.isArray(input)) return input.map((v) => resolveInput(v, outputs));
  if (input && typeof input === 'object') {
    const out = {};
    for (const [k, v] of Object.entries(input)) out[k] = resolveInput(v, outputs);
    return out;
  }
  return input;
}

/**
 * 跑一张图。
 * @param {object} spec flow.json 的内容
 * @param {{invoke:Function, ctx?:object, input?:object, log?:Function}} deps invoke 来自 lib/capabilities/host.mjs
 * @returns {Promise<{ok:boolean, nodes:object[], actions:object[], outputs:object, error?:string, ms:number}>}
 */
export async function runFlow(spec, { invoke, ctx = null, input = {}, log = () => {} } = {}) {
  const t0 = Date.now();
  const check = validateFlow(spec);
  if (!check.ok) return { ok: false, error: `这张图不合法：${check.errors.join('；')}`, nodes: [], actions: [], outputs: {}, ms: 0 };
  if (typeof invoke !== 'function') return { ok: false, error: '没有接能力调用器（invoke）', nodes: [], actions: [], outputs: {}, ms: 0 };

  const { order } = topoOrder(spec);
  const byId = new Map(spec.nodes.map((n) => [n.id, n]));
  const outputs = { [INPUT_NS]: input || {} };            // 节点可以用 $input.xxx 取这次运行的入参
  const nodes = [];
  let actions = [];

  for (const id of order) {
    const node = byId.get(id);
    const input = resolveInput(node.input || {}, outputs);
    const at = Date.now();
    let r;
    try { r = await invoke(node.capability, input, ctx); }
    catch (e) { r = { ok: false, error: (e && e.message) || String(e) }; }
    const ms = Date.now() - at;
    if (!r || r.ok === false) {
      nodes.push({ id, capability: node.capability, ok: false, ms, error: (r && r.error) || '未知原因' });
      log(`[flow] ${id}（${node.capability}）失败：${(r && r.error) || '未知原因'}`);
      return { ok: false, error: `节点 ${id}（${node.capability}）失败：${(r && r.error) || '未知原因'}`, nodes, actions, outputs, ms: Date.now() - t0 };
    }
    outputs[id] = r.output === undefined ? null : r.output;
    if (Array.isArray(r.actions) && r.actions.length) actions = actions.concat(r.actions);
    nodes.push({ id, capability: node.capability, ok: true, ms, has_output: r.output !== undefined, actions: (r.actions || []).length });
    log(`[flow] ${id}（${node.capability}）✓ ${ms}ms${r.actions && r.actions.length ? ` · ${r.actions.length} 条动作` : ''}`);
  }

  return { ok: true, nodes, actions, outputs, ms: Date.now() - t0 };
}

/** 给界面用的一句话摘要。 */
export function summarizeFlow(spec) {
  const nodes = (spec && spec.nodes) || [];
  const caps = [...new Set(nodes.map((n) => n.capability))];
  const writes = nodes.filter((n) => /^(file|notify|push)\./.test(String(n.capability)));
  return `${nodes.length} 个节点 · ${caps.length} 种能力${writes.length ? ` · ${writes.length} 个写动作` : ''}`;
}
