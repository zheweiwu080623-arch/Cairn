// onboarding/wizard.js —— 首次运行的**全屏**导览（2026-09-26 第二版）
//
// 用户这次的三条要求：
//   ① 「不要只是一个中心的小框，做成全屏的导览」→ 全屏两栏：左边步骤轨道，右边当前步骤的大舞台；
//   ② 「第一步做成添加的形式：添加 → 选数据源类型（类型同样做成滑动的选择栏）→ 填信息 → 添加完成」，
//      并附一份《如何上手数据源配置》的入口；
//   ③ 「分析偏好允许输入本地文件、允许写更长的一段文字」→ 支持导入本地 txt/md 文件 + 长文本框。
//
// 设计边界（不变）：只在第一次打开时出现；可逐步跳过、可整段跳过；走完记 completed_at，不再打扰。

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (m) => ({
  '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
}[m]));

export const DOC_SOURCES = '/docs/CONNECT_SOURCES.md';   // 应用内那篇《数据源配置教程》

/** 实例 id → 类型（`rss@2` → `rss`）。约定与 lib/connectors/instances.mjs 一致；
 *  浏览器拿不到 /lib 下的文件，所以这里留一份最小的。 */
const instanceTypeOf = (id) => { const s = String(id || ''); const i = s.indexOf('@'); return i < 0 ? s : s.slice(0, i); };

export function shouldGate(prefs = {}) {
  const w = (prefs && (prefs.wizard || prefs.onboarding_wizard)) || {};
  if (w.dismissed) return false;
  if (w.completed_at) return false;
  // 2026-09-26：用户反馈"每一次打开都要进一次导览"。以前只要没走完（没点完成也没跳过），
  // 关掉窗口再来还会被拦住。改成**只做"初次打开"**：弹过就记 shown_at，之后不再自动弹；
  // 想再看一遍，去导航里的「五步上手」点「重新打开五步上手」。
  if (w.shown_at) return false;
  return true;
}

export function stepDefs() {
  return [
    { id: 'sources', n: '①', title: '添加一个数据源', hint: '先看教程 → 点添加 → 选类型填信息', icon: '🔌' },
    { id: 'prefs', n: '②', title: '写下你在意什么', hint: '写一整段 / 导文件 + 把 Agent 接上', icon: '🧠' },
    { id: 'modules', n: '③', title: '挑几个功能', hint: '勾选 + 排序；没勾的不会出现', icon: '🧩' },
    { id: 'build', n: '④', title: '拼一个自己的功能', hint: '用能力搭一张图（可以跳过）', icon: '🛠' },
    { id: 'ui', n: '⑤', title: '调成你喜欢的样子', hint: '主题与名字', icon: '🎨' },
  ];
}

/** 全屏外壳（纯函数）：左轨道 + 右舞台。`stage` 就是那一步的真界面。 */
export function renderShell(payload = {}) {
  const steps = payload.steps || [];
  const i = Math.min(Math.max(Number(payload.step) || 0, 0), Math.max(0, steps.length - 1));
  const cur = steps[i] || {};
  const done = steps.filter((s) => s.done).length;
  const isLast = i === steps.length - 1;
  return `<div class="ob-gate ob-gate-full" id="ob-gate">
    <div class="ob-shell">
      <aside class="ob-rail">
        <div class="ob-rail-brand">⚙️ Cairn</div>
        <div class="ob-rail-title">第一次用<br /><span class="dim">先花两分钟配一下</span></div>
        <div class="ob-rail-steps">
          ${steps.map((s, k) => `<button class="ob-rail-step ${k === i ? 'cur' : ''} ${s.done ? 'done' : ''}" data-ob-jump="${k}">
            <span class="ob-rail-n">${esc(s.done ? '✓' : s.n)}</span>
            <span class="ob-rail-txt"><b>${esc(s.title)}</b><i>${esc(s.hint || '')}</i></span>
          </button>`).join('')}
        </div>
        <div class="ob-rail-foot">
          <div class="dim">已完成 ${done} / ${steps.length}</div>
          <button class="btn small" id="ob-skipall">先跳过，直接进入 ›</button>
        </div>
      </aside>
      <section class="ob-stage">
        <header class="ob-stage-head">
          <div>
            <h2><span class="ob-stage-ico">${esc(cur.icon || '')}</span> ${esc(cur.n)} ${esc(cur.title)}</h2>
            <div class="dim">${esc(cur.hint || '')}${payload.busy ? ' · ' + esc(payload.busy) : ''}</div>
          </div>
          <div class="ob-stage-dots">${steps.map((s, k) => `<i class="${k === i ? 'cur' : ''} ${s.done ? 'done' : ''}"></i>`).join('')}</div>
        </header>
        <div class="ob-stage-body">${payload.stage || ''}</div>
        <footer class="ob-stage-foot">
          <button class="btn small" id="ob-prev" ${i === 0 ? 'disabled' : ''}>‹ 上一步</button>
          <button class="btn small" id="ob-gate-skip">跳过这一步</button>
          ${isLast ? '<button class="btn primary" id="ob-finish">开始使用 ›</button>'
            : '<button class="btn primary" id="ob-next">下一步 ›</button>'}
        </footer>
      </section>
    </div>
  </div>`;
}

