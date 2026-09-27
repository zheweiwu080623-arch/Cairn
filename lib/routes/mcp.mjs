// routes/mcp.mjs —— 给外部 AI Agent 用的**只读**数据接口（2026-09-24，用户点名"针对办公 agent 做特化兼容"）。
//
// 为什么要有它：Qoder CN 的 CLI/桌面端支持 MCP，千问办公按"文件夹授权"读文件。
// 两边都需要**同一份事实**：今天有什么、哪些 task 快到期、什么最要紧、课件里哪份材料讲过什么。
// 这一组接口只做一件事 —— 把 Cairn 已经算好的东西**只读地**交出去。
//
// 三条硬边界（写在这里，也写在测试里）：
//   1) **只读**：没有任何写路径、不会发通知、不会推手机、不碰 Canvas 提交；
//   2) **只给本机**：这些接口和别的 /api/* 一样只在 127.0.0.1 上，绑到局域网的只有那个只读小服务；
//   3) **给的是"结论 + 依据"**：重要性带理由、DDL 带倒计时与下一次提醒 —— 让外部 agent 不必自己猜。

import { countdownText, dueLevel, nextStep, normalizeDdlPrefs } from '../ddl.mjs';

/** 一天内的键（YYYY-MM-DD，本地时区）。 */
function dateKey(d) {
  const x = new Date(d);
  const p = (n) => String(n).padStart(2, '0');
  return `${x.getFullYear()}-${p(x.getMonth() + 1)}-${p(x.getDate())}`;
}

