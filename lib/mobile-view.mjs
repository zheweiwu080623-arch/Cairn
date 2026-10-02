// mobile-view.mjs —— 手机 / 平板端的**真正的界面**。
//
// 为什么单独一个文件、而不是把 HTML 塞进 mobile-server.mjs：
//   * mobile-server 的职责是"守边界"（token 门禁 + 只读），界面属于另一个关注点；
//   * 界面**不另写一套渲染逻辑**：直接用 public/viewmodel.js 的纯函数产出 ViewModel，
//     所以手机页和桌面页看到的是同一个对象（同一个契约 contracts/viewmodel.v1.schema.json）。
//     这也兑现了 viewmodel.js 头部那句注释："the same object can feed the browser,
//     the native shell, the CLI, email and Markdown"——现在多了一个"手机页"。
//
// 安全边界与 mobile-server 完全一致：token 不对一律 404，连"这个路径存在"都不告诉外面。

import {
  buildNotificationsVM, buildTasksVM, buildTodayVM, calendarWeekSelection, renderText, weekNumberOf,
} from '../public/viewmodel.js';

/** 手机端要的那一坨数据。只依赖 state 里的六项（tasks/events/notifications/codex/courses/academic）。 */
export function buildMobileVM(state, nowMs = Date.now()) {
  const today = buildTodayVM(state, nowMs);
  return {
    schema: 'mobile-vm.v1',
    generated_at: new Date(nowMs).toISOString(),
    today,
    tasks: buildTasksVM(state, nowMs),
    notifications: buildNotificationsVM(state, nowMs),
    calendar: calendarWeekSelection(state, { cursorMs: nowMs }),
    anki: state.anki || null,
    // 兜底：万一渲染脚本挂了，纯文本也还能看（办公本就是靠这个）
    plain: renderText(today),
  };
}

const WEEK_MS = 7 * 24 * 3600 * 1000;

/** 任意一周的日程（`offset` 相对本周，单位周）。 */
export function buildMobileWeekVM(state, offset = 0, nowMs = Date.now()) {
  const n = Number.isFinite(Number(offset)) ? Math.trunc(Number(offset)) : 0;
  const cursorMs = nowMs + n * WEEK_MS;
  const calendar = calendarWeekSelection(state, { cursorMs });
  return {
    schema: 'mobile-week.v1',
    generated_at: new Date(nowMs).toISOString(),
    offset: n,
    week_no: weekNumberOf(state, new Date(cursorMs)),
    cursor_ms: cursorMs,
    calendar,
  };
}

const ESC = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ESC[c]);

/**
 * 手机界面外壳的版本号。**改了 HTML/CSS/JS 就 +1**。
 * 它会出现在三个地方：标签页标题、页面右上角的小徽章、以及加载提示那行 —— 
 * 这样"平板看到的是不是新版"一眼可辨，不用再靠猜。
 */
export const MOBILE_SHELL_VERSION = 'v5';

