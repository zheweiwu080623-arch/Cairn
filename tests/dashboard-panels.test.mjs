// 首页原生面板「变成可动卡片」（方案 A：把节点搬进 #dash-cards）的端到端验证。
//
//   node tests/dashboard-panels.test.mjs
//
// 为什么值得单开一个测试：这一步动的是**真实 DOM 的父子关系**，而且脚本靠
// MutationObserver 自愈 —— 一旦"自愈"和"自己的改动"互相触发，就回到 2026-10-02
// 用户看到的那种狂闪。所以这里用一个会**自动触发**的极简 DOM 桩：任何改动都会通知
// 观察器，观察器又会调度一次重画，正是最容易自激的环境；断言里专门有一条"不许画个没完"。

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

let failures = 0;
const ok = (label, cond, detail = '') => {
  if (cond) console.log(`  PASS ${label}`);
  else { failures += 1; console.log(`  FAIL ${label}${detail ? ` -- ${detail}` : ''}`); }
};

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const SRC = readFileSync(join(ROOT, 'public', 'dashboard-cards.js'), 'utf8');
const APP = readFileSync(join(ROOT, 'public', 'app.js'), 'utf8');

console.log('dashboard-panels.test.mjs');

// ---------------------------------------------------------------- 极简 DOM
const ELEMENT = 1;
const TEXT = 3;

let observers = [];
let queued = false;
let lastTouched = null;
let created = 0;

/** 任何改动都通知观察器（真实浏览器里就是这样的）——自激会在这里现形。 */
function note(node) {
  lastTouched = node;
  if (queued) return;
  queued = true;
  queueMicrotask(() => {
    queued = false;
    const records = [{ type: 'childList', target: lastTouched }];
    for (const ob of observers.slice()) {
      try { ob.cb(records, ob); } catch { /* 观察器里抛错不该影响页面 */ }
    }
  });
}

class TextNode {
  constructor(t) { this.nodeType = TEXT; this.textContent = String(t); this.parentNode = null; }
}

class El {
  constructor(tag) {
    this.nodeType = ELEMENT;
    this.tagName = String(tag).toUpperCase();
    this.childNodes = [];
    this.parentNode = null;
    this.attrs = {};
    this.style = {};
    this.disabled = false;
    this.title = '';
    this.onclick = null;
  }

  get children() { return this.childNodes.filter((n) => n.nodeType === ELEMENT); }
  get className() { return this.attrs.class || ''; }
  set className(v) { this.attrs.class = String(v); }
  get id() { return this.attrs.id || ''; }
  set id(v) { if (v) this.attrs.id = String(v); else delete this.attrs.id; }

  get textContent() { return this.childNodes.map((n) => n.textContent).join(''); }
  set textContent(v) {
    for (const n of this.childNodes) n.parentNode = null;
    this.childNodes = [];
    if (v !== '' && v != null) this.appendChild(new TextNode(v));
  }

  appendChild(n) {
    if (n.parentNode) n.parentNode.removeChild(n);
    n.parentNode = this;
    this.childNodes.push(n);
    note(this);
    return n;
  }

  insertBefore(n, ref) {
    if (!ref) return this.appendChild(n);
    if (n.parentNode) n.parentNode.removeChild(n);
    n.parentNode = this;
    const i = this.childNodes.indexOf(ref);
    if (i < 0) this.childNodes.push(n); else this.childNodes.splice(i, 0, n);
    note(this);
    return n;
  }

  removeChild(n) {
    const i = this.childNodes.indexOf(n);
    if (i < 0) return n;
    this.childNodes.splice(i, 1);
    n.parentNode = null;
    note(this);
    return n;
  }

  remove() { if (this.parentNode) this.parentNode.removeChild(this); }
  contains(n) { for (let p = n; p; p = p.parentNode) if (p === this) return true; return false; }
  getAttribute(name) { return Object.prototype.hasOwnProperty.call(this.attrs, name) ? this.attrs[name] : null; }
  setAttribute(name, v) { this.attrs[name] = String(v); note(this); }
  addEventListener() {}
  removeEventListener() {}
  focus() {}
  blur() {}