export function createMcpRoutes({
  store, sendJson, sendError, priority = null, course = null, dataDir = '',
  readStudyFile = null, listStudyFiles = null, log = () => {},
  now = () => Date.now(),            // 可注入时钟：测试里固定时间，避免"按时钟漂移"的假红
} = {}) {
  const ddlPrefs = () => {
    try { return normalizeDdlPrefs(JSON.parse(store.getSync('ddl_prefs_json') || 'null')); }
    catch { return normalizeDdlPrefs({}); }
  };

  /** 今天：日程 + 今天到期/逾期的任务 + 待看的提醒（都只读）。 */
  function today(now = Date.now()) {
    const key = dateKey(now);
    const events = store.listEvents().filter((e) => dateKey(e.start_at) === key);
    const tasks = store.listTasks().filter((t) => t.status !== 'done');
    const overdue = tasks.filter((t) => t.due_at && Date.parse(t.due_at) < now);
    const dueToday = tasks.filter((t) => t.due_at && dateKey(t.due_at) === key && Date.parse(t.due_at) >= now);
    const notifs = store.listNotifications().filter((n) => n.enabled).slice(0, 8);
    const academic = store.listAcademic() || [];
    const term = academic.find((a) => a.kind === 'term');
    let week = null;
    if (term && term.start_at) {
      const d0 = new Date(term.start_at); d0.setHours(0, 0, 0, 0);
      const d1 = new Date(now); d1.setHours(0, 0, 0, 0);
      week = Math.floor((d1 - d0) / (7 * 86400000)) + 1;
      if (week < 1) week = null;
    }
    return {
      schema: 'mcp.today.v1', at: new Date(now).toISOString(), date: key, semester_week: week,
      events: events.map((e) => ({ title: e.title, start_at: e.start_at, end_at: e.end_at || null, all_day: !!e.all_day, location: e.location || null })),
      due_today: dueToday.map((t) => ({ title: t.title, due_at: t.due_at, countdown: countdownText(t.due_at, now), level: dueLevel(t.due_at, now), priority: t.priority })),
      overdue: overdue.map((t) => ({ title: t.title, due_at: t.due_at, countdown: countdownText(t.due_at, now), priority: t.priority })),
      notifications: notifs.map((n) => ({ title: n.title, message: n.message || '', trigger_at: n.trigger_at, source: n.source || null })),
    };
  }

  /** 任务清单（可筛）：每条都带倒计时与"下一次提醒"。 */
  function tasks({ status = 'open', q = '', limit = 30 } = {}, now = Date.now()) {
    const prefs = ddlPrefs();
    const kw = String(q || '').toLowerCase();
    const list = store.listTasks()
      .filter((t) => (status === 'all' ? true : status === 'done' ? t.status === 'done' : t.status !== 'done'))
      .filter((t) => (!kw ? true : `${t.title} ${t.notes || ''}`.toLowerCase().includes(kw)));
    const withDue = list.map((t) => {
      const nx = t.due_at ? nextStep(t.due_at, now, prefs.steps) : null;
      return {
        title: t.title, status: t.status, priority: t.priority,
        due_at: t.due_at || null,
        countdown: t.due_at ? countdownText(t.due_at, now) : null,
        level: t.due_at ? dueLevel(t.due_at, now) : 'none',
        next_reminder: nx ? { at: new Date(nx.at).toISOString(), label: nx.label } : null,
        note: t.notes || null,
      };
    }).sort((a, b) => {
      const da = a.due_at ? Date.parse(a.due_at) : Infinity;
      const db = b.due_at ? Date.parse(b.due_at) : Infinity;
      return da - db || (a.priority || 2) - (b.priority || 2);
    });
    return { schema: 'mcp.tasks.v1', at: new Date(now).toISOString(), count: withDue.length, tasks: withDue.slice(0, Math.min(200, Math.max(1, Number(limit) || 30))) };
  }

  /** 重要信息（复用它自己的排序与理由）。 */
  function priorityNow({ top = 10 } = {}) {
    if (!priority || typeof priority.computePriority !== 'function') return { schema: 'mcp.priority.v1', items: [], note: '这台机器上没开重要性排序' };
    try {
      const r = priority.computePriority({ top: Math.min(50, Math.max(1, Number(top) || 10)) });
      const ranked = (r.result && r.result.ranked) || [];
      return {
        schema: 'mcp.priority.v1', at: new Date().toISOString(), count: ranked.length,
        items: ranked.map((x) => ({
          title: x.item ? x.item.title : x.title,
          score: x.score, band: x.band,
          reasons: Array.isArray(x.reasons) ? x.reasons.map((z) => (z && z.note) || String(z)) : [],
          source: (x.item && x.item.source) || null,
          at: (x.item && (x.item.due_at || x.item.start_at)) || null,
        })),
        advice: r.advice || null,
      };
    } catch (e) {
      return { schema: 'mcp.priority.v1', items: [], error: `算重要性时出错：${(e && e.message) || e}` };
    }
  }

  /** 已生成的学习产物清单（技能③等），以及读其中一份。 */
  function packs() {
    const files = typeof listStudyFiles === 'function' ? listStudyFiles() : [];
    return { schema: 'mcp.packs.v1', dir: dataDir, count: files.length, files };
  }

  function readPack(name) {
    const safe = String(name || '').trim();
    if (!safe || safe.includes('/') || safe.includes('\\') || safe.includes('..')) {
      return { ok: false, error: '文件名不合法（只接受 <数据目录>/study 下的单个文件名）' };
    }
    if (typeof readStudyFile !== 'function') return { ok: false, error: '读不到产物目录' };
    return readStudyFile(safe);
  }

  async function handleMcp(req, res, url) {
    const p = url.pathname;
    if (req.method !== 'GET') return sendError(res, 405, '这些接口是只读的（只用 GET）');
    try {
      if (p === '/api/mcp/today') return sendJson(res, 200, today(now()));
      if (p === '/api/mcp/tasks') {
        return sendJson(res, 200, tasks({
          status: url.searchParams.get('status') || 'open',
          q: url.searchParams.get('q') || '',
          limit: url.searchParams.get('limit') || 30,
        }, now()));
      }
      if (p === '/api/mcp/priority') return sendJson(res, 200, priorityNow({ top: url.searchParams.get('top') || 10 }));
      if (p === '/api/mcp/packs') return sendJson(res, 200, packs());
      if (p === '/api/mcp/pack') return sendJson(res, 200, readPack(url.searchParams.get('name')));
      if (p === '/api/mcp/course/search') {
        const q = String(url.searchParams.get('q') || '').trim();
        if (!q) return sendError(res, 400, '要搜什么？给一个 ?q=关键词');
        if (!course || typeof course.search !== 'function') return sendError(res, 500, '这台机器上没有可用的课件搜索');
        const r = course.search(q, { course: String(url.searchParams.get('course') || '').trim() });
        return sendJson(res, r.ok ? 200 : 400, { ...r, hits: (r.hits || []).slice(0, 30) });
      }
      log(`[mcp] 不认识的路径：${p}`);
      return sendError(res, 404, '没有这个接口');
    } catch (e) {
      return sendError(res, 500, `取数出错：${(e && e.message) || e}`);
    }
  }

  return { handleMcp, today, tasks, priorityNow, packs, readPack };
}
