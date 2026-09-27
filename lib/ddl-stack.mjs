// ddl-stack.mjs —— 「DDL 到点提醒」的执行能力 + 接口（纯逻辑在 lib/ddl.mjs）。
//
// 用户原话："ddl 的时候提醒和倒计时其实也可以加上……不然有可能就真的忘了。"
// 引擎（`lib/ddl.mjs`：档位 / 倒计时文案 / 去重键）早就写好了，一直没接上；这里把它接起来：
//
//   GET  /api/ddl        → 设置 + 接下来要提醒的任务 + 已提醒条数
//   POST /api/ddl        → 改设置（开关 / 走不走手机 / 档位）
//   POST /api/ddl/check  → 立刻按档位查一遍（心跳里也调它）
//   POST /api/ddl/reset  → 清掉"已提醒"记录（想让它重新提醒时用；要 {"confirm":true}）
//
// 三条规矩：
//   1) **做完的（status=done）不再提醒**，没有 due_at 的不管；
//   2) 每一档只提醒一次（`ddl:<任务>:<档位>` 记在同步表里，跨重启有效，60 天后自动清）；
//   3) 手机只发一句话（≤60 字）—— 与项目里其它推送同一条规矩；要不要发由设置决定，默认不发。

import {
  DDL_FINAL_STEP_MS, countdownText, dueLevel, nextStep, normalizeDdlPrefs, pruneReminded, reminderKey, stepsDueNow,
} from './ddl.mjs';

export const DDL_PREFS_KEY = 'ddl_prefs_json';
export const DDL_SEEN_KEY = 'ddl_seen_json';

/** 找出"现在该提醒"的任务与档位（纯函数，好测）。 */
export function selectDdlReminders(tasks = [], { prefs, seen = {}, now = Date.now(), windowMs } = {}) {
  const p = normalizeDdlPrefs(prefs);
  const out = [];
  for (const t of tasks) {
    if (!t || t.status === 'done' || !t.due_at) continue;
    for (const s of stepsDueNow(t.due_at, now, p.steps, windowMs ? { windowMs } : undefined)) {
      const key = reminderKey(t.id, s.step);
      if (seen[key]) continue;
      out.push({
        task: t, step: s.step, label: s.label, key, at: s.at,
        level: dueLevel(t.due_at, now), countdown: countdownText(t.due_at, now),
      });
    }
  }
  return out.sort((a, b) => a.at - b.at);
}