  matches(sel) {
    const s = String(sel).trim();
    if (!s) return false;
    if (s[0] === '.') return this.className.split(/\s+/).includes(s.slice(1));
    if (s[0] === '#') return this.id === s.slice(1);
    if (s[0] === '[') {
      const m = /^\[([\w-]+)(?:="([^"]*)")?\]$/.exec(s);
      if (!m) return false;
      const v = this.getAttribute(m[1]);
      return m[2] === undefined ? v != null : v === m[2];
    }
    return this.tagName === s.toUpperCase();
  }

  querySelectorAll(sel) {
    const out = [];
    const walk = (n) => {
      for (const c of n.children) { if (c.matches(sel)) out.push(c); walk(c); }
    };
    walk(this);
    return out;
  }

  querySelector(sel) { return this.querySelectorAll(sel)[0] || null; }
}

class MutationObserver {
  constructor(cb) { this.cb = cb; }
  observe() { observers.push(this); }
  disconnect() { observers = observers.filter((o) => o !== this); }
}

// ---------------------------------------------------------------- 模拟 app.js 画出来的首页
function card(html3, inner = '') {
  const c = new El('div');
  c.className = 'card';
  const h = new El('h3');
  if (html3.note) {
    h.appendChild(new TextNode(html3.title));
    const s = new El('span');
    s.className = 'muted';
    s.textContent = html3.note;
    h.appendChild(s);
  } else h.textContent = html3.title;
  c.appendChild(h);
  if (inner) {
    const d = new El('div');
    d.className = inner;
    c.appendChild(d);
  }
  return c;
}

function grid(cls, kids) {
  const g = new El('div');
  g.className = cls;
  kids.forEach((k) => g.appendChild(k));
  return g;
}

/** 逐块对应 public/app.js 的 todayHtml()/renderStudentCard()（有下面的源码守卫盯着）。 */
function todayContent({ student = true } = {}) {
  const nodes = [];
  if (student) {
    const sc = new El('div');
    sc.className = 'card student-card';
    sc.id = 'student-card';
    const head = new El('div');
    head.className = 'sc-head';
    head.textContent = '🎒 学生 · 第 1 周 / 共 16 周';
    sc.appendChild(head);
    const row = new El('div');
    row.className = 'sc-row';
    row.textContent = '⚠️ 未交作业 11 项';
    sc.appendChild(row);
    nodes.push(sc);                                   // insertAdjacentHTML('afterbegin')
  }
  nodes.push(grid('grid cols-3', [
    card({ title: '今日日程' }, 'stat-row'),
    card({ title: '待办任务' }, 'stat-row'),
    card({ title: '任务完成' }, 'stat-row'),
  ]));
  nodes.push(grid('grid cols-2 mt', [
    card({ title: '今天的安排 2026-10-02', note: '，暂无' }),
    card({ title: '需要关注的任务' }),
  ]));
  nodes.push(grid('grid cols-2 mt', [
    card({ title: '即将到来的提醒' }),
    card({ title: '未来任务' }),
  ]));
  const codex = card({ title: 'Codex 连接' });
  codex.className = 'card mt';
  nodes.push(codex);
  return nodes;
}

function buildTodayView(doc, opts) {
  const view = new El('div');
  view.id = 'view-today';
  view.className = 'view active';
  todayContent(opts).forEach((n) => view.appendChild(n));
  doc.body.appendChild(view);
  return view;
}

// ---------------------------------------------------------------- 跑脚本
const TYPES = [
  { id: 'today', title: '今日', kind: 'builtin' },
  { id: 'sources', title: '数据源', kind: 'builtin' },
  { id: 'stat-events', title: '今日日程', kind: 'native' },
  { id: 'stat-todo', title: '待办任务', kind: 'native' },
  { id: 'stat-done', title: '任务完成', kind: 'native' },
  { id: 'today-schedule', title: '今天的安排', kind: 'native' },
  { id: 'attention', title: '需要关注的任务', kind: 'native' },
  { id: 'reminders', title: '即将到来的提醒', kind: 'native' },
  { id: 'upcoming', title: '未来任务', kind: 'native' },
  { id: 'codex', title: 'Codex 连接', kind: 'native' },
  { id: 'student', title: '学生', kind: 'native' },
];

function vmOf(order, { extra = [] } = {}) {
  return {
    schema: 'dashboard.v1',
    generated_at: '2026-10-02T10:00:00.000Z',
    count: order.length + extra.length,
    cards: [...order, ...extra].map((id, i) => {
      const t = TYPES.find((x) => x.id === id) || { id, title: id, kind: 'unknown' };
      return {
        id: 'c-' + id, module_id: t.kind === 'native' ? 'native' : 'builtin', card_id: id,
        size: 'md', position: i, kind: t.kind, title: t.title, rows: [],
      };
    }),
  };
}

