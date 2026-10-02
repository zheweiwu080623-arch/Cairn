// permissions.mjs —— 「功能要什么权限」的词汇表与展示
//
// 一个再处理功能（processor）在 module.json 里声明三类东西：
//   permissions       能力：能上网吗、能发通知吗、能写文件吗……
//   data.reads/writes 数据面：读哪些、写哪些
//   data.tables       表：要碰哪几张表
//
// 为什么要有这个文件：安装一个别人写的功能时，**最该让用户看清的就是这一张清单**。
// 这里把代号翻成人话（界面 / CLI / 文档都引用同一份），并在"要装的东西"越权时给出提醒。

/** 已知能力的词表：代号 → 人话 + 风险级别（info / warn）。 */
export const PERMISSION_GLOSSARY = {
  'notify:app': { label: '发本机通知', level: 'info' },
  'notify:phone': { label: '推送到手机（短句）', level: 'info' },
  'net:outbound': { label: '访问互联网', level: 'warn' },
  'net:canvas': { label: '只读访问课程平台（Canvas）', level: 'warn' },
  'net:mail': { label: '收发邮件', level: 'warn' },
  'fs:read:data': { label: '读本机数据目录', level: 'info' },
  'fs:write:data': { label: '写本机数据目录', level: 'info' },
  'fs:read:course': { label: '读课程资料文件夹', level: 'warn' },
  'fs:write:course': { label: '写课程资料文件夹', level: 'warn' },
  'data:write:tasks': { label: '在你本机的任务清单里加一条', level: 'info' },
  'exec:shell': { label: '执行本机命令', level: 'warn' },
  'llm:ask': { label: '调用你配置的模型', level: 'warn' },
};

/** 代号 → 人话；不认识的代号如实说"不认识的权限"。 */
export function describePermission(code) {
  const key = String(code || '').trim();
  const hit = PERMISSION_GLOSSARY[key];
  if (hit) return hit;
  return { label: `未登记的能力「${key}」（安装前请弄清它要干什么）`, level: 'warn' };
}

/**
 * 把一个模块描述符折成"权限清单"（给 CLI / 界面显示）。
 * @param {object} descriptor module.json 的内容
 */
export function summarizePermissions(descriptor = {}) {
  const d = descriptor && typeof descriptor === 'object' ? descriptor : {};
  const perms = (Array.isArray(d.permissions) ? d.permissions : []).map((code) => ({ code: String(code), ...describePermission(code) }));
  const data = d.data && typeof d.data === 'object' ? d.data : {};
  const reads = Array.isArray(data.reads) ? data.reads.map(String) : [];
  const writes = Array.isArray(data.writes) ? data.writes.map(String) : [];
  const tables = Array.isArray(data.tables) ? data.tables.map(String) : [];
  const risky = perms.filter((p) => p.level === 'warn').length;
  return {
    kind: d.kind || 'unknown',
    permissions: perms,
    reads, writes, tables,
    risky,
    // 一句话总结（CLI 里直接打印）
    line: perms.length
      ? `${perms.length} 项能力${risky ? `（其中 ${risky} 项需要留意）` : ''}`
      : '没有声明任何特殊能力',
  };
}

/** 人类可读的多行清单（CLI 与文档共用）。 */
export function formatPermissions(descriptor = {}) {
  const s = summarizePermissions(descriptor);
  const L = [];
  L.push(`权限清单（${s.line}）`);
  for (const p of s.permissions) L.push(`  · ${p.code} —— ${p.label}${p.level === 'warn' ? ' ⚠️' : ''}`);
  if (s.reads.length) L.push(`  读数据：${s.reads.join(', ')}`);
  if (s.writes.length) L.push(`  写数据：${s.writes.join(', ')}`);
  if (s.tables.length) L.push(`  涉及表：${s.tables.join(', ')}`);
  return L.join('\n');
}

/**
 * 把"这个功能会碰什么"折成**一句人话**（2026-10-02 · 台阶 B）。
 *
 * 为什么要单独一句：安装预览 / 启用开关那里，用户最想知道的是
 * "**它会读我什么、会不会写、数据去哪**" —— 权限词表（`fs:write:data`）回答不了这个问题。
 * `module.json` 里写了 `privacy` 就以它为准（人写的更准），没写就按权限与数据面自动生成一句。
 *
 * @param {object} descriptor module.json
 * @param {object[]} caps 这个功能声明的能力（没有就传空数组）
 */