export function createDdlStack({
  store, sendJson, sendError, readBody, notify, bark = null, log = () => {}, now = () => Date.now(),
} = {}) {
  // 默认的通知方式：进既有的通知表（source=ddl；external_id 用去重键，重启也不会重复提醒）
  const defaultNotify = ({ title, text, key, level }) => store.createNotification({
    title: String(title).slice(0, 120), message: String(text || ''),
    trigger_at: new Date(now()).toISOString(), repeat: 'none',
    source: 'ddl', external_id: key,
    priority: level === 'overdue' || level === 'urgent' ? 0 : 1, url: null,
  });
  const notifyFn = typeof notify === 'function' ? notify : defaultNotify;
  const readPrefs = () => {
    try { return normalizeDdlPrefs(JSON.parse(store.getSync(DDL_PREFS_KEY) || 'null')); }
    catch { return normalizeDdlPrefs({}); }
  };
  const savePrefs = (patch) => {
    const next = normalizeDdlPrefs({ ...readPrefs(), ...(patch || {}) });
    store.setSync(DDL_PREFS_KEY, JSON.stringify(next));
    return next;
  };
  const readSeen = () => {
    try { return JSON.parse(store.getSync(DDL_SEEN_KEY) || '{}') || {}; } catch { return {}; }
  };

  /** 接下来会提醒什么（界面用：让人一眼看到"什么时候会被叫"）。 */
  function upcoming() {
    const p = readPrefs();
    const t = now();
    const seen = readSeen();
    return store.listTasks()
      .filter((x) => x.status !== 'done' && x.due_at && Date.parse(x.due_at) > t)
      .map((x) => {
        const nx = nextStep(x.due_at, t, p.steps);
        return {
          id: x.id, title: x.title, due_at: x.due_at,
          countdown: countdownText(x.due_at, t), level: dueLevel(x.due_at, t),
          next_step: nx ? { at: nx.at, label: nx.label, sent: Boolean(seen[reminderKey(x.id, nx.step)]) } : null,
        };
      })
      .sort((a, b) => Date.parse(a.due_at) - Date.parse(b.due_at))
      .slice(0, 20);
  }

  function status() {
    const prefs = readPrefs();
    const seen = readSeen();
    return {
      schema: 'ddl.v1', prefs,
      seen_count: Object.keys(seen).length,
      upcoming: upcoming(),
      levels: { overdue: '已逾期', urgent: '1 小时内', today: '今天', soon: '3 天内', week: '7 天内', later: '更远' },
    };
  }

  /** 到点就提醒（心跳里调；没到档位就什么都不做）。 */
  async function maybeRun() {
    const prefs = readPrefs();
    if (!prefs.enabled) return { ok: true, ran: false, fired: 0, reason: 'DDL 提醒已关闭' };
    const t = now();
    const seen = readSeen();
    const due = selectDdlReminders(store.listTasks(), { prefs, seen, now: t });
    if (!due.length) return { ok: true, ran: false, fired: 0, reason: '没有刚该提醒的档位' };

    let fired = 0;
    let pushed = 0;
    for (const d of due) {
      const title = `${d.label}：${String(d.task.title || '').slice(0, 60)}`;
      const text = [d.countdown, d.task.due_at ? `截止 ${String(d.task.due_at).slice(0, 16).replace('T', ' ')}` : '']
        .filter(Boolean).join(' · ');
      try {
        notifyFn({ title, text, task: d.task, key: d.key, level: d.level });
        fired += 1;
      } catch (e) {
        log(`[ddl] 建通知失败：${(e && e.message) || e}`);
        continue;                                  // 建不成就不记"已提醒"，下次还能补
      }
      seen[d.key] = t;
      if (prefs.bark && typeof bark === 'function') {
        try {
          // 免打扰例外（2026-09-27）：最后一档 / 已逾期的 DDL 推手机时带上标记，
          // 用户在「设置 → 偏好 → 免打扰」里开着这个例外就照推。
          const isFinal = d.step <= DDL_FINAL_STEP_MS || d.level === 'overdue';
          const r = await bark({
            title: 'DDL 提醒', body: `${d.label}｜${String(d.task.title || '').slice(0, 30)}`,
            level: 'timeSensitive', important: isFinal ? 'ddl_final' : '',
          });
          if (r && r.ok) pushed += 1;
        } catch { /* 手机推不出去不影响应用内提醒 */ }
      }
    }
    store.setSync(DDL_SEEN_KEY, JSON.stringify(pruneReminded(seen, t)));
    log(`[ddl] 提醒 ${fired} 条${pushed ? `（手机 ${pushed} 条）` : ''}`);
    return { ok: true, ran: true, fired, pushed, items: due.map((d) => ({ title: d.task.title, label: d.label, level: d.level })) };
  }

  async function handleDdl(req, res, url) {
    const p = url.pathname;
    if (p === '/api/ddl' && req.method === 'GET') return sendJson(res, 200, status());
    if (p === '/api/ddl' && req.method === 'POST') {
      const body = (await readBody(req)) || {};
      const prefs = savePrefs(body.prefs || body || {});
      log(`[ddl] 设置已更新：${prefs.enabled ? '开' : '关'} · ${prefs.steps.map((s) => Math.round(s / 3600000) + 'h').join('/')}${prefs.bark ? ' · 推手机' : ''}`);
      return sendJson(res, 200, { ...status(), saved: prefs });
    }
    if (p === '/api/ddl/check' && req.method === 'POST') {
      const r = await maybeRun();
      return sendJson(res, 200, { ...r, status: status() });
    }
    if (p === '/api/ddl/reset' && req.method === 'POST') {
      const body = (await readBody(req)) || {};
      if (body.confirm !== true) return sendError(res, 400, '这会清掉"已提醒"记录（可能重新提醒一遍），确认就带 {"confirm":true}');
      store.setSync(DDL_SEEN_KEY, JSON.stringify({}));
      return sendJson(res, 200, { ...status(), reset: true });
    }
    return sendError(res, 404, '没有这个接口');
  }

  return { readPrefs, savePrefs, readSeen, maybeRun, status, upcoming, handleDdl };
}
