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
//       { "id": "save",  "capability": "file.write",       "input": { "path": "$index.path", "text": "$index.markdown" } },
//       { "id": "tell",  "capability": "notify.app",       "when": { "ref": "$index.count", "op": "gt", "value": 0 },
//         "input": { "title": "课程资料索引已更新" } }
//     ],
//     "edges": [["scan", "read"], ["read", "index"], ["index", "save"], ["index", "tell"]]
//   }
//
// 三条设计约束（都对着"敢让别人拼"这件事）：
//   1) **纯函数**：本文件只做校验 / 排序 / 取值替换，不碰磁盘、不发通知 —— 好测、好审；
//   2) **值只能来自上游**：节点入参里的 `"$节点.路径"` 只能引用**在它之前**执行过的节点（拓扑序），
//      引用不到就报错，而不是塞个 undefined 让下游炸；
//   3) **写类能力照样走 action**：图里的 file.write / notify.app 不直接动手，
//      而是产出一条动作交给老那套执行器（所以 dry-run、审计、权限闸门全都照旧生效）。
//   4) **条件（2026-10-02 新增）**：节点可以写 `when` —— "如果…就…"。
//      条件不成立的节点**不跑**，并且"上游没跑 ⇒ 下游也不跑"会自动往后传
//      （这样才不用给每一个下游节点都重写一遍条件）。

export const FLOW_SCHEMA = 'flow.v1';

/** `$input.xxx` 是保留命名空间：指这次运行的入参，不是某个节点的产出。 */
export const INPUT_NS = 'input';

/**
 * 句子里的引用（2026-10-02 加）：`${节点.字段}`。
 *
 * 为什么加：`$article.text` 这种"整串就是一个引用"的写法取值没问题，但**拼提示词**时没法用 ——
 * 写模型的提示词永远是"一段话里夹一个变量"（`把下面这段总结成一句：${read.text}`）。
 * 以前只能先插一个 text.template 节点，很别扭。现在字符串里出现 `${…}` 会被就地替换
 * （取不到就是空串）。**旧写法完全不受影响**：没有 `${` 的字符串行为与以前一模一样。
 */
export const INTERP_RE = /\$\{([A-Za-z0-9_]+(?:\.[A-Za-z0-9_]+)*)\}/g;

/// 条件的比较方式。`truthy` 是默认（只写一个 `$节点.路径` 时就是它）。
export const WHEN_OPS = [
  'truthy', 'falsy', 'eq', 'ne', 'gt', 'gte', 'lt', 'lte',
  'contains', 'notContains', 'empty', 'notEmpty', 'matches', 'notMatches',
];

/** 空数组、空字符串、0、null、false 都算"不成立"；对象只要存在就算成立（哪怕是空对象）。 */
export function isTruthy(v) {
  if (v === undefined || v === null || v === false) return false;
  if (v === 0 || v === '') return false;
  if (Array.isArray(v)) return v.length > 0;
  return true;
}

const short = (v) => {
  try {
    const s = typeof v === 'string' ? v : JSON.stringify(v);
    if (s === undefined) return String(v);
    return s.length > 40 ? s.slice(0, 40) + '…' : s;
  } catch { return String(v); }
};

/** 条件里出现的 `$引用`（`ref` 与 `value`）。给"值只能来自上游"的校验用。 */
export function whenRefs(when, found = []) {
  if (typeof when === 'string') {
    const r = parseRef(when);
    if (r) found.push(r);
    return found;
  }
  if (when && typeof when === 'object' && !Array.isArray(when)) {
    if (typeof when.ref === 'string') {
      const r = parseRef(when.ref);
      if (r) found.push(r);
    }
    if (typeof when.value === 'string') {
      const r = parseRef(when.value);
      if (r) found.push(r);
    }
  }
  return found;
}

/**
 * 算一个节点条件（**纯函数**，不跑任何能力）。
 * @returns {{ok:boolean, pass:boolean, reason:string}} ok=false 表示条件本身写错了
 */
