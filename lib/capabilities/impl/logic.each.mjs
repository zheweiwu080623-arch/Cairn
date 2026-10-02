// 能力模块：logic.each —— 对一个列表里的每一条，都跑一次另一条能力（控制类）。
//
// 为什么要它：图上原来只能"从头跑到尾"，遇到"有几条课就处理几条"就必须写代码。
// 有了它，"对每一份新材料都套一次模板并记一笔"就是连线。
//
// 三个边界：
//   * **只调能力，不调子图**（要保持能看清它到底干了什么）；
//   * **不许调自己**（否则一个图就能把自己转死）；
//   * **条数有上限**（默认 200，防着"一取回来一万条"把机器拖住）。
export const meta = {
  id: 'logic.each',
  name: '对每一条都做一次',
  version: '1.0.0',
  kind: 'compute',
  input: {
    type: 'object',
    properties: {
      items: { type: 'array' },
      capability: { type: 'string' },
      input: { type: 'object' },
      max: { type: 'number' },
      stop_on_error: { type: 'boolean' },
    },
    required: ['items', 'capability'],
  },
  output: { type: 'object', properties: { items: { type: 'array' }, count: { type: 'number' }, errors: { type: 'array' } } },
  permissions: [],
  idempotent: false,
  cost: 'none',
  ui: { label: '逐条处理', group: '通用', icon: '🔁' },
  model: {
    description: '当要对一个列表逐条做同一件事（逐条通知、逐条写文件）时用它。它是"拼图里的循环"，由功能调用，不直接当工具给模型。',
    expose: 'none',
  },
  notes: 'input 里写 `$item` / `$item.字段` / `$index`，会在每一条上换成当条的值。'
    + '被调的能力如果是写类（发通知/写文件），它产出的动作会照常汇总上去 —— dry-run 依然只演练。',
};

export const bind = { from: 'none' };

/**
 * 把 `$item` / `$item.x` / `$index` 换成当条的值（整个字符串是一个引用时保留原类型）。
 *
 * 路径是"能对上多长就对多长，对不上就退回来"：
 * 写 `file-$item.title.md` 时，`title.md` 取不到、`title` 取得到 ⇒ 就按 `title` 换，
 * 后面的 `.md` 原样留着。不这么退，正常写文件路径就会被路径规则吃掉。
 */
export function bindItem(value, item, index) {
  if (typeof value === 'string') {
    if (value === '$item') return item;
    if (value === '$index') return index;
    if (value.startsWith('$item.')) {
      let cur = item;
      for (const seg of value.slice(6).split('.')) {
        if (cur == null || typeof cur !== 'object') return undefined;
        cur = cur[seg];
      }
      return cur;
    }
    const withIndex = value.replace(/\$index\b/g, String(index));
    const re = /\$item\.([a-zA-Z0-9_]+(?:\.[a-zA-Z0-9_]+)*)/g;
    let out = '';
    let last = 0;
    let m;
    while ((m = re.exec(withIndex)) !== null) {
      const segs = m[1].split('.');
      let cur = item;
      let used = 0;
      for (let k = 0; k < segs.length; k += 1) {
        if (cur == null || typeof cur !== 'object' || !(segs[k] in cur)) break;
        cur = cur[segs[k]];
        used = k + 1;
      }
      if (used === 0) continue;                       // 一段都对不上 ⇒ 原样留着，不乱换
      out += withIndex.slice(last, m.index) + (cur === undefined || cur === null ? '' : String(cur));
      last = m.index + ('$item.' + segs.slice(0, used).join('.')).length;
      re.lastIndex = last;                            // 没用上的那几段还回去，继续往后找
    }
    return out + withIndex.slice(last);
  }
  if (Array.isArray(value)) return value.map((v) => bindItem(v, item, index));
  if (value && typeof value === 'object') {
    const out = {};
    for (const [k, v] of Object.entries(value)) out[k] = bindItem(v, item, index);
    return out;
  }
  return value;
}

export async function run(input = {}, ctx = {}) {
  const items = Array.isArray(input.items) ? input.items : [];
  const capability = String(input.capability || '').trim();
  if (!capability) return { items: [], count: 0, errors: [{ index: -1, error: '没有说要对每一条做什么（capability）' }] };
  if (capability === meta.id) return { items: [], count: 0, errors: [{ index: -1, error: 'logic.each 不能调用它自己' }] };
  if (typeof ctx.invoke !== 'function') {
    return { items: [], count: 0, errors: [{ index: -1, error: '这个运行环境没有接能力调用器（ctx.invoke）' }] };
  }
  const max = Math.max(1, Math.min(Number(input.max) || 200, 1000));
  const stopOnError = input.stop_on_error === true;
  const template = input.input && typeof input.input === 'object' ? input.input : {};
  const outputs = [];
  const errors = [];
  const actions = [];
  for (let i = 0; i < Math.min(items.length, max); i += 1) {
    const one = bindItem(template, items[i], i);
    let r;
    try { r = await ctx.invoke(capability, one, ctx); }
    catch (e) { r = { ok: false, error: (e && e.message) || String(e) }; }
    if (r && Array.isArray(r.actions) && r.actions.length) actions.push(...r.actions);
    if (!r || r.ok === false) {
      errors.push({ index: i, error: (r && r.error) || '未知原因' });
      if (stopOnError) break;
      continue;
    }
    outputs.push(r.output === undefined ? null : r.output);
  }
  if (items.length > max) errors.push({ index: -1, error: `只处理了前 ${max} 条（这一轮的上限）` });
  const out = { items: outputs, count: outputs.length, errors };
  return actions.length ? { ...out, actions } : out;
}
