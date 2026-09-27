// 模块：五步上手（onboarding）—— 平台的第一印象 + 「用户模式 / 开发者模式」（P5）。
//
// 五步（可以跳过、可以回来，进度记在本机 prefs 里）：
//   ① 数据源      ② 分析偏好      ③ 已有功能模块      ④ 新建功能（能力搭建）      ⑤ UI 选择
//
// 两条刻意的设计：
//   * **勾是真实状态推出来的**：数据源配了几个、有没有声明式功能、主题换没换 —— 都不是"点过就算"；
//     只有③（挑功能）是自觉勾，因为"挑"没有机器可判的信号，那就如实写成"我自己看过了"。
//   * **开发者模式不是另一个软件**：它只是把"能力清单 / 写功能 / 写能力 / 契约 / 命令行"这几块
//     摊开给你看；用户模式下这些一律不出现。
//
// 纯函数 renderPage() 可测；mount() 只管交互。

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (m) => ({
  '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
}[m]));

export const DEV_DOCS = {
  processor: '/docs/WRITING_A_PROCESSOR.md',
  module: '/docs/WRITING_A_MODULE.md',
  guide: '/docs/DEVELOPER_GUIDE.md',
  works: '/docs/HOW_IT_WORKS.md',
};

/** 五步的定义（纯数据，测试直接断言条数与 id）。 */
export function stepDefs() {
  return [
    { id: 'sources', n: '①', title: '连上数据源', hint: '邮箱 / 日历订阅 / 课程平台，配一个就够了', go: '数据源' },
    { id: 'prefs', n: '②', title: '写下你关心什么', hint: '相关度与重要性都按这个打分（可以只写几个关键词）', go: '数据源' },
    { id: 'modules', n: '③', title: '挑几个现成功能', hint: '今日 / 通知 / 统计 那几页本来就是功能模块', go: '今日' },
    { id: 'build', n: '④', title: '拼一个自己的功能', hint: '能力搭建：点能力 → 连线 → 试跑（只演练）→ 存下来', go: '能力搭建' },
    { id: 'ui', n: '⑤', title: '调成你喜欢的样子', hint: '主题、壁纸、名字（不调也能用）', go: '风格' },
  ];
}

/** 进度条（纯函数）。 */
export function renderProgress(payload = {}) {
  const steps = payload.steps || [];
  const done = steps.filter((s) => s.done).length;
  const skipped = steps.filter((s) => s.skipped).length;
  const pct = steps.length ? Math.round((done / steps.length) * 100) : 0;
  return `<div class="ob-progress"><div class="ob-bar"><i style="width:${pct}%"></i></div>
    <span class="dim">${done}/${steps.length} 步完成${skipped ? ` · 跳过 ${skipped}` : ''}</span></div>`;
}

/** 单步（纯函数）。 */
export function renderStep(step = {}) {
  const badge = step.done ? '<span class="pill status">已完成</span>'
    : (step.skipped ? '<span class="pill off">已跳过</span>' : '<span class="pill pending">待办</span>');
  return `<div class="ob-step list-item" data-step="${esc(step.id)}">
    <div class="ob-n">${esc(step.n || '')}</div>
    <div style="flex:1">
      <div class="title">${esc(step.title)} ${badge}</div>
      <div class="dim">${esc(step.hint || '')}${step.why ? ` · ${esc(step.why)}` : ''}</div>
    </div>
    <div style="display:flex;gap:6px;align-items:center">
      ${step.manual ? `<button class="btn small" data-ob-done="${esc(step.id)}" ${step.done ? 'disabled' : ''}>我做好了</button>` : ''}
      ${step.target ? `<button class="btn small primary" data-ob-go="${esc(step.target)}">去${esc(step.go || '这一步')}</button>` : ''}
      <button class="btn small" data-ob-skip="${esc(step.id)}">${step.skipped ? '取消跳过' : '跳过'}</button>
    </div>
  </div>`;
}

