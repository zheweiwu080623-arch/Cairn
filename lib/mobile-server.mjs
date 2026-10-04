// mobile-server.mjs —— 手机侧的**只读**小服务（默认端口 3211，R2 从 server.mjs 搬出来）。
//
// 它和主服务是刻意分开的两个东西：
//   * 主服务只监听 127.0.0.1（本机）；这个服务监听 0.0.0.0，好让同一 Wi-Fi 下的手机访问；
//   * 因此它**只暴露**：日历 `.ics`、今日文本 `.txt`、说明页、健康检查，以及 `/m/` 下的
//     手机界面（页面本体 + vm.json + manifest + sw.js + icon.svg，全部由服务端生成，无静态目录）；
//     设置、任务原始数据、邮件内容、凭据一律不在里面。
//   * 访问要带随机 token（`mobile_cal_token`，可在界面一键重置）；token 不对一律 404，
//     连"这个路径存在"都不告诉外面。两族路径（`/cal/` 与 `/m/`）共用同一把 token。
//
// 导出两件：
//   mobileReadHandler({...}) → 请求处理器（**纯函数式**，测试可以直接喂假 req/res）
//   createMobileServer({...}) → { start(), stop(), get running() }，负责监听/关闭

import { createServer } from 'node:http';
import { timingSafeEqual } from 'node:crypto';
import { appendFileSync } from 'node:fs';

import { MOBILE_KEYS, computerName } from './mobile.mjs';
import {
  mobileAppHtml, mobileIconSvg, mobileManifest, mobileServiceWorker,
} from './mobile-view.mjs';

/** 常数时间比较，避免"逐字符比较"泄露 token。长度不同直接判否。 */
export function tokenEquals(a, b) {
  const x = Buffer.from(String(a || ''));
  const y = Buffer.from(String(b || ''));
  if (!x.length || x.length !== y.length) return false;
  try { return timingSafeEqual(x, y); } catch { return false; }
}

/**
 * 说明页（HTML 字符串单独放，处理器保持清爽）。
 *
 * `byName` = 用**电脑名字**访问的那条地址（如 LAPTOP-POTSMUO9）。它不是装饰：
 * IP 会随网络变（2026-10-03 实测 192.168.124.28 → 192.168.31.144），名字不会；
 * 家用路由器的 DNS 一般认得 DHCP 主机名，所以换 Wi-Fi 之后这条链接照样能用。
 */
export function mobilePageHtml({ token, host, byName = '' }) {
  const base = `http://${host}/cal/${token}`;
  const nameEntry = byName && byName !== host
    ? `<a class="btn primary" href="http://${byName}/p/${token}/">打开手机版界面（换网络也不用改：${byName}）</a>`
    : '';
  const changeNet = '<p style="opacity:.6;font-size:13px">换了 Wi-Fi / 路由器之后打不开？先确认平板和电脑在同一个网络；再看电脑上 Cairn「手机同步」那一栏显示的新地址（用电脑名的那条通常不用改）。如果新网络的路由器认不出电脑名字，就换成它下面列出的 IP 地址。</p>';
  return `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>Planner 手机同步</title>
<style>body{font-family:-apple-system,'PingFang SC',sans-serif;background:#12131a;color:#e8eaf2;padding:24px;line-height:1.7}
a.btn{display:block;padding:14px 16px;margin:12px 0;border-radius:12px;background:#2a2f45;color:#e8eaf2;text-decoration:none}
a.primary{background:#3b6cf6}code{background:#20243a;padding:2px 6px;border-radius:6px;font-size:12px}</style></head>
<body><h2>Planner 手机同步</h2>
<p>安卓 / 鸿蒙（平板、手机）：直接进下面的「手机版界面」，可以「添加到主屏幕」当 App 用。</p>
${nameEntry}
<a class="btn primary" href="http://${host}/p/${token}/">打开手机版界面（今日 / 日程 / 任务 / 提醒）</a>
<p style="opacity:.6;font-size:13px">如果之前用过 <code>/m/</code> 开头的老地址并卡在旧版，请改用上面这个 <code>/p/</code> 地址，并重新「添加到主屏幕」。</p>
<p>iPhone：点下面的「订阅日历」，系统会问是否订阅，选"订阅"即可。课表、校历、DDL、里程碑会自动刷新。</p>
<a class="btn" href="webcal://${host}/cal/${token}.ics">订阅日历（iPhone 日历）</a>
<a class="btn" href="${base}.ics">下载 .ics 文件（一次性导入）</a>
<a class="btn" href="${base}.txt">查看今日安排文本（办公本可另存）</a>
${changeNet}
<p style="opacity:.6;font-size:13px">此页面只在局域网内可用，链接里的密钥相当于密码，不要外发。</p></body></html>`;
}

/**
 * 请求处理器。依赖全部注入 ⇒ 单测里可以给假 store / 假 res，不需要真的监听端口。
 */