/**
 * ① 落地页：**一开始只有两样东西** —— 配置教程 + 「＋ 添加数据源」按钮；
 * 已经添加过的按 1、2、3… 排在下面（用户 2026-09-26 手绘稿的顺序）。
 */
export function renderSourcesList(S = {}) {
  const list = S.connectors || [];
  const meta = new Map(list.map((c) => [c.id, c]));
  const configs = S.configs || [];
  // 顺序跟"数据源卡片"一致（常用在前：邮箱 → arXiv → RSS → 日历 → JSON → 本地文件 → Canvas → 飞书），
  // 不按字母序 —— 列表是后端按 source 排的，直接拿来用会把 arXiv 顶到最前面（2026-09-26 修）。
  // `c.source` 现在是**实例 id**（可能是 `rss@2`），排优先级、找图标名字都要先剥成类型
  const rank = new Map(list.map((c, i) => [c.id, i]));
  // 学生模式：Canvas / 交大邮箱这类学生刚需往前挪（和设置页同一套规则）
  const STUDENT_BOOST = { canvas: 2.4, email_sjtu: 2.1, arxiv: 2.7 };
  const isStudent = S.studentMode === 'student' || (S.studentMode && S.studentMode.mode === 'student');
  const rankOf = (s) => {
    const t = instanceTypeOf(s);
    const base = rank.has(t) ? rank.get(t) : 99;
    return isStudent && STUDENT_BOOST[t] !== undefined ? STUDENT_BOOST[t] : base;
  };
  const ordered = configs.slice().sort((a, b) => rankOf(a.source) - rankOf(b.source));
  const rows = ordered.map((c, i) => {
    const m = meta.get(c.type || instanceTypeOf(c.source)) || { icon: '◆', name: c.source };
    let cfg = {};
    try { cfg = JSON.parse(c.config_json || '{}'); } catch { cfg = {}; }
    const who = cfg.label || cfg.user || cfg.host || '';
    const n = Number((S.countsByInstance || {})[c.source] ?? (S.counts || {})[c.type || instanceTypeOf(c.source)] ?? 0);
    // status 的真实取值是 ok / configured（配好了还没同步过）/ empty（还没收到数据），
    // 只有真带 last_error（或 error）才算"没连上"—— 2026-09-26 第一版在这里误报过。
    const bad = c.last_error ? String(c.last_error).slice(0, 40)
      : (c.status === 'error' ? '上次连的时候出错了' : '');
    const flag = bad ? ` · 没连上：${bad}`
      : (c.status === 'configured' ? ' · 已配置，还没同步过' : (c.status === 'empty' ? ' · 还没收到数据' : ''));
    return `<div class="ob-src-row">
      <span class="ob-src-n">${i + 1}</span>
      <span class="ob-src-ico">${esc(m.icon || '◆')}</span>
      <span class="ob-src-txt">
        <b>${esc((m.name || c.source) + (c.suffix || ''))}</b>
        <i>${esc(who ? String(who) + ' · ' : '')}已收到 ${n} 条${esc(flag)}</i>
      </span>
      <button class="btn small" data-ob-edit="${esc(c.source)}">改一下</button>
      <button class="btn small danger" data-ob-del="${esc(c.source)}">删除</button>
    </div>`;
  }).join('');

  return `<div class="ob-src-top">
      <a class="ob-tut" href="${DOC_SOURCES}" target="_blank" rel="noreferrer">
        <span class="ob-tut-ico">📖</span>
        <span class="ob-tut-txt">
          <b>如何上手数据源配置</b>
          <i>每个字段填什么、去哪拿密钥 / 授权码、连不上怎么查 —— 第一次配建议先扫一眼</i>
        </span>
        <span class="ob-tut-go">打开教程 ›</span>
      </a>
      <button class="btn primary" id="ob-src-add">＋ 添加数据源</button>
    </div>
    ${S.note ? `<div class="ob-src-note">${esc(S.note)}</div>` : ''}
    ${configs.length
      ? `<div class="ob-src-title">已经添加的（${configs.length}）</div><div class="ob-src-list">${rows}</div>`
      : `<div class="ob-src-empty">还没有添加任何数据源。点上面的「＋ 添加数据源」开始；<b>这一步不做也能先往下走</b>。</div>`}`;
}