/** 图标：一个内联 SVG（不额外托管二进制文件）。 */
export function mobileIconSvg() {
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512">
<rect width="512" height="512" rx="112" fill="#0f1115"/>
<path d="M256 96l112 64v128l-112 64-112-64V160z" fill="none" stroke="#7aa2ff" stroke-width="26" stroke-linejoin="round"/>
<path d="M256 224l112-64M256 224l-112-64M256 224v128" stroke="#7aa2ff" stroke-width="26" stroke-linecap="round"/>
<circle cx="256" cy="224" r="20" fill="#7aa2ff"/></svg>`;
}

/** PWA 清单：start_url 带 token，所以它只在这个 token 下有效。 */
export function mobileManifest({ token, appName = 'Cairn', family = 'm' }) {
  const root = `/${family === 'p' ? 'p' : 'm'}/${token}/`;
  return {
    name: `${appName} · 手机版`,
    short_name: appName,
    description: '今日安排 / 任务 / 提醒的手机端界面',
    start_url: root,
    scope: root,
    display: 'standalone',
    background_color: '#0f1115',
    theme_color: '#0f1115',
    icons: [{ src: 'icon.svg', sizes: 'any', type: 'image/svg+xml', purpose: 'any maskable' }],
  };
}

/**
 * `/m/<token>/sw.js` —— **自毁式 Service Worker**。
 *
 * 走过的弯路（值得留档）：最早我们注册了一个"缓存优先"的 SW，结果平板被钉在
 * 第一版上；改成网络优先后发现仍然可能旧 —— 因为浏览器对 SW 脚本的更新检查
 * 有节流（最坏 24 小时一次），而这期间旧 SW 照旧把缓存里的旧外壳发给你，
 * 服务端的改动根本没机会到达页面。
 *
 * 结论：这个只读小服务**不需要 SW**（数据本来就 `no-store`，离线外壳价值有限，
 * 却换来一整个类别"永远看到第一版"的坑）。所以现在这里发的是一个**自毁脚本**：
 * 浏览器哪一次来取它（页面里的自愈逻辑、或它自己的更新检查），都会顺手
 * 清空所有缓存、注销自己，并让已打开的页面重新导航 —— 从此回到"每次都从网络拿"。
 */
export function mobileServiceWorker() {
  return `// 自毁：清缓存 → 注销自己 → 让受控页面重新导航
self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (e) => {
  e.waitUntil((async () => {
    try {
      const keys = await caches.keys();
      await Promise.all(keys.map((k) => caches.delete(k)));
    } catch (err) {}
    try {
      const clients = await self.clients.matchAll({ type: 'window' });
      clients.forEach((c) => { try { c.navigate(c.url); } catch (err) {} });
    } catch (err) {}
    try { await self.registration.unregister(); } catch (err) {}
  })());
});`;
}

/**
 * 手机页外壳。刻意做成**自包含**（样式与脚本内联）：
 * 少一个静态资源就少一条要守的路由，边界更好证明。
 */
export function mobileAppHtml({ token, appName = 'Cairn' }) {
  const t = esc(token);
  const v = MOBILE_SHELL_VERSION;
  return `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover" />
