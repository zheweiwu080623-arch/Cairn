// mcp-stack.mjs —— 「给外部 AI agent 的只读入口」接线层（主程序只留一行）。
//
// 只做接线：把 store / 重要性排序 / 课程材料能力 / 产物目录 交给 lib/routes/mcp.mjs，
// 并实现"读一份已生成的产物"。真正取数在 routes/mcp.mjs，协议在 lib/mcp-server.mjs。

import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { agentDirOf, buildAgentFiles, writeAgentFiles } from './agent-export.mjs';
import { createMcpRoutes } from './routes/mcp.mjs';

export function createMcpStack({ store, sendJson, sendError, readBody = null, dataDir = '', priority = null, course = null, log = () => {} }) {
  const routes = createMcpRoutes({
    store, sendJson, sendError, dataDir, priority, course,
    // 产物清单就用"课程辅助那一页"已经在用的那份（同一份真相，不另写一套）
    listStudyFiles: () => (course && course.routes && typeof course.routes.outputs === 'function' ? course.routes.outputs() : []),
    readStudyFile: (name) => {
      try {
        if (!course || !course.studyDir) return { ok: false, name, error: '还没有产物目录' };
        return { ok: true, name, content: readFileSync(join(course.studyDir, name), 'utf8') };
      } catch (e) { return { ok: false, name, error: `读不到：${(e && e.message) || e}` }; }
    },
  });

  /**
   * 「给办公 AI 看的目录」：GET 看状态，POST 生成（**默认演练**，`{"dry_run":false}` 才真写）。
   * 数据来源与 MCP 工具**同一份**（today/tasks/priority/packs），不另开一套。
   */
  async function handleAgentExport(req, res, url) {
    const dir = agentDirOf(dataDir);
    const snapshot = () => buildAgentFiles({
      today: routes.today(), tasks: routes.tasks({ limit: 200 }), priority: routes.priorityNow({ top: 20 }),
      packs: routes.packs(), generatedAt: new Date().toISOString(),
    });
    if (url.pathname === '/api/agent-export' && req.method === 'GET') {
      return sendJson(res, 200, { schema: 'agent-export.v1', dir, files: Object.keys(snapshot()) });
    }
    if (url.pathname === '/api/agent-export' && req.method === 'POST') {
      const body = (readBody ? (await readBody(req)) : {}) || {};
      const dryRun = body.dry_run !== false;                  // 与项目里其它动作同一条规矩：默认演练
      const files = snapshot();
      const preview = Object.entries(files).map(([name, content]) => ({ name, bytes: Buffer.byteLength(content, 'utf8') }));
      if (dryRun) return sendJson(res, 200, { ok: true, dry_run: true, dir, would_write: preview });
      const r = writeAgentFiles(dir, files);
      log(`[agent-export] ${r.ok ? `已写入 ${dir}（${r.written.length} 个文件）` : r.error}`);
      return sendJson(res, r.ok ? 200 : 400, { ...r, dry_run: false, files: preview });
    }
    return sendError(res, 404, '没有这个接口');
  }

  return { ...routes, handleAgentExport };
}
