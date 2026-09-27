// 「五步上手」的验证：**首次运行的闸门**（像新电脑开箱）+ 用户/开发者模式（P5）。
//
//   node tests/onboarding-wizard.test.mjs
//
// 用户的原始要求：「五步上手整体设立在**能够使用本应用之前**，即像上手了一台新电脑配置 Windows 一样」。
// 所以这里最要紧的两条是：① 没配完**必须**弹；② 走完或明确跳过之后**必须**不再弹。

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  DEV_DOCS, boot, renderDevPanel, renderGate, renderPage, renderProgress, renderStep, shouldGate, stepDefs,
} from '../modules/onboarding/view.js';
import {
  DOC_SOURCES, renderLookStage, renderPrefsStage, renderShell, renderSourcesList, renderTypeForm,
  shouldGate as wizardShouldGate, stageOf as wizardStageOf, stepDefs as wizardStepDefs, stepsView,
} from '../modules/onboarding/wizard.js';
import { listConnectorMeta } from '../lib/connectors/index.mjs';
import { validateModule } from '../lib/modules.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
let failures = 0;
const ok = (label, cond, detail = '') => {
  if (cond) console.log(`  PASS ${label}`);
  else { failures += 1; console.log(`  FAIL ${label}${detail ? ` -- ${detail}` : ''}`); }
};

console.log('onboarding-wizard.test.mjs');

const STEPS = [
  { id: 'sources', n: '①', title: '连上数据源', hint: 'h', done: true, why: '已连上 5 个数据源', target: 'connectors', go: '数据源' },
  { id: 'prefs', n: '②', title: '写下你关心什么', hint: 'h', done: false, why: '还没写关键词', target: 'connectors', go: '数据源' },
  { id: 'modules', n: '③', title: '挑几个现成功能', hint: 'h', done: false, manual: true, why: '看过之后点一下', target: 'today', go: '今日' },
  { id: 'build', n: '④', title: '拼一个自己的功能', hint: 'h', done: true, why: '已经有 1 个能力图功能', target: 'flow-builder', go: '能力搭建' },
  { id: 'ui', n: '⑤', title: '调成你喜欢的样子', hint: 'h', done: false, why: '用的还是默认外观', target: 'theme', go: '风格' },
];

// ---------- ① 闸门的判断（最关键的一条） ----------
{
  ok('全新用户（没有任何偏好）→ 要弹', shouldGate({}) === true);
  ok('走完过（有 completed_at）→ 不再弹', shouldGate({ wizard: { completed_at: '2026-09-25T00:00:00Z' } }) === false);
  ok('明确跳过过（dismissed）→ 不再弹', shouldGate({ wizard: { dismissed: true } }) === false);
  ok('只是跳过某一步（skipped）→ 还要弹（没走完不能放行）',
    shouldGate({ wizard: { skipped: { build: true } } }) === true);
  ok('兼容老键名 onboarding_wizard（升级过的人不会又被弹一次）',
    shouldGate({ onboarding_wizard: { completed_at: 'x' } }) === false);
  // 2026-09-26：用户又反馈"每一次打开都要进一次导览" —— 以前没走完就关窗口，下次还会拦。
  ok('弹过一次（shown_at）→ 不再自动弹（只做"初次打开"）',
    shouldGate({ wizard: { shown_at: '2026-09-26T00:00:00Z' } }) === false);
  ok('偏好整个读不出来（空对象）→ 宁可弹（新机器语义）', shouldGate(null) === true && shouldGate(undefined) === true);
  let threw = false;
  try { shouldGate({ wizard: 'not-an-object' }); } catch { threw = true; }
  ok('偏好里存了怪东西也不炸', threw === false);
}

// ---------- ② 五步本身 ----------
{
  const defs = stepDefs();
  ok('就是五步', defs.length === 5, String(defs.length));
  ok('顺序是 数据源 → 分析偏好 → 现有功能 → 新建功能 → UI',
    defs.map((s) => s.id).join(',') === 'sources,prefs,modules,build,ui', defs.map((s) => s.id).join(','));
  ok('每步都有标题/说明/去哪', defs.every((s) => s.title && s.hint && s.go));
  ok('④ 指向能力搭建、⑤ 指向风格', defs[3].go === '能力搭建' && defs[4].go === '风格');
}