function boot({ vm, student = true, fail = false } = {}) {
  observers = [];
  created = 0;
  const doc = {
    head: new El('head'), body: new El('body'), documentElement: new El('html'),
    readyState: 'complete', hidden: false, title: '',
    createElement: (t) => { created += 1; return new El(t); },
    createTextNode: (t) => new TextNode(t),
    getElementById: (id) => doc.documentElement.querySelector('#' + id),
    querySelector: (s) => doc.documentElement.querySelector(s),
    querySelectorAll: (s) => doc.documentElement.querySelectorAll(s),
    addEventListener() {}, removeEventListener() {},
  };
  doc.documentElement.appendChild(doc.head);
  doc.documentElement.appendChild(doc.body);
  const main = new El('main');
  main.id = 'main';
  doc.body.appendChild(main);
  const view = buildTodayView(doc, { student });
  main.appendChild(view);

  const fetchStub = (path) => {
    if (fail) return Promise.reject(new Error('服务没在跑'));
    const p = String(path);
    if (p.indexOf('/available') >= 0) return Promise.resolve({ ok: true, json: async () => ({ types: TYPES }) });
    if (p.indexOf('/api/dashboard') >= 0) return Promise.resolve({ ok: true, json: async () => vm });
    return Promise.resolve({ ok: false, json: async () => ({}) });
  };
  const win = { document: doc, MutationObserver, location: { href: 'http://127.0.0.1:3210/' } };
  const factory = new Function('window', 'document', 'fetch', 'setInterval', 'queueMicrotask', 'MutationObserver', 'console',
    `${SRC}\nreturn { start: 1 };`);
  factory(win, doc, fetchStub, () => 0, (f) => queueMicrotask(f), MutationObserver, console);
  return { doc, view, main };
}

/** 把微任务队列抽干（含观察器→重画的连环调用）。 */
async function settle(rounds = 40) {
  for (let i = 0; i < rounds; i += 1) await Promise.resolve();
}

/** 卡片标题文字（h3 里除了按钮之外的部分）。 */
const titleOf = (node) => {
  const h3 = node.querySelector('h3');
  if (!h3) return '?';
  return h3.childNodes
    .filter((n) => !(n.nodeType === ELEMENT && n.className.indexOf('dash-acts') >= 0))
    .map((n) => n.textContent).join('');
};

const idsIn = (host) => host.children
  .filter((n) => n.className.indexOf('dash-bar') < 0)
  .map((n) => {
    const panel = n.getAttribute('data-panel');
    if (panel) return panel;
    const text = titleOf(n);
    const hit = TYPES.find((x) => x.title === text);
    return hit ? hit.id : text;
  });

// ---------------------------------------------------------------- ① 全部搬进网格、顺序按表来
{
  const order = ['today', 'stat-done', 'today-schedule', 'attention', 'reminders', 'upcoming', 'codex', 'student', 'stat-events', 'stat-todo'];
  const { view } = boot({ vm: vmOf(order) });
  await settle();

  const host = view.querySelector('#dash-cards');
  ok('#dash-cards 建起来了，并且就在 #view-today 里', !!host && host.parentNode === view);
  ok('每一块面板的父节点都变成了卡片网格（真的搬了，不是复制）',
    ['stat-events', 'stat-todo', 'stat-done', 'today-schedule', 'attention', 'reminders', 'upcoming', 'codex', 'student']
      .every((id) => {
        const n = view.querySelector(`[data-panel="${id}"]`);
        return !!n && n.parentNode === host && view.querySelectorAll(`[data-panel="${id}"]`).length === 1;
      }));
  ok('顺序 = 表里的 position 顺序（可以和外来的卡混排）',
    idsIn(host).join(',') === order.join(','), idsIn(host).join(','));
  ok('搬进来的面板也长出了 ↑ ↓ ⤢ ✕',
    ['stat-events', 'today-schedule', 'codex', 'student']
      .every((id) => !!view.querySelector(`[data-panel="${id}"]`).querySelector('.dash-acts')));
  ok('外面没留下空壳容器（原来那三个 .grid 已经清掉）',
    view.children.filter((n) => n.className.indexOf('grid') >= 0 && !n.children.length).length === 0);
  ok('学生卡的头部被当成表头（按钮挂得上去）',
    !!view.querySelector('[data-panel="student"]').querySelector('.dash-acts'));
  ok('没有画个没完（自激熔断/收敛判定有效）', created < 400, `createElement 次数 ${created}`);
}