/** ① 添加：**选择数据类型（下拉，和任务页那个排序框同一个样式）+ 配置部分**。 */
export function renderTypeForm(S = {}) {
  const list = S.connectors || [];
  const c = list.find((x) => x.id === S.pickedType) || null;
  const saved = S.formSaved || {};
  const fields = c ? (c.fields || []).map((f) => `<label class="ob-field">
        <span>${esc(f.label)}${f.required ? ' *' : ''}</span>
        <input data-ob-field="${esc(f.key)}"
          type="${f.type === 'password' ? 'password' : (f.type === 'number' ? 'number' : 'text')}"
          placeholder="${esc(f.placeholder || '')}"
          value="${esc(saved[f.key] !== undefined ? saved[f.key] : (f.default !== undefined ? f.default : ''))}" />
      </label>`).join('') : '';

  return `<div class="ob-setup-row">
      <label class="ob-setup-label" for="ob-type-select">选择数据类型</label>
      <select id="ob-type-select" class="select-inline ob-select">
        <option value="">请选择一种数据源…</option>
        ${list.map((x) => `<option value="${esc(x.id)}"${x.id === S.pickedType ? ' selected' : ''}>${esc((x.icon ? x.icon + ' ' : '') + x.name)}</option>`).join('')}
      </select>
    </div>
    <div class="ob-config">
      <div class="ob-config-head">配置部分${c ? ' · ' + esc((c.icon || '') + ' ' + c.name) : ''}</div>
      <div class="dim" style="margin-bottom:12px">${esc(c ? (c.description || '') : '先在上面选一种数据类型，这里就会列出它要你提供的信息。')}</div>
      ${fields ? `<div class="ob-formgrid">${fields}</div>`
        : (c ? '<div class="dim">这种类型不需要填东西，直接点下面的按钮即可。</div>' : '')}
    </div>
    <div class="ob-hint-row">
      <button class="btn primary" id="ob-type-save" ${c ? '' : 'disabled'}>保存并试一次</button>
      <button class="btn small" id="ob-type-back">‹ 返回列表</button>
      <a class="btn small" href="${DOC_SOURCES}" target="_blank" rel="noreferrer">📖 数据源配置教程</a>
      <span class="dim">${S.note ? esc(S.note) : '凭据只存本机（加密），不进仓库'}</span>
    </div>`;
}

/**
 * ② 分析偏好：长文本 + 导入本地文件 + **谁来判断（Agent / 模型接入）**。
 * 2026-09-26 晚：审核的人说"接入 agent 的操作也该在五步里"——分析偏好本来就依赖它
 *（语义兜底、打分都由 agent 干），所以放在同一步的下面，而不是再加第六步。
 */
export function renderPrefsStage(S = {}) {
  return `<div class="ob-stage-lead">写一段话，说说你在意什么、这学期想做成什么。写得越具体，排序越准；也可以导入一个本地文件（txt / md）。</div>
    <textarea id="ob-notes" class="ob-notes" rows="12"
      placeholder="例如：我在意 TOEFL 与 ACM 班补选；这学期重点是数学与编程基础；希望课程作业至少提前一天做完；科研想每周读一篇 agent 方向的论文……">${esc(S.notes || '')}</textarea>
    <div class="ob-hint-row">
      <label class="btn small" for="ob-file">📂 导入本地文件</label>
      <input type="file" id="ob-file" accept=".txt,.md,.markdown,.json,.csv" style="display:none" />
      <span class="dim" id="ob-file-note">${S.fileName ? esc(`已导入：${S.fileName}`) : '支持 txt / md / json / csv（只读进这个框，不上传）'}</span>
    </div>
    <div class="ob-hint-row" style="margin-top:10px">
      <button class="btn primary" id="ob-notes-save">保存</button>
      <span class="dim">${S.note ? esc(S.note) : '写好的这段话会存进「分析偏好」；关键词可以从里面自动提炼'}</span>
      <button class="btn small" id="ob-notes-next">跳过这一步 ›</button>
    </div>
    <div id="ob-agent-host" class="ob-wp"><div class="dim">正在读 Agent / 模型接入…</div></div>`;
}