// ---------- ③ 闸门的界面 ----------
{
  const html = renderGate({ steps: STEPS, step: 0 });
  ok('盖住整个界面（全屏遮罩 + 独立 id）', html.includes('class="ob-gate" id="ob-gate"'));
  ok('五个点都在，当前那个高亮、做过的标完成',
    (html.match(/data-ob-jump="/g) || []).length === 5 && html.includes('ob-dot cur') && html.includes('ob-dot'));
  ok('每一步都说清"现在是什么状态"（真实理由写在标题下）', html.includes('已连上 5 个数据源'));
  ok('当前步的**真界面**是被嵌进来的（panelHtml），不是跳出去',
    renderGate({ steps: STEPS, step: 1, panelHtml: '<div id="ob-panel-x">面板</div>' }).includes('id="ob-panel-x"'));
  ok('底部常驻"跳过这一步"（不依赖那一步自己的按钮）',
    renderGate({ steps: STEPS, step: 1 }).includes('id="ob-gate-skip"'));
  ok('每一步都有"先跳过，直接进入"（不能把人锁死在向导里）',
    html.includes('id="ob-skipall"') && html.includes('先跳过，直接进入'));
  ok('最后一步的按钮是"开始使用"，不是"下一步"',
    renderGate({ steps: STEPS, step: 4 }).includes('id="ob-finish"') && !renderGate({ steps: STEPS, step: 4 }).includes('id="ob-next"'));
  ok('中间步骤是"下一步"', renderGate({ steps: STEPS, step: 1 }).includes('id="ob-next"'));
  ok('第一步没有"上一步"（禁用了）', /id="ob-prev" disabled/.test(renderGate({ steps: STEPS, step: 0 })));
  ok('步数写出来（第 N 步，共 5 步）', html.includes('第 1 步，共 5 步'));
  ok('页面/闸门都不引入外链脚本（只用接口）', !/<script/i.test(html));
}

// ---------- ④ 用户模式 / 开发者模式 ----------
{
  ok('用户模式：不出现开发者那一块', renderDevPanel({ mode: 'user' }) === '');
  const dev = renderDevPanel({ mode: 'dev', capabilityCount: 10, flowCount: 2 });
  ok('开发者模式：摊开能力数/功能数', dev.includes('10') && dev.includes('2') && dev.includes('🛠 开发者'));
  ok('开发者模式：给到"画一个功能"与三个文档出口',
    dev.includes('data-ob-go="能力搭建"')
    && dev.includes(DEV_DOCS.processor) && dev.includes(DEV_DOCS.module) && dev.includes(DEV_DOCS.guide));
  ok('开发者模式：带命令行速查（cap list / mod test / mod run）',
    dev.includes('cairn.mjs cap list') && dev.includes('cairn.mjs mod test') && dev.includes('--real'));
  ok('页面里也有模式下拉（存在偏好里）',
    renderPage({ steps: STEPS, mode: 'dev' }).includes('id="ob-mode"')
    && renderPage({ steps: STEPS, mode: 'dev' }).includes('>开发者模式<'));
  ok('用户模式下页面不出现开发者清单',
    !renderPage({ steps: STEPS, mode: 'user' }).includes('🛠 开发者'));
  ok('页面上常驻一颗「重新打开五步上手」（导览只做初次打开，想再看就靠它）',
    renderPage({ steps: STEPS, dismissed: true }).includes('id="ob-reopen-wizard"')
    && renderPage({ steps: STEPS }).includes('id="ob-reopen-wizard"')
    && renderPage({ steps: STEPS, dismissed: true }).includes('重新打开五步上手'));
}

// ---------- ⑤ 进度与单步 ----------
{
  ok('进度条按"完成了几步"算（2/5 = 40%）', renderProgress({ steps: STEPS }).includes('40%'));
  ok('进度文案写清 2/5 与跳过数',
    renderProgress({ steps: [{ done: true }, { skipped: true }] }).includes('1/2 步完成')
    && renderProgress({ steps: [{ done: true }, { skipped: true }] }).includes('跳过 1'));
  ok('单步徽章三态（已完成 / 已跳过 / 待办）',
    renderStep({ id: 'a', done: true }).includes('已完成')
    && renderStep({ id: 'a', skipped: true }).includes('已跳过')
    && renderStep({ id: 'a' }).includes('待办'));
}

// ---------- ⑥ 接进平台：boot 钩子 ----------
{
  const desc = JSON.parse(readFileSync(join(ROOT, 'modules', 'onboarding', 'module.json'), 'utf8'));
  ok('模块声明了 boot: true（应用启动时跑一次）', desc.boot === true);
  ok('它仍然是一个能单独打开的页面（kind=view）', desc.kind === 'view' && desc.entry.view === 'view.js');
  ok('validateModule 接受 boot: true', validateModule(desc).ok === true, validateModule(desc).errors.join('；'));
  ok('boot 写错类型要报错',
    validateModule({ ...desc, boot: 'yes' }).errors.some((e) => e.includes('boot')));
  const app = readFileSync(join(ROOT, 'public', 'app.js'), 'utf8');
  ok('主程序在启动后调用 boot 模块', app.includes('await runBootModules()') && app.includes('x.boot === true'));
  ok('boot 模块坏了不拖垮主应用（整段 try 住）',
    /runBootModules[\s\S]{0,600}catch/.test(app));
  // 2026-09-26：版本号里要**同时带上入口文件的 mtime** —— 只带 version 的话，
  // 改了 view.js 但没提版本号，浏览器还是跑旧模块（今天就是这么卡住的）。
  ok('模块脚本带版本号 + 入口文件时间戳导入（改了模块刷新就生效）',
    app.includes("m.version || '0'") && app.includes('m.mtime')
    && app.includes("/modules/' + m.id + '/' + m.entry.view"));
  ok('导出的是 boot 函数（app.js 按名字找）',
    typeof boot === 'function');
  const view = readFileSync(join(ROOT, 'modules', 'onboarding', 'view.js'), 'utf8');
  ok('闸门用 Esc 也能"先跳过"（不锁人）', view.includes("e.key === 'Escape'"));
  ok('闸门自己会清理（关闭时把宿主节点移除，不留空遮罩）', view.includes('host.remove()'));
  ok('样式里有闸门与进度条', readFileSync(join(ROOT, 'public', 'styles.css'), 'utf8').includes('.ob-gate'));
}

// ---------- ⑦ 用户在 2026-09-25 报的四个问题：逐条钉住 ----------
{
  const view = readFileSync(join(ROOT, 'modules', 'onboarding', 'view.js'), 'utf8');

  // 问题①「每次打开都弹」 ⇒ 状态必须**存得进服务端**（prefs 白名单以前不认这个键）
  const prefs = readFileSync(join(ROOT, 'lib', 'routes', 'prefs.mjs'), 'utf8');
  ok('偏好接口认 wizard 这个键（以前 POST 直接被忽略 ⇒ 所以每次打开都弹）',
    prefs.includes("WIZARD_KEY") && /body\.wizard/.test(prefs));
  ok('偏好接口也认 ui_mode 与 ui_modules（用户/开发者模式、主页摆哪些功能）',
    /body\.ui_mode/.test(prefs) && /body\.ui_modules/.test(prefs));
  ok('快照里带上它们（界面改完能立刻读到新值）',
    /wizard: readJson\(WIZARD_KEY\)/.test(prefs) && /ui_mode:/.test(prefs) && /ui_modules: readJson/.test(prefs));
  ok('向导写的是新键 wizard（不是被忽略的 onboarding_wizard）',
    view.includes("api('POST', '/api/prefs', { wizard: patch })"));
  ok('服务端存不上时，本机也要记住这一次（不会再骚扰一遍）',
    view.includes('planner-wizard-fallback'));

  // 问题②「操作没嵌在步骤里、点完背景跳走还没法操作」 ⇒ 每一步都要自带界面
  ok('① 数据源：列出数据源 + 就地配置表单（不再跳到别的页）',
    view.includes('data-conn-open') && view.includes('data-conn-field') && view.includes('ob-conn-save'));
  ok('① 保存就走已有接口（POST /api/connectors/:id/import，真连一次）',
    view.includes("api('POST', `/api/connectors/${id}/import`, { config })"));
  ok('② 分析偏好：就地写关键词并保存到 /api/profile',
    view.includes('id="ob-keywords"') && view.includes("api('POST', '/api/profile', { enabled: true, keywords })"));
  ok('④ 拼功能：把「能力搭建」嵌进来（import + mount，不再跳页）',
    view.includes("'/modules/flow-builder/' + fb.entry.view") && view.includes('m.mount(box, ctx)'));
  ok('④ 嵌入时版本号是从 /api/modules 现读的（别人升版这里就不会拿到旧代码）',
    view.includes("encodeURIComponent(fb.version || '0')") && !view.includes("view.js?v=0.3.1"));
  ok('⑤ 外观：主题按钮就地生效（写 body.dataset.theme + localStorage + prefs）',
    view.includes("data-ob-theme") && view.includes("document.body.dataset.theme = id")
    && view.includes("localStorage.setItem('planner-theme', id)"));
  ok('⑤ 名字就地改（并同步顶部显示名）', view.includes("app_name: v") && view.includes('app-name-brand'));
  const bootPart = view.slice(view.indexOf('export async function boot('));
  ok('闸门这一段里没有"把应用切到别的页"的调用（不然又变成背景跳转）',
    bootPart.length > 500 && !/nav\(['"]/.test(bootPart) && !bootPart.includes('data-ob-gate-go'));

  // 问题③「挑功能要能勾选 + 排序，并且主页按它摆、没勾的不出现」
  ok('③ 勾选（复选框）与上下排序都在', view.includes('data-um="') && view.includes('data-um-up') && view.includes('data-um-down'));
  ok('③ 保存清单走 ui_modules（enabled + order）',
    view.includes('ui_modules: { enabled: S.picked, order: S.order }'));
  const app = readFileSync(join(ROOT, 'public', 'app.js'), 'utf8');
  ok('主程序按清单筛选模块（没勾的不进导航，主页也不出现）',
    app.includes('function applyModuleLayout()') && app.includes('pages = pages.filter((p) => sel.includes(p.tab))'));
  ok('主程序按清单排序（order 决定先后；不在 order 里的排后面）',
    app.includes('const ia = order.indexOf(a.p.tab)') && app.includes('MODULES.push(...arranged'));
  // 2026-09-26 用户改了口径：**主菜单上的每一项都是功能**，核心页（日程/任务/养成/统计/音乐…）
  // 也能被取消；只有「今日」是落地页不能取消，「设置」永不入列（走右上角齿轮）。
  ok('核心页也能被取消（除「今日」），「设置」永不入导航',
    app.includes("const ALWAYS_ON = ['today'];") && app.includes('UI_MODULES.enabled.includes(m.tab)')
    && app.includes("p.tab !== 'settings'"));
  ok('向导保存清单后立刻重排主页（applyLayout 回填给它）',
    view.includes('if (applyLayout) await applyLayout()') && app.includes('applyLayout: reloadModuleLayout'));

  // 问题④「开始使用 / 去风格点了没反应」 ⇒ 根因：绑定时元素不存在直接抛异常
  ok('绑定按钮前都判空（上一版就是这里 null.onclick 抛异常，整排按钮全哑）',
    view.includes('const on = (sel, fn) => { const el = q(sel); if (el) el.onclick = fn; }'));
  ok('"开始使用"绑的事件真的存在（#ob-finish 只在最后一步渲染，也没有裸查）',
    view.includes("on('#ob-finish'") && !/querySelector\('#ob-next'\)\.onclick/.test(view));
  ok('"跳过这一步"是底部一颗常驻按钮（不依赖那一步有没有手动标记）',
    view.includes("on('#ob-gate-skip'"));
  ok('关闸门会顺手把宿主节点移除（不留半透明遮罩挡住应用）',
    view.includes('host.remove()'));
}

// ---------- ⑧ 全屏导览（wizard.js）：2026-09-26 用户的三条新要求 ----------
{
  const wz = readFileSync(join(ROOT, 'modules', 'onboarding', 'wizard.js'), 'utf8');
  const css = readFileSync(join(ROOT, 'public', 'styles.css'), 'utf8');
  const CONNS = listConnectorMeta();

  // 要求①：整屏导览，不是中间一个小框
  const shell = renderShell({ steps: STEPS, step: 0, stage: '<div id="ob-stage-x">舞台</div>' });
  ok('是全屏外壳（ob-gate-full + 左右两栏 ob-shell）',
    shell.includes('ob-gate-full') && shell.includes('class="ob-shell"'));
  ok('左边是步骤轨道，五步都在、当前那步高亮',
    shell.includes('class="ob-rail"') && (shell.match(/data-ob-jump="/g) || []).length === 5
    && shell.includes('ob-rail-step cur'));
  ok('右边是大舞台，这一步的真界面嵌在里面（不是跳走）',
    shell.includes('class="ob-stage"') && shell.includes('id="ob-stage-x"'));
  ok('底部有 上一步 / 跳过这一步 / 下一步，最后一步换成「开始使用」',
    shell.includes('id="ob-prev"') && shell.includes('id="ob-gate-skip"') && shell.includes('id="ob-next"')
    && renderShell({ steps: STEPS, step: 4 }).includes('id="ob-finish"'));
  ok('全屏那套样式真的写了（外壳/轨道/舞台/教程卡/数据源行/长文本/配置块）',
    ['.ob-gate-full', '.ob-shell', '.ob-rail-step', '.ob-stage-body', '.ob-tut', '.ob-src-row', '.ob-notes', '.ob-formgrid', '.ob-config']
      .every((sel) => css.includes(sel)));
  ok('窗口够宽就保持左右两栏，太窄了才竖过来',
    /@media \(max-width: 820px\)[\s\S]{0,200}\.ob-shell \{ grid-template-columns: 1fr; \}/.test(css)
    && /@media \(max-width: 1180px\)[\s\S]{0,120}\.ob-shell \{ grid-template-columns: 272px 1fr; \}/.test(css));

  // 要求②（2026-09-26 改版）：第一步 = 一开始**只有教程 + 添加按钮**，
  // 点「＋ 添加数据源」→ 选择数据类型（下拉）+ 配置部分 → 回到列表，列表多一行。
  const empty = renderSourcesList({ connectors: CONNS, configs: [], counts: {} });
  ok('一开始整个页面只有两样东西：教程 + 「＋ 添加数据源」按钮',
    empty.includes('class="ob-tut"') && empty.includes('id="ob-src-add"')
    && !empty.includes('ob-src-row') && empty.includes('还没有添加任何数据源'));
  ok('教程卡就是《如何上手数据源配置》，点开有东西看', empty.includes(`href="${DOC_SOURCES}"`));
  ok('那份文档真的存在，而且不是空壳（讲清了字段/凭据/试跑）',
    (() => {
      const doc = readFileSync(join(ROOT, 'docs', 'CONNECT_SOURCES.md'), 'utf8');
      return doc.length > 800 && /导入|试/.test(doc);
    })());
  const withTwo = renderSourcesList({
    connectors: CONNS, counts: { email: 5, rss: 0 },
    configs: [
      { source: 'email', config_json: JSON.stringify({ user: 'me@example.com' }), status: 'ok' },
      { source: 'rss', config_json: JSON.stringify({ label: '学院公告' }), status: 'error', last_error: '拿不到 feed' },
    ],
  });
  ok('已经添加过的按 1、2…排在下面，带名字 / 来源 / 收到多少条',
    (withTwo.match(/class="ob-src-n"/g) || []).length === 2
    && withTwo.includes('邮箱 (IMAP)') && withTwo.includes('已收到 5 条')
    && withTwo.includes('me@example.com') && withTwo.includes('学院公告'));
  // status 的取值是 ok / configured / empty，**只有真带 last_error 才算没连上** ——
  // 第一版把 configured 也标成"没连上"，是误报，这条盯着别再犯。
  ok('真出错了才标「没连上」，并带上原因',
    withTwo.includes('没连上：拿不到 feed')
    && !renderSourcesList({ connectors: CONNS, configs: [{ source: 'rss', status: 'configured' }] }).includes('没连上')
    && renderSourcesList({ connectors: CONNS, configs: [{ source: 'rss', status: 'configured' }] }).includes('已配置，还没同步过')
    && renderSourcesList({ connectors: CONNS, configs: [{ source: 'rss', status: 'ok' }] }).includes('已收到 0 条'));
  ok('每一行都有「改一下」', (withTwo.match(/data-ob-edit="/g) || []).length === 2);
  // 2026-09-26 用户要求：已添加的数据源要能删
  ok('每一行都有「删除」', (withTwo.match(/data-ob-del="/g) || []).length === 2
    && withTwo.includes('data-ob-del="email"') && withTwo.includes('data-ob-del="rss"'));
  ok('删除走 DELETE /api/connectors/:id，并且二次确认里说清连带删什么',
    wz.includes("api('DELETE', `/api/connectors/${id}`)")
    && wz.includes('会一并删掉它导入进来的') && wz.includes('已经推送到日程 / 任务的不会动'));
  // 列表顺序要跟"数据源卡片"的优先级一致（backend 是按 source 字母序给的）
  {
    const rowsHtml = renderSourcesList({
      connectors: CONNS,
      configs: [
        { source: 'feishu', config_json: '{}' },
        { source: 'arxiv', config_json: '{}' },
        { source: 'email', config_json: '{}' },
        { source: 'rss', config_json: '{}' },
      ],
    });
    const order = [...rowsHtml.matchAll(/data-ob-edit="([^"]+)"/g)].map((m) => m[1]);
    ok('列表按"常用在前"排（邮箱 → arXiv → RSS → 飞书），不是按字母序',
      JSON.stringify(order) === JSON.stringify(['email', 'arxiv', 'rss', 'feishu']), JSON.stringify(order));
  }

  const rssMeta = CONNS.find((c) => c.id === 'rss');
  const blank = renderTypeForm({ connectors: CONNS, pickedType: null });
  ok('「选择数据类型」是个下拉框，而且和任务页那个排序框同一个样式（图 1）',
    blank.includes('id="ob-type-select"') && blank.includes('class="select-inline ob-select"')
    && (blank.match(/<option /g) || []).length === CONNS.length + 1);
  ok('还没选类型时：配置部分给提示，「保存并试一次」是灰的',
    /id="ob-type-save" disabled/.test(blank) && blank.includes('先在上面选一种数据类型'));
  const form = renderTypeForm({ connectors: CONNS, pickedType: 'rss' });
  ok('选好类型后，配置部分按这个数据源自己的字段生成输入框',
    form.includes('ob-config-head') && form.includes('配置部分')
    && (form.match(/data-ob-field="/g) || []).length === (rssMeta.fields || []).length
    && (rssMeta.fields || []).length > 0);
  ok('下拉里默认选中刚才那个类型（改一下时一眼能看出在改谁）',
    /<option value="rss" selected>/.test(form));
  ok('「改一下」会把存过的值填回去（掩码凭据原样带回，服务端沿用真值）',
    renderTypeForm({ connectors: CONNS, pickedType: 'rss', formSaved: { url: 'https://a.example/feed.xml' } })
      .includes('value="https://a.example/feed.xml"'));
  ok('能翻回列表 / 翻文档', form.includes('id="ob-type-back"') && form.includes(`href="${DOC_SOURCES}"`));

  // 要求③：分析偏好可写长文 + 导本地文件
  const prefsStage = renderPrefsStage({ notes: 'x' });
  ok('分析偏好是一块能写长文的文本域（不是一行小输入框）',
    prefsStage.includes('id="ob-notes"') && /rows="12"/.test(prefsStage));
  ok('能导入本地文件（file input 收 txt / md / json / csv）',
    prefsStage.includes('type="file"') && prefsStage.includes('id="ob-file"')
    && ['.txt', '.md', '.json', '.csv'].every((ext) => prefsStage.includes(ext)));
  ok('导入走 FileReader（选完就把内容并进长文里）',
    wz.includes('new FileReader()') && wz.includes('readAsText') && wz.includes('slice(0, 4000)'));
  ok('保存时顺手把关键词一起写进 /api/profile',
    wz.includes("api('POST', '/api/profile', { enabled: true, notes: text, keywords: merged })"));
  ok('关键词"只加不减"（设置页里手填的不会被这一步冲掉）',
    wz.includes('[...new Set([...(S.keywords || []), ...freshKeywords])]'));
  ok('这一步也有自己的「下一步」，而且 id 和底部那颗不重名',
    prefsStage.includes('id="ob-notes-next"') && !prefsStage.includes('id="ob-next"'));
  // 2026-09-26 现场抓到的真 bug：舞台里那颗和底部那颗撞了同一个 id，
  // q('#ob-next') 只拿到先出现的一颗 ⇒ 底部那颗点了完全没反应（老毛病"点了不动"）。
  {
    const screens = [
      { step: 0, addPhase: 'list' }, { step: 0, addPhase: 'form', pickedType: 'rss' },
      { step: 1 }, { step: 2 }, { step: 3 }, { step: 4 },
    ];
    const dupes = [];
    for (const s of screens) {
      const html = renderShell({ steps: STEPS, step: s.step, stage: wizardStageOf({ ...s, connectors: CONNS }) });
      const ids = [...html.matchAll(/id="([^"]+)"/g)].map((m) => m[1]);
      const bad = [...new Set(ids.filter((id, i) => ids.indexOf(id) !== i))];
      if (bad.length) dupes.push(`第${s.step + 1}步(${s.addPhase || '唯一一屏'}): ${bad.join(',')}`);
    }
    ok('每一屏里的元素 id 都不重复（否则 querySelector 只绑到先出现的那一颗）', dupes.length === 0, dupes.join(' | '));
    ok('底部与第②步那两颗「下一步」都真的绑上了事件',
      wz.includes("on('#ob-next', goNext)") && wz.includes("on('#ob-notes-next', goNext)"));
    ok('新第一步的三颗按钮都绑了：添加 / 下拉切换 / 返回列表',
      wz.includes("on('#ob-src-add'") && wz.includes("sel.onchange") && wz.includes("on('#ob-type-back'")
      && wz.includes("onAll('[data-ob-edit]'"));
  }
  // 2026-09-26 现场抓到的第二处漏接：启动钩子没把「可挑功能清单」传进来，
  // 向导只好退回 /api/modules 的插件页 ⇒ 第③步只列出 2 个功能（核心页全都不见了）。
  // 2026-09-26：所有模块挂载点统一走 moduleCtx()，不再各写一份（以前就漏过一次 pickablePages）
  ok('启动钩子拿到的是统一的那份模块上下文（含可挑功能清单 + 重排主页）',
    /await mod\.boot\(moduleCtx\(\)\)/.test(readFileSync(join(ROOT, 'public', 'app.js'), 'utf8'))
    && /function moduleCtx\(\) \{[\s\S]{0,260}pickablePages: pickablePages\(\)[\s\S]{0,80}applyLayout: reloadModuleLayout/.test(
      readFileSync(join(ROOT, 'public', 'app.js'), 'utf8')));
  {
    const app = readFileSync(join(ROOT, 'public', 'app.js'), 'utf8');
    const core = app.slice(app.indexOf('const CORE_PAGES'), app.indexOf('let MODULE_PAGES'));
    ok('可挑清单里含核心页（除落地页「今日」）与插件页，且排除设置/五步上手',
      /ALWAYS_ON = \['today'\]/.test(core) && core.includes('core: true')
      && core.includes("m.tab !== 'settings' && m.tab !== 'onboarding'"));
  }
  ok('长文真的活得下来（relevance 的画像归一化不再把 notes 丢掉）',
    readFileSync(join(ROOT, 'lib', 'relevance.mjs'), 'utf8').includes('notes'));

  // 分屏路由：step + addPhase 决定这一屏画什么
  ok('第一步的两屏（列表 / 添加）由 addPhase 切换',
    wizardStageOf({ step: 0, addPhase: 'list', connectors: CONNS }).includes('id="ob-src-add"')
    && wizardStageOf({ step: 0, addPhase: 'form', connectors: CONNS, pickedType: 'rss' }).includes('id="ob-type-save"'));
  ok('不写 addPhase 时默认落在列表（不是直接进表单）',
    wizardStageOf({ step: 0, connectors: CONNS }).includes('id="ob-src-add"'));
  ok('②③④⑤ 各有自己的一屏', wizardStageOf({ step: 1 }).includes('ob-notes')
    && wizardStageOf({ step: 2 }).includes('ob-fnlist')
    && wizardStageOf({ step: 3 }).includes('ob-flowhost')
    && wizardStageOf({ step: 4 }).includes('data-ob-theme'));
  // 2026-09-26 晚（审核的意见）：接入 agent 的操作也要在五步里 ⇒ 挂在第②步下面
  ok('第②步里挂了「Agent / 模型接入」（审核的人提的）',
    renderPrefsStage({}).includes('id="ob-agent-host"')
    && wz.includes("ctx.mountModule(aBox, 'agent-connect')"));

  // 2026-09-26 用户要求：第⑤步接 Wallpaper Engine。做法是复用主程序里抽出来的那一份壁纸界面。
  ok('第⑤步里留了壁纸的位置，并且叫主程序把同一份界面挂进来（不另写一套）',
    renderLookStage({}).includes('id="ob-wp-host"')
    && wz.includes("typeof ctx.mountWallpaper === 'function'") && wz.includes('ctx.mountWallpaper(wpBox)'));
  {
    const app = readFileSync(join(ROOT, 'public', 'app.js'), 'utf8');
    ok('壁纸整块被抽成可复用的函数（主题弹窗 / 设置页 / 向导共用一份）',
      app.includes('function wallpaperPanelHtml()') && app.includes('function mountWallpaperPanel(host)')
      && app.includes('function bindWallpaperPanel(root)') && app.includes('function refreshWallpaperPanels()'));
    ok('接的还是 Wallpaper Engine 那一套接口：扫壁纸库 / 设为某主题 / 选创意工坊目录',
      app.includes("api('GET', '/api/wallpapers')") && app.includes('/api/wallpapers/${id}/use')
      && app.includes("api('POST', '/api/localdirs', { key: 'wallpaper', dir })")
      && app.includes("api('POST', '/api/localdirs/pick', { key: 'wallpaper' })")
      && app.includes('appid=431960'));
    ok('主程序把「挂壁纸面板」写进统一模块上下文（页面模块与启动钩子都会拿到）',
      (app.match(/await mod\.mount\(box, moduleCtx\(\)\)/g) || []).length >= 1
      && app.includes('mountWallpaper: mountWallpaperPanel')
      && app.includes('await mod.boot(moduleCtx())'));
    const panel = readFileSync(join(ROOT, 'modules', 'settings', 'panel.js'), 'utf8');
    ok('设置 → 外观 里也挂同一份壁纸（否则走完向导就再也改不了壁纸）',
      panel.includes('id="set-wp-host"') && panel.includes('ctx.mountWallpaper(host)'));
  }
  ok('左轨下半截那条多余的横向滑条没了（只留竖直滚动）',
    /\.ob-rail-steps \{[^}]*overflow-y: auto; overflow-x: hidden/.test(css));
  ok('五步的定义和 view.js 完全一致（没有两套说法）',
    wizardStepDefs().map((s) => s.id).join(',') === stepDefs().map((s) => s.id).join(','));
  ok('新导览的闸门判断与旧的同一套语义（没走完就该弹，跳过过就不再弹）',
    wizardShouldGate({}) === true && wizardShouldGate({ wizard: { completed_at: 'x' } }) === false
    && wizardShouldGate({ wizard: { dismissed: true } }) === false);
  {
    const view = readFileSync(join(ROOT, 'modules', 'onboarding', 'view.js'), 'utf8');
    ok('只做"初次打开"：弹出来就记一笔，以后再打开不会又被拦住',
      wizardShouldGate({ wizard: { shown_at: 'x' } }) === false
      && wz.includes('if (w.shown_at) return false;')
      && wz.includes('shown_at: new Date().toISOString()'));
    ok('「重新打开五步上手」把三个开关都清掉再叫起导览（想再看就有路）',
      view.includes("dismissed: false, completed_at: '', shown_at: ''") && view.includes('mod.bootWizard(ctx)'));
    ok('导航页写偏好统一用新键 wizard（以前写 onboarding_wizard，按了"别再提示我"其实不管用）',
      view.includes("savePrefs({ wizard: { dismissed: true }") && !view.includes('onboarding_wizard: { dismissed'));
  }
  ok('每一步按真实状态打勾（连了数据源 / 写了偏好 才算完）',
    stepsView({ counts: { rss: 3 } }).find((s) => s.id === 'sources').done === true
    && stepsView({}).find((s) => s.id === 'sources').done === false
    && stepsView({ notes: '在意的东西' }).find((s) => s.id === 'prefs').done === true);
  ok('view.js 的 boot 只是转发到 wizard.js，并且转发时自带时间戳（不吃浏览器旧缓存）',
    /import\(`\.\/wizard\.js\?v=\$\{Date\.now\(\)\}`\)/.test(
      readFileSync(join(ROOT, 'modules', 'onboarding', 'view.js'), 'utf8')));
}

console.log('');
console.log(failures === 0 ? 'onboarding-wizard.test: PASS' : `onboarding-wizard.test: FAIL (${failures})`);
process.exit(failures === 0 ? 0 : 1);
