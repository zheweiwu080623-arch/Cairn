// routes/local-drop.mjs —— 「本机备用投递口」的接口（2026-10-01 新增）
//
//   GET  /api/local-drop   → 就绪探测（给外部邮件桥的 --doctor 用，无副作用）
//   POST /api/local-drop   → 投一条内容进「通知」页：{ title, body, kind?, ref?, reason?, push?, urgent? }
//
// 为什么要有它：邮件桥（163 SMTP）会因服务商风控偶发拒绝发信（`535 authentication failed`）——
// 那段时间收信正常、发信全挂，回信与课程材料邮件都卡在 outbox 里等人。于是给"发不出去的东西"
// 一个**不依赖外网、不需要新凭据**的落点：外部邮件桥直接把内容投到本机 Cairn，用户打开应用就看得见。
//
// 三条刻意的边界：
//   1. **只接受本机**（loopback）来的请求 —— 这是"本机互投"，不是对外接口；
//   2. **不做任何外发**：不像 /api/automation/report 那样再走一次邮件（邮件正是坏的）；
//   3. **如实标注**：通知正文里会写清"这条走的是备用通道 + 为什么"，不假装邮件发出去了。
//
// 与外部邮件桥的约定（那边有一个 local_drop 适配器）：
//   成功 → `{ ok: true, notification_id, external_id, chars, pushed }`
//   重复（同 ref）→ `{ ok: true, skipped: 'duplicate' }`（外部邮件桥会把它当成功，不重试）

// 注意：这个值会**出现在通知页的"来源"上**，所以它必须是中性的（2026-10-02 从旧名改成 mail-bridge：
// 对外发的体验包里不许出现另一个项目的名字，用户明确要求过）。
export const LOCAL_DROP_SOURCE = 'mail-bridge';
export const LOCAL_DROP_MAX_CHARS = 20000;

/** 请求是不是从本机来的（127.0.0.1 / ::1）。 */
export function isLoopbackRequest(req) {
  const addr = String((req && req.socket && (req.socket.remoteAddress || '')) || '');
  return addr === '127.0.0.1' || addr === '::1' || addr === '::ffff:127.0.0.1';
}

/** 投一条（纯逻辑，便于测试；外部依赖全部注入）。 */
export async function ingestLocalDrop(req, body = {}, {
  store, barkNotify = null, log = () => {},
  source = LOCAL_DROP_SOURCE, maxChars = LOCAL_DROP_MAX_CHARS,
} = {}) {
  if (!isLoopbackRequest(req)) {
    return { ok: false, error: '这个投递口只接受本机（127.0.0.1）来的请求' };
  }
  const title = String(body.title || '备用通道投递').trim().slice(0, 200);
  const raw = String(body.body || body.message || '').trim();
  if (!raw) return { ok: false, error: '正文是空的（body 不能为空）' };
  const text = raw.length > maxChars
    ? `${raw.slice(0, maxChars)}\n\n…（正文超过 ${maxChars} 字，已截断）`
    : raw;
  const kind = String(body.kind || 'reply').trim() || 'reply';
  const ref = String(body.ref || '').trim();
  // 去重只对**带 ref 的投递**做（ref = 邮件桥那边的 outbox 文件名，重试时同一个）——
  // 没有 ref 的是临时投递，本来就没有"重试"语义，不去重（否则同一毫秒内的两条会被误判成重复）。
  const externalId = ref
    ? `mail-bridge-${ref}`
    : `mail-bridge-${kind}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  if (ref && store.listNotifications().some((n) => n.source === source && n.external_id === externalId)) {
    return { ok: true, skipped: 'duplicate', external_id: externalId };
  }
  const nowIso = new Date().toISOString();
  const reason = String(body.reason || '邮件通道发不出去').trim().slice(0, 200);
  const notif = store.createNotification({
    title,
    message: `${text}\n\n${'-'.repeat(48)}\n📨 这条走的是**备用通道**：${reason}，`
      + '内容先送到本机 Cairn（邮件恢复后仍会照常补发）。',
    trigger_at: nowIso,
    repeat: 'none',
    source,
    external_id: externalId,
    priority: 1,
    url: body.url || null,
    // silent = 只留一条记录、**不弹**系统通知（2026-10-02：给"任务完成"这类
    // 只为推手机而投的短消息用 —— 手机已经响了，页面上再弹一次是噪音）。
    ...(body.silent === true ? { last_fired_at: nowIso } : {}),
  });
  // 手机推送：备用通道是"故障兜底"，所以**不受"重点来源"过滤**（邮件桥通常不在那个清单里）；
  // 但**仍然尊重免打扰**（安静时段不响）。要连免打扰一起绕过，投递时带 `urgent: true`。
  let pushed = null;
  if (barkNotify && body.push !== false) {
    const urgent = body.urgent === true;
    try {
      pushed = await barkNotify({
        title, body: text.slice(0, 180), url: body.url || '',
        source, ignoreSource: !urgent, force: urgent,
      });
    } catch (e) {
      pushed = { ok: false, error: (e && e.message) || String(e) };
    }
  }
  log(`[local-drop] 收到「${title}」（${text.length} 字 · kind=${kind}）`
    + `${pushed ? ` · 手机推送：${pushed.ok ? '成功' : (pushed.skipped || pushed.error)}` : ''}`);
  return { ok: true, notification_id: notif.id, external_id: externalId, chars: text.length, pushed };
}

export function createLocalDropRoutes({
  store, sendJson, sendError, readBody, barkNotify = null, log = () => {},
} = {}) {
  async function handleLocalDrop(req, res, url) {
    const p = url && url.pathname;
    if (p !== '/api/local-drop') return sendError(res, 404, '没有这个接口');
    if (req.method === 'GET') {
      return sendJson(res, 200, {
        ok: true, schema: 'local-drop.v1',
        note: '本机备用投递口就绪：POST {title, body} 即可',
      });
    }
    if (req.method !== 'POST') return sendError(res, 405, '只支持 GET（探测）/ POST（投递）');
    const body = (await readBody(req)) || {};
    try {
      return sendJson(res, 200, await ingestLocalDrop(req, body, { store, barkNotify, log }));
    } catch (e) {
      log(`[local-drop] 投递失败：${(e && e.message) || e}`);
      // 与 /api/automation/report 一致：出错也用 200 + ok:false 回，让调用方看得懂原因
      return sendJson(res, 200, { ok: false, error: (e && e.message) || String(e) });
    }
  }
  return { handleLocalDrop };
}
