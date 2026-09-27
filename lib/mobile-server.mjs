// mobile-server.mjs —— 手机侧的**只读**小服务（默认端口 3211，R2 从 server.mjs 搬出来）。
//
// 它和主服务是刻意分开的两个东西：
//   * 主服务只监听 127.0.0.1（本机）；这个服务监听 0.0.0.0，好让同一 Wi-Fi 下的手机访问；
//   * 因此它**只暴露三样东西**：日历 `.ics`、今日文本 `.txt`、以及一个说明页；
//     设置、任务、邮件内容、凭据一律不在里面。
//   * 访问要带随机 token（`mobile_cal_token`，可在界面一键重置）；token 不对一律 404，
//     连"这个路径存在"都不告诉外面。
//
// 导出两件：
//   mobileReadHandler({...}) → 请求处理器（**纯函数式**，测试可以直接喂假 req/res）
//   createMobileServer({...}) → { start(), stop(), get running() }，负责监听/关闭

import { createServer } from 'node:http';
import { timingSafeEqual } from 'node:crypto';

import { MOBILE_KEYS } from './mobile.mjs';

/** 常数时间比较，避免"逐字符比较"泄露 token。长度不同直接判否。 */
export function tokenEquals(a, b) {
  const x = Buffer.from(String(a || ''));
  const y = Buffer.from(String(b || ''));
  if (!x.length || x.length !== y.length) return false;
  try { return timingSafeEqual(x, y); } catch { return false; }
}

/** 说明页（HTML 字符串单独放，处理器保持清爽）。 */
export function mobilePageHtml({ token, host }) {
  const base = `http://${host}/cal/${token}`;
  return `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>Planner 手机同步</title>
<style>body{font-family:-apple-system,'PingFang SC',sans-serif;background:#12131a;color:#e8eaf2;padding:24px;line-height:1.7}
a.btn{display:block;padding:14px 16px;margin:12px 0;border-radius:12px;background:#2a2f45;color:#e8eaf2;text-decoration:none}
a.primary{background:#3b6cf6}code{background:#20243a;padding:2px 6px;border-radius:6px;font-size:12px}</style></head>
<body><h2>Planner 手机同步</h2>
<p>iPhone：点下面的「订阅日历」，系统会问是否订阅，选"订阅"即可。课表、校历、DDL、里程碑会自动刷新。</p>
<a class="btn primary" href="webcal://${host}/cal/${token}.ics">订阅日历（iPhone 日历）</a>
<a class="btn" href="${base}.ics">下载 .ics 文件（一次性导入）</a>
<a class="btn" href="${base}.txt">查看今日安排文本（办公本可另存）</a>
<p style="opacity:.6;font-size:13px">此页面只在局域网内可用，链接里的密钥相当于密码，不要外发。</p></body></html>`;
}

/**
 * 请求处理器。依赖全部注入 ⇒ 单测里可以给假 store / 假 res，不需要真的监听端口。
 */
export function mobileReadHandler({ store, buildIcs, buildDigestText, appName = () => 'Cairn' }) {
  return (req, res) => {
    const url = new URL(req.url, `http://${req.headers?.host || 'localhost'}`);
    const seg = url.pathname.split('/').filter(Boolean);
    const token = String(store.getSync(MOBILE_KEYS.cal_token) || '');
    const head = (code, type, extra = {}) => res.writeHead(code, {
      'Content-Type': type,
      'Cache-Control': 'no-store',
      'Access-Control-Allow-Origin': '*',
      ...extra,
    });

    if (url.pathname === '/health') {
      head(200, 'application/json; charset=utf-8');
      res.end(JSON.stringify({ ok: true, app: 'planner-mobile' }));
      return;
    }
    // 路径不对、或 token 不对 → 统一 404（不区分"没有"和"没权限"）
    const given = seg[1] ? String(seg[1]).split('.')[0] : '';
    if (!seg.length || seg[0] !== 'cal' || !tokenEquals(given, token)) {
      head(404, 'text/plain; charset=utf-8');
      res.end('Not Found');
      return;
    }

    const want = String(seg[1]).split('.').slice(1).join('.');
    const host = req.headers?.host || '';
    try {
      if (want === 'ics') {
        const i = buildIcs(store, {});
        head(200, 'text/calendar; charset=utf-8', { 'Content-Disposition': 'inline; filename="planner.ics"' });
        res.end(i.ics);
        return;
      }
      if (want === 'txt') {
        head(200, 'text/plain; charset=utf-8');
        res.end('\uFEFF' + buildDigestText(store, { days: 2, appName: appName() }));
        return;
      }
      head(200, 'text/html; charset=utf-8');
      res.end(mobilePageHtml({ token, host }));
    } catch (e) {
      head(500, 'text/plain; charset=utf-8');
      res.end('生成失败：' + ((e && e.message) || e));
    }
  };
}

/**
 * 起 / 停那个只读服务。`start()` 幂等（已在跑就返回 already）。
 * 端口被占用时**不让主服务崩**：记一条警告、把自己置空，下次还能再试。
 */
export function createMobileServer({
  store, mobilePort, buildIcs, buildDigestText, appName, calendarInfo,
  log = () => {}, warn = () => {},
}) {
  let server = null;
  const handler = mobileReadHandler({ store, buildIcs, buildDigestText, appName });

  function start() {
    if (server) return { ok: true, already: true };
    server = createServer(handler);
    server.on('error', (e) => {
      warn(`[mobile] 手机同步端口 ${mobilePort} 打开失败：${(e && e.message) || e}`);
      server = null;
    });
    server.listen(mobilePort, '0.0.0.0', () => {
      const hosts = calendarInfo(store, { port: mobilePort }).urls;
      log(`[mobile] 手机同步已开启：${hosts.length ? hosts.map((h) => h.page).join(' , ') : '(未发现局域网地址)'}`);
    });
    return { ok: true, port: mobilePort };
  }

  function stop() {
    if (!server) return { ok: true, already: true };
    try { server.close(); } catch { /* ignore */ }
    server = null;
    return { ok: true };
  }

  return { start, stop, get running() { return !!server; } };
}