export function evalWhen(when, outputs = {}) {
  if (when === undefined || when === null) return { ok: true, pass: true, reason: '' };
  if (typeof when === 'boolean') return { ok: true, pass: when, reason: when ? '' : '条件写死为不成立' };
  if (typeof when === 'string') {
    const v = resolveInput(when, outputs);
    return { ok: true, pass: isTruthy(v), reason: `${when} = ${short(v)}` };
  }
  if (typeof when !== 'object' || Array.isArray(when)) {
    return { ok: false, pass: false, reason: `条件要是一个 $引用、true/false，或 { ref, op, value }，收到 ${JSON.stringify(when)}` };
  }
  const op = String(when.op || 'truthy');
  if (!WHEN_OPS.includes(op)) return { ok: false, pass: false, reason: `不认识的条件 op：${op}（可用：${WHEN_OPS.join(' / ')}）` };
  const left = when.ref === undefined ? undefined : resolveInput(when.ref, outputs);
  const right = when.value === undefined ? undefined : resolveInput(when.value, outputs);
  // 理由里带上引用名（界面与日志要能看出"是哪一条不成立"，只写 "0 gt 0" 太干）
  const label = when.ref !== undefined
    ? `${when.ref}（${short(left)}） ${op} ${short(right)}`
    : `${short(left)} ${op} ${short(right)}`;
  const numOr = (v) => (typeof v === 'number' ? v : (typeof v === 'string' && v.trim() !== '' && Number.isFinite(Number(v)) ? Number(v) : null));
  const cmp = (fn) => {
    const a = numOr(left); const b = numOr(right);
    if (a === null || b === null) return null;
    return fn(a, b);
  };
  const same = (a, b) => (a === b) || (typeof a === typeof b ? false : String(a) === String(b));
  switch (op) {
    case 'truthy': return { ok: true, pass: isTruthy(left), reason: label };
    case 'falsy': return { ok: true, pass: !isTruthy(left), reason: label };
    case 'eq': return { ok: true, pass: same(left, right), reason: label };
    case 'ne': return { ok: true, pass: !same(left, right), reason: label };
    case 'gt': return { ok: true, pass: cmp((a, b) => a > b) === true, reason: label };
    case 'gte': return { ok: true, pass: cmp((a, b) => a >= b) === true, reason: label };
    case 'lt': return { ok: true, pass: cmp((a, b) => a < b) === true, reason: label };
    case 'lte': return { ok: true, pass: cmp((a, b) => a <= b) === true, reason: label };
    case 'contains': {
      const hay = Array.isArray(left) ? left : String(left === undefined || left === null ? '' : left);
      const pass = Array.isArray(hay) ? hay.some((x) => same(x, right)) : hay.includes(String(right === undefined ? '' : right));
      return { ok: true, pass, reason: label };
    }
    case 'notContains': {
      const hay = Array.isArray(left) ? left : String(left === undefined || left === null ? '' : left);
      const pass = Array.isArray(hay) ? !hay.some((x) => same(x, right)) : !hay.includes(String(right === undefined ? '' : right));
      return { ok: true, pass, reason: label };
    }
    case 'empty': return { ok: true, pass: !isTruthy(left), reason: label };
    case 'notEmpty': return { ok: true, pass: isTruthy(left), reason: label };
    case 'matches': case 'notMatches': {
      let re;
      try { re = new RegExp(String(right === undefined ? '' : right)); }
      catch (e) { return { ok: false, pass: false, reason: `value 不是合法正则：${(e && e.message) || e}` }; }
      const hit = re.test(String(left === undefined || left === null ? '' : left));
      return { ok: true, pass: op === 'matches' ? hit : !hit, reason: label };
    }
    default: return { ok: false, pass: false, reason: `不认识的条件 op：${op}` };
  }
}

/** 节点的全部上游引用（入参 + 条件）。 */
export function refsOfNode(node = {}) {
  return [...refsIn(node.input), ...whenRefs(node.when)];
}

