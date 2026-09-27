// capabilities/host.mjs —— 按登记表**装配能力**（M1 · S4/S5），并给 M2 一个统一的调用口
//
// 在这之前，注入是 hand-written：`server.mjs` 里 `{ ...preclass.extraContext(mod), ...course.extraContext(mod) }`。
// 现在改成：读 `lib/capabilities/index.mjs` 的登记表，按每条能力的 `bind` 去三个提供者
// （preclass / course / executors，就是那三个 stack）里取函数，装成功能拿到的 `ctx`。
//
// 两条规矩（S5）：
//   1) **声明了才给**：功能在 `module.json` 的 `requires.capabilities` 里写了哪几条，`ctx` 里就有哪几条；
//   2) **没声明就用 → 明确报错**：没声明的能力位会装成一个"一调用就抛人话错误"的函数，
//      而不是给个 `undefined` 让功能在别处崩（错误信息里直接告诉你该往 module.json 里加什么）。
//
// `invoke(id, input, ctx)` 是给 M2「功能 = 能力图」用的统一入口：读类能力直接返回产出，
// 写类能力返回一条 **action**（交给 lib/processor-executors.mjs 执行，所以 dry-run / 审计照样生效）。

import { CAPABILITIES, getCapability, ctxBindingsOf, isExecutorCapability } from './index.mjs';
import { runUserCapability } from './user.mjs';

/** 从 `{ a: { b: 1 } }` 里按 `'a.b'` 取值；取不到返回 undefined。 */
function getPath(obj, path) {
  let cur = obj;
  for (const seg of String(path).split('.')) {
    if (cur == null) return undefined;
    cur = cur[seg];
  }
  return cur;
}

/** 往 `{ a: {} }` 里按 `'a.b'` 塞值（中间层没有就建）。 */
function setPath(obj, path, value) {
  const segs = String(path).split('.');
  let cur = obj;
  for (let i = 0; i < segs.length - 1; i += 1) {
    const k = segs[i];
    if (cur[k] == null || typeof cur[k] !== 'object') cur[k] = {};
    cur = cur[k];
  }
  cur[segs[segs.length - 1]] = value;
  return obj;
}

/** 功能声明了哪些能力（去重、去空、按登记表过滤掉不认识的）。 */
export function declaredCapabilities(mod) {
  const raw = mod && mod.requires && Array.isArray(mod.requires.capabilities) ? mod.requires.capabilities : [];
  const ids = [...new Set(raw.map((s) => String(s || '').trim()).filter(Boolean))];
  return { ids, known: ids.filter((id) => !!getCapability(id)), unknown: ids.filter((id) => !getCapability(id)) };
}

/**
 * 建一个能力宿主。
 * @param {{providers?: Record<string, Function|object>, log?: Function}} options
 *        providers：`{ preclass: () => preclass.extraContext(), course: () => course.extraContext(), executors: () => {...} }`
 *        —— 一律传**函数**（懒引用），跟原来 server.mjs 的求值时机保持一致。
 */