/** 每步的状态（真实状态优先）。 */
export function stepsView(S = {}) {
  const configured = Object.entries(S.counts || {}).filter(([, n]) => Number(n) > 0).map(([k]) => k);
  const real = {
    sources: configured.length > 0,
    prefs: !!(S.notes && S.notes.trim()),
    modules: (S.picked || []).length > 0 && (S.modules || []).length > 0,
    build: false,
    ui: !!S.theme,
  };
  return stepDefs().map((s) => ({
    ...s,
    done: !!real[s.id] || !!(S.done && S.done[s.id]),
    skipped: !!(S.skipped && S.skipped[s.id]),
    why: ({
      sources: configured.length ? `已连上 ${configured.length} 个数据源` : '一个都还没连',
      prefs: real.prefs ? `写了 ${String(S.notes).length} 字` : '还没写',
      modules: (S.picked || []).length ? `已选 ${S.picked.length} 个功能` : '还没挑',
      build: '可以跳过',
      ui: `当前主题：${S.theme || 'p5'}`,
    })[s.id],
  }));
}

/** 这一屏用哪个 stage。 */
export function stageOf(S = {}) {
  if (S.step === 0) {
    return S.addPhase === 'form' ? renderTypeForm(S) : renderSourcesList(S);
  }
  if (S.step === 1) return renderPrefsStage(S);
  if (S.step === 2) return renderFunctionsStage(S);
  if (S.step === 3) return renderBuildStage(S);
  return renderLookStage(S);
}

/** ③ 挑功能（核心页 + 插件都在同一份清单里）。 */
export function renderFunctionsStage(S = {}) {
  const fns = S.functions || [];
  const picked = S.picked || [];
  const order = (S.order || []).filter((id) => fns.some((f) => f.id === id));
  const ordered = order.map((id) => fns.find((f) => f.id === id)).filter(Boolean);
  return `<div class="ob-stage-lead">勾上想要的、用 ↑↓ 排序。保存后主页就按这个摆；<b>没勾的在应用里一概不出现</b>。</div>
    <div class="ob-fnlist">
      ${ordered.map((f, i) => `<div class="ob-row">
        <input type="checkbox" class="ob-check" data-ob-pick="${esc(f.id)}" ${picked.includes(f.id) ? 'checked' : ''} ${f.always ? 'disabled' : ''} />
        <span class="ob-row-ico">${esc(f.icon || '◆')}</span>
        <div style="flex:1"><div>${esc(f.name)}${f.always ? ' <span class="pill p3">落地页</span>' : ''}</div><div class="dim">${esc(f.sub || '')}</div></div>
        <button class="btn small" data-ob-up="${esc(f.id)}" ${i === 0 ? 'disabled' : ''}>↑</button>
        <button class="btn small" data-ob-down="${esc(f.id)}" ${i === ordered.length - 1 ? 'disabled' : ''}>↓</button>
      </div>`).join('') || '<div class="empty">还没读到功能清单。</div>'}
    </div>
    <div class="ob-hint-row" style="margin-top:12px">
      <button class="btn primary" id="ob-fns-save">保存这份清单</button>
      <span class="dim">${S.note ? esc(S.note) : `已选 ${picked.length} / ${fns.length}`}</span>
    </div>`;
}

/** ④ 拼功能：把能力搭建整页嵌进来。 */
export function renderBuildStage() {
  return `<div class="ob-stage-lead">下面就是「能力搭建」（嵌在这一步里）：左边点能力 → 连线 → 试跑（只演练）→ 存成新功能。不想弄就跳过。</div>
    <div id="ob-flowhost" class="ob-embed">正在载入能力搭建…</div>`;
}

/** ⑤ 外观（含壁纸 —— 接的就是 Wallpaper Engine 那个目录）。 */
export function renderLookStage(S = {}) {
  const themes = [{ id: 'p5', name: 'Persona 5 · 黑红' }, { id: 'p3r', name: 'Persona 3R · 克莱因蓝' }];
  return `<div class="ob-stage-lead">点一下立刻生效；名字也可以改（留空 = Cairn）。</div>
    <div style="display:flex;gap:10px;flex-wrap:wrap">
      ${themes.map((t) => `<button class="btn ${S.theme === t.id ? 'primary' : ''}" data-ob-theme="${t.id}">${esc(t.name)}</button>`).join('')}
    </div>
    <label class="ob-field" style="margin-top:14px;max-width:420px"><span>应用显示名</span>
      <input id="ob-appname" placeholder="留空 = Cairn" value="${esc(S.appName || '')}" /></label>
    <div class="ob-hint-row" style="margin-top:10px">
      <button class="btn primary" id="ob-appname-save">保存名字</button>
      <span class="dim">${S.note ? esc(S.note) : '外观存本机；名字存 data/brand.json'}</span>
    </div>
    <div id="ob-wp-host" class="ob-wp"><div class="dim">正在读壁纸库…</div></div>`;
}

