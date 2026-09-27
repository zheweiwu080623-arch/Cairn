// routes/mobile.mjs —— 「手机 / 办公本」通道的十条 HTTP 路径（R2 拆分：P0）。
//
//   GET  /api/mobile                → 手机侧偏好（掩码）+ 日历订阅地址 + 上次结果
//   POST /api/mobile                → 保存手机侧偏好（含开关局域网小服务）
//   POST /api/mobile/bark/test      → 发一条测试推送
//   POST /api/mobile/digest/send    → 立即发早报 / 晚报（kind=morning|evening|both）
//   POST /api/mobile/calendar/reset → 重置日历订阅密钥
//   POST /api/mobile/icloud/test    → 测 iCloud（CalDAV）连接
//   POST /api/mobile/icloud/sync    → 立即同步到 iCloud 日历
//   GET  /api/mobile/calendar.ics   → 下载 .ics
//   GET  /api/mobile/today.txt      → 今日 / 明日安排文本（办公本可直接读）
//   POST /api/mobile/files          → 把 today-plan / .ics 写到本地目录（数据线 / 网盘中转）
//   POST /api/mobile/open-folder    → 在文件管理器里打开那个目录
//
// 为什么把它从 server.mjs 搬出来：这一块是"手机侧的全部出入口"，自成一体；
// 主程序有条"别再长回去"的行数护栏，把它搬出来既腾了地方，也让审阅时能一眼看全手机通道。
//
// 安全边界（与之前完全一致，一行没改）：
//   * 读偏好一律给掩码（`lib/credential-mask.mjs`）；写回来时"带掩码 / 留空"= 沿用已存真值；
//   * 局域网那个只读小服务只暴露 `.ics` / `.txt` / 说明页，密钥是随机 token，可一键重置；
//   * open-folder 只打开目录（不存在就建），不删任何东西。