export function mobileReadHandler({
  store, buildIcs, buildDigestText, appName = () => 'Cairn', buildState = null, buildVM = null,
  buildWeek = null, accessLog = '',
}) {
  return (req, res) => {
    const url = new URL(req.url, `http://${req.headers?.host || 'localhost'}`);
    const seg = url.pathname.split('/').filter(Boolean);
    const startedAt = Date.now();
    // 访问留痕：**只记路径、不记 token**（token 一律折叠成 `<token>`）。
    // 用途很实在——"平板到底有没有够到电脑"这件事，以前只能猜。
    if (accessLog) {
      res.on('finish', () => {
        try {
          const safe = url.pathname.replace(/\/(cal|m|p)\/[^/]+/g, '/$1/<token>');
          const ua = String(req.headers?.['user-agent'] || '').slice(0, 60);
          const ip = String(req.socket?.remoteAddress || '');
          appendFileSync(
            accessLog,
            `${new Date().toISOString()}\t${req.method}\t${safe}${url.search}\t${res.statusCode}\t${Date.now() - startedAt}ms\t${ip}\t${ua}\n`,
          );
        } catch { /* 记日志失败绝不影响响应 */ }
      });
    }
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
    const family = seg[0];
    // 三族路径共用同一把 token：`cal` 是日历/文本，`m` 是老入口，`p` 是新入口。
    // 为什么要 `p`：早期版本的 Service Worker 作用域是 `/m/<token>/`，会把 `/m/` 的
    // 页面**缓存优先**地钉死在旧版（服务端改了也没用）。`/p/` 不在它的作用域里，
    // 因此天然拿得到最新页面 —— 这是"绕过历史缓存"的干净做法。
    const FAMILIES = ['cal', 'm', 'p'];
    if (!seg.length || FAMILIES.indexOf(family) < 0 || !tokenEquals(given, token)) {
      head(404, 'text/plain; charset=utf-8');
      res.end('Not Found');
      return;
    }

    // ---- /m/<token>/… 与 /p/<token>/… ：手机端界面（同一把 token，只读） ----
    if (family === 'm' || family === 'p') {
      const what = seg[2] || 'index.html';
      try {
        if (what === 'vm.json') {
          if (!buildVM || !buildState) {
            head(503, 'application/json; charset=utf-8');
            res.end(JSON.stringify({ error: '手机界面尚未接线' }));
            return;
          }
          head(200, 'application/json; charset=utf-8');
          res.end(JSON.stringify(buildVM(buildState())));
          return;
        }
        // 日程页：任意一周（offset 相对本周，单位周）
        if (what === 'week.json') {
          if (!buildWeek || !buildState) {
            head(503, 'application/json; charset=utf-8');
            res.end(JSON.stringify({ error: '日程页尚未接线' }));
            return;
          }
          const off = Number(url.searchParams.get('offset') || 0);
          head(200, 'application/json; charset=utf-8');
          res.end(JSON.stringify(buildWeek(buildState(), Number.isFinite(off) ? off : 0)));
          return;
        }
        if (what === 'manifest.webmanifest') {
          head(200, 'application/manifest+json; charset=utf-8');
          res.end(JSON.stringify(mobileManifest({ token, appName: appName(), family })));
          return;
        }
        if (what === 'sw.js') {
          head(200, 'text/javascript; charset=utf-8');
          res.end(mobileServiceWorker());
          return;
        }
        if (what === 'icon.svg') {
          head(200, 'image/svg+xml; charset=utf-8');
          res.end(mobileIconSvg());
          return;
        }
        if (what === 'index.html') {
          // 顺手让浏览器丢掉本站缓存（Chrome 只在安全上下文生效，HTTP 下会被忽略，
          // 但发出去无害；配合标题里的版本号，能覆盖"平板卡在旧版"这一类问题）。
          head(200, 'text/html; charset=utf-8', { 'Clear-Site-Data': '"cache", "storage"' });
          res.end(mobileAppHtml({ token, appName: appName() }));
          return;
        }
        head(404, 'text/plain; charset=utf-8');
        res.end('Not Found');
        return;
      } catch (e) {
        head(500, 'text/plain; charset=utf-8');
        res.end('生成失败：' + ((e && e.message) || e));
        return;
      }
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
      // byName：把"用电脑名字"的那条也摆上来 —— 换网络后 IP 会变，名字不变。
      // 端口从请求的 Host 里取（Host 形如 192.168.31.144:3211），否则拼出来的链接会掉端口。
      const portPart = /:(\d+)$/.exec(host);
      const cn = computerName();
      res.end(mobilePageHtml({ token, host, byName: cn ? `${cn}${portPart ? `:${portPart[1]}` : ''}` : '' }));
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
  buildState = null, buildVM = null, buildWeek = null, accessLog = '',
  log = () => {}, warn = () => {},
}) {
  // 可能同时开两个：IPv4（0.0.0.0）和 IPv6（::，仅 v6）。
  // 为什么加 IPv6：路由器会把电脑名字解析成 A + AAAA 两条，客户端（安卓）可能**先试 IPv6**；
  // 只监听 IPv4 时这一下要先失败再回退，慢起来就像"换了网络打不开"（2026-10-03 实测本机有公网 IPv6）。
  let servers = [];
  const handler = mobileReadHandler({
    store, buildIcs, buildDigestText, appName, buildState, buildVM, buildWeek, accessLog,
  });

  function open(host, options) {
    const s = createServer(handler);
    s.on('error', (e) => {
      warn(`[mobile] 监听 ${host}:${mobilePort} 失败：${(e && e.message) || e}`);
      const i = servers.indexOf(s);
      if (i >= 0) servers.splice(i, 1);
    });
    s.listen(mobilePort, host, options);
    servers.push(s);
  }

  function start() {
    if (servers.length) return { ok: true, already: true };
    open('0.0.0.0');                    // 局域网里任何设备都能连（一直是这样）
    open('::', { ipv6Only: true });     // 与 IPv4 并存；失败只是少一条路，会记一条警告
    const hosts = calendarInfo(store, { port: mobilePort }).urls;
    log(`[mobile] 手机同步已开启：${hosts.length ? hosts.map((h) => h.page).join(' , ') : '(未发现局域网地址)'}`);
    return { ok: true, port: mobilePort };
  }

  function stop() {
    if (!servers.length) return { ok: true, already: true };
    for (const s of servers) { try { s.close(); } catch { /* ignore */ } }
    servers = [];
    return { ok: true };
  }

  return { start, stop, get running() { return servers.length > 0; } };
}