/** 开发者那一块（纯函数）：只有开发者模式才渲染。 */
export function renderDevPanel(payload = {}) {
  if (payload.mode !== 'dev') return '';
  const caps = payload.capabilityCount || 0;
  const flows = payload.flowCount || 0;
  return `<div class="card" style="margin-top:12px">
    <div class="between"><b>🛠 开发者</b><span class="dim">用户模式下这一块不出现</span></div>
    <div class="dim" style="margin:6px 0 8px">平台现在有 <b>${caps}</b> 条能力、<b>${flows}</b> 个声明式功能（能力图）。</div>
    <div style="display:flex;gap:8px;flex-wrap:wrap">
      <button class="btn small" data-ob-go="能力搭建">画一个功能（能力搭建）</button>
      <a class="btn small" href="${DEV_DOCS.processor}" target="_blank" rel="noreferrer">写一个功能（run.js）</a>
      <a class="btn small" href="${DEV_DOCS.module}" target="_blank" rel="noreferrer">写一个模块（界面）</a>
      <a class="btn small" href="${DEV_DOCS.guide}" target="_blank" rel="noreferrer">开发者与审阅指南</a>
    </div>
    <pre class="ob-cmd">node bin/cairn.mjs cap list            看平台有哪些能力
node bin/cairn.mjs mod list --permissions   看功能要哪些能力与权限
node bin/cairn.mjs mod test &lt;id&gt;         校验 + 演练（零副作用）
node bin/cairn.mjs mod run  &lt;id&gt; --real  真的跑一次</pre>
  </div>`;
}

/** 整页（纯函数）。 */
export function renderPage(payload = {}) {
  const steps = payload.steps || [];
  if (payload.dismissed) {
    return `<div class="card"><b>🧭 五步上手</b>
      <div class="dim" style="margin:6px 0 10px">你已经说过"别再提示了"。想看随时可以回来。</div>
      <button class="btn" id="ob-reopen-wizard">🧭 重新打开五步上手</button>
      ${renderDevPanel(payload)}
    </div>`;
  }
  return `<div class="fb-wrap">
    <div class="between" style="margin-bottom:12px">
      <div>
        <h3 style="margin:0">🧭 五步上手 <span class="muted">可跳过、可回来</span></h3>
        <div class="dim">每一步的"已完成"都是**真实状态**推出来的，不是点过就算。</div>
      </div>
      <div style="display:flex;gap:8px;align-items:center">
        <select class="select-inline" id="ob-mode" title="用户模式：只看到能用的功能。开发者模式：多出能力清单 / 写功能 / 写能力 / 契约 / 命令行。">
          <option value="user" ${payload.mode !== 'dev' ? 'selected' : ''}>用户模式</option>
          <option value="dev" ${payload.mode === 'dev' ? 'selected' : ''}>开发者模式</option>
        </select>
        <button class="btn" id="ob-reopen-wizard">🧭 重新打开五步上手</button>
        <button class="btn small" id="ob-dismiss">别再提示我</button>
      </div>
    </div>
    <div class="card">
      ${renderProgress(payload)}
      ${steps.map(renderStep).join('')}
    </div>
    ${renderDevPanel(payload)}
  </div>`;
}

