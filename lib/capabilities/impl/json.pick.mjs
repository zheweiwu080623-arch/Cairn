// 能力模块：json.pick —— 从一个对象里按路径取字段（纯计算）。
//
// 典型用法：http.get 拿回一个大 JSON，用 `$get.json` 喂给它，取出自己要的那几个字段，
// 再交给 text.template 拼成一段话。**这三步拼起来就是"接一个新数据源"，不用写代码。**
export const meta = {
  id: 'json.pick',
  name: '从 JSON 里取字段',
  version: '1.0.0',
  kind: 'compute',
  input: {
    type: 'object',
    properties: {
      data: {},
      path: { type: 'string' },
      fields: { type: 'object' },
      fallback: {},
    },
    required: ['data'],
  },
  output: {
    type: 'object',
    properties: { value: {}, out: { type: 'object' }, found: { type: 'boolean' }, missing: { type: 'array' } },
  },
  permissions: [],
  idempotent: true,
  cost: 'none',
  ui: { label: '取 JSON 字段', group: '通用', icon: '📌' },
  model: { description: '当手上已经有一份 JSON 数据、要取出其中某几个字段时用它。路径写成 a.b[0].c。' },
  used_by: ['web-fetch-flow'],
  notes: '路径写成 `a.b[0].c`。给 path 时回 { value, found }；给 fields（{ 名字: 路径 }）时回 { out, missing }。',
};

export const bind = { from: 'none' };

/** 按 `a.b[0].c` 取值；取不到返回 undefined（不抛）。 */
export function pickPath(data, path) {
  const segs = String(path || '').trim().split('.').filter(Boolean);
  let cur = data;
  for (const seg of segs) {
    const m = seg.match(/^([^[\]]*)((\[\d+\])*)$/);
    const name = m ? m[1] : seg;
    if (name) {
      if (cur == null || typeof cur !== 'object') return undefined;
      cur = cur[name];
    }
    const idxs = m ? m[2].match(/\d+/g) : null;
    if (idxs) {
      for (const i of idxs) {
        if (!Array.isArray(cur)) return undefined;
        cur = cur[Number(i)];
      }
    }
  }
  return cur;
}

export async function run(input = {}) {
  const data = input.data;
  const fallback = input.fallback;
  const fields = input.fields && typeof input.fields === 'object' && !Array.isArray(input.fields) ? input.fields : null;
  if (fields) {
    const out = {};
    const missing = [];
    for (const [key, path] of Object.entries(fields)) {
      const v = pickPath(data, path);
      if (v === undefined) { missing.push(key); out[key] = fallback === undefined ? null : fallback; }
      else out[key] = v;
    }
    return { out, missing, found: missing.length === 0 };
  }
  const path = String(input.path || '').trim();
  if (!path) return { value: data, found: data !== undefined, missing: [] };
  const v = pickPath(data, path);
  if (v === undefined) return { value: fallback === undefined ? null : fallback, found: false, missing: [path] };
  return { value: v, found: true, missing: [] };
}
