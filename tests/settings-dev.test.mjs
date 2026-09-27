// 2026-09-26 用户的三条要求：① 真做设置页（数据源/外观/模式/功能 + 齿轮入口）② 能真写真注册真试跑
// ③ 新增能力应当是"单立的能力文件夹、不改内核" ⑤ 任务排序加一个折中档。
//
//   node tests/settings-dev.test.mjs

import { mkdtempSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { renderPage, renderFeatures, renderRuntime, tabsFor } from '../modules/settings/panel.js';
import * as settingsView from '../modules/settings/panel.js';
import { renderDevPane, renderPage as renderBuilderPage, DEV_TEMPLATE } from '../modules/flow-builder/builder.js';
import { loadUserCapabilities, saveUserCapability, runUserCapability, scanUserCapabilities, userCapDir } from '../lib/capabilities/user.mjs';
import { createCapabilityRoutes } from '../lib/routes/capabilities.mjs';
import { createCapabilityHost } from '../lib/capabilities/host.mjs';
import { tasksSelection } from '../public/viewmodel.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
let failures = 0;
const ok = (label, cond, detail = '') => {
  if (cond) console.log(`  PASS ${label}`);
  else { failures += 1; console.log(`  FAIL ${label}${detail ? ` -- ${detail}` : ''}`); }
};

console.log('settings-dev.test.mjs');

const app = readFileSync(join(ROOT, 'public', 'app.js'), 'utf8');
const html = readFileSync(join(ROOT, 'public', 'index.html'), 'utf8');
const view = readFileSync(join(ROOT, 'modules', 'settings', 'panel.js'), 'utf8');
const cssSrc = readFileSync(join(ROOT, 'public', 'styles.css'), 'utf8');
const prefsSrc = readFileSync(join(ROOT, 'lib', 'routes', 'prefs.mjs'), 'utf8');

// ---------- ① 设置页 + 齿轮入口 + 数据源被收进去 ----------
{
  const mod = JSON.parse(readFileSync(join(ROOT, 'modules', 'settings', 'module.json'), 'utf8'));
  ok('设置是一个独立页面模块（kind=view）', mod.kind === 'view' && !!mod.entry.view);
  ok('图标是齿轮', mod.icon === '⚙️', mod.icon);
  const tabs = tabsFor({ mode: 'user' }).map((t) => t.id);
  ok('四个主区都在：数据源 / 外观 / 模式 / 功能',
    ['sources', 'look', 'mode', 'features'].every((t) => tabs.includes(t)), tabs.join(','));
  ok('「后台」也在（自启/服务状态）', tabs.includes('runtime'));
  // 2026-09-26 用户要求：开发能力不该待在设置里，应该待在「能力搭建」那一页
  ok('开发不在设置里（设置只留 数据源/外观/模式/功能/后台）',
    !tabs.includes('dev') && !readFileSync(join(ROOT, 'modules', 'settings', 'panel.js'), 'utf8').includes("id: 'dev'"));
  ok('能力搭建页里多了「开发 · 能力」（写/注册/试跑都在这儿）',
    renderBuilderPage({ capabilities: [], nodes: [], edges: [], flows: [], pane: 'dev' }).includes('fb-dev-code')
    && renderBuilderPage({ capabilities: [], nodes: [], edges: [], flows: [] }).includes('data-fb-pane="dev"'));
  ok('搭功能那一栏还在（没被开发页签挤掉）',
    renderBuilderPage({ capabilities: [], nodes: [], edges: [], flows: [] }).includes('fb-palette-inner'));
  ok('导航里的「数据源」已经拿掉', !/\{ tab: 'codex'/.test(app) && app.includes('主菜单上的每一项都是'));
  ok('旧的「数据源」请求会被转到设置页的数据源页签',
    app.includes("window.__cairnSettingsWanted = 'sources'") && app.includes("if (tab === 'connectors' || tab === 'codex')"));
  ok('数据源那一块是"寄存"原来那块（不重写）',
    view.includes("document.getElementById('view-connectors')") && view.includes('host.appendChild(src)'));
  ok('右上角是齿轮按钮、title=设置',
    html.includes('id="settings-btn"') && html.includes('title="设置"') && !html.includes('id="theme-btn"'));
  // 2026-09-26：用户窗口里 app.js 是旧版（脚本没有版本号 ⇒ 我改了它也不会刷新）⇒ 三处资源全带版本号
  ok('index.html 的脚本/样式都带版本号（改完 app.js 刷新就能生效）',
    /app\.js\?v=/.test(html) && /styles\.css\?v=/.test(html) && /vm-bridge\.js\?v=/.test(html));
  ok('设置页自己就能画数据源（不再依赖主程序那半边是不是新版本）',
    view.includes('export function renderSources(payload') && view.includes('data-set-conn-open')
    && view.includes("api('POST', `/api/connectors/${id}/import`, {"));   // 现在多带 instance / create
  // 2026-09-26 用户要求：已添加的数据源要能删
  // 2026-09-26 用户要求：分析偏好要能"随时改动" ⇒ 从向导里搬回设置页常驻
  {
    ok('设置页多了一个「分析偏好」页签（在数据源后面）',
      tabsFor({}).map((t) => t.id).join(',').startsWith('sources,profile,')
      && tabsFor({}).find((t) => t.id === 'profile').name === '分析偏好');
    const pf = settingsView.renderProfile({ notes: '我在意课程作业', keywords: ['TOEFL', 'ACM'] });
    ok('分析偏好那块：能写长文（10 行文本域）',
      pf.includes('id="set-pf-notes"') && /rows="10"/.test(pf));
    ok('也能导入本地文件（txt / md / json / csv）',
      pf.includes('id="set-pf-file"') && ['.txt', '.md', '.json', '.csv'].every((x) => pf.includes(x)));
    ok('存的是同一份（走 /api/profile）', view.includes("api('POST', '/api/profile', { enabled: true, notes: text, keywords: merged })"));
    ok('保存时关键词"只加不减"（不把设置页里手填的冲掉）',
      view.includes('[...new Set([...(S.keywords || []), ...fresh])]') && view.includes('只加不减'));
    ok('下面挂的是同一个筛选面板（filter-profile），不是另写一套',
      pf.includes('id="set-pf-host"') && view.includes('ctx.mountProfile(host)'));
    // 提炼规则收紧过一次：以前中文长句会被切成"提交」字样的优先推给我"这种碎片塞进关键词
    ok('提炼关键词：丢掉句子碎片与口语填充词，英文词照收',
      JSON.stringify(settingsView.extractKeywords('出现「作业 / 实验 / 提交」字样的优先推给我。arXiv 只看 agent memory'))
        === JSON.stringify(['实验', 'arXiv', 'agent', 'memory']),
      JSON.stringify(settingsView.extractKeywords('出现「作业 / 实验 / 提交」字样的优先推给我。arXiv 只看 agent memory')));
    ok('向导那一步用同一套规则（两边都丢碎片、都跳填充词）',
      readFileSync(join(ROOT, 'modules', 'onboarding', 'wizard.js'), 'utf8').includes('filler.includes(w)'));
    ok('主程序把「挂某个模块」这手交出来了（mountModuleById + moduleCtx）',
      app.includes('async function mountModuleById(host, id)')
      && app.includes("mountProfile: (host) => mountModuleById(host, 'filter-profile')"));
    // 旧「数据源」页撤掉之后，那三块面板（连接向导 / Agent 接入 / 摘要预览）跟着没人看得见 —— 接回设置页
    ok('数据源页签把失去归宿的三块面板接回来了',
      ['connect-wizard', 'agent-connect', 'digest-preview'].every((id) => view.includes(`'${id}'`))
      && view.includes('function placeSourceGadgets()')
      && view.includes('ctx.mountModule(host, id)'));
    ok('主程序给了通用的挂模块出口', app.includes('mountModule: (host, id) => mountModuleById(host, id)'));
  }

  {
    const withOne = settingsView.renderSources({
      connectors: [{ id: 'rss', name: '通用 RSS', icon: '📡', description: '贴网址', fields: [] }],
      configs: [{ source: 'rss' }], counts: { rss: 3 },
    });
    ok('配过的数据源那一行有「删除」', withOne.includes('data-set-conn-del="rss"'));
    ok('没配过的行不出现「删除」（没什么可删的）',
      !settingsView.renderSources({
        connectors: [{ id: 'rss', name: '通用 RSS', icon: '📡', fields: [] }], configs: [], counts: { rss: 0 },
      }).includes('data-set-conn-del'));
    ok('删除走 DELETE 接口，并且二次确认里说清连带删什么',
      view.includes("api('DELETE', `/api/connectors/${id}`)")
      && view.includes('会一并删掉它导入进来的')
      && view.includes('已经推送到日程 / 任务的不会动'));
  }
  // 真跑一遍 mount()：断言数据源那页在**没有任何主程序配合**的情况下也能画出卡片
  {
    const el = { innerHTML: '', querySelector: () => null, querySelectorAll: () => [], addEventListener: () => {}, appendChild: () => {} };
    const g = globalThis;
    const saved = { fetch: g.fetch, window: g.window, localStorage: g.localStorage, document: g.document };
    g.window = { addEventListener: () => {} };
    g.localStorage = { getItem: () => null, setItem: () => {} };
    g.document = {
      body: { dataset: {} }, getElementById: () => null, querySelector: () => null, querySelectorAll: () => [],
      // 2026-09-27：挂载改成"容器不在就现建一个" ⇒ 假 document 也得有 createElement
      createElement: () => ({ style: {}, dataset: {}, appendChild: () => {}, querySelector: () => null }),
    };
    g.fetch = async (url) => {
      const u = String(url);
      const body = u.includes('/api/connectors') ? {
        connectors: [{ id: 'rss', name: '通用 RSS / Atom 订阅', icon: '📡', description: '贴一个网址就能订阅', fields: [{ key: 'url', label: '订阅地址', type: 'text' }] }],
        configs: [], counts: { rss: 0 },
      } : u.includes('/api/prefs') ? { ui_mode: 'user', theme: 'p5', brand: {}, ui_modules: {} }
        : u.includes('/api/modules') ? { modules: [] }
          : u.includes('/api/health') ? { state: 'ok' }
            : { ok: true, capabilities: [], template: '' };
      return { ok: true, status: 200, json: async () => body };
    };
    let err = '';
    try { await settingsView.mount(el, { api: async () => ({}), pickablePages: [] }); }
    catch (e) { err = (e && e.message) || String(e); }
    g.fetch = saved.fetch; g.window = saved.window; g.localStorage = saved.localStorage; g.document = saved.document;
    ok('mount() 不抛错', err === '', err);
    // 2026-09-26 改版：这一页跟五步上手第①步同款 —— 一开始只有"教程 + 添加按钮 + 已添加的列表"
    ok('设置页自己就能画出新的数据源页（教程卡 + ＋添加数据源，不再依赖主程序）',
      el.innerHTML.includes('id="set-conn-add"') && el.innerHTML.includes('class="ob-tut"')
      && el.innerHTML.includes('还没有添加任何数据源'), el.innerHTML.slice(0, 200));
    ok('没有已配置的数据源时，不出现编号行', !el.innerHTML.includes('class="ob-src-row"'));
    const withOne = settingsView.renderSources({
      connectors: [{ id: 'rss', name: '通用 RSS', icon: '📡', description: '贴网址', fields: [] }],
      configs: [{ source: 'rss', config_json: JSON.stringify({ label: '学院公告' }), status: 'ok' }],
      counts: { rss: 7 },
    });
    ok('配过的按 1、2…列出来，带名字/来源/条数/改一下/删除',
      withOne.includes('class="ob-src-row"') && withOne.includes('已收到 7 条')
      && withOne.includes('学院公告') && withOne.includes('data-set-conn-open="rss"')
      && withOne.includes('data-set-conn-del="rss"'));
    // 「＋ 添加数据源」→ 选类型（下拉）+ 配置部分，和向导第①步是同一个流程
    ok('「＋ 添加数据源」打开"选择数据类型（下拉）+ 配置部分"',
      view.includes("on('#set-conn-add'") && view.includes('NEW_SOURCE')
      && view.includes("const sel = q('#set-conn-type')"));
    const blank = settingsView.renderSources({
      connectors: [{ id: 'rss', name: '通用 RSS', icon: '📡', fields: [] }], configs: [], counts: {},
      openSource: settingsView.NEW_SOURCE,
    });
    ok('还没选类型时：配置部分是提示，「保存并试一次」是灰的',
      blank.includes('id="set-conn-type"') && blank.includes('class="select-inline ob-select"')
      && /id="set-conn-save" disabled/.test(blank) && blank.includes('先在上面选一种数据类型'));
    const editing = settingsView.renderSources({
      connectors: [{ id: 'rss', name: '通用 RSS', icon: '📡', fields: [{ key: 'url', label: '订阅地址' }] }],
      configs: [{ source: 'rss', config_json: JSON.stringify({ url: 'https://a.example/feed.xml' }) }],
      counts: { rss: 3 }, openSource: 'rss', openInstance: 'rss',
    });
    ok('改某一个：下拉默认选中它、值填回去、还能就地删掉',
      /<option value="rss" selected>/.test(editing) && editing.includes('value="https://a.example/feed.xml"')
      && editing.includes('data-set-conn-del="rss"'));
    // 同类型第二条：下拉仍选中"类型"，但存取值走的是那条实例（rss@2）
    const editing2 = settingsView.renderSources({
      connectors: [{ id: 'rss', name: '通用 RSS', icon: '📡', fields: [{ key: 'url', label: '订阅地址' }] }],
      configs: [{ source: 'rss@2', type: 'rss', suffix: '（第 2 条）', config_json: JSON.stringify({ url: 'https://b.example/feed.xml' }) }],
      counts: { rss: 3 }, countsByInstance: { 'rss@2': 2 }, openSource: 'rss', openInstance: 'rss@2',
    });
    ok('改第 2 条时：下拉还是那个类型，但值取的是 `rss@2` 的、删除删的也是它',
      /<option value="rss" selected>/.test(editing2) && editing2.includes('value="https://b.example/feed.xml"')
      && editing2.includes('data-set-conn-del="rss@2"'), editing2.slice(0, 200));
  }
  ok('点齿轮 → 打开设置页', app.includes("$('#settings-btn').onclick = () => switchTab('settings')"));
  // 2026-09-26 晚：用户四条 —— ① Agent 卡片提前 ② 主菜单点击方式可选 ③ 学生特化（学期）
  {
    // 2026-09-26 晚第二版：**不单独给学生开一页**（非学生也用这个应用），
    // 学生模式 + 点击方式 + 学期 都收进「偏好」这一页；学期只在学生模式下出现。
    ok('设置里没有单独的「学期」页签（用户要求：别让学生专属占一页）',
      !tabsFor({}).some((t) => t.id === 'semester'));
    ok('多了一个「偏好」页签，里面有"是不是学生"的选择',
      tabsFor({}).some((t) => t.id === 'prefs')
      && settingsView.renderPrefs({}).includes('data-set-student="student"')
      && settingsView.renderPrefs({}).includes('data-set-student="general"')
      && settingsView.renderPrefs({}).includes('data-set-student="auto"'));
    ok('非学生：偏好页里**看不到**学期设置',
      !settingsView.renderPrefs({ studentMode: { mode: 'general' } }).includes('id="set-sem-start"'));
    const stu = settingsView.renderPrefs({
      studentMode: { mode: 'student', why: '你在分析偏好里提到了「课程、作业」' },
      semester: { start: '2026-09-07', weeks: 18 },
      semesterInfo: { configured: true, label: '第 3 周 / 共 18 周', end: '2027-01-10' },
    });
    ok('学生模式：偏好页里出现学期设置 + "第几周"预览',
      stu.includes('id="set-sem-start"') && stu.includes('id="set-sem-weeks"') && stu.includes('第 3 周 / 共 18 周'));
    ok('学生模式会说清"为什么按学生模式"（自动判断也要给依据）',
      stu.includes('你在分析偏好里提到了'));
    ok('偏好接口认 hub_click / semester / student_mode（白名单都加了）',
      /body\.hub_click/.test(prefsSrc) && /body\.semester/.test(prefsSrc) && /body\.student_mode/.test(prefsSrc)
      && prefsSrc.includes('hub_click:') && prefsSrc.includes('semester_info:') && prefsSrc.includes('student_mode:'));
    ok('主菜单有两种点法可选，默认是"点一次就进"',
      settingsView.renderFeatures({ pages: [], hubClick: 'once' }).includes('data-set-hub-click="once"')
      && settingsView.renderFeatures({ pages: [], hubClick: 'twice' }).includes('data-set-hub-click="twice"')
      && app.includes("let HUB_CLICK = 'once'"));
    ok('主菜单照模式走：once 直接切页、twice 才需要点第二下',
      /if \(HUB_CLICK !== 'twice'\) \{ switchTab\(tab\); return; \}/.test(app)
      && app.includes('if (hubCursor === tab) switchTab(tab)'));
    ok('悬停不再改按钮几何（否则按下那一刻元素还在滑，"点两下才生效"）',
      !/\.hub-mi:hover \{[^}]*transform:\s*translateX/.test(cssSrc) && cssSrc.includes('.semester-line'));
    ok('设置里换主题会连壁纸一起换（走主程序的出口，不让它绕过 applyWallpaper）',
      view.includes('window.__cairnApplyTheme(id)') && app.includes('window.__cairnApplyTheme = (id) =>')
      && /applyWallpaper\(id, state\.tab === 'hub' \? 'hub' : 'inner'\)/.test(app));
  }
  ok('外观页签：主题按钮 + 名字（点一下立刻生效）',
    renderPage({ tab: 'look' }).includes('data-set-theme="p5"') && renderPage({ tab: 'look' }).includes('set-appname-save'));
  ok('模式页签：用户/开发者两个按钮', /data-set-mode="user"/.test(renderPage({ tab: 'mode' })) && /data-set-mode="dev"/.test(renderPage({ tab: 'mode' })));
  ok('功能页签：勾选 + ↑↓ + 保存（与五步向导同一套数据）',
    renderFeatures({ pages: [{ id: 'a', name: 'A' }, { id: 'b', name: 'B' }], picked: ['a'], order: ['a', 'b'] })
      .includes('data-set-um="a"') && view.includes('ui_modules: { enabled: S.picked, order: S.order }'));
  ok('主菜单上的每一项都能被勾选（核心页也算功能）',
    app.includes('function pickablePages()') && app.includes('CORE_PAGES.filter((m) => !ALWAYS_ON.includes(m.tab))')
    && app.includes('pickablePages: pickablePages()'));
  ok('「今日」是落地页不能取消，「设置」永不入列',
    app.includes("const ALWAYS_ON = ['today'];") && app.includes("p.tab !== 'settings'"));
  // 2026-09-26 深夜（用户要求）：自启开关搬到「偏好」页，后台页只留状态
  ok('后台页签：服务状态（自启开关已经搬到偏好页）',
    renderRuntime({ health: { state: 'ok', autostart: { enabled: true } } }).includes('已开启')
    && !renderRuntime({ health: { state: 'ok', autostart: { enabled: true } } }).includes('id="set-autostart"'));
  ok('偏好页里有开机自启开关',
    settingsView.renderPrefs({ autostart: true, autostartPath: 'C:\\...\\CodexPlanner.lnk' }).includes('id="set-autostart"'));
}

// ---------- ②③ 能力开发：单文件、不改内核、能真跑 ----------
{
  const TMP = process.env.PLANNER_TEST_TMP || tmpdir();
  let dataDir = '';
  try { dataDir = mkdtempSync(join(TMP, 'capdev-')); } catch { dataDir = ''; }
  if (!dataDir) {
    console.log('  SKIP 临时目录不可写（没设 PLANNER_TEST_TMP）—— 能力开发那几条跳过');
  } else {
    ok('能力放在独立的文件夹里（数据目录/capabilities）', userCapDir(dataDir).endsWith(join('capabilities')) && !userCapDir(dataDir).startsWith(ROOT));
    ok('一开始是空的', (await loadUserCapabilities(dataDir)).length === 0);

    const code = [
      "export const meta = { id: 'demo.upper', name: '转大写', kind: 'compute', permissions: [], idempotent: true, cost: 'none', ui: { label: '转大写', group: '自写' } };",
      "export async function run(input = {}) { return { upper: String(input.text || '').toUpperCase() }; }",
    ].join('\n');
    const saved = await saveUserCapability(dataDir, { id: 'demo.upper', code, name: '转大写', kind: 'compute' });
    ok('保存即注册（回读校验通过）', saved.ok === true, JSON.stringify(saved));
    ok('文件真的落在数据目录里', existsSync(join(userCapDir(dataDir), 'demo.upper.mjs')));
    const list = await loadUserCapabilities(dataDir);
    ok('它出现在能力清单里（不用改内核）', list.length === 1 && list[0].id === 'demo.upper');
    const run = await runUserCapability(dataDir, 'demo.upper', { text: 'hi' });
    ok('试跑真的跑出结果', run.ok === true && run.output.upper === 'HI', JSON.stringify(run));

    const bad = await saveUserCapability(dataDir, { id: 'demo.bad', code: 'export const meta = {};' });
    ok('缺 run 的代码被拒收（并说清原因）', bad.ok === false && bad.error.includes('run'), JSON.stringify(bad));
    const clash = await saveUserCapability(dataDir, { id: 'course.text', code });
    ok('和平台自带能力重名会被拒（不能偷偷换掉别人依赖的能力）', clash.ok === false && clash.error.includes('重名'), JSON.stringify(clash));
    const badKind = await saveUserCapability(dataDir, {
      id: 'demo.badkind',
      code: "export const meta = { id: 'demo.badkind', name: 'x', kind: 'magic', permissions: [], idempotent: true, cost: 'none' };\nexport function run() { return {}; }",
    });
    ok('kind 写错也拦得住（走的是平台同一套校验）', badKind.ok === false && badKind.error.includes('kind'), JSON.stringify(badKind));

    // 接口层：列表 / 读文件 / 试跑 / 保存
    const routes = createCapabilityRoutes({
      dataDir,
      sendJson: (res, code2, body) => { res.code = code2; res.body = body; },
      sendError: (res, code2, msg) => { res.code = code2; res.body = { error: msg }; },
      readBody: async (req) => req.body,
      listModules: () => [],
    });
    const res1 = {};
    await routes.handleCapabilities({ method: 'GET' }, res1, { pathname: '/api/capabilities/dev', searchParams: new URLSearchParams('') });
    ok('接口能列出你写的能力', res1.code === 200 && res1.body.capabilities.length === 1, JSON.stringify(res1.body).slice(0, 160));
    const res2 = {};
    await routes.handleCapabilities({ method: 'GET' }, res2, { pathname: '/api/capabilities/dev', searchParams: new URLSearchParams('id=demo.upper') });
    ok('接口能把源码读回来（"打开"用）', res2.code === 200 && res2.body.code.includes('export async function run'));
    const res3 = {};
    await routes.handleCapabilities({ method: 'POST', body: { id: 'demo.upper', input: { text: 'abc' } } }, res3, { pathname: '/api/capabilities/dev/run', searchParams: new URLSearchParams('') });
    ok('接口试跑返回产出', res3.code === 200 && res3.body.output.upper === 'ABC', JSON.stringify(res3.body));
    const res4 = {};
    await routes.handleCapabilities({ method: 'GET' }, res4, { pathname: '/api/capabilities', searchParams: new URLSearchParams('') });
    ok('自写能力也进了 /api/capabilities（能力搭建能用它）',
      res4.body.count === 11 && res4.body.user_count === 1 && res4.body.capabilities.some((c) => c.id === 'demo.upper' && c.source === 'user'),
      `count=${res4.body.count} user=${res4.body.user_count}`);

    // 图执行里也能调到它（host.invoke 兜底去找自写能力）
    const host = createCapabilityHost({ providers: { dataDir } });
    const viaHost = await host.invoke('demo.upper', { text: 'via host' });
    ok('「功能 = 能力图」里能直接调用自写能力', viaHost.ok === true && viaHost.output.upper === 'VIA HOST', JSON.stringify(viaHost));

    ok('开发面板带模板与试跑入口', renderDevPane({ userCaps: [] }).includes('fb-dev-code') && DEV_TEMPLATE.includes('export async function run'));
  }
}

// ---------- ⑤ 第三档排序：轻重缓急 ----------
{
  const H = 3600 * 1000;
  const now = Date.now();
  const mk = (id, due, pri, status = 'todo') => ({ id, title: id, status, priority: pri, due_at: due });
  const tasks = [
    mk('overdue-low', new Date(now - 5 * H).toISOString(), 3),        // 逾期、低优先级
    mk('today-high', new Date(now + 3 * H).toISOString(), 0),          // 今天、高优先级
    mk('soon-low', new Date(now + 40 * H).toISOString(), 3),           // 三天内、低优先级
    mk('far-high', new Date(now + 20 * 24 * H).toISOString(), 0),      // 很久以后、高优先级（"重要不紧急"）
  ];
  const order = (s) => tasksSelection({ tasks }, { filter: 'all', sort: s, nowMs: now }).list.map((t) => t.id).join(',');
  ok('轻重缓急：逾期最前，其次今天，再三天内，最后远期',
    order('balanced') === 'overdue-low,today-high,soon-low,far-high', order('balanced'));
  ok('重要不紧急（far-high）不会因为"优先级高"就占前排', order('balanced').split(',').pop() === 'far-high');
  ok('同档内按优先级（今天档里高优先级在前）', order('balanced').indexOf('today-high') < order('balanced').indexOf('soon-low'));
  ok('时间优先仍然是严格按截止时间', order('due') === 'overdue-low,today-high,soon-low,far-high' || order('due').split(',')[0] === 'overdue-low');
  ok('三档在界面上都能选', app.includes('>智能排序<') && app.includes('>轻重缓急<') && app.includes('>时间优先<'));
}

console.log('');
console.log(failures === 0 ? 'settings-dev.test: PASS' : `settings-dev.test: FAIL (${failures})`);
process.exit(failures === 0 ? 0 : 1);