<meta name="theme-color" content="#0f1115" />
<link rel="manifest" href="manifest.webmanifest" />
<link rel="apple-touch-icon" href="icon.svg" />
<link rel="icon" href="icon.svg" />
<title>${esc(appName)} · 手机版 ${v}</title>
<style>
  :root{
    --bg:#0f1115; --card:#171a21; --card2:#1e222b; --line:#272c37;
    --fg:#e8eaf2; --dim:#9aa3b5; --accent:#7aa2ff; --ok:#3ddc97; --warn:#ffcc66; --err:#ff6b6b;
    --r:14px; --pad:14px;
  }
  @media (prefers-color-scheme: light){
    :root{ --bg:#f6f7fb; --card:#fff; --card2:#f1f3f9; --line:#e3e6ef; --fg:#1b1e27; --dim:#6b7387; }
  }
  *{box-sizing:border-box}
  body{margin:0;background:var(--bg);color:var(--fg);
    font:15px/1.55 -apple-system,BlinkMacSystemFont,"HarmonyOS Sans SC","PingFang SC","Microsoft YaHei",sans-serif;
    padding:env(safe-area-inset-top) 0 calc(72px + env(safe-area-inset-bottom));}
  header{position:sticky;top:0;z-index:5;background:var(--bg);padding:12px var(--pad) 8px;
    border-bottom:1px solid var(--line);display:flex;align-items:center;gap:10px}
  header h1{font-size:16px;margin:0;font-weight:600;flex:1}
  header .meta{font-size:11px;color:var(--dim)}
  header .ver{font-size:11px;color:var(--dim);border:1px solid var(--line);border-radius:6px;padding:0 6px}
  button{font:inherit;color:inherit;background:var(--card2);border:1px solid var(--line);
    border-radius:10px;padding:6px 10px}
  main{padding:var(--pad);display:grid;gap:var(--pad)}
  .summary{background:var(--card);border:1px solid var(--line);border-radius:var(--r);padding:12px 14px}
  .summary b{font-size:20px}
  section.card{background:var(--card);border:1px solid var(--line);border-radius:var(--r);overflow:hidden}
  section.card > h2{font-size:13px;margin:0;padding:10px 14px;color:var(--dim);
    border-bottom:1px solid var(--line);font-weight:600;letter-spacing:.02em}
  ul{list-style:none;margin:0;padding:0}
  li{padding:11px 14px;border-bottom:1px solid var(--line)}
  li:last-child{border-bottom:0}
  li .t{font-weight:500}
  li .m{font-size:12px;color:var(--dim);margin-top:2px}
  li.err{border-left:3px solid var(--err)} li.warn{border-left:3px solid var(--warn)}
  li.ok{border-left:3px solid var(--ok)} li.info{border-left:3px solid var(--accent)}
  li.muted{opacity:.55}
  .empty{padding:14px;color:var(--dim);font-size:13px}
  .err-box{background:var(--card);border:1px solid var(--err);border-radius:var(--r);padding:14px}
  .err-box p{margin:.4em 0;font-size:13px;color:var(--dim)}
  nav{position:fixed;left:0;right:0;bottom:0;display:flex;background:var(--card);
    border-top:1px solid var(--line);padding-bottom:env(safe-area-inset-bottom)}
  nav a{flex:1;text-align:center;padding:12px 4px;color:var(--dim);text-decoration:none;font-size:12px}
  nav a.on{color:var(--accent)}
  a.link{color:var(--accent)}
  .hint{font-size:12px;color:var(--dim);padding:0 var(--pad) 6px}
  .weekbar{display:flex;align-items:center;gap:8px;padding:10px 14px;border-bottom:1px solid var(--line)}
  .weekbar .lbl{flex:1;font-size:13px;color:var(--dim);text-align:center}
  .day{border-bottom:1px solid var(--line)}
  .day:last-child{border-bottom:0}
  .dayh{display:flex;align-items:baseline;gap:8px;padding:9px 14px 4px;font-size:12px;color:var(--dim)}
  .dayh .d{font-weight:600;color:var(--fg);font-size:13px}
  .dayh .t{color:var(--accent);font-size:11px}
  .row{display:flex;align-items:baseline;gap:8px;padding:7px 14px 7px 20px;font-size:13px;
    border-left:3px solid transparent}
  .row.course{border-left-color:var(--accent)}
  .row.event{border-left-color:var(--ok)}
  .row.acad{border-left-color:var(--warn)}
  .row .tm{flex:0 0 92px;font-size:12px;color:var(--dim);font-variant-numeric:tabular-nums}
  .row.course .tm{color:var(--accent);font-weight:600}
  .row .tt{flex:1;min-width:0}
  .row .loc{flex:0 0 auto;font-size:11px;color:var(--dim);border:1px solid var(--line);
    border-radius:6px;padding:0 6px;white-space:nowrap}
  .day .none{padding:6px 14px 10px 20px;font-size:12px;color:var(--dim)}
  section.card.today{border-color:var(--accent)}
  section.card > h2 .sub{font-weight:400;color:var(--dim);margin-left:6px}
</style>
</head>
<body>
<header>
  <h1 id="title">${esc(appName)}</h1>
  <span class="ver">${v}</span>
  <span class="meta" id="stamp"></span>
  <button id="refresh" type="button">刷新</button>
</header>
<div class="hint" id="hint">正在加载…</div>
<main id="view"></main>
<nav>
  <a href="#today" data-tab="today">今日</a>
  <a href="#schedule" data-tab="schedule">日程</a>
  <a href="#tasks" data-tab="tasks">任务</a>
  <a href="#notifications" data-tab="notifications">提醒</a>
</nav>
<script>
(function () {
  var TOKEN = ${JSON.stringify(t)};
  // 入口可能是 /m/<token>/ 也可能是 /p/<token>/（后者用来绕过历史 Service Worker 缓存），
  // 所以数据接口的基路径从当前地址推出来，不写死。
  var BASE = location.pathname.replace(/[^/]*$/, '');
  var API = BASE + 'vm.json';
  var view = document.getElementById('view');
  var hint = document.getElementById('hint');
  var stamp = document.getElementById('stamp');
  var titleEl = document.getElementById('title');
  var data = null;
  var tab = 'today';
  var week = null;
  var weekOffset = 0;
  var SHELL_VERSION = '${v}';   // 与移动端的 MOBILE_SHELL_VERSION 同源

  function el(tag, cls, text) {
    var n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text != null) n.textContent = text;
    return n;
  }

  function renderItems(items) {
    var ul = el('ul');
    (items || []).forEach(function (it) {
      var li = el('li', it.level || 'info');
      li.appendChild(el('div', 't', it.title));
      if (it.meta) li.appendChild(el('div', 'm', it.meta));
      if (it.url) {
        var a = el('a', 'link', '打开链接');
        a.href = it.url; a.target = '_blank'; a.rel = 'noreferrer';
        li.appendChild(a);
      }
      ul.appendChild(li);
    });
    return ul;
  }

  function renderVM(vm) {
    view.textContent = '';
    var s = el('div', 'summary');
    var b = el('b', null, String(vm.badge == null ? '' : vm.badge));
    s.appendChild(el('div', null, vm.title));
    s.appendChild(b);
    s.appendChild(el('div', 'm', vm.summary || ''));
    view.appendChild(s);
    (vm.sections || []).forEach(function (sec) {
      var box = el('section', 'card');
      box.appendChild(el('h2', null, sec.title));
      if (sec.items && sec.items.length) {
        box.appendChild(renderItems(sec.items));
      } else {
        box.appendChild(el('div', 'empty', sec.note || '暂无内容'));
      }
      view.appendChild(box);
    });
    if (vm.summary && vm.sections && vm.sections.length === 0) {
      var e = el('div', 'empty', '这一页还没有内容。先到电脑上的 Cairn 添加任务或提醒。');
      view.appendChild(e);
    }
  }

  function renderError(err) {
    view.textContent = '';
    var box = el('div', 'err-box');
    box.appendChild(el('div', null, '加载失败'));
    box.appendChild(el('p', null, err));
    box.appendChild(el('p', null, '检查：① 电脑上的 Cairn 在运行；② 平板和电脑在同一个 Wi-Fi；③ 密钥没过期（电脑上「数据源 → 手机与办公本」可一键重置）。'));
    var btn = el('button', null, '重试');
    btn.onclick = function () { load(); };
    box.appendChild(btn);
    view.appendChild(box);
  }

  function paint() {
    Array.prototype.forEach.call(document.querySelectorAll('nav a'), function (a) {
      a.className = a.getAttribute('data-tab') === tab ? 'on' : '';
    });
    titleEl.textContent = TITLES[tab] || '';
    if (tab === 'schedule') {
      if (week) renderWeek(); else loadWeek(weekOffset);
      return;
    }
    if (!data) return;
    var vm = data[tab];
    if (vm) renderVM(vm);
    // 「今日」页的顶部补一块当天的课（课程在另一张表里，桌面版今日页没有它）
    if (tab === 'today') {
      var tc = todayCard('course');
      if (tc) view.insertBefore(tc, view.firstChild);
      var ak = ankiCard(data.anki);
      if (ak) view.appendChild(ak);
    }
    hint.textContent = data.generated_at ? '数据生成于 ' + new Date(data.generated_at).toLocaleTimeString() : '';
    hint.textContent += ' · 界面 ' + SHELL_VERSION;
  }

  function tm(s) {
    if (!s) return '';
    var m = String(s).match(/(\\d{2}:\\d{2})/);
    return m ? m[1] : '';
  }

  var DOW = ['周一', '周二', '周三', '周四', '周五', '周六', '周日'];
  var TITLES = { today: '今日', schedule: '日程', tasks: '任务', notifications: '提醒' };

  // 本地日期键（不能用 toISOString：那是 UTC，早上 8 点前会算成昨天）
  function localKey(dt) {
    var m = dt.getMonth() + 1, d = dt.getDate();
    return dt.getFullYear() + '-' + (m < 10 ? '0' : '') + m + '-' + (d < 10 ? '0' : '') + d;
  }
  var todayKey = localKey(new Date());
  function mins(s) {
    var t = tm(s);
    if (!t) return null;
    var p = t.split(':');
    return (+p[0]) * 60 + (+p[1]);
  }

  /** 一天里的全部条目：课程 / 日程 / 校历，合并后按开始时间排序（没时间的排最后）。 */
  function dayItems(d, only) {
    var out = [];
    (d.courses || []).forEach(function (c) {
      out.push({ kind: 'course', t: [tm(c.start_at), tm(c.end_at)].filter(Boolean).join('-'),
        sort: mins(c.start_at), title: c.course, loc: c.location });
    });
    (d.events || []).forEach(function (e) {
      out.push({ kind: 'event', t: [tm(e.start_at), tm(e.end_at)].filter(Boolean).join('-'),
        sort: mins(e.start_at), title: e.title, loc: e.location });
    });
    (d.acad || []).forEach(function (a) {
      out.push({ kind: 'acad', t: [tm(a.start_at), tm(a.end_at)].filter(Boolean).join('-'),
        sort: mins(a.start_at), title: a.title, loc: '' });
    });
    out.sort(function (x, y) {
      return (x.sort == null ? 9999 : x.sort) - (y.sort == null ? 9999 : y.sort);
    });
    return only ? out.filter(function (it) { return it.kind === only; }) : out;
  }

  /** 一行：时间（左）· 标题 · 地点（右，独立标签）。 */
  function rowEl(it) {
    var r = el('div', 'row ' + it.kind);
    if (it.t) r.appendChild(el('span', 'tm', it.t));
    r.appendChild(el('span', 'tt', it.title));
    if (it.loc) r.appendChild(el('span', 'loc', it.loc));
    return r;
  }

  function todayDay() {
    var cal = (data && data.calendar) || null;
    if (!cal) return null;
    for (var i = 0; i < (cal.days || []).length; i++) if (cal.days[i].key === todayKey) return cal.days[i];
    return null;
  }

  /** 「今天」卡片。only='course' 时只显示课程（给「今日」页当顶部块用）。 */
  function todayCard(only) {
    var d = todayDay();
    if (!d) return null;
    var box = el('section', 'card today');
    var h = el('h2');
    h.appendChild(document.createTextNode(only === 'course' ? '今天的课' : '今天'));
    h.appendChild(el('span', 'sub', DOW[d.dow] + ' ' + (d.monthIndex + 1) + '月' + d.date + '日'));
    box.appendChild(h);
    var items = dayItems(d, only);
    if (!items.length) box.appendChild(el('div', 'none', only === 'course' ? '今天没有课' : '今天没有安排'));
    items.forEach(function (it) { box.appendChild(rowEl(it)); });
    return box;
  }

  /** Anki 卡片：今日待复习多少张。数据来自服务端只读读出的 Anki 库。 */
  function ankiCard(a) {
    if (!a) return null;
    var box = el('section', 'card anki');
    box.appendChild(el('h2', null, 'Anki 复习'));
    if (!a.ok) {
      box.appendChild(el('div', 'none', a.error || 'Anki 未接入'));
      return box;
    }
    var sum = el('div', 'row');
    sum.appendChild(el('span', 'tm', '今日'));
    sum.appendChild(el('span', 'tt', '待复习 ' + (a.due ? a.due.total : 0) + ' 张'));
    box.appendChild(sum);
    var detail = [];
    if (a.due && a.due.new) detail.push('新 ' + a.due.new);
    if (a.due && a.due.learning) detail.push('学习中 ' + a.due.learning);
    if (a.due && a.due.review) detail.push('复习 ' + a.due.review);
    var meta = el('div', 'row');
    meta.appendChild(el('span', 'tm', '细分'));
    meta.appendChild(el('span', 'tt', detail.length ? detail.join(' · ') : '没有到期卡'));
    box.appendChild(meta);
    var sync = el('div', 'row');
    sync.appendChild(el('span', 'tm', '同步'));
    sync.appendChild(el('span', 'tt', a.never_synced
      ? '从未同步（电脑上登录 AnkiWeb 后点一次同步）'
      : (a.last_sync_at ? new Date(a.last_sync_at).toLocaleString() : '未知')));
    box.appendChild(sync);
    var total = el('div', 'row');
    total.appendChild(el('span', 'tm', '总量'));
    total.appendChild(el('span', 'tt', '共 ' + a.total_cards + ' 张 / ' + a.total_notes + ' 条笔记'));
    box.appendChild(total);
    if (a.note) box.appendChild(el('div', 'none', a.note));
    return box;
  }

  function renderDay(d, box) {
    var day = el('div', 'day');
    var h = el('div', 'dayh');
    h.appendChild(el('span', 'd', DOW[d.dow] + ' ' + (d.monthIndex + 1) + '月' + d.date + '日'));
    if (d.key === todayKey) h.appendChild(el('span', 't', '今天'));
    day.appendChild(h);
    var items = dayItems(d);
    if (!items.length) day.appendChild(el('div', 'none', '无安排'));
    items.forEach(function (it) { day.appendChild(rowEl(it)); });
    box.appendChild(day);
  }

  function renderWeek() {
    if (!week || !week.calendar) return;
    var cal = week.calendar;
    var days = cal.days || [];
    view.textContent = '';

    // 最上头固定放"今天"，翻到别的周也看得到（它永远取本周的那一天）
    var tc = todayCard();
    if (tc) view.appendChild(tc);

    var box = el('section', 'card');
    var bar = el('div', 'weekbar');
    var prev = el('button', null, '‹ 上一周');
    var lbl = el('span', 'lbl', (week.week_no ? '第 ' + week.week_no + ' 周 · ' : '') +
      ((days[0] && (days[0].monthIndex + 1) + '月' + days[0].date + '日') || '') + ' – ' +
      ((days[6] && (days[6].monthIndex + 1) + '月' + days[6].date + '日') || ''));
    var next = el('button', null, '下一周 ›');
    prev.onclick = function () { loadWeek(weekOffset - 1); };
    next.onclick = function () { loadWeek(weekOffset + 1); };
    lbl.onclick = function () { loadWeek(0); };
    bar.appendChild(prev); bar.appendChild(lbl); bar.appendChild(next);
    box.appendChild(bar);
    days.forEach(function (d) { renderDay(d, box); });

    view.appendChild(box);
    if (weekOffset !== 0) {
      var back = el('button', null, '回到本周');
      back.onclick = function () { loadWeek(0); };
      view.appendChild(back);
    }
  }

  function loadWeek(offset) {
    hint.textContent = '正在加载日程…';
    fetch(BASE + 'week.json?offset=' + offset, { cache: 'no-store' })
      .then(function (r) {
        if (!r.ok) throw new Error('HTTP ' + r.status);
        return r.json();
      })
      .then(function (json) {
        week = json; weekOffset = json.offset || 0;
        location.hash = 'schedule/' + weekOffset;
        renderWeek();
        hint.textContent = '日程生成于 ' + new Date(json.generated_at).toLocaleTimeString();
      })
      .catch(function (e) { renderError(String(e && e.message ? e.message : e)); });
  }

  function load() {
    hint.textContent = '正在加载…';
    fetch(API, { cache: 'no-store' })
      .then(function (r) {
        if (!r.ok) throw new Error('HTTP ' + r.status);
        return r.json();
      })
      .then(function (json) {
        data = json;
        var when = new Date(json.generated_at);
        stamp.textContent = when.toLocaleString();
        paint();
        hint.textContent = '数据生成于 ' + when.toLocaleTimeString();
      })
      .catch(function (e) { renderError(String(e && e.message ? e.message : e)); });
  }

  /**
   * 自愈：早期版本注册过 Service Worker，而它对**页面本身**是"缓存优先"，
   * 于是服务端再怎么改，平板都拿不到新版（关后台、点图标都没用）。
   * 现在起不再使用 SW；只要发现本页还被 SW 控制/注册，就注销它、清空缓存、
   * 硬刷新一次（用 sessionStorage 标记，避免刷新循环）。
   */
  function purgeOldServiceWorker() {
    if (!('serviceWorker' in navigator)) return;
    navigator.serviceWorker.getRegistrations().then(function (rs) {
      if (!rs || !rs.length) return;
      return Promise.all(rs.map(function (r) { return r.unregister(); })).then(function () {
        var keys = (window.caches && caches.keys) ? caches.keys() : Promise.resolve([]);
        return keys.then(function (ks) {
          return Promise.all(ks.map(function (k) { return caches.delete(k); }));
        });
      }).then(function () {
        if (sessionStorage.getItem('cairn-sw-purged') === '1') return;
        sessionStorage.setItem('cairn-sw-purged', '1');
        location.reload();
      });
    }).catch(function () {});
  }

  Array.prototype.forEach.call(document.querySelectorAll('nav a'), function (a) {
    a.addEventListener('click', function (ev) {
      ev.preventDefault();
      tab = a.getAttribute('data-tab');
      paint();
      location.hash = tab;
    });
  });
  document.getElementById('refresh').addEventListener('click', function () {
    if (tab === 'schedule') loadWeek(weekOffset); else load();
  });

  var h = (location.hash || '').replace('#', '');
  var mw = /^schedule\\/(-?\\d+)$/.exec(h);
  if (mw) { tab = 'schedule'; weekOffset = parseInt(mw[1], 10) || 0; }
  else if (h === 'tasks' || h === 'notifications' || h === 'today' || h === 'schedule') tab = h;

  purgeOldServiceWorker();
  load();
})();
</script>
</body>
</html>`;
}