export async function mount(el, ctx = {}) {
  const { api, toast = () => {}, nav, DB } = ctx;
  const state = { steps: [], dismissed: false, mode: 'user', capabilityCount: 0, flowCount: 0 };

  const readJson = async (path) => {
    const url = path + (path.includes('?') ? '&' : '?') + '_t=' + Date.now();
    const res = await fetch(url, { cache: 'no-store', headers: { Accept: 'application/json' } });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
    return data;
  };

  const draw = () => { el.innerHTML = renderPage(state); bind(); };

  /** 把"真实状态"折算成每一步的完成情况。 */
  function computeSteps({ prefs = {}, configuredSources = 0, profileKeywords = 0, flows = 0, themePicked = false }) {
    // 2026-09-26：统一用新键 `wizard`（闸门读的就是它；以前这里写 onboarding_wizard，
    // 结果"别再提示我"按了也不管用 —— 闸门读 wizard 时压根看不到那个键）。
    const w = (prefs.wizard || prefs.onboarding_wizard) || {};
    const done = w.done || {};
    const skipped = w.skipped || {};
    const real = {
      sources: configuredSources > 0,
      prefs: profileKeywords > 0,
      modules: !!done.modules,                 // 挑功能没有机器可判的信号 ⇒ 自觉勾
      build: flows > 0,
      ui: !!themePicked,
    };
    const why = {
      sources: configuredSources > 0 ? `已配置 ${configuredSources} 个数据源` : '一个数据源都还没配',
      prefs: profileKeywords > 0 ? `写了 ${profileKeywords} 个关键词` : '还没写关键词（没写也能用，只是排序会粗）',
      modules: done.modules ? '你自己确认过了' : '看过之后点一下"我做好了"',
      build: flows > 0 ? `已经有 ${flows} 个能力图功能` : '还没有拼过功能（不拼也能用）',
      ui: themePicked ? '已经调过外观' : '用的还是默认外观',
    };
    return stepDefs().map((s) => ({
      ...s,
      done: !!real[s.id],
      skipped: !!skipped[s.id],
      manual: s.id === 'modules',
      target: ({ sources: 'connectors', prefs: 'connectors', modules: 'today', build: 'flow-builder', ui: 'theme' })[s.id],
      why: why[s.id],
    }));
  }

  async function load() {
    let prefs = {};
    try { prefs = await readJson('/api/prefs'); } catch { prefs = {}; }
    const wiz = (prefs && (prefs.wizard || prefs.onboarding_wizard)) || {};
    state.dismissed = !!wiz.dismissed;
    state.mode = prefs.ui_mode === 'dev' ? 'dev' : 'user';
    let configuredSources = 0;
    try {
      const st = await readJson('/api/state');
      const counts = (st.connectors && st.connectors.counts) || {};
      configuredSources = Object.values(counts).filter((n) => Number(n) > 0).length;
    } catch { configuredSources = 0; }
    let profileKeywords = 0;
    try { const p = await readJson('/api/profile'); profileKeywords = ((p && p.profile && p.profile.keywords) || p.keywords || []).length; } catch { profileKeywords = 0; }
    let flows = 0;
    try { const f = await readJson('/api/flows'); flows = f.count || 0; } catch { flows = 0; }
    let caps = 0;
    try { const c = await readJson('/api/capabilities'); caps = c.count || 0; } catch { caps = 0; }
    let themePicked = false;
    try { themePicked = !!localStorage.getItem('planner-theme'); } catch { themePicked = false; }

    state.steps = computeSteps({ prefs, configuredSources, profileKeywords, flows, themePicked });
    state.capabilityCount = caps;
    state.flowCount = flows;
    draw();
  }

  const savePrefs = async (patch, okMsg) => {
    try { await api('POST', '/api/prefs', patch); if (okMsg) toast(okMsg, 'green'); await load(); }
    catch (e) { toast(`没保存上：${e.message || ''}`, 'red'); }
  };

  function bind() {
    const modeSel = el.querySelector('#ob-mode');
    if (modeSel) modeSel.onchange = () => savePrefs({ ui_mode: modeSel.value === 'dev' ? 'dev' : 'user' },
      modeSel.value === 'dev' ? '已切到开发者模式' : '已切回用户模式');
    const dis = el.querySelector('#ob-dismiss');
    if (dis) dis.onclick = () => savePrefs({ wizard: { dismissed: true } }, '好，以后不再提示（随时能回来）');
    const reopen = el.querySelector('#ob-reopen-wizard');
    if (reopen) reopen.onclick = async () => {
      // 重新打开：先把门的三个开关都清掉（跳过过 / 完成过 / 弹过），再叫起全屏导览
      try {
        await api('POST', '/api/prefs', { wizard: { dismissed: false, completed_at: '', shown_at: '' } });
      } catch (e) { toast(`没打开：${e.message || ''}`, 'red'); return; }
      const mod = await import(`./wizard.js?v=${Date.now()}`).catch(() => null);
      if (mod && typeof mod.bootWizard === 'function') await mod.bootWizard(ctx);
      else toast('导览没载起来', 'red');
    };
    el.querySelectorAll('[data-ob-skip]').forEach((b) => b.onclick = () => {
      const id = b.dataset.obSkip;
      const cur = state.steps.find((s) => s.id === id);
      const patch = { wizard: { skipped: { [id]: !(cur && cur.skipped) } } };
      savePrefs(patch, cur && cur.skipped ? '已取消跳过' : '这一步先跳过');
    });
    el.querySelectorAll('[data-ob-done]').forEach((b) => b.onclick = () => {
      savePrefs({ wizard: { done: { [b.dataset.obDone]: true } } }, '记下了');
    });
    el.querySelectorAll('[data-ob-go]').forEach((b) => b.onclick = () => {
      const t = b.dataset.obGo;
      if (t === 'theme') { const btn = document.querySelector('#theme-btn'); if (btn) btn.click(); else toast('在右上角「🎨 风格」里调', ''); return; }
      if (nav) nav(t); else if (t === 'flow-builder') toast('在左侧导航里找「能力搭建」', '');
    });
  }

  await load();
}

// ==================== 首次运行的闸门（像新电脑开箱那样） ====================
//
// 用户 2026-09-25 的要求：「五步上手整体设立在**能够使用本应用之前**，即像上手了一台新电脑配置 Windows 一样」。
// 所以它不是一个页面，而是一个**盖住整个界面、必须走完（或明确跳过）的向导**：
//   * 没配完之前，底下的应用看得见但点不到（遮罩挡住）；
//   * 每一步都能"去配置"，回来接着走；也能"跳过这一步"；
//   * 最后一步「开始使用」= 记下 completed_at，从此不再弹；
//   * 「先跳过，直接进入」= 记 dismissed，也不再弹。

