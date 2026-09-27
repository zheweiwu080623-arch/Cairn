// capabilities/user.mjs —— **开发者自己写的能力**（放在 <数据目录>/capabilities/ 下的单文件）。
//
// 用户 2026-09-26 的判据（原话）：「如果说新增能力意味着改动平台内核的话，说明平台本身的模块化不够强、
// 自由度不够高（如果我的理解正确的话），我预期的情况是新增能力开发者会新写一段程序实现数据的处理，
// 处于单立的能力文件夹中，不需要改动内核，不需要改动主程序」。
//
// 这个理解是对的，所以这里就是那个"单立的能力文件夹"：
//   * 一条能力 = 一个 .mjs 文件，导出 `meta`（描述）与 `run(input, ctx)`（干活）；
//   * 放在**数据目录**里（不在仓库里，不进版本控制，卸载就走）；
//   * 平台启动/请求时扫描它、校验它、登记它 —— **内核与主程序一行都不用改**；
//   * 写好的能力会出现在 `GET /api/capabilities` 与「能力搭建」的素材栏里，可以像自带能力一样被拼进功能。
//
// 安全边界（写在这里，也让界面能如实告诉开发者）：
//   * 能力的 `permissions` 必须能在 lib/permissions.mjs 的词表里查到（拼错会被拒收）；
//   * 不允许覆盖平台自带能力的 id（避免"偷偷换掉别人依赖的能力"）；
//   * 校验失败的能力会被**如实列出来**（带错误原因），而不是静默丢掉。

import { existsSync, mkdirSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve, sep } from 'node:path';
import { pathToFileURL } from 'node:url';

import { CAPABILITIES, validateCapability } from './index.mjs';

export const USER_CAP_DIR = 'capabilities';
const ID_RE = /^[a-z][a-zA-Z0-9]*(\.[a-z][a-zA-Z0-9]*)+$/;

export function userCapDir(dataDir) {
  return join(String(dataDir || ''), USER_CAP_DIR);
}

/** 一个能力文件的路径（顺便防目录穿越：id 只允许点分小写）。 */
export function userCapPath(dataDir, id) {
  const key = String(id || '').trim();
  if (!ID_RE.test(key)) return null;
  const root = resolve(userCapDir(dataDir));
  const full = resolve(join(root, key + '.mjs'));
  if (full !== join(root, key + '.mjs') || !full.startsWith(root + sep)) return null;
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

/** 扫一遍用户能力目录，逐条校验（坏的要带 error 报出来，不静默丢）。 */
export async function scanUserCapabilities(dataDir) {
  const dir = userCapDir(dataDir);
  const out = [];
  if (!existsSync(dir)) return out;
  let names = [];
  try { names = readdirSync(dir).filter((n) => n.endsWith('.mjs')).sort(); } catch { return out; }
  for (const name of names) {
    const file = join(dir, name);
    let meta = null;
    let run = null;
    let error = '';
    try {
      const mod = await import(pathToFileURL(file).href + '?t=' + Date.now());
      meta = mod.meta || null;
      run = typeof mod.run === 'function' ? mod.run : null;
    } catch (e) { error = `加载失败：${(e && e.message) || e}`; }
    const base = { file: name, id: (meta && meta.id) || name.replace(/\.mjs$/, ''), name: (meta && meta.name) || '', kind: (meta && meta.kind) || '', error };
    if (!error && !meta) error = '文件里没有导出 meta';
    if (!error && !run) error = '文件里没有导出 run(input, ctx)';
    if (!error && CAPABILITIES.some((c) => c.id === meta.id)) error = `id「${meta.id}」和平台自带的能力重名了，换一个`;
    if (!error) {
      const v = validateCapability({ ...meta, schema: 'capability.v1', version: meta.version || '1.0.0' });
      if (!v.ok) error = v.errors.join('；');
    }
    out.push({ ...base, error, meta, run });
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

/** 拿一条用户能力来跑（试跑与图执行都走这里）。 */
export async function runUserCapability(dataDir, id, input = {}, ctx = {}) {
  const all = await scanUserCapabilities(dataDir);
  const hit = all.find((c) => (c.meta && c.meta.id === id) || c.id === id);
  if (!hit) return { ok: false, error: `没有这条自写能力：${id}` };
  if (hit.error) return { ok: false, error: hit.error };
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
    source: 'user',
  };
}
