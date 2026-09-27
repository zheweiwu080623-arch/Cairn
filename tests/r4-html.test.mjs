// R4 端到端（HTML 级）验证：首页 / 养成 / 统计 / 音乐 / 数据源 五个视图，
// 在 Node 里加载真实 app.js，用「显示层取数」与「旧实现取数」两条路径分别渲染，
// 比较写进对应容器的 HTML 是否**逐字节相同**。
//
//   node tests/r4-html.test.mjs
//
// 为什么要在 HTML 层面比：这一轮只换「数据从哪来」，**外观必须一点不变**。
// 逐字节相同是"没改外观"最硬的证据。

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import {
  codexSelection, habitsSelection, hubSelection, musicSelection, statsSelection, todaySelection,
} from '../public/viewmodel.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..');

let failures = 0;
const ok = (label, condition, detail = '') => {
  if (condition) console.log(`  PASS ${label}`);
  else {
    failures += 1;
    console.log(`  FAIL ${label}${detail ? ` -- ${detail}` : ''}`);
  }
};

function makeElement(tag = 'div') {
  return {
    tagName: tag, innerHTML: '', textContent: '', value: '', className: '', checked: false,
    style: {}, dataset: {}, children: [], onclick: null,
    classList: { add() {}, remove() {}, toggle() {}, contains: () => false },
    appendChild(c) { this.children.push(c); return c; },
    removeChild() {}, remove() {}, setAttribute() {}, removeAttribute() {},
    addEventListener() {}, removeEventListener() {}, focus() {}, blur() {}, click() {},
    querySelector: () => null, querySelectorAll: () => [], insertAdjacentHTML() {},
    getBoundingClientRect: () => ({ top: 0, left: 0, width: 0, height: 0, bottom: 0, right: 0 }),
  };
}

function loadApp(plannerVM = null) {
  const elements = new Map();
  const get = (key) => {
    if (!elements.has(key)) elements.set(key, makeElement(key.startsWith('#') ? key.slice(1) : 'div'));
    return elements.get(key);
  };
  const documentStub = {
    body: makeElement('body'), documentElement: makeElement('html'), title: '',
    querySelector: (s) => get(s), querySelectorAll: () => [],
    getElementById: (id) => get('#' + id),
    createElement: (t) => makeElement(t), createTextNode: (t) => ({ textContent: t }),
    addEventListener() {}, removeEventListener() {}, cookie: '',
  };
  const windowStub = {
    document: documentStub,
    location: { search: '', href: 'http://127.0.0.1:3210/', origin: 'http://127.0.0.1:3210' },
    navigator: { userAgent: 'node', language: 'zh-CN', clipboard: {} },
    localStorage: { getItem: () => null, setItem() {}, removeItem() {} },
    sessionStorage: { getItem: () => null, setItem() {}, removeItem() {} },
    matchMedia: () => ({ matches: false, addEventListener() {}, removeEventListener() {} }),
    requestAnimationFrame: (fn) => setTimeout(fn, 0),
    cancelAnimationFrame() {}, setTimeout, clearTimeout, setInterval: () => 0, clearInterval() {},
    addEventListener() {}, removeEventListener() {}, dispatchEvent() {},
    getComputedStyle: () => ({ getPropertyValue: () => '' }),
    innerWidth: 1280, innerHeight: 800, devicePixelRatio: 1,
    Audio: function Audio() { return { play() {}, pause() {}, addEventListener() {} }; },
    Image: function Image() { return makeElement('img'); },
    Notification: undefined,
    fetch: () => Promise.resolve({ ok: true, json: () => Promise.resolve({}) }),
    console,
  };
  windowStub.window = windowStub;
  windowStub.self = windowStub;
  if (plannerVM) windowStub.PlannerVM = plannerVM;

  const src = readFileSync(join(ROOT, 'public/app.js'), 'utf8');
  const factory = new Function(
    'window', 'document', 'localStorage', 'sessionStorage', 'location', 'navigator',
    'URLSearchParams', 'requestAnimationFrame', 'getComputedStyle', 'fetch', 'console',
    `${src}
     return {
       DB, state, MODULES,
       renderHub, renderHabits, renderStats, renderMusic, renderCodex,
       setHubCursor: (v) => { hubCursor = v; },
       setLang: (v) => { lang = v; },
       setLocalTracks: (t) => { localMusicTracks = t; },
       setChat: (c) => { chatLog = c; },
     };`,
  );
  const api = factory(
    windowStub, documentStub, windowStub.localStorage, windowStub.sessionStorage, windowStub.location,
    windowStub.navigator, URLSearchParams, windowStub.requestAnimationFrame,
    windowStub.getComputedStyle, windowStub.fetch, console,
  );
  return { ...api, sandbox: { get, window: windowStub } };
}