const THEME_IDS = ['p5', 'p3r'];

/** 真正的交互层。返回 { close } 或 null（不需要弹）。 */
export async function bootWizard(ctx = {}) {
  const { api, toast = () => {}, applyLayout, DB } = ctx;
  const readJson = async (p) => {
    const r = await fetch(p + (p.includes('?') ? '&' : '?') + '_t=' + Date.now(), { cache: 'no-store' });
    const d = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(d.error || `HTTP ${r.status}`);
    return d;
  };
  let prefs = {};
  try { prefs = await readJson('/api/prefs'); } catch { prefs = {}; }
  if (!shouldGate(prefs)) return null;

  // 弹出来就记一笔（不等用户操作）：这样关掉窗口再来不会被反复拦住
  api('POST', '/api/prefs', {
    wizard: { shown_at: new Date().toISOString(), shown_count: (Number(prefs.wizard && prefs.wizard.shown_count) || 0) + 1 },
  }).catch(() => {});

  const S = {
    step: 0, addPhase: 'list', pickedType: null, formSaved: {}, note: '', busy: '',
    connectors: [], configs: [], counts: {}, countsByInstance: {}, notes: '', keywords: [], fileName: '',
    editingInstance: null, studentMode: 'general',
    functions: [], picked: [], order: [],
    theme: (() => { try { return localStorage.getItem('planner-theme') || 'p5'; } catch { return 'p5'; } })(),
    appName: (prefs.brand && prefs.brand.custom ? prefs.brand.app_name : '') || '',
    done: (prefs.wizard && prefs.wizard.done) || {}, skipped: (prefs.wizard && prefs.wizard.skipped) || {},
  };

  const host = document.createElement('div');
  host.id = 'onboarding-wizard-host';
  document.body.appendChild(host);
  const q = (sel) => host.querySelector(sel);
  const qa = (sel) => [...host.querySelectorAll(sel)];
  const on = (sel, fn) => { const el = q(sel); if (el) el.onclick = fn; };
  const onAll = (sel, fn) => qa(sel).forEach((el) => { el.onclick = fn; });
  // 全屏盖住的时候，底下的页面不该还能滚（不然右边会多出一条背景滚动条）
  const prevOverflow = (() => { try { return document.body.style.overflow || ''; } catch { return ''; } })();
  try { document.body.style.overflow = 'hidden'; } catch { /* ignore */ }
  const closeGate = () => {
    try { host.innerHTML = ''; host.remove(); } catch { /* 已经没了 */ }
    try { document.body.style.overflow = prevOverflow; } catch { /* ignore */ }
  };
  const draw = () => { host.innerHTML = renderShell({ steps: stepsView(S), step: S.step, stage: stageOf(S), busy: S.busy }); bind(); afterRender(); };

  async function load() {
    try {
      const c = await readJson('/api/connectors');
      S.connectors = c.connectors || []; S.configs = c.configs || []; S.counts = c.counts || {};
      S.countsByInstance = c.counts_by_instance || {};
    } catch { /* 读不到就给空表 */ }
    try {
      const p = await readJson('/api/profile');
      S.notes = (p.profile && p.profile.notes) || '';
      S.keywords = (p.profile && p.profile.keywords) || [];
    } catch { /* ignore */ }
    try {
      const f = await readJson('/api/prefs');
      const ui = f.ui_modules || {};
      S.picked = Array.isArray(ui.enabled) ? ui.enabled.slice() : null;
      S.order = Array.isArray(ui.order) ? ui.order.slice() : [];
      S.studentMode = (f.student_mode && f.student_mode.mode) || 'general';
    } catch { /* ignore */ }
    try {
      const m = await readJson('/api/modules');
      S.functions = (ctx.pickablePages && ctx.pickablePages.length) ? ctx.pickablePages
        : (m.modules || []).filter((x) => !x.error && x.kind === 'view' && x.id !== 'settings' && x.boot !== true)
          .map((x) => ({ id: x.id, name: x.name, sub: x.sub, icon: x.icon }));
    } catch { S.functions = []; }
    if (!Array.isArray(S.picked)) S.picked = S.functions.map((f) => f.id);
    S.order = [...S.order.filter((id) => S.functions.some((f) => f.id === id)),
      ...S.functions.map((f) => f.id).filter((id) => !S.order.includes(id))];
  }

  const saveWizard = async (patch) => {
    S.busy = '保存中…'; draw();
    try { await api('POST', '/api/prefs', { wizard: patch }); }
    catch (e) { try { localStorage.setItem('planner-wizard-fallback', JSON.stringify({ ...patch, at: Date.now() })); } catch { /* ignore */ } toast(`偏好没存上（${e.message || ''}），本机已记住`, ''); }
    S.busy = '';
  };

  function afterRender() {
    // ② 分析偏好：底下再挂一块「Agent / 模型接入」——谁来判断这件事，得让第一次用的人也能设。
    if (S.step === 1) {
      const aBox = q('#ob-agent-host');
      if (aBox && aBox.dataset.mounted !== '1') {
        aBox.dataset.mounted = '1';
        if (typeof ctx.mountModule === 'function') ctx.mountModule(aBox, 'agent-connect');
        else aBox.innerHTML = '<div class="dim">Agent 接入要在应用里才能用。</div>';
      }
      return;
    }
    // ⑤ 外观：把壁纸那一块（Wallpaper Engine 目录 / 动态壁纸开关 / 选壁纸）
    // 挂进这一步里 —— 用的是主程序给的同一份界面，不另写一套。
    if (S.step === 4) {
      const wpBox = q('#ob-wp-host');
      if (wpBox && wpBox.dataset.mounted !== '1') {
        wpBox.dataset.mounted = '1';
        if (typeof ctx.mountWallpaper === 'function') ctx.mountWallpaper(wpBox);
        else wpBox.innerHTML = '<div class="dim">壁纸这一块要在应用里才能用。</div>';
      }
      return;
    }
    if (S.step !== 3) return;
    const box = q('#ob-flowhost');
    if (!box || box.dataset.mounted === '1') return;
    box.dataset.mounted = '1';
    readJson('/api/modules').then((r) => {
      const fb = (r.modules || []).find((x) => x.id === 'flow-builder' && x.entry && x.entry.view);
      if (!fb) throw new Error('没找到「能力搭建」模块');
      return import('/modules/flow-builder/' + fb.entry.view + '?v=' + encodeURIComponent((fb.version || '0') + '-' + (fb.mtime || 0)));
    }).then((m) => { if (typeof m.mount === 'function') m.mount(box, ctx); })
      .catch((e) => { box.dataset.mounted = ''; box.innerHTML = `<div class="empty">没载入成功：${esc((e && e.message) || '')}</div>`; });
  }

  function bind() {
    on('#ob-skipall', async () => { await saveWizard({ dismissed: true }); closeGate(); });
    on('#ob-prev', () => { S.step = Math.max(0, S.step - 1); S.addPhase = 'list'; draw(); });
    // 注意：舞台里也有"下一步"（跳过这一步）。**每一颗按钮的 id 必须唯一**，
    // 否则 q('#ob-next') 只会拿到先出现的那一颗，另一颗点了没反应（用户报过好几次）。
    // 2026-09-26 改版后，第①步的"加数据源"由页内的「＋ 添加数据源」按钮负责，
    // 底部这颗「下一步」就直接进第②步。
    const goNext = () => {
      S.step = Math.min(stepDefs().length - 1, S.step + 1); S.addPhase = 'list'; S.note = ''; draw();
    };
    on('#ob-next', goNext);
    on('#ob-notes-next', goNext);
    on('#ob-finish', async () => {
      await saveWizard({ completed_at: new Date().toISOString() });
      try { if (applyLayout) await applyLayout(); } catch { /* ignore */ }
      closeGate();
      toast('配好了，开始用吧', 'green');
    });
    on('#ob-gate-skip', async () => {
      const id = stepDefs()[S.step].id;
      S.skipped = { ...S.skipped, [id]: true };
      await saveWizard({ skipped: { [id]: true } });
      S.step = Math.min(stepDefs().length - 1, S.step + 1); S.addPhase = 'list'; draw();
    });
    onAll('[data-ob-jump]', (e) => { S.step = Number(e.currentTarget.dataset.obJump); S.addPhase = 'list'; draw(); });

    // ① 添加数据源：列表 →（选类型 + 配置）→ 回到列表
    on('#ob-src-add', () => { S.pickedType = null; S.editingInstance = null; S.formSaved = {}; S.note = ''; S.addPhase = 'form'; draw(); });
    onAll('[data-ob-edit]', (e) => {
      const id = e.currentTarget.dataset.obEdit;          // 实例 id（可能是 `rss@2`）
      const rec = (S.configs || []).find((x) => x.source === id);
      let cfg = {};
      // 界面拿到的是掩码凭据（••••1234），原样带回去时服务端会沿用已存的真值
      try { cfg = JSON.parse((rec && rec.config_json) || '{}'); } catch { cfg = {}; }
      S.pickedType = instanceTypeOf(id);                 // 表单按**类型**渲染
      S.editingInstance = id;                            // 保存时带回去 ⇒ 改的是这一条
      S.formSaved = cfg; S.note = ''; S.addPhase = 'form'; draw();
    });
    {
      const sel = q('#ob-type-select');
      if (sel) sel.onchange = () => {
        S.pickedType = sel.value || null; S.editingInstance = null;   // 换类型 = 重新选
        S.formSaved = {}; S.note = ''; draw();
      };
    }
    on('#ob-type-back', () => { S.addPhase = 'list'; S.note = ''; draw(); });
    // 删掉一个已经加过的数据源（加错了 / 不想用了）。会二次确认，并如实说清连带删什么。
    onAll('[data-ob-del]', async (e) => {
      const id = e.currentTarget.dataset.obDel;
      const t = instanceTypeOf(id);
      const m = (S.connectors || []).find((x) => x.id === t) || {};
      const n = Number((S.countsByInstance || {})[id] ?? (S.counts || {})[t] ?? 0);
      const row = (S.configs || []).find((x) => x.source === id) || {};
      const okGo = window.confirm(
        `删掉「${m.name || id}${row.suffix || ''}」？\n\n`
        + `· 会一并删掉它导入进来的 ${n} 条数据\n`
        + '· 已经推送到日程 / 任务的不会动\n'
        + '· 配置和凭据也会一起删掉（想再用就重新配一次）');
      if (!okGo) return;
      S.busy = '正在删除…'; draw();
      try {
        const r = await api('DELETE', `/api/connectors/${id}`);
        S.note = `已删掉：${m.name || id}${row.suffix || ''}${r.removed_items ? `（连带 ${r.removed_items} 条导入数据）` : ''}。`;
        toast('已经删掉', 'green');
        try { const c = await readJson('/api/connectors'); S.connectors = c.connectors || []; S.configs = c.configs || []; S.counts = c.counts || {}; S.countsByInstance = c.counts_by_instance || {}; } catch { /* ignore */ }
      } catch (err) { S.note = `没删掉：${err.message || ''}`; toast('没删掉，看提示', 'red'); }
      S.busy = ''; draw();
    });
    on('#ob-type-save', async () => {
      const id = S.pickedType;
      const config = {};
      qa('[data-ob-field]').forEach((el) => { config[el.dataset.obField] = el.value; });
      S.busy = '正在连接并试一次…'; draw();
      try {
        // 带 instance ⇒ 改这一条；否则 create:true ⇒ **新建一条**（再加一个 RSS 就是这里来的）
        const r = await api('POST', `/api/connectors/${id}/import`, {
          config, instance: S.editingInstance || undefined, create: S.editingInstance ? undefined : true,
        });
        const m = (S.connectors || []).find((x) => x.id === id) || {};
        S.note = `刚${S.editingInstance ? '改好' : '添加'}：${(m.icon || '')} ${m.name || id}${r.instance > 1 ? `（第 ${r.instance} 条）` : ''} —— 试了一次，收到 ${r.inserted || 0} 条。`;
        toast('添加成功', 'green');
        S.editingInstance = null;
        try { const c = await readJson('/api/connectors'); S.connectors = c.connectors || []; S.configs = c.configs || []; S.counts = c.counts || {}; S.countsByInstance = c.counts_by_instance || {}; } catch { /* ignore */ }
        S.addPhase = 'list';
      } catch (e) { S.note = `没连上：${e.message || ''}（检查一下再试）`; toast('没连上，看提示', 'red'); }
      S.busy = ''; draw();
    });

    // ② 分析偏好：长文本 + 导入本地文件
    const fileInput = q('#ob-file');
    if (fileInput) fileInput.onchange = () => {
      const f = fileInput.files && fileInput.files[0];
      if (!f) return;
      const reader = new FileReader();
      reader.onload = () => {
        const text = String(reader.result || '').slice(0, 4000);
        const ta = q('#ob-notes');
        S.notes = ta ? `${ta.value ? ta.value + '\n\n' : ''}${text}` : text;
        S.fileName = f.name;
        draw();
      };
      reader.readAsText(f, 'utf-8');
    };
    on('#ob-notes-save', async () => {
      const ta = q('#ob-notes');
      const text = (ta ? ta.value : S.notes) || '';
      // 提炼规则和 设置 → 分析偏好 那份**一模一样**（modules/settings/panel.js 的 extractKeywords）：
      // 带括号的是句子碎片要丢，纯英文词照收，中文短语最多 6 字。
      const keywords = [];
      const filler = ['只看', '不要', '优先', '出现', '字样', '可以', '需要', '以及', '这些', '那些',
        '还有', '如果', '然后', '别的', '一律', '最好', '尽量', '比如', '因为', '所以', '但是', '而且',
        '现在', '之后', '之前', '一样', '一些', '一个', '什么', '怎么', '哪些', '就行', '即可'];
      for (const piece of String(text).split(/[,，、。;；:：\s\n\r\t/|]+/)) {
        const w = piece.replace(/^[「『（(\[【"'“]+/, '').replace(/[」』）)\]】"'”]+$/, '').trim();
        if (!w) continue;
        if (/[「」『』（）()\[\]【】]/.test(w)) continue;
        if (filler.includes(w)) continue;
        if (/^[\x20-\x7e]+$/.test(w)) { if (w.length >= 2 && w.length <= 24) keywords.push(w); }
        else if (w.length >= 2 && w.length <= 6) keywords.push(w);
      }
      const freshKeywords = [...new Set(keywords)].slice(0, 12);
      // 只加不减：设置页里也可能手填过关键词，别把已有的一把冲掉（2026-09-26）
      const merged = [...new Set([...(S.keywords || []), ...freshKeywords])].slice(0, 40);
      S.busy = '保存中…'; draw();
      try {
        const r = await api('POST', '/api/profile', { enabled: true, notes: text, keywords: merged });
        S.notes = text;
        S.keywords = (r.profile && r.profile.keywords) || merged;
        S.note = `存好了：${text.length} 字 · 关键词一共 ${S.keywords.length} 个（这次提炼出 ${freshKeywords.length} 个）`;
        toast('分析偏好已保存', 'green');
      } catch (e) { S.note = `没保存上：${e.message || ''}`; }
      S.busy = ''; draw();
    });

    // ③ 挑功能
    onAll('[data-ob-pick]', (e) => {
      const id = e.currentTarget.dataset.obPick;
      S.picked = S.picked.includes(id) ? S.picked.filter((x) => x !== id) : [...S.picked, id];
      S.note = ''; draw();
    });
    const move = (id, d) => {
      const from = S.order.indexOf(id); const to = from + d;
      if (from < 0 || to < 0 || to >= S.order.length) return;
      const next = S.order.slice(); next.splice(to, 0, next.splice(from, 1)[0]); S.order = next; draw();
    };
    onAll('[data-ob-up]', (e) => move(e.currentTarget.dataset.obUp, -1));
    onAll('[data-ob-down]', (e) => move(e.currentTarget.dataset.obDown, 1));
    on('#ob-fns-save', async () => {
      S.busy = '保存中…'; draw();
      try {
        await api('POST', '/api/prefs', { ui_modules: { enabled: S.picked, order: S.order } });
        if (applyLayout) await applyLayout();
        S.note = `已保存：${S.picked.length} 个功能（主页按这个顺序摆）`;
        toast('清单保存了', 'green');
      } catch (e) { S.note = `没保存上：${e.message || ''}`; }
      S.busy = ''; draw();
    });

    // ⑤ 外观
    onAll('[data-ob-theme]', (e) => {
      const id = e.currentTarget.dataset.obTheme;
      S.theme = THEME_IDS.includes(id) ? id : 'p5';
      // 主题要和壁纸一起换（用户 2026-09-26 晚要求）；主程序那个出口会一起做
      if (typeof window.__cairnApplyTheme === 'function') window.__cairnApplyTheme(S.theme);
      else {
        document.body.dataset.theme = S.theme;
        try { localStorage.setItem('planner-theme', S.theme); } catch { /* ignore */ }
        api('POST', '/api/prefs', { theme: S.theme }).catch(() => {});
      }
      S.note = `主题换成「${S.theme}」，壁纸也跟着换了`; draw();
    });
    on('#ob-appname-save', async () => {
      const v = ((q('#ob-appname') || {}).value || '').trim();
      S.busy = '保存中…'; draw();
      try {
        const r = await api('POST', '/api/prefs', { app_name: v });
        const nm = (r.brand && r.brand.app_name) || 'Cairn';
        const bn = document.getElementById('app-name-brand'); if (bn) bn.textContent = nm;
        const bw = document.getElementById('app-name-wb'); if (bw) bw.textContent = nm;
        S.appName = v; S.note = `名字改成「${nm}」`;
      } catch (e) { S.note = `没保存上：${e.message || ''}`; }
      S.busy = ''; draw();
    });
  }

  const onKey = (e) => {
    if (e.key === 'Escape' && document.getElementById('ob-gate')) saveWizard({ dismissed: true }).then(closeGate);
  };
  document.addEventListener('keydown', onKey);

  await load();
  draw();
  return { close: closeGate, state: S };
}
