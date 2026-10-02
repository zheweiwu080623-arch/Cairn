// routes/modules.mjs —— 模块系统的接口（R2/R3：原来 /api/modules 挤在主程序里）
//
//   GET  /api/modules            → 模块清单（含坏模块与"上次运行"）
//   POST /api/modules/:id/run    → 跑一个 **processor**（再处理功能）
//
// 关于 run 接口的三条硬规矩：
//   1) **默认 dry-run**：`{"dry_run": false}` 才真执行 —— 再处理功能是别人写的，
//      默认不该有副作用；演练会把每条动作停在 `planned`；
//   2) **动作必须能被规范化**：功能吐什么形状都行，这里统一过 `lib/processor.mjs`，
//      认不出来的 type 标 `failed` 并写清原因，绝不"悄悄发出去"；
//   3) **执行能力是注入的**：真正发通知 / 推手机由服务器提供（executors），这里只负责调度与记账。

import { join } from 'node:path';
import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

import { scanModules } from '../modules.mjs';
import { canExecute, normalizeActions, summarizeActions } from '../processor.mjs';
import { getCapability } from '../capabilities/index.mjs';
import { declaredCapabilities } from '../capabilities/host.mjs';
import { describePrivacy } from '../permissions.mjs';
import { runFlow, summarizeFlow, validateFlow } from '../flow.mjs';

export const RUNS_KEY = 'module_runs_json';