/** 现在该不该弹闸门？（纯函数，测试直接用）—— 只在**第一次**打开时弹。 */
export function shouldGate(prefs = {}) {
  const w = (prefs && (prefs.wizard || prefs.onboarding_wizard)) || {};
  if (w.dismissed) return false;
  if (w.completed_at) return false;
  if (w.shown_at) return false;      // 弹过一次就不再自动弹（只做"初次打开"）
  return true;
}

/**
 * 闸门的"壳"（纯函数，生产代码真的用它）：标题 + 步骤点 + 当前步说明 + **嵌进来的面板** + 底部按钮。
 * `panelHtml` 就是那一步的真界面（数据源表单 / 关键词 / 功能清单 / 能力搭建 / 外观）。
 */
export function renderGate(payload = {}) {
  const steps = payload.steps || [];
  const i = Math.min(Math.max(Number(payload.step) || 0, 0), Math.max(0, steps.length - 1));
  const cur = steps[i] || {};
  const done = steps.filter((s) => s.done).length;
  const isLast = i === steps.length - 1;
  return `<div class="ob-gate" id="ob-gate">
    <div class="ob-gate-box">
      <div class="between">
        <div>
          <h2 style="margin:0 0 4px">第一次用，先花两分钟配一下</h2>
          <div class="dim">每一步都在这里直接配好，不用来回跳页。${payload.busy ? ' · ' + esc(payload.busy) : ''}</div>
        </div>
        <button class="btn small" id="ob-skipall" title="不配置，先看看（记住：以后不再弹）">先跳过，直接进入 ›</button>
      </div>
      <div class="ob-gate-steps">
        ${steps.map((s, k) => `<button class="ob-dot ${k === i ? 'cur' : ''} ${s.done ? 'done' : ''}" data-ob-jump="${k}"
            title="${esc(s.title)}${s.done ? '（已完成）' : ''}">${esc(s.n)}</button>`).join('<span class="ob-dot-line"></span>')}
      </div>
      <div class="ob-gate-title">${esc(cur.n)} ${esc(cur.title)}</div>
      <div class="dim" style="margin-bottom:6px">${esc(cur.hint || '')} · ${esc(cur.why || '')}</div>
      ${payload.panelHtml || ''}
      <div class="between" style="margin-top:12px">
        <div class="dim">第 ${i + 1} 步，共 ${steps.length} 步 · 已完成 ${done}${payload.skippedId && cur.skipped ? ' · 这一步已跳过' : ''}</div>
        <div style="display:flex;gap:8px;flex-wrap:wrap">
          <button class="btn small" id="ob-prev" ${i === 0 ? 'disabled' : ''}>‹ 上一步</button>
          <button class="btn small" id="ob-gate-skip">跳过这一步</button>
          ${isLast
            ? '<button class="btn primary" id="ob-finish">开始使用 ›</button>'
            : '<button class="btn primary" id="ob-next">下一步 ›</button>'}
        </div>
      </div>
    </div>
  </div>`;
}

/**
 * 首次运行的闸门。
 *
 * 2026-09-25 用户的两个关键要求（第一版做错了，这里重做）：
 *   「操作要**嵌在每一步里面**」—— 不要点一下就背景跳走、然后页面被遮住没法操作；
 *   「只在**第一次**打开应用时存在」—— 走完或明确跳过后写进偏好，不再弹。
 * 所以每一步都自带那一块的真实界面：
 *   ① 数据源：列出九个数据源，点开就是表单，填完"保存并试一次"
 *   ② 分析偏好：直接写关注关键词
 *   ③ 挑功能：勾选 + 上下排序；保存后主页就按这个摆，**没勾的在应用里一概不出现**
 *   ④ 拼功能：把「能力搭建」那一页嵌进来用
 *   ⑤ 外观：主题与显示名，点一下立即生效
 * 还有一条血泪教训：**所有按钮都要判空再绑定**（上一版第 5 步少了"下一步"按钮，
 * 直接 null.onclick 抛异常，导致那一整排按钮全哑、"开始使用"永远没反应）。
 */
