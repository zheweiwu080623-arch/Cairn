// routes/flows.mjs —— 「能力搭建」的接口（M3）
//
//   GET  /api/flows            现有的声明式功能（带 entry.flow 的模块）
//   POST /api/flows/validate   校验一张图（纯校验，不跑）
//   POST /api/flows/dry-run    把一张图**演练**跑一遍（真能力、真数据、零副作用）
//   POST /api/flows/save       把一张图存成一个新功能（modules/<id>/）
//                              —— 或者存成一条**复合能力**（<数据目录>/capabilities/<id>.json，
//                                 用 `target: 'capability'`；2026-10-02 加的"能力也能由能力拼出来"）
//
// 三条安全线（这是别人拖出来的图，必须比手写功能更保守）：
//   1) **只有演练**：dry-run 接口只返回"本来会做什么"（planned），**没有任何真的执行路径**；
//   2) **只写进 modules/**：保存时目录名只允许 [a-z0-9-]，且一律拼在模块根下面（防目录穿越），
//      同名模块默认拒绝覆盖，要覆盖得显式说 overwrite；
//   3) **声明自动生成**：保存出来的 module.json 里 requires.capabilities 与 permissions
//      由图里真正用到的能力推导 —— 人忘了写也不会漏（图跑了什么，就声明什么）。

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve, sep } from 'node:path';

import { getCapability } from '../capabilities/index.mjs';
import { saveUserCapabilityFlow, scanUserCapabilities } from '../capabilities/user.mjs';
import { runFlow, summarizeFlow, topoOrder, validateFlow } from '../flow.mjs';
import { scanModules } from '../modules.mjs';

const ID_RE = /^[a-z][a-z0-9-]*$/;
/** 能力 id 是点分的「域.动作」（和 lib/capabilities/user.mjs 同一套规则）。 */
const CAP_ID_RE = /^[a-z][a-zA-Z0-9]*(\.[a-z][a-zA-Z0-9]*)+$/;