// ---------------------------------------------------------------- ② renderToday() 重建之后自己搬回去
{
  const order = ['stat-events', 'today-schedule', 'codex', 'today'];
  const { doc, view } = boot({ vm: vmOf(order) });
  await settle();
  const before = idsIn(view.querySelector('#dash-cards')).join(',');

  // app.js: el.innerHTML = todayHtml(...) —— 整段重画（我们这里手动重建同样的结构）
  while (view.childNodes.length) view.removeChild(view.childNodes[0]);
  todayContent({ student: true }).forEach((n) => view.appendChild(n));
  await settle();

  const host = view.querySelector('#dash-cards');
  ok('重建之后只应有一个卡片网格', view.querySelectorAll('#dash-cards').length === 1);
  ok('重建之后面板又被搬回网格（顺序不变）',
    idsIn(host).join(',') === before, idsIn(host).join(','));
  ok('重建之后首页上不再有漏在外面的面板（学生卡也不会停在最上面）',
    view.querySelectorAll('.card').every((n) => host.contains(n)));
  ok('重建之后也没有画个没完', created < 600, `createElement 次数 ${created}`);
}

// ---------------------------------------------------------------- ③ 删掉的那张不再出现
{
  const { view } = boot({ vm: vmOf(['stat-events', 'today', 'stat-todo']) });
  await settle();
  const host = view.querySelector('#dash-cards');
  ok('表里没有 Codex 卡 → 页面上那块被拿走', !view.querySelector('[data-panel="codex"]'));
  ok('留下的那几张照旧在网格里', idsIn(host).join(',') === 'stat-events,today,stat-todo', idsIn(host).join(','));
  ok('原来包着它的容器也没留下空壳',
    !view.children.some((n) => n.className.indexOf('grid') >= 0 && !n.children.length));
}

// ---------------------------------------------------------------- ④ 拿不到数据：退回老版面，不折腾
{
  const { view } = boot({ vm: null, fail: true });
  await settle();
  ok('两条接口都拿不到 → 卡片网格不建、原版面一块不动',
    !view.querySelector('#dash-cards') && view.querySelectorAll('.card').length >= 7
    && view.querySelector('.student-card').parentNode === view);
  ok('这时候也没有反复重画', created < 20, `createElement 次数 ${created}`);
}

// ---------------------------------------------------------------- ⑤ 观察器连环触发也不许自激
{
  const { view } = boot({ vm: vmOf(['stat-events', 'today']) });
  await settle();
  const host = view.querySelector('#dash-cards');
  const snapshot = host.children.length;
  const stable = created;
  const ob = observers[0];
  for (let i = 0; i < 30; i += 1) ob.cb([{ type: 'childList', target: view }], ob);
  await settle();
  ok('没事干的时候观察器触发多少次都不重画',
    created === stable && host.children.length === snapshot, `${created} vs ${stable}`);
}

// ---------------------------------------------------------------- ⑥ 源码守卫：面板标题/app.js 结构没被改跑
{
  const titles = ['今日日程', '待办任务', '任务完成', '今天的安排', '需要关注的任务', '即将到来的提醒', '未来任务', 'Codex 连接'];
  ok('app.js 里这些面板的标题还在（前端就是靠标题认面板的）',
    titles.every((t) => APP.includes(`<h3>${t}`)), titles.filter((t) => !APP.includes(`<h3>${t}`)).join(','));
  ok('app.js 还在用 #student-card 这个 id', APP.includes("id=\"student-card\"") || APP.includes("id='student-card'"));
  ok('前端没有硬编码一份标题表（标题的唯一真相源在后端 /api/dashboard/available）',
    !SRC.includes('今日日程') && !SRC.includes('即将到来的提醒'));
}

console.log('');
console.log(failures === 0 ? 'dashboard-panels.test: PASS' : `dashboard-panels.test: FAIL (${failures})`);
process.exit(failures === 0 ? 0 : 1);