export async function boot(ctx = {}) {
  // 2026-09-26 第二版：全屏导览整块搬到 wizard.js（新路径 ⇒ 不会被浏览器旧缓存挡住）。
  // 这里只留一个薄薄的转发，保持模块契约不变（entry.view 导出 boot）。
  // 相对 import 会把 ?v= 丢掉，而这个浏览器对模块脚本是按路径死缓存的
  //（view.js 的版本号没变时，wizard.js 改了也照样跑旧代码）。所以这里自己带时间戳：
  // 向导一共 20 多 KB，每次启动现取一次，换掉的是"改了没生效"这类反复踩的坑。
  const mod = await import(`./wizard.js?v=${Date.now()}`).catch(() => null);
  if (mod && typeof mod.bootWizard === 'function') return mod.bootWizard(ctx);
  return null;
}

/** 旧版的小框闸门（保留给测试与回退；生产路径已改走 wizard.js）。 */
export async function bootLegacy(ctx = {}) {
  const { api, toast = () => {}, applyLayout } = ctx;
  const readJson = async (path) => {
    const res = await fetch(path + (path.includes('?') ? '&' : '?') + '_t=' + Date.now(), { cache: 'no-store' });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
    return data;
  };

  let prefs = {};
  try { prefs = await readJson('/api/prefs'); } catch { prefs = {}; }
  if (!shouldGate(prefs)) return null;                       // 走过了 / 跳过过：安静退出

  const S = {
    step: 0,
    connectors: [], configs: [], counts: {}, openSource: null,
    keywords: [], modules: [], picked: [], order: [],
    theme: (() => { try { return localStorage.getItem('planner-theme') || 'p5'; } catch { return 'p5'; } })(),
    appName: (prefs.brand && prefs.brand.custom ? prefs.brand.app_name : '') || '',
    busy: '', note: '',
    done: (prefs.wizard && prefs.wizard.done) || {},
    skipped: (prefs.wizard && prefs.wizard.skipped) || {},
  };

  const host = document.createElement('div');
  host.id = 'onboarding-gate-host';
  document.body.appendChild(host);
  const closeGate = () => { try { host.innerHTML = ''; host.remove(); } catch { /* 已经没了 */ } };
  const q = (sel) => host.querySelector(sel);
  const qa = (sel) => [...host.querySelectorAll(sel)];
  const on = (sel, fn) => { const el = q(sel); if (el) el.onclick = fn; };          // 判空！
  const onAll = (sel, fn) => qa(sel).forEach((el) => { el.onclick = fn; });

  // ---------------- 数据 ----------------
  async function loadData() {
    try {
      const c = await readJson('/api/connectors');
      S.connectors = c.connectors || []; S.configs = c.configs || []; S.counts = c.counts || {};
    } catch { S.connectors = []; }
    try { const p = await readJson('/api/profile'); S.keywords = ((p.profile && p.profile.keywords) || []).slice(); } catch { S.keywords = []; }
    try {
      const m = await readJson('/api/modules');
      S.modules = (m.modules || []).filter((x) => !x.error && x.kind === 'view' && x.id !== 'onboarding' && x.boot !== true);
    } catch { S.modules = []; }
    let picked = null; let order = [];
    try {
      const ui = (await readJson('/api/prefs')).ui_modules || {};
      picked = Array.isArray(ui.enabled) ? ui.enabled.slice() : null;
      order = Array.isArray(ui.order) ? ui.order.slice() : [];
    } catch { /* 用默认 */ }
    S.picked = picked === null ? S.modules.map((x) => x.id) : picked.filter((id) => S.modules.some((m) => m.id === id));
    S.order = [...order.filter((id) => S.modules.some((m) => m.id === id)),
      ...S.modules.map((m) => m.id).filter((id) => !order.includes(id))];
  }

  const saveWizard = async (patch) => {
    S.busy = '保存中…'; render();
    try { await api('POST', '/api/prefs', { wizard: patch }); }
    catch (e) {
      try { localStorage.setItem('planner-wizard-fallback', JSON.stringify({ ...patch, at: Date.now() })); } catch { /* ignore */ }
      toast(`偏好没存上（${e.message || ''}），本机已经记住这一次`, '');
    }
    S.busy = '';
  };

  // ---------------- 每一屏 ----------------
  function renderSourcesStep() {
    if (S.openSource) {
      const c = S.connectors.find((x) => x.id === S.openSource) || {};
      let saved = {};
      try { saved = JSON.parse((S.configs.find((x) => x.source === c.id) || {}).config_json || '{}'); } catch { saved = {}; }
      return `<div class="ob-panel">
        <div class="between"><b>${esc(c.icon || '')} ${esc(c.name || c.id)}</b>
          <button class="btn small" id="ob-conn-back">‹ 换一个数据源</button></div>
        <div class="dim" style="margin:4px 0 10px">${esc(c.description || '')}</div>
        ${(c.fields || []).map((f) => `<div class="field ob-field">
            <label>${esc(f.label)}${f.required ? ' *' : ''}</label>
            <input data-conn-field="${esc(f.key)}"
              type="${f.type === 'password' ? 'password' : (f.type === 'number' ? 'number' : 'text')}"
              placeholder="${esc(f.placeholder || '')}"
              value="${esc(saved[f.key] !== undefined ? saved[f.key] : (f.default !== undefined ? f.default : ''))}" />
          </div>`).join('')}
        <div style="display:flex;gap:8px;flex-wrap:wrap;margin-top:10px">
          <button class="btn primary" id="ob-conn-save">保存并试一次</button>
          <span class="dim">${S.note ? esc(S.note) : '凭据只存本机（加密），不进仓库'}</span>
        </div>
      </div>`;
    }
    return `<div class="ob-panel">
      <div class="dim" style="margin-bottom:8px">点一个就**在这里**配好，不用离开这一步。配一个就够；不想配就点"跳过这一步"。</div>
      ${S.connectors.map((c) => {
        const n = S.counts[c.id] || 0;
        const configured = S.configs.some((x) => x.source === c.id);
        return `<div class="ob-row">
          <span class="ob-row-ico">${esc(c.icon || '◆')}</span>
          <div style="flex:1">
            <div>${esc(c.name)} ${configured ? '<span class="pill status">已配置</span>' : '<span class="pill pending">未配置</span>'}</div>
            <div class="dim">${esc(c.description || '')}${n ? ` · 已收到 ${n} 条` : ''}</div>
          </div>
          <button class="btn small primary" data-conn-open="${esc(c.id)}">${configured ? '改一下' : '配置'}</button>
        </div>`;
      }).join('') || '<div class="empty">读不到数据源清单。</div>'}
    </div>`;
  }

  function renderPrefsStep() {
    return `<div class="ob-panel">
      <div class="dim" style="margin-bottom:8px">写几个你在意的词（逗号分隔）。相关度与"重要信息"都按它打分；不写也能用，只是排得粗。</div>
      <div class="field ob-field"><label>你在意什么</label>
        <input id="ob-keywords" value="${esc(S.keywords.join(', '))}" placeholder="例如 TOEFL, ACM, 科研, 大创" /></div>
      <div style="display:flex;gap:8px;flex-wrap:wrap;margin-top:10px">
        <button class="btn primary" id="ob-keywords-save">保存</button>
        <span class="dim">${S.note ? esc(S.note) : '以后随时能在「数据源」页的筛选面板里改'}</span>
      </div>
    </div>`;
  }

  function renderModulesStep() {
    const ordered = S.order.map((id) => S.modules.find((m) => m.id === id)).filter(Boolean);
    return `<div class="ob-panel">
      <div class="dim" style="margin-bottom:8px">勾上你想要的，用 ↑↓ 排序。保存之后**主页就按这个顺序摆；没勾的功能在应用里一概不出现**（随时能回来改）。</div>
      ${ordered.map((m, i) => `<div class="ob-row">
        <input type="checkbox" class="ob-check" data-um="${esc(m.id)}" ${S.picked.includes(m.id) ? 'checked' : ''} />
        <span class="ob-row-ico">${esc(m.icon || '◆')}</span>
        <div style="flex:1"><div>${esc(m.name)}</div><div class="dim">${esc(m.sub || '功能模块')}</div></div>
        <button class="btn small" data-um-up="${esc(m.id)}" ${i === 0 ? 'disabled' : ''}>↑</button>
        <button class="btn small" data-um-down="${esc(m.id)}" ${i === ordered.length - 1 ? 'disabled' : ''}>↓</button>
      </div>`).join('') || '<div class="empty">现在还没有可选的功能模块。</div>'}
      <div style="display:flex;gap:8px;flex-wrap:wrap;align-items:center;margin-top:10px">
        <button class="btn primary" id="ob-modules-save">保存这份清单</button>
        <span class="dim">${S.note ? esc(S.note) : `已选 ${S.picked.length} / ${S.modules.length} 个`}</span>
      </div>
    </div>`;
  }

  function renderBuildStep() {
    return `<div class="ob-panel">
      <div class="dim" style="margin-bottom:8px">下面就是「能力搭建」本身（嵌在这一步里）：左边点能力 → 中间连起来 → 试跑（只演练）→ 存下来。不想弄就点"跳过这一步"。</div>
      <div id="ob-flowhost" class="ob-embed">正在载入能力搭建…</div>
    </div>`;
  }

  function renderUiStep() {
    const themes = [{ id: 'p5', name: 'Persona 5 · 黑红' }, { id: 'p3r', name: 'Persona 3R · 克莱因蓝' }];
    return `<div class="ob-panel">
      <div class="dim" style="margin-bottom:8px">点一下立刻生效。名字也能改；留空就用默认 Cairn。</div>
      <div style="display:flex;gap:8px;flex-wrap:wrap">
        ${themes.map((t) => `<button class="btn ${S.theme === t.id ? 'primary' : ''}" data-ob-theme="${t.id}">${esc(t.name)}</button>`).join('')}
      </div>
      <div class="field ob-field" style="margin-top:12px"><label>应用显示名</label>
        <input id="ob-appname" value="${esc(S.appName)}" placeholder="留空 = Cairn" /></div>
      <div style="display:flex;gap:8px;flex-wrap:wrap;margin-top:10px">
        <button class="btn primary" id="ob-appname-save">保存名字</button>
        <span class="dim">${S.note ? esc(S.note) : '外观存本机；名字存本机 data/brand.json'}</span>
      </div>
    </div>`;
  }

  function currentStepHtml() {
    if (S.step === 0) return renderSourcesStep();
    if (S.step === 1) return renderPrefsStep();
    if (S.step === 2) return renderModulesStep();
    if (S.step === 3) return renderBuildStep();
    return renderUiStep();
  }

  function stepsView() {
    const configured = Object.entries(S.counts).filter(([, n]) => Number(n) > 0).map(([k]) => k);
    const real = {
      sources: configured.length > 0,
      prefs: S.keywords.length > 0,
      modules: S.picked.length > 0 && S.modules.length > 0,
      build: false,
      ui: !!S.theme,
    };
    return stepDefs().map((s) => ({
      ...s,
      done: !!real[s.id] || !!S.done[s.id],
      skipped: !!S.skipped[s.id],
      why: ({
        sources: configured.length ? `已连上 ${configured.length} 个数据源` : '一个都还没连',
        prefs: S.keywords.length ? `写了 ${S.keywords.length} 个关键词` : '还没写关键词',
        modules: S.picked.length ? `已选 ${S.picked.length} 个功能` : '还没挑',
        build: '想拼就拼一个（也可以跳过）',
        ui: `当前主题：${S.theme}`,
      })[s.id],
    }));
  }

  function render() {
    const steps = stepsView();
    const i = Math.min(Math.max(S.step, 0), steps.length - 1);
    host.innerHTML = renderGate({
      steps, step: i, panelHtml: currentStepHtml(), busy: S.busy,
      skippedId: steps[i] && steps[i].id,
    });
    bind();
    afterRender();
  }

  /** 有些步骤渲染完还要做点事（把能力搭建嵌进来）。 */
  function afterRender() {
    if (S.step !== 3) return;
    const box = q('#ob-flowhost');
    if (!box || box.dataset.mounted === '1') return;
    box.dataset.mounted = '1';
    // 嵌入「能力搭建」：版本号从 /api/modules 里读（不要在这里写死别人的版本，否则它一升版这里就拿到旧代码）
    readJson('/api/modules').then((r) => {
      const fb = (r.modules || []).find((x) => x.id === 'flow-builder' && x.entry && x.entry.view);
      if (!fb) throw new Error('没有找到「能力搭建」模块');
      return import('/modules/flow-builder/' + fb.entry.view + '?v=' + encodeURIComponent(fb.version || '0'));
    }).then((m) => {
      if (typeof m.mount === 'function') m.mount(box, ctx);
    }).catch((e) => {
      box.dataset.mounted = '';
      box.innerHTML = `<div class="empty">没载入成功：${esc((e && e.message) || '')}</div>`;
    });
  }

  function bind() {
    on('#ob-skipall', async () => { await saveWizard({ dismissed: true }); closeGate(); toast('好，随时可以在「五步上手」里回来', ''); });
    on('#ob-prev', () => { S.step = Math.max(0, S.step - 1); render(); });
    on('#ob-next', () => { S.step = Math.min(stepDefs().length - 1, S.step + 1); render(); });
    on('#ob-finish', async () => {
      await saveWizard({ completed_at: new Date().toISOString() });
      try { if (applyLayout) await applyLayout(); } catch { /* 布局失败也照样放行 */ }
      closeGate();
      toast('配好了，开始用吧', 'green');
    });
    on('#ob-gate-skip', async () => {
      const id = stepDefs()[S.step].id;
      S.skipped = { ...S.skipped, [id]: true };
      await saveWizard({ skipped: { [id]: true } });
      S.step = Math.min(stepDefs().length - 1, S.step + 1);
      render();
    });
    onAll('[data-ob-jump]', (e) => { S.step = Number(e.currentTarget.dataset.obJump); render(); });

    // ① 数据源：在这一步里直接配
    onAll('[data-conn-open]', (e) => { S.openSource = e.currentTarget.dataset.connOpen; S.note = ''; render(); });
    on('#ob-conn-back', () => { S.openSource = null; render(); });
    on('#ob-conn-save', async () => {
      const id = S.openSource;
      const config = {};
      qa('[data-conn-field]').forEach((el) => { config[el.dataset.connField] = el.value; });
      S.busy = '正在连接并试一次…'; render();
      try {
        const r = await api('POST', `/api/connectors/${id}/import`, { config });
        S.note = `配好了，试了一次：收到 ${r.inserted || 0} 条`;
        toast(S.note, 'green');
        await loadData();
        S.openSource = null;
        S.step = 1;                                   // 配好就自动进下一步
      } catch (e) {
        S.note = `没连上：${e.message || ''}（配置没保存，检查一下再试）`;
        toast('没连上，看看提示', 'red');
      }
      S.busy = ''; render();
    });

    // ② 关注词
    on('#ob-keywords-save', async () => {
      const raw = (q('#ob-keywords') || {}).value || '';
      const keywords = raw.split(/[,，、\s]+/).map((x) => x.trim()).filter(Boolean);
      S.busy = '保存中…'; render();
      try {
        await api('POST', '/api/profile', { enabled: true, keywords });
        S.keywords = keywords; S.note = `记下了 ${keywords.length} 个关键词`;
        toast('记下了', 'green');
        S.step = 2;
      } catch (e) { S.note = `没保存上：${e.message || ''}`; }
      S.busy = ''; render();
    });

    // ③ 挑功能 + 排序
    onAll('[data-um]', (e) => {
      const id = e.currentTarget.dataset.um;
      S.picked = S.picked.includes(id) ? S.picked.filter((x) => x !== id) : [...S.picked, id];
      S.note = ''; render();
    });
    const move = (id, delta) => {
      const from = S.order.indexOf(id);
      const to = from + delta;
      if (from < 0 || to < 0 || to >= S.order.length) return;
      const next = S.order.slice();
      next.splice(to, 0, next.splice(from, 1)[0]);
      S.order = next; render();
    };
    onAll('[data-um-up]', (e) => move(e.currentTarget.dataset.umUp, -1));
    onAll('[data-um-down]', (e) => move(e.currentTarget.dataset.umDown, 1));
    on('#ob-modules-save', async () => {
      S.busy = '保存中…'; render();
      try {
        await api('POST', '/api/prefs', { ui_modules: { enabled: S.picked, order: S.order } });
        if (applyLayout) await applyLayout();
        S.note = `已保存：${S.picked.length} 个功能，主页按这个顺序摆`;
        toast('清单保存了（主页已经按它重排）', 'green');
      } catch (e) { S.note = `没保存上：${e.message || ''}`; }
      S.busy = ''; render();
    });

    // ⑤ 外观
    onAll('[data-ob-theme]', (e) => {
      const id = e.currentTarget.dataset.obTheme;
      S.theme = id;
      document.body.dataset.theme = id;
      try { localStorage.setItem('planner-theme', id); } catch { /* ignore */ }
      api('POST', '/api/prefs', { theme: id }).catch(() => {});
      S.note = `主题换成「${id}」，已经生效`;
      render();
    });
    on('#ob-appname-save', async () => {
      const v = ((q('#ob-appname') || {}).value || '').trim();
      S.busy = '保存中…'; render();
      try {
        const r = await api('POST', '/api/prefs', { app_name: v });
        const nm = (r.brand && r.brand.app_name) || 'Cairn';
        const bn = document.getElementById('app-name-brand'); if (bn) bn.textContent = nm;
        const bw = document.getElementById('app-name-wb'); if (bw) bw.textContent = nm;
        S.appName = v; S.note = `名字改成「${nm}」`;
      } catch (e) { S.note = `没保存上：${e.message || ''}`; }
      S.busy = ''; render();
    });
  }

  // Esc = 先跳过（与那颗按钮同效），只在闸门还在时生效
  const onKey = (e) => {
    if (e.key === 'Escape' && document.getElementById('ob-gate')) {
      saveWizard({ dismissed: true }).then(closeGate);
    }
  };
  document.addEventListener('keydown', onKey);

  await loadData();
  render();
  return { close: closeGate };
}
