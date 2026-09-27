// 数据源「实例」：同一种类型可以配多条（2026-09-26 用户要求：两个 RSS、两个 IMAP…）。
//
// 关键约定：**实例 id = 类型 id（第一条），第二条起是 `类型@2`、`类型@3`…**
//
// 分隔符为什么是 `@`：实例 id 会出现在**URL 路径**里（`/api/connectors/rss@2/import`），
// 而 `#` 在 URL 里是**片段起点** —— 会被浏览器/URL 解析吃掉，路径里只剩 `rss`，
// 结果"删第二条"变成"删第一条"（2026-09-26 写测试时当场踩到）。`@` 是路径里合法字符，
// 不会被编码、也不会被截断，而且读起来顺（rss @ 第 2 条）。
//
// 为什么这么定：库里 `connector_config.source` 本来就是文本主键，`connector_data.source`
// 也只是普通列 —— 把"实例 id"直接放进去，**不用改表、不用迁移**：
// 老数据（id 就是类型）天然就是"这个类型的第一条实例"。
// 想知道它属于哪种类型，把 `#` 之后切掉即可。
//
// 所以：**凡是拿"用户配置的那个 key"去查连接器定义的地方，都要先过一次 instanceType()**。

export const INSTANCE_SEP = '@';

/** `email@2` → `email`；`email` → `email`。 */
export function instanceType(id) {
  const s = String(id || '');
  const i = s.indexOf(INSTANCE_SEP);
  return i < 0 ? s : s.slice(0, i);
}

/** 这是这个类型的第几条（从 1 开始）。 */
export function instanceOrdinal(id) {
  const s = String(id || '');
  const i = s.indexOf(INSTANCE_SEP);
  if (i < 0) return 1;
  const n = Number(s.slice(i + 1));
  return Number.isFinite(n) && n > 1 ? Math.floor(n) : 1;
}

/** 给这个类型挑一个还没人用的实例 id。 */
export function nextInstanceId(type, used = []) {
  const taken = new Set(used);
  if (!taken.has(type)) return type;
  for (let n = 2; n < 1000; n++) {
    const id = `${type}${INSTANCE_SEP}${n}`;
    if (!taken.has(id)) return id;
  }
  return `${type}${INSTANCE_SEP}${Date.now()}`;
}

/** 列表里第 2 条起加个后缀，免得两行都叫"通用 RSS"分不清。 */
export function instanceSuffix(id) {
  const n = instanceOrdinal(id);
  return n > 1 ? `（第 ${n} 条）` : '';
}

/** 这个类型现在有几条实例。 */
export function instancesOf(type, ids = []) {
  return ids.filter((id) => instanceType(id) === type);
}
