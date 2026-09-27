// capabilities/index.mjs —— 能力注册表（**自动发现**版，2026-09-26 拆分）
//
// 用户的要求：「新增能力开发者会新写一段程序实现数据的处理，处于单立的能力文件夹中，
// 不需要改动内核，不需要改动主程序」。所以这里不再手写登记表：
//
//   一条能力 = `lib/capabilities/impl/<域>.<动作>.mjs` 一个文件，导出三样东西：
//     meta  —— 身份证（id / name / kind / input / output / permissions / idempotent / cost / ui / notes）
//     bind  —— 装到哪：{ from: 'preclass'|'course'|'executors', ctx: [...] } 或 { executor: 'notify' }
//     run   —— 干什么：run(input, ctx) → 产出（写类返回 { actions: [...] }）
//
// 这个文件只做三件事：**扫目录、逐个 import、把 helper 提供出去**。
// 想加能力？加一个文件；想改能力？改那一个文件；内核（server.mjs / routes）一行都不用动。
// 开发者自己写的能力放在**数据目录**的 capabilities/ 下（见 user.mjs），走同一套形状。

import { readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { PERMISSION_GLOSSARY } from '../permissions.mjs';

export const CAPABILITY_SCHEMA = 'capability.v1';
export const CAPABILITY_KINDS = ['read', 'compute', 'write', 'outbound'];
export const CAPABILITY_COSTS = ['none', 'tokens', 'money'];
export const IMPL_DIR = join(dirname(fileURLToPath(import.meta.url)), 'impl');

export const KIND_LABELS = {
  read: '只读（磁盘或网络）',
  compute: '纯计算（没有副作用）',
  write: '写本机（文件 / 库 / 通知）',
  outbound: '对外发送（邮件 / 手机 / 外部接口）',
};
export const COST_LABELS = { none: '不花钱', tokens: '要调模型（花 token）', money: '要付费外部接口' };

const ID_RE = /^[a-z][a-zA-Z0-9]*(\.[a-z][a-zA-Z0-9]*)+$/;
const VERSION_RE = /^\d+\.\d+\.\d+$/;

/** 扫 impl/ 目录：每个 .mjs 就是一条能力。坏文件不会让整张表起不来（带 error 列出来）。 */
async function discover() {
  let names = [];
  try { names = readdirSync(IMPL_DIR).filter((n) => n.endsWith('.mjs') && !n.startsWith('_')).sort(); }
  catch { return []; }
  const out = [];
  for (const name of names) {
    try {
      const mod = await import(pathToFileURL(join(IMPL_DIR, name)).href);
      if (!mod.meta || typeof mod.run !== 'function') { out.push({ id: name.replace(/\.mjs$/, ''), error: '缺少 meta 或 run', file: name }); continue; }
      out.push({
        ...mod.meta,
        // entry 由"注册表自己"给出（它就是从这个文件发现这条能力的）；meta 里写了就以 meta 为准
        entry: mod.meta.entry || `lib/capabilities/impl/${name}`,
        bind: mod.bind || {}, run: mod.run, file: name, source: 'builtin',
      });
    } catch (e) {
      out.push({ id: name.replace(/\.mjs$/, ''), error: `加载失败：${(e && e.message) || e}`, file: name });
    }
  }
  return out;
}

export const CAPABILITIES = await discover();

export function getCapability(id) {
  const key = String(id || '').trim();
  return CAPABILITIES.find((c) => c.id === key) || null;
}

export function capabilityIds() { return CAPABILITIES.map((c) => c.id); }

/** 写类执行能力（不注入 ctx，靠功能吐出 action 交执行器办）。 */
export function isExecutorCapability(cap) { return !!(cap && cap.bind && cap.bind.executor); }

/** 这条能力会注入到 ctx 的哪些位置（写类返回空数组）。 */
export function ctxBindingsOf(cap) {
  const list = cap && cap.bind && Array.isArray(cap.bind.ctx) ? cap.bind.ctx : [];
  return list.map(String);
}

export function listCapabilities({ kind, group, cost, q } = {}) {
  let out = CAPABILITIES.slice();
  if (kind) out = out.filter((c) => c.kind === kind);
  if (cost) out = out.filter((c) => c.cost === cost);
  if (group) out = out.filter((c) => c.ui && c.ui.group === group);
  const needle = String(q || '').trim().toLowerCase();
  if (needle) out = out.filter((c) => `${c.id} ${c.name} ${(c.ui && c.ui.label) || ''}`.toLowerCase().includes(needle));
  return out;
}

export function capabilityGroups() {
  const seen = [];
  for (const c of CAPABILITIES) {
    const g = (c.ui && c.ui.group) || '未分组';
    if (!seen.includes(g)) seen.push(g);
  }
  return seen;
}

/** 校验一条能力描述符（形状 + 权限词表）。返回 { ok, errors[] }。 */
export function validateCapability(descriptor) {
  const errors = [];
  const d = descriptor && typeof descriptor === 'object' ? descriptor : {};
  if (d.schema && d.schema !== CAPABILITY_SCHEMA) errors.push(`schema 必须是 ${CAPABILITY_SCHEMA}`);
  if (!d.id || typeof d.id !== 'string') errors.push('缺少 id');
  else if (!ID_RE.test(d.id)) errors.push('id 要是点分的「域.动作」小写形式，如 course.text');
  if (!d.name || typeof d.name !== 'string') errors.push('缺少 name');
  if (!d.version || !VERSION_RE.test(String(d.version))) errors.push('version 要形如 1.0.0');
  if (!CAPABILITY_KINDS.includes(d.kind)) errors.push(`kind 必须是 ${CAPABILITY_KINDS.join(' / ')}`);
  if (!CAPABILITY_COSTS.includes(d.cost)) errors.push(`cost 必须是 ${CAPABILITY_COSTS.join(' / ')}`);
  if (typeof d.idempotent !== 'boolean') errors.push('idempotent 要是 true / false（能不能重放靠它）');
  if (!Array.isArray(d.permissions)) errors.push('permissions 要是数组（没有额外权限就给空数组）');
  else {
    d.permissions.forEach((p, i) => {
      if (typeof p !== 'string') errors.push(`permissions[${i}] 要是字符串`);
      else if (!PERMISSION_GLOSSARY[p]) errors.push(`permissions[${i}] 是未登记的权限「${p}」（词表见 lib/permissions.mjs）`);
    });
  }
  for (const key of ['input', 'output', 'ui']) {
    if (d[key] !== undefined && (typeof d[key] !== 'object' || d[key] === null || Array.isArray(d[key]))) errors.push(`${key} 要是对象`);
  }
  for (const key of ['entry', 'tests']) {
    if (d[key] !== undefined && d[key] !== null && typeof d[key] !== 'string') errors.push(`${key} 要是字符串或 null`);
  }
  return { ok: errors.length === 0, errors };
}

export function summarizeCapability(cap) {
  const c = cap && typeof cap === 'object' ? cap : {};
  const perms = Array.isArray(c.permissions) && c.permissions.length ? c.permissions.join(', ') : '无额外权限';
  return `${c.id} —— ${c.name}（${KIND_LABELS[c.kind] || c.kind}｜${perms}｜`
    + `${c.idempotent ? '可重放' : '不可重放'}｜${COST_LABELS[c.cost] || c.cost}）`;
}