export function createModuleRoutes(ctx) {
  const {
    modulesDir, store, sendJson, sendError, readBody,
    executors = {},                 // { notify(action, mod), push(action, mod), … }
    extraContext = () => ({}),      // 注入给功能的能力（例如 canvas 检查、模块偏好）
    capabilities = null,            // 能力宿主（M2 的图执行用它调能力）；不传就没法跑声明式功能
    log = () => {},
  } = ctx;

  const readRuns = () => {
    try { return JSON.parse(store.getSync(RUNS_KEY) || '{}') || {}; } catch { return {}; }
  };

  function rememberRun(id, out) {
    try {
      const map = readRuns();
      map[id] = {
        at: out.at, dry_run: out.dry_run, count: out.actions.length,
        done: out.actions.filter((a) => a.status === 'done').length,
        failed: out.actions.filter((a) => a.status === 'failed').length,
        summary: out.summary,
      };
      store.setSync(RUNS_KEY, JSON.stringify(map));
    } catch { /* 记账失败不影响这次运行 */ }
  }

  function listModules() {
    // 每个模块带上"它声明了哪些能力"（S6）：界面/命令行就能在列表里直接说清它要干什么，
    // 不用等装了才知道。声明了但登记表里没有的，单独放进 missing_capabilities 里报出来。
    const modules = scanModules(modulesDir).map((m) => {
      const { known, unknown } = declaredCapabilities(m);
      const caps = known.map((id) => getCapability(id)).filter(Boolean);
      return {
        ...m,
        capabilities: caps,
        missing_capabilities: unknown,
        // 一句话讲清"它会碰什么"（2026-10-02 · 台阶 B）：装在「设置 → 功能」里给用户看
        privacy: describePrivacy(m, caps),
      };
    });
    return { schema: 'module.v1', modules, broken: modules.filter((m) => m.error).length, runs: readRuns() };
  }

  /**
   * 跑一个再处理功能。返回结构化结果（接口与内部调用共用同一个入口）。
   * @param {string} id 模块 id
   * @param {{input?:object, dryRun?:boolean}} opts
   */
  async function runModule(id, { input = {}, dryRun = true } = {}) {
    const mod = scanModules(modulesDir).find((m) => m.id === id);
    if (!mod) return { ok: false, error: `没有这个模块：${id}` };
    if (mod.error) return { ok: false, error: `模块有问题：${mod.error}` };
    if (mod.kind !== 'processor') return { ok: false, error: `模块 ${id} 不是 processor（kind=${mod.kind}）` };
    const entry = mod.entry && mod.entry.run;
    const flowEntry = mod.entry && mod.entry.flow;
    if (!entry && !flowEntry) return { ok: false, error: 'processor 缺少 entry.run（或声明式的 entry.flow）' };

    // 声明的能力名必须是登记表里有的（S5）：拼错名字要当场报清楚，
    // 而不是让功能跑到一半才对着一句"undefined 不是函数"发愣。
    const decl = declaredCapabilities(mod);
    if (decl.unknown.length) {
      return { ok: false, error: `模块声明了不存在的能力：${decl.unknown.join('、')}（见 cairn cap list）` };
    }

    const t0 = Date.now();
    let raw;                       // 两种功能的产出都汇到这里：手写的 run() 与声明式的能力图
    // ---- 声明式功能（M2）：功能 = 能力图 ----
    // 图执行器产出的也是 action，所以后面那套规范化 / 演练 / 执行器 / 记账**一行都不用改**。
    if (!entry && flowEntry) {
      let spec;
      try { spec = JSON.parse(readFileSync(join(mod.dir, flowEntry), 'utf8')); }
      catch (e) { return { ok: false, error: `读不出能力图 ${flowEntry}：${(e && e.message) || e}` }; }
      const check = validateFlow(spec);
      if (!check.ok) return { ok: false, error: `能力图不合法：${check.errors.join('；')}` };
      if (!capabilities || typeof capabilities.invoke !== 'function') {
        return { ok: false, error: '这台服务器没有接能力宿主（capabilities.invoke），跑不了声明式功能' };
      }
      const run = await runFlow(spec, {
        invoke: (id, input, ctx) => capabilities.invoke(id, input, ctx),
        ctx: capabilities.allContext(),
        input,
        log,
      });
      if (!run.ok) {
        return { ok: false, error: run.error, ms: run.ms, flow: { nodes: run.nodes, summary: summarizeFlow(spec) } };
      }
      raw = run.actions;
      log(`[flow] ${mod.id} ${summarizeFlow(spec)} · ${run.nodes.length} 个节点跑完 · ${run.ms}ms`);
    } else {
    try {
      const impl = await import(pathToFileURL(join(mod.dir, entry)).href);
      if (typeof impl.run !== 'function') return { ok: false, error: 'entry.run 没有导出 run(input, ctx)' };
      raw = await impl.run(input, {
        store, now: t0, dryRun, log,
        module: { id: mod.id, name: mod.name, dir: mod.dir },
        ...extraContext(mod),
      });
    } catch (e) {
      return { ok: false, error: `再处理功能跑出错：${(e && e.message) || e}`, ms: Date.now() - t0 };
    }
    }

    const now = Date.now();
    const actions = normalizeActions(raw, { moduleId: mod.id, dryRun, now });

    if (!dryRun) {
      for (const a of actions) {
        const verdict = canExecute(a, { dryRun: false });
        if (!verdict.ok) {
          a.status = a.status === 'failed' ? 'failed' : 'skipped';
          a.result = { ok: false, detail: verdict.reason };
          continue;
        }
        try {
          const r = await executors[a.type](a, mod);
          a.status = r && r.ok === false ? 'failed' : 'done';
          a.result = { ok: !(r && r.ok === false), detail: (r && (r.detail || r.error)) || '' };
        } catch (e) {
          a.status = 'failed';
          a.result = { ok: false, detail: String((e && e.message) || e) };
        }
      }
    }

    const out = {
      ok: true, module: mod.id, name: mod.name, dry_run: dryRun,
      at: new Date(now).toISOString(), ms: Date.now() - t0,
      actions, summary: summarizeActions(actions, { dryRun }),
    };
    rememberRun(mod.id, out);
    log(`[processor] ${mod.id} ${dryRun ? '（演练）' : ''}${out.summary} · ${out.ms}ms`);
    return out;
  }

  async function handleModules(req, res, url) {
    const p = url.pathname;
    const method = req.method;
    if (p === '/api/modules' && method === 'GET') return sendJson(res, 200, listModules());
    const m = p.match(/^\/api\/modules\/([a-z0-9-]+)\/run$/);
    if (m && method === 'POST') {
      const body = (await readBody(req)) || {};
      const dryRun = body.dry_run !== false;                 // **默认演练**
      const input = body.input || body.signal || {};
      const r = await runModule(m[1], { input, dryRun });
      return sendJson(res, r.ok ? 200 : 400, r);
    }
    return sendError(res, 404, '没有这个接口');
  }

  return { handleModules, runModule, listModules, readRuns };
}