export function createFlowRoutes({
  sendJson, sendError, readBody, modulesDir,
  capabilities = null, dataDir = '', log = () => {},
} = {}) {
  /** 图里真正用到的能力（去重、保序）。 */
  function usedCapabilities(spec) {
    const ids = (spec?.nodes || []).map((n) => String(n.capability || '').trim()).filter(Boolean);
    return [...new Set(ids)];
  }

  /** 保存出来的 module.json：声明与权限都**从图里推导**，不靠人写。 */
  function descriptorFor({ id, name, spec }) {
    const used = usedCapabilities(spec);
    const perms = [...new Set(used.flatMap((cid) => (getCapability(cid)?.permissions) || []))];
    return {
      schema: 'module.v1',
      id,
      name: name || id,
      version: '0.1.0',
      kind: 'processor',
      icon: '🧩',
      order: 60,
      author: { name: '能力搭建（图形化）' },
      license: 'MIT',
      entry: { flow: 'flow.json', readme: 'README.md' },
      data: { reads: [], writes: [], tables: [] },
      permissions: perms,
      config: [],
      requires: { app: '>=1.0', agent: false, capabilities: used },
    };
  }

  /** 这张图用到的、**登记表里没有**的能力（自写能力也算"有"，所以要先扫一遍数据目录）。 */
  async function unknownCapabilities(spec) {
    const ids = usedCapabilities(spec);
    const missing = ids.filter((c) => !getCapability(c));
    if (!missing.length || !dataDir) return missing;
    let user = [];
    try { user = await scanUserCapabilities(dataDir); } catch { user = []; }
    const ok = new Set(user.filter((c) => !c.error).map((c) => c.id));
    return missing.filter((c) => !ok.has(c));
  }

  /** 图里用到的能力合起来要哪些权限（自写能力的权限从它自己的 meta 里读）。 */
  async function permissionsOfUsed(spec) {
    const ids = usedCapabilities(spec);
    const perms = new Set(ids.flatMap((cid) => (getCapability(cid)?.permissions) || []));
    const missing = ids.filter((cid) => !getCapability(cid));
    if (missing.length && dataDir) {
      try {
        const user = await scanUserCapabilities(dataDir);
        for (const c of user) {
          if (missing.includes(c.id) && c.meta && Array.isArray(c.meta.permissions)) {
            for (const p of c.meta.permissions) perms.add(p);
          }
        }
      } catch { /* 读不到就按"没有额外权限"处理 */ }
    }
    return [...perms];
  }

  function listFlows() {
    const flows = scanModules(modulesDir)
      .filter((m) => !m.error && m.entry && m.entry.flow)
      .map((m) => {
        let spec = null;
        try { spec = JSON.parse(readFileSync(join(m.dir, m.entry.flow), 'utf8')); } catch { spec = null; }
        const used = spec ? usedCapabilities(spec) : [];
        return {
          id: m.id, name: m.name, icon: m.icon || null, order: m.order ?? null,
          nodes: (spec?.nodes || []).length, capabilities: used,
          summary: spec ? summarizeFlow(spec) : '（flow.json 读不出来）',
        };
      });
    return { schema: 'flows.v1', count: flows.length, flows };
  }

  async function handleFlows(req, res, url) {
    const p = url.pathname;
    const method = req.method;
    if (p === '/api/flows' && method === 'GET') return sendJson(res, 200, listFlows());

    if (p === '/api/flows/validate' && method === 'POST') {
      const body = (await readBody(req)) || {};
      const spec = body.spec || body;
      const v = validateFlow(spec);
      const order = v.ok ? topoOrder(spec).order : [];
      return sendJson(res, 200, {
        ok: v.ok, errors: v.errors,
        nodes: (spec?.nodes || []).length,
        order,
        capabilities: usedCapabilities(spec),
        summary: spec ? summarizeFlow(spec) : '',
      });
    }

    if (p === '/api/flows/dry-run' && method === 'POST') {
      const body = (await readBody(req)) || {};
      const spec = body.spec || {};
      const input = body.input || {};
      if (!capabilities || typeof capabilities.invoke !== 'function') {
        return sendError(res, 503, '这台服务器没有接能力宿主，演练不了');
      }
      const r = await runFlow(spec, {
        invoke: (id, i, ctx) => capabilities.invoke(id, i, ctx),
        ctx: capabilities.allContext(),
        input,
        log,
      });
      // 注意：这里**只返回**计划中的动作，绝不调用执行器 —— 演练就是演练。
      return sendJson(res, 200, {
        ok: r.ok, error: r.error || null, ms: r.ms,
        nodes: r.nodes, summary: spec ? summarizeFlow(spec) : '',
        planned: (r.actions || []).map((a) => ({
          type: a.type, summary: a.summary || '', status: 'planned',
          path: (a.target && a.target.path) || null,
        })),
      });
    }

    if (p === '/api/flows/save' && method === 'POST') {
      const body = (await readBody(req)) || {};
      const id = String(body.id || '').trim();
      const spec = body.spec || {};
      const target = body.target === 'capability' ? 'capability' : 'module';
      // ---- 存成一条**复合能力**（<数据目录>/capabilities/<id>.json）----
      if (target === 'capability') {
        if (!dataDir) return sendError(res, 503, '这台服务器没有数据目录，存不了自写能力');
        if (!CAP_ID_RE.test(id)) {
          return sendError(res, 400, '能力 id 要是点分的「域.动作」小写形式（例如 demo.headline），不能用连字符');
        }
        const v = validateFlow(spec);
        if (!v.ok) return sendError(res, 400, `这张图还不能保存：${v.errors.join('；')}`);
        const unknown = await unknownCapabilities(spec);
        if (unknown.length) return sendError(res, 400, `图里用了不存在的能力：${unknown.join('、')}`);
        const r = await saveUserCapabilityFlow(dataDir, {
          id, name: String(body.name || id).slice(0, 60), kind: body.kind, spec: { ...(body.meta || {}), flow: spec },
        });
        if (!r.ok) return sendError(res, 400, r.error);
        log(`[flow] 存成新能力：${id}（${r.capabilities.join('、')}）`);
        return sendJson(res, 200, {
          ok: true, target, id, file: r.file,
          capabilities: r.capabilities, permissions: r.permissions,
        });
      }
      if (!ID_RE.test(id)) return sendError(res, 400, '功能名（id）只能是小写字母、数字与连字符，且以字母开头');
      const v = validateFlow(spec);
      if (!v.ok) return sendError(res, 400, `这张图还不能保存：${v.errors.join('；')}`);
      const unknown = await unknownCapabilities(spec);
      if (unknown.length) return sendError(res, 400, `图里用了不存在的能力：${unknown.join('、')}`);

      const root = resolve(String(modulesDir));
      const dir = resolve(join(root, id));
      if (dir !== join(root, id) || (!dir.startsWith(root + sep))) return sendError(res, 400, '路径不合法');
      if (existsSync(dir) && !body.overwrite) return sendError(res, 409, `已经有一个叫 ${id} 的功能了（要覆盖就显式说 overwrite）`);

      const name = String(body.name || id).slice(0, 60);
      const desc = descriptorFor({ id, name, spec });
      desc.permissions = await permissionsOfUsed(spec);
      const readme = [
        `# ${name}`,
        '',
        `这个功能是用「能力搭建」画出来的（M3）：${summarizeFlow(spec)}。`,
        `用到的能力：${usedCapabilities(spec).map((c) => `\`${c}\``).join('、')}。`,
        '',
        '跑法（默认演练）：',
        '',
        '```bash',
        `node bin/cairn.mjs mod test ${id}`,
        `node bin/cairn.mjs mod run  ${id}`,
        '```',
        '',
      ].join('\n');
      try {
        mkdirSync(dir, { recursive: true });
        writeFileSync(join(dir, 'module.json'), JSON.stringify(desc, null, 2) + '\n', 'utf8');
        writeFileSync(join(dir, 'flow.json'), JSON.stringify(spec, null, 2) + '\n', 'utf8');
        writeFileSync(join(dir, 'README.md'), readme, 'utf8');
      } catch (e) {
        return sendError(res, 500, `写不进去：${(e && e.message) || e}`);
      }
      return sendJson(res, 200, { ok: true, id, dir, capabilities: desc.requires.capabilities, permissions: desc.permissions });
    }

    return sendError(res, 404, '没有这个接口');
  }

  return { handleFlows, listFlows, usedCapabilities, descriptorFor };
}