/** 从 `$scan.courses` 里取 `scan` 与 `['courses']`。 */
export function parseRef(ref) {
  const s = String(ref || '').trim();
  if (!s.startsWith('$')) return null;
  // `${a.b}` 是"句子里的引用"，不是"整串引用"——交给下面的插值处理（2026-10-02）
  if (s.includes('{') || s.includes('}')) return null;
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
    // 条件（可选）：写成 "$节点.路径" / true|false / { ref, op, value }
    if (n.when !== undefined) {
      const w = n.when;
      const shapeOk = typeof w === 'string' || typeof w === 'boolean'
        || (w && typeof w === 'object' && !Array.isArray(w));
      if (!shapeOk) errors.push(`节点 ${ids[i] || i + 1} 的 when 看不懂（要 $引用 / true|false / {ref, op, value}）`);
      else if (w && typeof w === 'object' && w.op !== undefined && !WHEN_OPS.includes(String(w.op))) {
        errors.push(`节点 ${ids[i] || i + 1} 的 when.op「${w.op}」不认识（可用：${WHEN_OPS.join(' / ')}）`);
      }
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
      for (const ref of refsOfNode(n)) {
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
    // 句子里的 `${节点.字段}` 也算上游引用（不然"引用了排在后面的节点"会漏检）
    INTERP_RE.lastIndex = 0;
    let m;
    while ((m = INTERP_RE.exec(input)) !== null) {
      const inner = parseRef('$' + m[1]);
      if (inner) found.push(inner);
    }
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
    if (r) {
      let cur = outputs[r.node];
      for (const seg of r.path) {
        if (cur == null) return undefined;
        cur = cur[seg];
      }
      return cur;
    }
    // 不是整串引用：看看句子里有没有 `${节点.字段}`，就地替换（取不到给空串）
    if (!input.includes('${')) return input;
    return input.replace(INTERP_RE, (_m, path) => {
      let cur = outputs[String(path).split('.')[0]];
      for (const seg of String(path).split('.').slice(1)) {
        if (cur == null) return '';
        cur = cur[seg];
      }
      if (cur === undefined || cur === null) return '';
      return typeof cur === 'object' ? (() => { try { return JSON.stringify(cur); } catch { return ''; } })() : String(cur);
    });
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
  const skipped = new Map();                              // 节点 id → 为什么没跑（条件不成立 / 上游没跑）

  for (const id of order) {
    const node = byId.get(id);
    // ① 上游被跳过 ⇒ 这一条也跳过（"上游没跑，下游自然不跑"，不用给每个下游都重写条件）
    const deadUpstream = refsIn(node.input || {})
      .filter((r) => r.node !== INPUT_NS && skipped.has(r.node))
      .map((r) => r.node);
    if (deadUpstream.length) {
      const reason = `上游 ${[...new Set(deadUpstream)].join('、')} 没跑`;
      skipped.set(id, reason);
      outputs[id] = null;
      nodes.push({ id, capability: node.capability, ok: true, skipped: true, reason, ms: 0 });
      log(`[flow] ${id}（${node.capability}）⏭ 跳过：${reason}`);
      continue;
    }
    // ② 自己的条件不成立 ⇒ 跳过（并继续往下传）
    if (node.when !== undefined && node.when !== true) {
      const w = evalWhen(node.when, outputs);
      if (!w.ok) {
        nodes.push({ id, capability: node.capability, ok: false, ms: 0, error: `条件写得不对：${w.reason}` });
        log(`[flow] ${id} 的条件不合法：${w.reason}`);
        return { ok: false, error: `节点 ${id} 的条件不合法：${w.reason}`, nodes, actions, outputs, ms: Date.now() - t0 };
      }
      if (!w.pass) {
        skipped.set(id, w.reason || '条件不成立');
        outputs[id] = null;
        nodes.push({ id, capability: node.capability, ok: true, skipped: true, reason: w.reason || '条件不成立', ms: 0 });
        log(`[flow] ${id}（${node.capability}）⏭ 条件不成立：${w.reason}`);
        continue;
      }
    }
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

  return { ok: true, nodes, actions, outputs, skipped: [...skipped.keys()], ms: Date.now() - t0 };
}

/** 给界面用的一句话摘要。 */
export function summarizeFlow(spec) {
  const nodes = (spec && spec.nodes) || [];
  const caps = [...new Set(nodes.map((n) => n.capability))];
  const writes = nodes.filter((n) => /^(file|notify|push)\./.test(String(n.capability)));
  const conds = nodes.filter((n) => n.when !== undefined && n.when !== true).length;
  return `${nodes.length} 个节点 · ${caps.length} 种能力${writes.length ? ` · ${writes.length} 个写动作` : ''}${conds ? ` · ${conds} 个条件` : ''}`;
}