import { existsSync, mkdirSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { openPath } from '../server-shell.mjs';

export function createMobileRoutes(ctx) {
  const {
    store, sendJson, sendError, readBody,
    dataDir, mobilePort,
    // 手机侧的领域函数（都来自 lib/mobile.mjs，这里只做转发，不重写规则）
    mobileApi,
    maskMobilePrefs, sanitizeMobilePatch, buildIcs,
    appName = () => 'Cairn',
    briefFor = null,             // (kind) => 日报/晚报 brief（排序与「重要信息」同一套）
    lanServer,                   // { start(), stop(), running } —— 局域网只读小服务
    barkNotify,                  // ({title,body,url,level,force}) => Promise
  } = ctx;

  const {
    getMobilePrefs, saveMobilePrefs, ensureCalToken, calendarInfo,
    buildDigestText, writeMobileFiles, testIcloud, syncIcloud,
  } = mobileApi;

  const mobileDirDefault = () => join(dataDir, 'mobile');
  const maskPrefs = (prefs) => (maskMobilePrefs ? maskMobilePrefs(prefs) : prefs);

  /** 偏好快照：给界面用的一小包（含日历地址与两个"上次结果"）。 */
  function prefsPayload(prefs, { withLastResult = false } = {}) {
    const out = {
      prefs: maskPrefs(prefs),
      calendar: calendarInfo(store, { port: mobilePort }),
      mobile_dir_default: mobileDirDefault(),
    };
    if (withLastResult) {
      const readJson = (v) => { try { return v ? JSON.parse(v) : null; } catch { return null; } };
      out.last_digest = readJson(prefs.digest_result);
      out.last_icloud = readJson(prefs.icloud_result);
    }
    return out;
  }

  async function handleMobile(req, res, url) {
    const p = url.pathname;
    const method = req.method;
    if (!(p === '/api/mobile' || p.startsWith('/api/mobile/'))) return sendError(res, 404, '没有这个接口');

    if (p === '/api/mobile' && method === 'GET') {
      return sendJson(res, 200, prefsPayload(getMobilePrefs(store), { withLastResult: true }));
    }

    if (p === '/api/mobile' && method === 'POST') {
      const body = await readBody(req);
      const before = getMobilePrefs(store);
      const prefs = saveMobilePrefs(store, sanitizeMobilePatch(body, before));
      // 局域网小服务：跟着开关走（打开就起、关掉就停）
      if (prefs.lan_enabled && !before.lan_enabled) lanServer?.start?.();
      if (!prefs.lan_enabled && before.lan_enabled) lanServer?.stop?.();
      return sendJson(res, 200, prefsPayload(prefs));
    }

    if (p === '/api/mobile/bark/test' && method === 'POST') {
      const body = await readBody(req);
      if (body && body.bark_key !== undefined) {
        const before = getMobilePrefs(store);
        const patch = sanitizeMobilePatch(body, before);
        saveMobilePrefs(store, { bark_key: patch.bark_key ?? before.bark_key, bark_server: body.bark_server });
      }
      const nowLocal = new Date();
      const r = await barkNotify({
        title: '🧪 Planner 测试推送',
        body: `如果你在手机上看到这条，说明通知已经打通了。\n发送时间 ${nowLocal.toLocaleString('zh-CN')}`,
        level: 'active',
        force: true,
      });
      return sendJson(res, 200, r);
    }

    if (p === '/api/mobile/digest/send' && method === 'POST') {
      const body = await readBody(req);
      if (body && body.digest_to !== undefined) saveMobilePrefs(store, { digest_to: body.digest_to });
      return sendJson(res, 200, await mobileApi.sendDigestNow(store, {
        dataDir, appName: appName(),
        kind: String((body && body.kind) || 'morning').toLowerCase(),
        briefFor,
      }));
    }

    if (p === '/api/mobile/calendar/reset' && method === 'POST') {
      ensureCalToken(store, { reset: true });
      return sendJson(res, 200, { calendar: calendarInfo(store, { port: mobilePort }) });
    }

    if (p === '/api/mobile/icloud/test' && method === 'POST') {
      const body = await readBody(req);
      if (body) saveMobilePrefs(store, sanitizeMobilePatch(body, getMobilePrefs(store)));
      return sendJson(res, 200, await testIcloud(store));
    }

    if (p === '/api/mobile/icloud/sync' && method === 'POST') {
      const body = await readBody(req);
      if (body) saveMobilePrefs(store, sanitizeMobilePatch(body, getMobilePrefs(store)));
      return sendJson(res, 200, await syncIcloud(store, { force: true, log: (m) => console.log(m) }));
    }

    if (p === '/api/mobile/calendar.ics' && method === 'GET') {
      const i = buildIcs(store, {});
      res.writeHead(200, {
        'Content-Type': 'text/calendar; charset=utf-8',
        'Content-Disposition': 'attachment; filename="planner.ics"',
        'Cache-Control': 'no-store',
      });
      return res.end(i.ics);
    }

    if (p === '/api/mobile/today.txt' && method === 'GET') {
      res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store' });
      return res.end('\uFEFF' + buildDigestText(store, { days: 2, appName: appName() }));
    }

    if (p === '/api/mobile/files' && method === 'POST') {
      return sendJson(res, 200, writeMobileFiles(store, { dataDir }));
    }

    if (p === '/api/mobile/open-folder' && method === 'POST') {
      const body = await readBody(req);
      const dir = resolve(String((body && body.dir) || '').trim() || mobileDirDefault());
      let ok = false;
      try { ok = statSync(dir).isDirectory(); } catch { ok = false; }
      if (!ok) {
        try { mkdirSync(dir, { recursive: true }); ok = existsSync(dir); } catch { ok = false; }
      }
      if (!ok) return sendError(res, 400, '目录不存在且无法创建');
      // 2026-09-27：以前写死 explorer.exe，而且**忽略返回值恒回 ok:true** —— macOS / Linux 上
      // 点了会提示"已打开"其实没打开（Windows 上 explorer 失败时同样谎报）。
      // 现在按平台选 explorer / open / xdg-open，并把真实结果回给界面（失败前端会提示路径）。
      const r = await openPath(dir);
      return sendJson(res, r.ok ? 200 : 500, { ok: !!r.ok, dir, via: r.cmd || null, error: r.error || null });
    }

    return sendError(res, 404, '没有这个接口');
  }

  return { handleMobile, prefsPayload };
}
