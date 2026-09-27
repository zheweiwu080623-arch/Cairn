// daily-stack.mjs —— 「每日 18:00 开工」的执行能力 + 接口（D5）。
//
//   GET  /api/daily        → 设置 / 上次开工做了什么 / 今天到点没有
//   POST /api/daily        → 改设置（开关、几点、要不要刷新本周巩固、要不要推手机）
//   POST /api/daily/run    → 立刻开工一次（默认**演练**：只说会做什么，不写文件、不发通知）
//
// 开工顺序（对应计划里那段"产品层"）：
//   ① 刷新本周巩固包（能力③，只从材料里摘，摘不到就说摘不到）
//   ② 把今天该处理的事挑出来（过期 / 今天到期 / 明天到期）—— 用"重要性"那一套排序
//   ③ 汇总成**一条**应用内通知（"今天准备完了：…"），默认**不推手机**
//
// 三条规矩：演练零副作用；一天只开一次工（dateKey 去重）；写文件走功能那套闸门（只准写 study）。

import { DAILY_LAST_KEY, DAILY_PREFS_KEY, dailyDue, dateKeyOf, normalizeDailyPrefs } from './daily.mjs';

export function createDailyStack({
  store, sendJson, sendError, readBody, runModule, log = () => {},
  now = () => Date.now(), dataDir = '', onReady = null,
} = {}) {
  // 默认的"开工结果"去处：**一条**应用内通知（source=daily，按日期去重 ⇒ 一天最多一条）
  const readyFn = typeof onReady === 'function' ? onReady : ({ title, text }) => {
    // 一天只留一条：同一天手动再开一次工（force）不会往通知里刷第二条
    const key = `daily:${dateKeyOf(now())}`;
    const dup = typeof store.listNotifications === 'function'
      && store.listNotifications().some((n) => n && n.external_id === key);
    if (dup) return { skipped: '今天已经有一条开工通知了' };
    return store.createNotification({
      title: String(title).slice(0, 120), message: String(text || ''),
      trigger_at: new Date(now()).toISOString(), repeat: 'none',
      source: 'daily', external_id: key, priority: 2, url: null,
    });
  };
  const readPrefs = () => {
    try { return normalizeDailyPrefs(JSON.parse(store.getSync(DAILY_PREFS_KEY) || 'null')); }
    catch { return normalizeDailyPrefs({}); }
  };
  const savePrefs = (patch) => {
    const next = normalizeDailyPrefs({ ...readPrefs(), ...(patch || {}) , updated_at: now() });
    store.setSync(DAILY_PREFS_KEY, JSON.stringify(next));
    return next;
  };
  const readLast = () => {
    try { return JSON.parse(store.getSync(DAILY_LAST_KEY) || 'null'); } catch { return null; }
  };

  /** 今天该处理的事（挑出来，不排序 —— 排序交给界面/通知文案自己）。 */
  function todayItems(t = now()) {
    const today = dateKeyOf(t);
    const tomorrow = dateKeyOf(t + 86400000);
    const open = store.listTasks().filter((x) => x.status !== 'done' && x.due_at);
    const day = (v) => dateKeyOf(Date.parse(v));
    return {
      overdue: open.filter((x) => Date.parse(x.due_at) < t),
      today: open.filter((x) => day(x.due_at) === today && Date.parse(x.due_at) >= t),
      tomorrow: open.filter((x) => day(x.due_at) === tomorrow),
    };
  }

  async function runOnce({ dryRun = true, force = false } = {}) {
    const prefs = readPrefs();
    const t = now();
    const due = force ? { ok: true, reason: '' } : dailyDue({ prefs, last: readLast(), now: t });
    const items = todayItems(t);
    const plan = {
      date: dateKeyOf(t),
      prefs,
      weekly: prefs.weekly,
      counts: { overdue: items.overdue.length, today: items.today.length, tomorrow: items.tomorrow.length },
    };
    if (!due.ok) return { ok: true, ran: false, dry_run: dryRun, reason: due.reason, plan };
    if (dryRun) return { ok: true, ran: false, dry_run: true, reason: '演练：只说会做什么', plan };

    const out = { ...plan, actions: [] };
    // ① 刷新本周巩固包（走功能；它自己保证"只摘不编"、只写 study 目录）
    if (prefs.weekly && typeof runModule === 'function') {
      try {
        const r = await runModule('course-assist', { input: { mode: 'weekly' }, dryRun: false });
        const a = (r && r.actions && r.actions[0]) || null;
        out.weekly_result = a ? { summary: a.summary, status: a.status } : { error: (r && r.error) || '没有产出' };
      } catch (e) { out.weekly_result = { error: (e && e.message) || String(e) }; }
    }
    // ②③ 汇总一条通知（默认不推手机）
    const head = [
      out.counts.overdue ? `${out.counts.overdue} 件已逾期` : '',
      out.counts.today ? `${out.counts.today} 件今天到期` : '',
      out.counts.tomorrow ? `${out.counts.tomorrow} 件明天到期` : '',
    ].filter(Boolean).join(' · ') || '今天没有到期的事';
    const tail = out.weekly_result && out.weekly_result.summary ? `；本周巩固包：${out.weekly_result.summary}` : '';
    try {
      const made = readyFn({ title: `🧭 每日开工（${out.date}）`, text: `${head}${tail}`, items, prefs });
      out.notified = !(made && made.skipped);
      if (made && made.skipped) out.notify_skipped = made.skipped;
    } catch (e) { out.notified = false; out.notify_error = (e && e.message) || String(e); }
    store.setSync(DAILY_LAST_KEY, JSON.stringify({ at: t, date: out.date, counts: out.counts, weekly_result: out.weekly_result || null }));
    log(`[daily] 开工完成：${head}${tail}`);
    return { ok: true, ran: true, ...out };
  }

  function status() {
    const prefs = readPrefs();
    const last = readLast();
    const due = dailyDue({ prefs, last, now: now() });
    return { schema: 'daily.v1', prefs, last: last || null, due: { ok: due.ok, reason: due.reason }, plan: { counts: todayItems().counts } };
  }

  async function handleDaily(req, res, url) {
    const p = url.pathname;
    if (p === '/api/daily' && req.method === 'GET') return sendJson(res, 200, status());
    if (p === '/api/daily' && req.method === 'POST') {
      const body = (await readBody(req)) || {};
      const prefs = savePrefs(body.prefs || body || {});
      log(`[daily] 设置已更新：${prefs.enabled ? '开' : '关'} · ${prefs.at}${prefs.weekly ? ' · 顺手刷新巩固包' : ''}${prefs.push ? ' · 推手机' : ''}`);
      return sendJson(res, 200, { ...status(), saved: prefs });
    }
    if (p === '/api/daily/run' && req.method === 'POST') {
      const body = (await readBody(req)) || {};
      const r = await runOnce({ dryRun: body.dry_run !== false, force: body.force === true });
      return sendJson(res, r.ok ? 200 : 400, { ...r, status: status() });
    }
    return sendError(res, 404, '没有这个接口');
  }

  return { readPrefs, savePrefs, readLast, runOnce, status, todayItems, handleDaily };
}