export function describePrivacy(descriptor = {}, caps = []) {
  const d = descriptor && typeof descriptor === 'object' ? descriptor : {};
  if (typeof d.privacy === 'string' && d.privacy.trim()) return d.privacy.trim();
  const own = Array.isArray(d.permissions) ? d.permissions.map(String) : [];
  const fromCaps = (Array.isArray(caps) ? caps : []).flatMap((c) => (c && Array.isArray(c.permissions) ? c.permissions.map(String) : []));
  const perms = [...new Set([...own, ...fromCaps])].map((p) => describePermission(p).label);
  const data = d.data && typeof d.data === 'object' ? d.data : {};
  const list = (v) => (Array.isArray(v) ? v.map(String).filter(Boolean) : []);
  const bits = [];
  if (perms.length) bits.push(`要${perms.join('、')}`);
  if (list(data.reads).length) bits.push(`读 ${list(data.reads).join('、')}`);
  if (list(data.writes).length) bits.push(`写 ${list(data.writes).join('、')}`);
  if (list(data.tables).length) bits.push(`动表 ${list(data.tables).join('、')}`);
  if (!bits.length) return '不碰网络、不写你的数据（纯本地计算）。';
  return `这个功能会：${bits.join('；')}。`;
}

/**
 * 把「这个功能要用哪些能力」折成清单（M1 · S6）。
 *
 * 为什么要单独一条：能力比权限码更能说明"它要干什么"（权限是 `fs:write:data`，
 * 能力是"写产物文件 / 出课程巩固包"）。安装与列模块时两条一起给，用户才看得懂。
 *
 * 注意：能力描述符由调用方传进来（`lib/capabilities/index.mjs` 会反向 import 本文件，
 * 这里再 import 回去就成了循环依赖）—— 所以本函数只认数据，不认登记表。
 *
 * @param {object} descriptor module.json
 * @param {object[]} caps 已解析的能力描述符数组（没有的会进 `missing`，如实报出来）
 */
export function summarizeCapabilityUse(descriptor = {}, caps = []) {
  const list = (Array.isArray(caps) ? caps : []).filter(Boolean).map((c) => ({
    id: c.id,
    name: c.name,
    kind: c.kind,
    idempotent: c.idempotent,
    permissions: Array.isArray(c.permissions) ? c.permissions.map(String) : [],
    risky: (Array.isArray(c.permissions) ? c.permissions : []).some((p) => describePermission(p).level === 'warn'),
  }));
  const declared = descriptor && descriptor.requires && Array.isArray(descriptor.requires.capabilities)
    ? descriptor.requires.capabilities.map(String)
    : [];
  const missing = declared.filter((id) => !list.some((c) => c.id === id));
  const permissions = [...new Set(list.flatMap((c) => c.permissions))];
  const risky = list.filter((c) => c.risky).length;
  return {
    capabilities: list,
    missing,
    permissions,
    count: list.length,
    risky,
    line: list.length
      ? `${list.length} 项能力${risky ? `（其中 ${risky} 项碰磁盘或网络）` : ''}`
      : (declared.length ? '声明的能力都不在登记表里' : '没有声明任何能力'),
  };
}

/** 人话的能力清单（CLI 的 `mod list --permissions`、安装预览、打包提示共用）。 */
export function formatCapabilityUse(descriptor = {}, caps = []) {
  const s = summarizeCapabilityUse(descriptor, caps);
  const L = [`能力清单（${s.line}）`];
  for (const c of s.capabilities) {
    const perm = c.permissions.length ? `　授权：${c.permissions.join(', ')}` : '';
    const replay = c.idempotent ? '' : '　⚠️ 不能重放';
    L.push(`  · ${c.id} —— ${c.name}${perm}${replay}`);
  }
  if (s.missing.length) L.push(`  ⚠️ 这些能力不在登记表里：${s.missing.join(', ')}（拼错了？看 cairn cap list）`);
  return L.join('\n');
}