export function createCapabilityHost({ providers = {}, log = () => {} } = {}) {
  // dataDir：开发者自己写的能力放在 <数据目录>/capabilities/ 下（不需要改内核，见 user.mjs）
  const dataDir = (providers && providers.dataDir) || '';
  /** 每次装配都重新问一遍提供者（和原来"每次 run 都调 extraContext"一样，避免缓存住旧数据目录）。 */
  function snapshot() {
    const out = {};
    for (const [name, p] of Object.entries(providers)) {
      try { out[name] = typeof p === 'function' ? (p() || {}) : (p || {}); }
      catch (e) { out[name] = {}; log(`[capabilities] 提供者 ${name} 取不到：${(e && e.message) || e}`); }
    }
    return out;
  }

  /** 没声明的能力位：一调用就抛人话错误（而不是 undefined 让功能在别处崩）。 */
  function undeclared(capId) {
    return function notDeclared() {
      throw new Error(`能力「${capId}」没有声明：请在这个功能的 module.json 里加 "requires": { "capabilities": ["${capId}"] }`);
    };
  }

  /** 一条能力真正绑到的函数（从提供者里按 bind 取）。 */
  function boundFunction(cap, snap, path) {
    const from = cap.bind && cap.bind.from;
    const fn = getPath(snap[from], path);
    if (typeof fn !== 'function') {
      log(`[capabilities] ${cap.id} 的 ${from}.${path} 取不到（提供者没给这个函数）`);
      return null;
    }
    return fn;
  }

  /**
   * 装配给某个功能的 ctx（= 原来 preclass.extraContext + course.extraContext 的位置）。
   * 只装配**它声明过的**能力；写类能力不进 ctx（它们由 action 走执行器）。
   */
  function extraContext(mod) {
    const { ids } = declaredCapabilities(mod);
    const declared = new Set(ids);
    const snap = snapshot();
    const out = {};
    for (const cap of CAPABILITIES) {
      if (isExecutorCapability(cap)) continue;
      for (const path of ctxBindingsOf(cap)) {
        if (!declared.has(cap.id)) { setPath(out, path, undeclared(cap.id)); continue; }
        const fn = boundFunction(cap, snap, path);
        setPath(out, path, fn || undeclared(cap.id));
      }
    }
    return out;
  }

  /** 全部能力（不挑声明）—— 给"功能 = 能力图"的图执行用：图自己已经声明过了。 */
  function allContext() {
    const snap = snapshot();
    const out = {};
    for (const cap of CAPABILITIES) {
      if (isExecutorCapability(cap)) continue;
      for (const path of ctxBindingsOf(cap)) {
        const fn = boundFunction(cap, snap, path);
        if (fn) setPath(out, path, fn);
      }
    }
    return out;
  }

  /**
   * 把一条写类能力折成一条 action（不真执行；由 processor 那条老路子去执行/演练/记账）。
   * 这样"图上拼出来的功能"与"手写的功能"在审计与 dry-run 上是同一套。
   */
  function actionFor(cap, input = {}) {
    const key = `${cap.id}:${input.idempotency_key || input.course || input.path || ''}`;
    if (cap.id === 'notify.app') {
      return {
        type: 'notify', summary: input.title || cap.name, idempotency_key: key,
        payload: { text: input.text || '' }, target: { url: input.url || null },
        permissions: cap.permissions,
      };
    }
    if (cap.id === 'push.phone') {
      return {
        type: 'push', summary: input.title || cap.name, idempotency_key: key,
        payload: { push: String(input.push || '').slice(0, 60) }, target: { url: input.url || null },
        permissions: cap.permissions,
      };
    }
    if (cap.id === 'file.write') {
      return {
        type: 'file', summary: input.summary || `写出 ${input.path || ''}`, idempotency_key: key,
        target: { kind: 'file', path: input.path }, payload: { text: input.text },
        permissions: cap.permissions,
      };
    }
    return { type: 'external', summary: cap.name, idempotency_key: key, permissions: cap.permissions };
  }

  /**
   * 统一调用一条能力（M2 的图执行只用这一个入口）。
   * @returns {Promise<{ok:boolean, output?:any, actions?:object[], error?:string}>}
   */
  async function invoke(id, input = {}, ctx = null) {
    const cap = getCapability(id);
    if (!cap) {
      // 不是平台自带的 ⇒ 试试"开发者自己写的能力"（单文件、放在数据目录里）
      if (dataDir) {
        const r = await runUserCapability(dataDir, id, input, ctx || allContext());
        if (r.ok) return r;
        return { ok: false, error: r.error.includes('没有这条自写能力') ? `没有这个能力：${id}` : r.error };
      }
      return { ok: false, error: `没有这个能力：${id}` };
    }
    if (isExecutorCapability(cap)) return { ok: true, actions: [actionFor(cap, input || {})] };
    const c = ctx || allContext();
    try {
      // 2026-09-26 拆分：能力自己的 run(input, ctx) 就是唯一的调用方式（不再有手写的适配表）——
      // 加一条能力只要加一个文件，宿主、路由、主程序都不用动。
      const out = await cap.run(input || {}, c);
      if (out && Array.isArray(out.actions)) return { ok: true, actions: out.actions };
      return { ok: true, output: out };
    } catch (e) {
      return { ok: false, error: `能力「${id}」跑出错：${(e && e.message) || e}` };
    }
  }

  /**
   * 记录声明情况（给 `cairn cap list` / 安装预览 / 界面用）。
   * unknown = 声明了登记表里没有的能力名（拼错或版本不匹配），要显式报出来。
   */
  function describe(mod) {
    const { ids, known, unknown } = declaredCapabilities(mod);
    return {
      declared: ids,
      known,
      unknown,
      capabilities: known.map((id) => getCapability(id)),
    };
  }

  return { extraContext, allContext, invoke, describe, actionFor, snapshot };
}

/**
 * 调用适配层：登记表是**纯数据**（不能塞函数），所以"输入怎么变成各能力真正的签名"写在宿主这边。
 * 每条都是薄薄一层，功能 = 能力图的节点参数就是照这里的入参写的。
 */
const INVOKERS = {
  'canvas.course.check': (ctx, input) => ctx.canvas.checkCourse(input),
  'course.scan': (ctx, input) => ctx.course.scan(input),
  'course.text': (ctx, input = {}) => {
    if (input.q) {
      const materials = input.materials || (ctx.course.read(input) || {}).materials || [];
      return { hits: ctx.course.search(materials, input.q) };
    }
    return ctx.course.read(input);
  },
  'course.artifacts': (ctx, input = {}) => (input.mode === 'weekly' ? ctx.course.weekly(input) : ctx.course.index(input)),
  'dedupe.filterNew': (ctx, input = {}) => ctx.dedupe.filterNew(input.items || [], { scope: input.scope }),
  'dedupe.markSeen': (ctx, input = {}) => ctx.dedupe.markSeen(input.items || [], { scope: input.scope }),
  'prefs.read': (ctx) => ctx.prefs(),
};