function firstDiff(a, b) {
  let i = 0;
  while (i < a.length && i < b.length && a[i] === b[i]) i += 1;
  return `@${i}\n      legacy=${JSON.stringify(a.slice(i, i + 90))}\n      vm    =${JSON.stringify(b.slice(i, i + 90))}`;
}

// ---------------- 构造一份"刚好能覆盖每个视图分支"的数据 ----------------
const DAY = 86400000;
const dayIso = (offsetDays) => new Date(Date.now() + offsetDays * DAY).toISOString();
const STATE = {
  tasks: [
    { id: 't1', title: 'A', status: 'done', updated_at: dayIso(0), due_at: dayIso(1), priority: 1 },
    { id: 't2', title: 'B', status: 'done', updated_at: dayIso(-2), due_at: dayIso(2), priority: 2 },
    { id: 't3', title: 'C', status: 'todo', updated_at: dayIso(-1), due_at: dayIso(3), priority: 0 },
  ],
  focus: [
    { id: 'f1', minutes: 25, started_at: dayIso(0) },
    { id: 'f2', minutes: 50, started_at: dayIso(-1) },
    { id: 'f3', minutes: 10, started_at: dayIso(-6) },
  ],
  habits: [
    { id: 'h1', name: '背单词', icon: '📖', color: '#4f7cff' },
    { id: 'h2', name: '跑步', icon: '🏃', color: '#ff5252' },
  ],
  habit_logs: [
    { habit_id: 'h1', date: localKey(0), done: 1 },
    { habit_id: 'h1', date: localKey(-1), done: 1 },
    { habit_id: 'h2', date: localKey(-3), done: 1 },
  ],
  milestones: [
    { id: 'm1', title: '线代期中', target_at: dayIso(5), done: 0 },
    { id: 'm2', title: '实验报告', target_at: dayIso(2), done: 0 },
    { id: 'm3', title: '已完成的', target_at: dayIso(1), done: 1 },
    { id: 'm4', title: '第四项', target_at: dayIso(9), done: 0 },
    { id: 'm5', title: '第五项（不该出现）', target_at: dayIso(11), done: 0 },
  ],
  insights: {
    semesterWeek: 3,
    tasks: { total: 3, done: 2, doneToday: 1, doneWeek: 2, completion: 67, open: 1 },
    focus: { today: 25, week: 85, sessions: 3 },
    habits: { total: 2, todayDone: 1, streaks: [{ id: 'h1', name: '背单词', streak: 4 }, { id: 'h2', name: '跑步', streak: 1 }] },
    milestone: { id: 'm2', title: '实验报告', daysLeft: 2 },
    exam: null,
  },
  music: { dir: 'C:\\Users\\demo\\Music', tracks: [{ name: 'a.mp3', ext: '.mp3', size: 1024, file: 'a.mp3' }], scanned_at: 0 },
  codex: {
    connected: true, home: 'C:\\Users\\demo\\.codex', error: null, synced_at: 1789000000000,
    automations: [
      { id: 'a1', name: '每日计划', prompt: 'p1', kind: 'heartbeat', status: 'ACTIVE', describe: '每天 07:00', next_run_at: dayIso(1) },
      { id: 'a2', name: '暂停的', prompt: 'p2', kind: 'cron', status: 'PAUSED', describe: '每周一', next_run_at: null },
      { id: 'a3', name: '坏掉的', prompt: 'p3', kind: 'cron', status: 'PARSE_ERROR', describe: '', next_run_at: null },
    ],
  },
  codex_home: 'C:\\Users\\demo\\.codex',
  plan_export: { exported_at: dayIso(0), paths: ['C:\\Users\\demo\\.codex\\planner\\daily-plan.md'] },
};

function localKey(offsetDays) {
  const d = new Date(Date.now() + offsetDays * DAY);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

const VM = {
  todaySelection, hubSelection, habitsSelection, statsSelection, musicSelection, codexSelection,
};

console.log('r4-html.test.mjs');

// ---------------- 1. 五个视图：两条路径渲染结果逐字节比对 ----------------
const CASES = [
  ['首页/主菜单', 'renderHub', '#view-hub', (app) => app.renderHub()],
  ['养成', 'renderHabits', '#view-habits', (app) => app.renderHabits()],
  ['统计', 'renderStats', '#view-stats', (app) => app.renderStats()],
  ['音乐', 'renderMusic', '#view-music', (app) => app.renderMusic()],
  ['数据源/Codex', 'renderCodex', '#view-codex', (app) => app.renderCodex()],
];

for (const [label, fn, sel, run] of CASES) {
  const out = {};
  for (const useVM of [true, false]) {
    const app = loadApp(useVM ? VM : null);
    Object.assign(app.DB, JSON.parse(JSON.stringify(STATE)));
    app.setChat([{ role: 'user', text: '你好' }, { role: 'assistant', text: '你好，有什么可以帮你？' }]);
    if (fn === 'renderHub') { app.setHubCursor('tasks'); app.setLang('zh'); }
    run(app);
    out[useVM ? 'vm' : 'legacy'] = app.sandbox.get(sel).innerHTML;
  }
  const same = out.vm === out.legacy;
  ok(`[${label}] 两条路径渲染的 HTML 逐字节相同（${out.vm.length} 字符）`, same,
    same ? '' : `${fn}: ${firstDiff(out.legacy, out.vm)}`);
  ok(`[${label}] 渲染结果非空`, out.vm.length > 200);
}

// ---------------- 2. 首页：高亮项跟着 cursor 走 + 中英切换 ----------------
{
  const app = loadApp(VM);
  app.setHubCursor('music');
  app.setLang('zh');
  app.renderHub();
  const zh = app.sandbox.get('#view-hub').innerHTML;
  ok('首页：当前项被标记为 active', /class="hub-mi active" data-tab="music"/.test(zh), zh.slice(0, 120));
  ok('首页：九项导航都在（数据驱动）', (zh.match(/class="hub-mi/g) || []).length === app.MODULES.length);
  app.setLang('en');
  app.renderHub();
  const en = app.sandbox.get('#view-hub').innerHTML;
  ok('首页：切英文后标题变英文', en.includes('LOCAL MUSIC') && !en.includes('本地音乐'));
}

// ---------------- 3. 音乐：浏览器直读优先于服务端扫描 ----------------
{
  const app = loadApp(VM);
  Object.assign(app.DB, JSON.parse(JSON.stringify(STATE)));
  app.setLocalTracks([{ name: '本地-1.mp3', ext: '.mp3', size: 2048, url: 'blob:x' }]);
  app.renderMusic();
  const html = app.sandbox.get('#view-music').innerHTML;
  ok('音乐：本地直读时用本地那一份', html.includes('本地-1.mp3') && !html.includes('a.mp3'));
  ok('音乐：状态行写明"本地直接读取"', html.includes('已收录 1 首（本地直接读取）'));
  ok('音乐：出现"清除本地选择"按钮', html.includes('mu-clear'));
}

// ---------------- 4. 养成：最多显示 4 个未完成倒计时 ----------------
{
  const app = loadApp(VM);
  Object.assign(app.DB, JSON.parse(JSON.stringify(STATE)));
  app.renderHabits();
  const html = app.sandbox.get('#view-habits').innerHTML;
  ok('养成：只显示 4 个未完成倒计时', (html.match(/class="cd-chip"/g) || []).length === 4);
  ok('养成：已完成的不出现', !html.includes('已完成的'));
  ok('养成：打卡格子 2 × 7 = 14 个', (html.match(/class="hday/g) || []).length === 14);
  ok('养成：连续天数来自 insights', html.includes('连续 4 天'));
}

// ---------------- 5. 数据源：三种自动化状态各有样式 ----------------
{
  const app = loadApp(VM);
  Object.assign(app.DB, JSON.parse(JSON.stringify(STATE)));
  app.renderCodex();
  const html = app.sandbox.get('#view-codex').innerHTML;
  ok('数据源：运行中 / 已暂停 / 异常三种徽章都在',
    html.includes('pill status">运行中') && html.includes('pill status off">已暂停') && html.includes('pill p0">PARSE_ERROR'));
  ok('数据源：运行中计数 1/3', html.includes('1/3 运行中'));
  ok('数据源：计划导出路径已列出', html.includes('daily-plan.md'));
}

// ---------------- 6. 防回归：渲染函数必须走显示层取数 ----------------
{
  const src = readFileSync(join(ROOT, 'public/app.js'), 'utf8');
  const probes = [
    ['renderHub', 'hubSelectionFor', /function renderHub\(\)[\s\S]{0,160}hubSelectionFor\(\)/],
    ['renderHabits', 'habitsSelectionFor', /function renderHabits\(\)[\s\S]{0,200}habitsSelectionFor\(\)/],
    ['renderStats', 'statsSelectionFor', /function renderStats\(\)[\s\S]{0,260}statsSelectionFor\(\)/],
    ['renderMusic', 'musicSelectionFor', /function renderMusic\(\)[\s\S]{0,260}musicSelectionFor\(\)/],
    ['renderCodex', 'codexSelectionFor', /function renderCodex\(\)[\s\S]{0,260}codexSelectionFor\(\)/],
  ];
  for (const [fn, helper, re] of probes) {
    ok(`${fn} 用 ${helper}() 取数`, re.test(src));
    // hubSelectionFor -> legacyHubSelection（去掉结尾的 For，首字母大写）
    const legacyName = `legacy${helper.replace(/For$/, '')}`.replace('legacy', 'legacy')
      .replace(/^legacy(.)/, (_, c) => `legacy${c.toUpperCase()}`);
    ok(`app.js 保留 ${legacyName} 的旧实现可回退`, src.includes(`function ${legacyName}(`), legacyName);
  }
  ok('renderHabits 不再自己去读 DB.habits',
    !/function renderHabits\(\)[\s\S]{0,400}DB\.habits/.test(src));
  ok('renderStats 不再自己去读 DB.insights',
    !/function renderStats\(\)[\s\S]{0,400}DB\.insights/.test(src));
  ok('renderCodex 不再自己去读 DB.codex',
    !/function renderCodex\(\)[\s\S]{0,400}DB\.codex/.test(src));

  const bridge = readFileSync(join(ROOT, 'public/vm-bridge.js'), 'utf8');
  for (const name of ['hubSelection', 'habitsSelection', 'statsSelection', 'musicSelection', 'codexSelection']) {
    ok(`vm-bridge 已挂上 ${name}`, bridge.includes(name));
  }
}

console.log('');
console.log(failures === 0 ? 'r4-html.test: PASS' : `r4-html.test: FAIL (${failures})`);
process.exit(failures === 0 ? 0 : 1);
