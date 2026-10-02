// 模块：能力搭建（flow-builder）—— 用能力"拼"出一个新功能的页面（M3）。
//
// 与其他 view 模块同一套规矩：`renderPage()` / `renderNodeCard()` 是纯函数（可测），
// `mount()` 负责交互与连线。页面只调四个接口：
//   GET  /api/capabilities     能力清单（按组分成左边的"素材栏"）
//   GET  /api/flows            已经存下来的声明式功能
//   POST /api/flows/dry-run    试跑（**永远只演练**，真数据、零副作用）
//   POST /api/flows/save       存成一个新功能（modules/<id>/）
//                              —— 或者存成一条新能力（<数据目录>/capabilities/<id>.json，target:'capability'）
//
// 交互刻意保持朴素：**点素材 → 加节点**；节点可以拖（HTML5 拖拽）上下换位置、
// 也可以点 ↑↓ 按钮；节点之间用一条 SVG 曲线连起来（"拉线"）。每一对相邻节点就是一条边。
//
// 2026-10-02（台阶 0/1/2）：
//   * 节点可以写**条件**（"如果…就…"）—— 条件不成立就不跑，并且自动往下游传；
//   * 拼好的图可以**存成一条能力**，于是"能力也能由能力拼出来"（复合能力，一行 JS 不写）；
//   * 开发页可以直接**打开能力目录**——用你自己的编辑器改文件，平台每次读取都会重扫，不用重启。

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (m) => ({
  '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
}[m]));

/** 素材栏：按分组列出能力（可点，点了就加一个节点）。 */
export function renderPalette(caps = []) {
  if (!caps.length) return '<div class="empty">没有可用的能力。</div>';
  const groups = [];
  for (const c of caps) {
    const g = c.group || '未分组';
    if (!groups.some((x) => x.name === g)) groups.push({ name: g, items: [] });
    groups.find((x) => x.name === g).items.push(c);
  }
  return groups.map((g) => `<div class="fb-group">
    <div class="dim" style="margin:6px 0 4px">${esc(g.name)}</div>
    ${g.items.map((c) => `<button class="fb-cap" data-add="${esc(c.id)}" title="${esc(c.kind_label)}${c.permissions.length ? ` · 要 ${esc(c.permissions.join(', '))}` : ' · 不要额外权限'}${c.idempotent ? '' : ' · 不能重放'}${c.composite ? ' · 复合能力（由别的能力拼出来的）' : ''}">
      <span class="fb-cap-ico">${esc(c.icon || '◆')}</span>
      <span>${esc(c.label || c.name)}${c.composite ? ' <span class="dim">·拼</span>' : ''}${c.expose === 'tool_with_confirm' ? ' <span class="dim" title="写类：外部 agent 调它只会拿到计划">⚠️</span>' : ''}${c.expose === 'none' ? ' <span class="dim" title="只用于拼图，不交给模型">🔒</span>' : ''}</span>
    </button>`).join('')}
  </div>`).join('');
}

/**
 * 一个节点卡片（纯函数）。
 * @param {object} node { id, capability, input }
 * @param {number} index 在画布里的顺序（只影响排版与按钮，不再决定连线）
 * @param {object} capMeta 能力元数据（含 __all：全部能力，供下拉用）
 * @param {object} wiring { inbound: [{from}], sources: [节点 id…] } —— 指向本节点的连线 / 可选的起点
 */
export function renderNodeCard(node = {}, index = 0, capMeta = null, wiring = {}) {
  const input = node.input && Object.keys(node.input).length ? JSON.stringify(node.input, null, 1) : '';
  const when = node.when === undefined ? '' : (typeof node.when === 'string' ? node.when : JSON.stringify(node.when));
  const kind = capMeta ? capMeta.kind : '';
  const tag = kind === 'write' || kind === 'outbound' ? '写' : (kind === 'read' ? '读' : '算');
  const condTag = when ? '<span class="pill p0" title="只有条件成立时这一条才跑">如果</span>' : '';
  const inbound = wirelessSafe(wiring.inbound);
  const sources = Array.isArray(wiring.sources) ? wiring.sources : [];
  return `<div class="fb-node list-item" draggable="true" data-node="${esc(node.id)}" data-index="${index}">
    <div class="fb-node-head">
      <span class="pill ${tag === '写' ? 'p1' : (tag === '读' ? 'p3' : 'p2')}">${esc(tag)}</span>
      ${condTag}
      <input class="fb-id" data-node-id="${index}" value="${esc(node.id)}" size="10" />
      <select class="select-inline" data-node-cap="${index}">
        ${(capMeta && capMeta.__all ? capMeta.__all : []).map((c) => `<option value="${esc(c.id)}" ${c.id === node.capability ? 'selected' : ''}>${esc(c.label || c.id)}</option>`).join('')}
      </select>
      <span style="flex:1"></span>
      <button class="btn small" data-up="${index}" title="上移">↑</button>
      <button class="btn small" data-down="${index}" title="下移">↓</button>
      <button class="btn small" data-del="${index}" title="删掉这个节点">✕</button>
    </div>
    <div class="fb-wires">
      ${inbound.length
        ? inbound.map((w) => `<span class="fb-wire">← ${esc(w.from)}<button class="fb-wire-x" data-unlink="${index}:${esc(w.from)}" title="断开这条线">✕</button></span>`).join('')
        : '<span class="dim">没有上游（这一条是起点）</span>'}
      ${sources.length
        ? `<span class="fb-linkbox">
             <select class="select-inline" data-link-from="${index}">
               <option value="">从哪个节点连过来…</option>
               ${sources.map((id) => `<option value="${esc(id)}">${esc(id)}</option>`).join('')}
             </select>
             <button class="btn small" data-link="${index}" title="把选中的节点连到这一条">＋连线</button>
           </span>`
        : ''}
    </div>
    <textarea class="fb-input" data-node-input="${index}" rows="2"
      placeholder='入参（JSON）：可以写 "$上游节点.id" 取它的产出'>${esc(input)}</textarea>
    <input class="fb-when" data-node-when="${index}" value="${esc(when)}"
      placeholder='条件（可空）：留空 = 每次都跑；写 $pick.count > 0 = 只有条件成立才跑' />
    <div class="dim fb-hint">${esc(capMeta ? capMeta.name : '')}</div>
  </div>`;
}

/**
 * 把界面上那个"条件"输入框里的文字变成 flow.v1 认的 `when`（**纯函数**，可测）。
 *
 * 认这几种写法（够用就行，不搞成表达式语言）：
 *   `$pick.count`            → 取到的东西"成立"（非空/非 0/非 false）才跑
 *   `$pick.count > 0`        → 也认 >= < <= == != contains matches
 *   `{ "ref": "$a.b", "op": "eq", "value": "x" }` → 原样（JSON）
 *   `true` / `false`         → 写死的条件（调试用）
 * 看不懂就返回 `{ error }`（界面会提示，不会静默丢掉这个条件）。
 */
export function parseWhenInput(text) {
  const s = String(text == null ? '' : text).trim();
  if (!s) return { when: undefined };
  if (s === 'true' || s === 'false') return { when: s === 'true' };
  if (s.startsWith('{')) {
    try { return { when: JSON.parse(s) }; } catch (e) { return { error: `条件要写合法 JSON：${(e && e.message) || e}` }; }
  }
  const m = s.match(/^(\$[A-Za-z0-9_.]+)\s*(>=|<=|==|!=|>|<|contains|matches)?\s*(.*)$/);
  if (!m) return { error: '条件看不懂：要么写 $节点.字段，要么写 $节点.字段 > 值' };
  const ref = m[1];
  const opRaw = m[2] || '';
  const rhs = (m[3] || '').trim();
  if (!opRaw) {
    if (rhs) return { error: `条件里多了一段看不懂的东西：${rhs}` };
    return { when: ref };
  }
  const op = { '>': 'gt', '>=': 'gte', '<': 'lt', '<=': 'lte', '==': 'eq', '!=': 'ne', contains: 'contains', matches: 'matches' }[opRaw];
  let value = rhs;
  if (/^-?\d+(\.\d+)?$/.test(rhs)) value = Number(rhs);
  else if (rhs === 'true' || rhs === 'false') value = rhs === 'true';
  else if ((rhs.startsWith('"') && rhs.endsWith('"')) || (rhs.startsWith("'") && rhs.endsWith("'"))) value = rhs.slice(1, -1);
  return { when: { ref, op, value } };
}

/** 连线的数组可能来自外部（保存的 flow.json），这里统一成数组，坏值不炸。 */
function wirelessSafe(list) {
  return Array.isArray(list) ? list.filter((x) => x && x.from) : [];
}

/** 整页（纯函数）。 */
export function renderPage(payload = {}) {
  // ⚠️ 2026-09-26 找到的根源 bug：mount 里把能力放在 `caps`，这里却只读 `capabilities` —— 名字对不上，
  // 于是**素材栏永远是 0 条**（"共 0 条能力"）；而"已存功能"那块正常（那个字段两边都叫 flows）。
  // 现在两个名字都认，别再让这种内部字段错位发生。
  const caps = payload.capabilities || payload.caps || [];
  const usable = caps.filter((c) => !c.disabled);          // 停用的不进素材栏（台阶 D）
  const offCount = caps.length - usable.length;
  const nodes = payload.nodes || [];
  const edges = Array.isArray(payload.edges) ? payload.edges : [];
  const all = caps.map((c) => ({ id: c.id, label: c.label, kind: c.kind }));
  const byId = new Map(caps.map((c) => [c.id, c]));
  const flows = payload.flows || [];
  const inboundOf = (id) => edges.filter((e) => e.to === id);
  const sourcesFor = (id) => nodes.map((n) => n.id).filter((from) => from !== id && !edges.some((e) => e.from === from && e.to === id));
  return `<div class="fb-wrap">
    <div class="filters" style="margin-bottom:10px">
      <button class="filter ${payload.pane !== 'dev' ? 'active' : ''}" data-fb-pane="build">🧩 搭功能</button>
      <button class="filter ${payload.pane === 'dev' ? 'active' : ''}" data-fb-pane="dev">🛠 开发 · 能力</button>
      <span style="flex:1"></span>
      <span class="dim">写能力 → 注册 → 立刻能在这里搭进功能里（单文件，不改内核）</span>
    </div>
    ${payload.pane === 'dev' ? renderDevPane(payload) : ''}
    ${payload.pane === 'dev' ? '' : `
    <div class="between" style="margin-bottom:12px">
      <div>
        <h3 style="margin:0">🧩 能力搭建 <span class="muted">拖能力 → 连线 → 试跑 → 存成新功能</span></h3>
        <div class="dim">${nodes.length} 个节点 · ${edges.length} 条连线（想连哪就连哪）· 试跑**只演练**，不会写文件也不会发通知。
          拼好的图既能存成**功能**，也能存成一条**能力**（下次直接当素材用）。</div>
      </div>
      <div style="display:flex;gap:8px;align-items:center">
        <button class="btn" id="fb-clear">清空</button>
        <button class="btn" id="fb-dry">试跑（演练）</button>
      </div>
    </div>

    <div class="fb-cols">
      <div class="card fb-palette">
        <div class="dim">能力素材栏（点一下加到图里）</div>
        <div id="fb-palette-inner" style="max-height:520px;overflow:auto">${renderPalette(usable)}</div>
        ${payload.capsError
          ? `<div class="empty" style="margin-top:6px">能力清单没读出来：${esc(payload.capsError)}
              <div style="margin-top:6px"><button class="btn small" id="fb-retry">再试一次</button></div></div>`
          : `<div class="dim" style="margin-top:8px">共 ${usable.length} 条能力${offCount ? `（另有 ${offCount} 条已停用，去「🛠 开发 · 能力」里启用）` : ''}</div>`}
      </div>

      <div class="card fb-canvas" id="fb-canvas">
        <svg class="fb-lines" id="fb-lines"></svg>
        <div class="fb-nodecol" id="fb-nodes">
          ${nodes.length ? nodes.map((n, i) => renderNodeCard(n, i, { ...(byId.get(n.capability) || {}), __all: all },
            { inbound: inboundOf(n.id), sources: sourcesFor(n.id) })).join('')
            : '<div class="empty" id="fb-empty">左边点几条能力，这里就会出现节点；节点可以拖动换顺序。</div>'}
        </div>
      </div>
    </div>

    <div class="card" style="margin-top:12px">
      <div class="between">
        <div><b>试跑结果</b><div class="dim" id="fb-status">还没试跑</div></div>
        <div style="display:flex;gap:8px;align-items:center">
          <input id="fb-new-id" class="select-inline" placeholder="新功能 id（如 my-flow）" size="18" />
          <input id="fb-new-name" class="select-inline" placeholder="显示名（可选）" size="16" />
          <button class="btn primary" id="fb-save">存成新功能</button>
        </div>
      </div>
      <div class="between" style="margin-top:6px">
        <div class="dim">存成**能力**：以后能在素材栏里直接选它（能力 id 要写成点分的，如 <code>my.flow</code>）</div>
        <div style="display:flex;gap:8px;align-items:center">
          <input id="fb-new-cap-id" class="select-inline" placeholder="新能力 id（如 my.flow）" size="18" />
          <button class="btn" id="fb-save-cap">存成新能力</button>
        </div>
      </div>
      <pre id="fb-result" style="display:none;white-space:pre-wrap;margin-top:8px"></pre>
    </div>

    <div class="card" style="margin-top:12px">
      <b>已经存下来的声明式功能</b>
      <div class="dim">这些功能的目录里没有 run.js，只有一张 flow.json。</div>
      ${payload.flowsError ? `<div class="empty">功能清单没读出来：${esc(payload.flowsError)}</div>` : ''}
      ${flows.length ? `<table class="table" style="margin-top:6px"><thead><tr><th>id</th><th>显示名</th><th>图</th><th>用到的能力</th></tr></thead>
        <tbody>${flows.map((f) => `<tr><td><code>${esc(f.id)}</code></td><td>${esc(f.name)}</td><td>${esc(f.summary)}</td>
        <td>${esc((f.capabilities || []).join(', '))}</td></tr>`).join('')}</tbody></table>`
        : '<div class="empty">还没有声明式功能。左边拼一个，然后"存成新功能"。</div>'}
    </div>
    </div>`}
  </div>`;
}

/**
 * 「开发 · 能力」：写一条能力（单文件）→ 注册 → 试跑（2026-09-26 从设置页搬到这里）。
 * 2026-10-02 加了台阶 0：把"在浏览器里写代码"从**唯一入口**降成**兜底入口** ——
 * 能力就是数据目录下的普通文件，用你自己的编辑器改完，回来点「重新扫描」就生效（不用重启服务）。
 */
export function renderDevPane(payload = {}) {
  const caps = payload.userCaps || [];
  const allCaps = payload.capabilities || payload.caps || [];
  const code = payload.devCode !== undefined ? payload.devCode : DEV_TEMPLATE;
  const dir = payload.capDir || '';
  return `<div class="card">
    <b>停用 / 启用（本机版"隔离"）</b>
    <div class="dim">停用的能力：**不进素材栏、不进给模型的工具表，图执行会明确报"已停用"**（不是静默不跑）。
      这个是本机设置，存在数据目录里，删掉那份清单就等于全部启用。</div>
    <div style="margin-top:8px;max-height:220px;overflow:auto">
      ${allCaps.length ? allCaps.map((c) => `<div class="ob-row">
        <span style="flex:1">${esc(c.icon || '◆')} ${esc(c.label || c.name || c.id)}
          <span class="dim">${esc(c.id)}${c.expose === 'none' ? ' · 只用于拼图' : (c.expose === 'tool_with_confirm' ? ' · 写类只给计划' : '')}</span></span>
        ${c.disabled ? '<span class="pill p0">已停用</span>' : ''}
        <button class="btn small" data-fb-toggle="${esc(c.id)}" data-fb-disabled="${c.disabled ? '1' : '0'}">${c.disabled ? '启用' : '停用'}</button>
      </div>`).join('') : '<div class="empty">没读到能力清单。</div>'}
    </div>
  </div>
  <div class="card">
    <b>在哪写</b>
    <div class="dim">能力就是<strong>数据目录下的普通文件</strong>：手写的是一份 <code>.json</code>/<code>.mjs</code>，
      放在 <code>${esc(dir || '<数据目录>/capabilities/')}</code>。
      平台**每次读取都会重扫这个目录** —— 用你自己的编辑器（VS Code / Codex 都行）改完文件，
      回到这里点「重新扫描」就生效，**不用重启服务**。</div>
    <div style="display:flex;gap:8px;flex-wrap:wrap;align-items:center;margin-top:8px">
      <button class="btn" id="fb-dev-open">打开能力目录</button>
      <button class="btn" id="fb-rescan">重新扫描</button>
      <span class="dim">${esc(dir ? `目录：${dir}` : '（这台服务器没给数据目录，用不了自写能力）')}</span>
    </div>
    <div class="dim" style="margin-top:6px">想"零代码"加一条能力？不用在这儿写代码 ——
      去「🧩 搭功能」把能力连成一张图，然后点「存成新能力」。（也可以在文件里手写一条复合能力：一个 <code>.json</code>，里面是 <code>{meta, flow}</code>。）</div>
  </div>
  <div class="card">
    <b>写一条能力</b>
    <div class="dim">能力 = 一个单文件：<code>&lt;数据目录&gt;/capabilities/&lt;id&gt;.mjs</code>，导出 <code>meta</code> 与 <code>run(input, ctx)</code>。
      <b>不用改内核、不用改主程序</b>；写好点「保存并注册」，它会立刻出现在上面的素材栏里。</div>
    <div style="display:flex;gap:8px;flex-wrap:wrap;margin-top:8px">
      <input id="fb-dev-id" class="select-inline" placeholder="能力 id（如 demo.upper）" size="20" />
      <input id="fb-dev-name" class="select-inline" placeholder="显示名" size="16" />
      <select id="fb-dev-kind" class="select-inline">
        <option value="compute">compute</option><option value="read">read</option>
        <option value="write">write</option><option value="outbound">outbound</option>
      </select>
    </div>
    <textarea id="fb-dev-code" spellcheck="false" style="width:100%;min-height:190px;margin-top:8px;background:var(--panel2);border:1px solid var(--line2);color:var(--text);border-radius:10px;padding:10px;font-family:ui-monospace,Consolas,monospace;font-size:12px">${esc(code)}</textarea>
    <div style="display:flex;gap:8px;flex-wrap:wrap;align-items:center;margin-top:10px">
      <button class="btn primary" id="fb-dev-save">保存并注册</button>
      <button class="btn" id="fb-dev-run">试跑</button>
      <input id="fb-dev-input" class="select-inline" value='{"text":"hello"}' size="24" />
      <span class="dim" id="fb-dev-note">${payload.note ? esc(payload.note) : ''}</span>
    </div>
    <div style="margin-top:12px"><b>你已经写的能力</b>
      ${caps.length ? caps.map((c) => `<div class="ob-row">
        <div style="flex:1"><div>${esc(c.id)} <span class="dim">${esc(c.name || '')}</span>${c.error ? ' <span class="pill p0">坏了</span>' : (c.composite ? ' <span class="pill p3">拼的</span>' : '')}</div>
          <div class="dim">${c.error ? esc(c.error) : esc(c.file || '')}${c.composite && !c.error ? ` · ${esc((c.capabilities || []).join('、'))}` : ''}</div></div>
        ${c.composite ? '' : `<button class="btn small" data-fb-dev-load="${esc(c.id)}">打开</button>`}
        <button class="btn small" data-fb-dev-run="${esc(c.id)}">试跑</button>
      </div>`).join('') : '<div class="empty">还没有自己写的能力。</div>'}
    </div>
  </div>`;
}

export const DEV_TEMPLATE = `// 一条能力 = 一个文件。导出 meta（描述）与 run（干活）。
export const meta = {
  id: 'demo.upper',            // 点分「域.动作」；不能和平台自带的重名
  name: '把文字转成大写',
  kind: 'compute',             // read | compute | write | outbound
  permissions: [],             // 要动磁盘/网络才需要，例如 ['fs:read:data']
  idempotent: true,
  cost: 'none',
  ui: { label: '转大写', group: '自写' },
};

export async function run(input = {}) {
  return { upper: String(input.text || '').toUpperCase() };
}
`;

export async function mount(el, ctx = {}) {
  const { api, toast = () => {}, DB } = ctx;
  // 事件绑定助手（2026-09-26 补：我把页签/开发面板的绑定写成 on/onAll，却忘了在这里定义它们，
  // 结果整页抛 `onAll is not defined`、只显示"模块加载失败"）。
  const q = (sel) => el.querySelector(sel);
  const qa = (sel) => [...el.querySelectorAll(sel)];
  const on = (sel, fn) => { const node = q(sel); if (node) node.onclick = fn; };
  const onAll = (sel, fn) => qa(sel).forEach((node) => { node.onclick = fn; });
  // nodes 管顺序与参数；edges 管"谁连到谁"（M3 第二版：不再是"相邻即连"）
  const state = { caps: [], flows: [], nodes: [], edges: [], capsError: '', flowsError: '', pane: 'build', userCaps: [], devCode: undefined, note: '', capDir: '' };
  const draw = () => { el.innerHTML = renderPage({ ...state }); bind(); drawLines(); };
  const status = (t) => { const s = el.querySelector('#fb-status'); if (s) s.textContent = t || ''; };
  const showResult = (text) => {
    const pre = el.querySelector('#fb-result');
    if (pre) { pre.textContent = text; pre.style.display = ''; }
  };

  /**
   * 这一页的两个读取都显式带 `cache: 'no-store'`：
   * 2026-09-25 实测踩到过 —— 浏览器（应用内浏览器）把"接口还没做时"的那个响应缓存住了，
   * 接口做好之后页面仍拿到旧的，表现成"素材栏是空的"。带上 no-store 与一个递增参数最稳。
   */
  const readJson = async (path) => {
    // 本地接口 + 中间可能还隔着浏览器缓存：带一个时间戳，保证每次都是新的一次请求
    const url = path + (path.includes('?') ? '&' : '?') + '_t=' + Date.now();
    const res = await fetch(url, { cache: 'no-store', headers: { Accept: 'application/json' } });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
    return data;
  };

  async function load() {
    // 先画一帧"载入中"（2026-09-26 修：以前是先 await 取数、取不到就整页空白，
    // 用户看到的是"能力搭建完全是空的"）。现在保证第一帧一定画出来。
    state.capsError = '正在载入能力清单…';
    draw();
    // 读不出来要说出来（别给一张空素材栏让人猜）：把错误原样显示在页面上
    // 优先用应用启动时已经取好的那份（ctx.DB.capabilities）——页面自己再请求一次有卡住的风险。
    // 那份是启动后异步填的，所以这里**等一下**（最多 1.5 秒），别因为"还没取回来"就显示空的。
    const injected = await (async () => {
      for (let i = 0; i < 15; i += 1) {
        if (DB && Array.isArray(DB.capabilities) && DB.capabilities.length) return DB.capabilities;
        await new Promise((r) => setTimeout(r, 100));
      }
      return null;
    })();
    // 兜底：取数不许无限等（4 秒还没回来就先按"读不到"画出来，用户能点重试）
    const withTimeout = (p, ms) => Promise.race([
      p, new Promise((resolve) => setTimeout(() => resolve({ __timeout: true }), ms)),
    ]);
    if (injected) {
      state.caps = injected;
      state.capsError = '';
    } else {
    try {
      const r = await withTimeout(readJson('/api/capabilities'), 4000);
      if (r && r.__timeout) { state.caps = []; state.capsError = '取能力清单一事超时（4 秒）——点「再试一次」'; draw(); }
      else
      state.caps = r.capabilities || [];
      state.capsError = state.caps.length ? '' : `接口回了 ${JSON.stringify(r).slice(0, 120)}`;
    } catch (e) { state.caps = []; state.capsError = String((e && e.message) || e); }
    }
    // 兜底：既没错误又是空的（不该发生）⇒ 也把话说明白，别给一张空面板
    if (!state.caps.length && !state.capsError) {
      state.capsError = '没读到能力清单（页面可能缓存了旧模块）——点下面「再试一次」';
    }
    try {
      const f = await withTimeout(readJson('/api/flows'), 4000);
      state.flows = (f && f.flows) || []; state.flowsError = (f && f.__timeout) ? '取已存功能超时' : '';
    } catch (e) { state.flows = []; state.flowsError = String((e && e.message) || e); }
    // 开发者模式才多取一份"你写的能力"（给"开发 · 能力"那一页）
    try {
      const d = await withTimeout(readJson('/api/capabilities/dev'), 4000);
      state.userCaps = (d && d.capabilities) || [];
      state.capDir = (d && d.dir) || '';
      if (d && d.template && state.devCode === undefined) state.devCode = d.template;
    }
    catch { state.userCaps = []; }
    draw();
  }

  /** 每条连线画一条曲线（"拉线"）：位置要等布局出来才算，所以每次重画都重算。 */
  function drawLines() {
    const svg = el.querySelector('#fb-lines');
    const col = el.querySelector('#fb-nodes');
    if (!svg || !col) return;
    const cards = new Map([...col.querySelectorAll('.fb-node')].map((c) => [c.dataset.node, c]));
    const box = col.getBoundingClientRect();
    const w = Math.max(1, Math.round(box.width));
    const h = Math.max(1, Math.round(col.scrollHeight || box.height));
    svg.setAttribute('viewBox', `0 0 ${w} ${h}`);
    svg.setAttribute('width', String(w));
    svg.setAttribute('height', String(h));
    const paths = [];
    for (const e of state.edges) {
      const ca = cards.get(e.from);
      const cb = cards.get(e.to);
      if (!ca || !cb) continue;
      const a = ca.getBoundingClientRect();
      const b = cb.getBoundingClientRect();
      const x1 = a.left - box.left + 22;
      const y1 = a.bottom - box.top;
      const x2 = b.left - box.left + 22;
      const y2 = b.top - box.top;
      const mid = (y1 + y2) / 2;
      paths.push(`<path d="M ${x1} ${y1} C ${x1} ${mid}, ${x2} ${mid}, ${x2} ${y2}" fill="none" stroke="var(--accent2, #7fd1ff)" stroke-width="2" stroke-dasharray="4 3" />`);
    }
    svg.innerHTML = paths.join('');
  }

  /** 图 = 节点 + 连线（这也是下面发给服务端的东西）。 */
  function spec() {
    const nodes = state.nodes.map((n) => {
      const out = { id: n.id, capability: n.capability };
      if (n.input && Object.keys(n.input).length) out.input = n.input;
      if (n.when !== undefined && n.when !== true && n.when !== '') out.when = n.when;
      return out;
    });
    const ids = new Set(nodes.map((n) => n.id));
    const edges = state.edges.filter((e) => ids.has(e.from) && ids.has(e.to)).map((e) => [e.from, e.to]);
    return { schema: 'flow.v1', nodes, edges };
  }

  function addNode(capId) {
    const cap = state.caps.find((c) => c.id === capId);
    const base = String(capId || 'node').replace(/[^a-z0-9]+/gi, '-').toLowerCase();
    let id = base;
    let i = 2;
    while (state.nodes.some((n) => n.id === id)) { id = `${base}-${i}`; i += 1; }
    const prev = state.nodes.length ? state.nodes[state.nodes.length - 1].id : null;
    state.nodes.push({ id, capability: capId, input: {} });
    // 默认接上"上一个节点 → 这个"，省得每加一个都要手动连；不想要就点 ✕ 断开
    if (prev) state.edges.push({ from: prev, to: id });
    status(`加了「${(cap && (cap.label || cap.name)) || capId}」`);
    draw();
  }

  function moveNode(from, to) {
    if (to < 0 || to >= state.nodes.length || from === to) return;
    const [n] = state.nodes.splice(from, 1);
    state.nodes.splice(to, 0, n);
    draw();
  }

  function unlink(nodeId, from) {
    state.edges = state.edges.filter((e) => !(e.to === nodeId && e.from === from));
    draw();
  }

  function link(nodeId, from) {
    if (!from || from === nodeId) return;
    if (state.edges.some((e) => e.from === from && e.to === nodeId)) { status('这条线已经有了'); return; }
    state.edges.push({ from, to: nodeId });
    status(`连上了：${from} → ${nodeId}`);
    draw();
  }

  function bind() {
    // 顶部两个页签：搭功能 / 开发 · 能力（2026-09-26：之前画了页签却忘了绑点击，"点不动"就是这个）
    onAll('[data-fb-pane]', (e) => {
      state.pane = e.currentTarget.dataset.fbPane === 'dev' ? 'dev' : 'build';
      draw();
    });
    const inner = el.querySelector('#fb-palette-inner');
    if (inner) inner.onclick = (e) => {
      const b = e.target.closest('[data-add]');
      if (b) addNode(b.dataset.add);
    };
    const retry = el.querySelector('#fb-retry');
    if (retry) retry.onclick = () => load();
    // 台阶 0：能力就在本机文件夹里 —— 打开目录 / 重新扫描（不用重启服务）
    on('#fb-dev-open', async () => {
      try {
        const r = await api('POST', '/api/capabilities/dev/open', {});
        state.note = r.ok ? `已在文件管理器里打开：${r.dir}` : `没能打开：${r.error || '未知原因'}（路径：${r.dir || ''}）`;
        if (r.ok) toast('已打开能力目录', 'green');
      } catch (e) { state.note = `没能打开：${e.message || ''}`; }
      draw();
    });
    on('#fb-rescan', async () => {
      state.note = '重新扫描中…'; draw();
      state.devCode = undefined;                  // 让模板重新读一次，别把上次的编辑器内容当成"现在的"
      await load();
      state.note = `已重新扫描（共 ${state.userCaps.length} 条自写能力）`;
      draw();
    });
    // 停用 / 启用一条能力（台阶 D）：本机隔离，坏能力或"暂时不想看见"的能力都能关掉
    onAll('[data-fb-toggle]', async (e) => {
      const id = e.currentTarget.dataset.fbToggle;
      const want = e.currentTarget.dataset.fbDisabled !== '1';
      try {
        const r = await api('POST', '/api/capabilities/disabled', { id, disabled: want });
        toast(`${want ? '已停用' : '已启用'}「${id}」`, want ? 'green' : 'green');
        await load();
      } catch (err) { toast(`没改成：${err.message || ''}`, 'red'); }
    });

    // ---- 开发 · 能力：保存并注册 / 试跑 / 打开（从设置页搬过来时漏了绑，这次补齐） ----
    on('#fb-dev-save', async () => {
      const id = ((q('#fb-dev-id') || {}).value || '').trim();
      const name = ((q('#fb-dev-name') || {}).value || '').trim();
      const kind = ((q('#fb-dev-kind') || {}).value || 'compute');
      const code = (q('#fb-dev-code') || {}).value || '';
      state.note = '保存中…'; draw();
      try {
        const r = await api('POST', '/api/capabilities/dev/save', { id, name, kind, code });
        state.note = r.ok ? `已注册能力「${r.id}」——上面的素材栏现在能选它了` : `没注册上：${r.error || ''}`;
        if (r.ok) toast(`能力「${r.id}」已注册`, 'green');
        await load();                     // 重新取一遍：新能力要立刻出现在素材栏
      } catch (e) { state.note = `没注册上：${e.message || ''}`; draw(); }
    });
    const runDev = async (id) => {
      if (!id) { state.note = '先写个能力 id'; draw(); return; }
      let input = {};
      try { input = JSON.parse((q('#fb-dev-input') || {}).value || '{}'); } catch { input = {}; }
      state.note = `试跑 ${id} …`; draw();
      try {
        const r = await api('POST', '/api/capabilities/dev/run', { id, input });
        state.note = r.ok ? `试跑成功：${JSON.stringify(r.output).slice(0, 200)}` : `试跑失败：${r.error || ''}`;
      } catch (e) { state.note = `试跑失败：${e.message || ''}`; }
      draw();
    };
    on('#fb-dev-run', () => runDev(((q('#fb-dev-id') || {}).value || '').trim()));
    onAll('[data-fb-dev-run]', (e) => runDev(e.currentTarget.dataset.fbDevRun));
    onAll('[data-fb-dev-load]', async (e) => {
      try {
        const r = await readJson('/api/capabilities/dev?id=' + encodeURIComponent(e.currentTarget.dataset.fbDevLoad));
        state.devCode = r.code || '';
        state.note = `已打开 ${r.id}（点"保存并注册"覆盖它）`;
        state.devPrefill = { id: r.id, name: r.name, kind: r.kind };
        draw();
        const set = (sel, v) => { const x = q(sel); if (x) x.value = v; };
        set('#fb-dev-id', r.id || ''); set('#fb-dev-name', r.name || ''); set('#fb-dev-kind', r.kind || 'compute');
      } catch (err) { state.note = `打不开：${err.message || ''}`; draw(); }
    });
    el.querySelector('#fb-clear') && (el.querySelector('#fb-clear').onclick = () => { state.nodes = []; draw(); });

    el.querySelectorAll('[data-del]').forEach((b) => b.onclick = () => { state.nodes.splice(Number(b.dataset.del), 1); draw(); });
    el.querySelectorAll('[data-up]').forEach((b) => b.onclick = () => moveNode(Number(b.dataset.up), Number(b.dataset.up) - 1));
    el.querySelectorAll('[data-down]').forEach((b) => b.onclick = () => moveNode(Number(b.dataset.down), Number(b.dataset.down) + 1));
    // 连线：断开 / 连上（这是 M3 第二版的重点 —— 想连哪就连哪）
    el.querySelectorAll('[data-unlink]').forEach((b) => b.onclick = () => {
      const [idx, from] = String(b.dataset.unlink).split(':');
      const n = state.nodes[Number(idx)];
      if (n) unlink(n.id, from);
    });
    el.querySelectorAll('[data-link]').forEach((b) => b.onclick = () => {
      const idx = Number(b.dataset.link);
      const n = state.nodes[idx];
      const sel = el.querySelector(`[data-link-from="${idx}"]`);
      if (n && sel) link(n.id, sel.value);
    });

    // 节点 id / 能力 / 入参的编辑：输入即改（不重画，免得打断打字）
    el.querySelectorAll('[data-node-id]').forEach((inp) => inp.onchange = () => {
      const n = state.nodes[Number(inp.dataset.nodeId)];
      const v = inp.value.trim().replace(/[^a-zA-Z0-9_-]/g, '');
      if (!v || state.nodes.some((x, i) => x !== n && x.id === v)) { toast('这个节点名不能用（重复或为空）', 'red'); draw(); return; }
      const old = n.id;
      n.id = v;
      // 连线和 $引用 都跟着改名（不然一改 id 图就断了）
      state.edges = state.edges.map((e) => ({ from: e.from === old ? v : e.from, to: e.to === old ? v : e.to }));
      for (const x of state.nodes) {
        if (!x.input) continue;
        const fix = (val) => (typeof val === 'string' ? val.replaceAll(`$${old}.`, `$${v}.`) : (Array.isArray(val) ? val.map(fix) : (val && typeof val === 'object' ? Object.fromEntries(Object.entries(val).map(([k, vv]) => [k, fix(vv)])) : val)));
        x.input = fix(x.input);
      }
      draw();
    });
    el.querySelectorAll('[data-node-cap]').forEach((sel) => sel.onchange = () => {
      state.nodes[Number(sel.dataset.nodeCap)].capability = sel.value;
      draw();
    });
    el.querySelectorAll('[data-node-input]').forEach((ta) => ta.onchange = () => {
      const n = state.nodes[Number(ta.dataset.nodeInput)];
      const raw = ta.value.trim();
      if (!raw) { n.input = {}; return; }
      try { n.input = JSON.parse(raw); }
      catch { toast('入参要写合法 JSON（例如 { "courses": "$scan.courses" }）', 'red'); return; }
      draw();
    });
    // 条件（"如果…就…"）：留空 = 每次都跑
    el.querySelectorAll('[data-node-when]').forEach((inp) => inp.onchange = () => {
      const n = state.nodes[Number(inp.dataset.nodeWhen)];
      if (!n) return;
      const r = parseWhenInput(inp.value);
      if (r.error) { toast(r.error, 'red'); draw(); return; }
      if (r.when === undefined) delete n.when; else n.when = r.when;
      status(r.when === undefined ? `「${n.id}」改回每次都跑` : `「${n.id}」只有条件成立才跑`);
      draw();
    });

    // 拖动换顺序（HTML5 原生拖拽，拖动时就能看到顺序变化）
    let dragFrom = null;
    el.querySelectorAll('.fb-node').forEach((card) => {
      card.ondragstart = (e) => { dragFrom = Number(card.dataset.index); e.dataTransfer?.setData('text/plain', String(dragFrom)); };
      card.ondragover = (e) => { e.preventDefault(); };
      card.ondrop = (e) => {
        e.preventDefault();
        const to = Number(card.dataset.index);
        if (dragFrom !== null) moveNode(dragFrom, to);
        dragFrom = null;
      };
    });

    const dry = el.querySelector('#fb-dry');
    if (dry) dry.onclick = async () => {
      status('试跑中…（真数据、只演练）');
      try {
        const r = await api('POST', '/api/flows/dry-run', { spec: spec() });
        const line = (n) => (n.skipped ? `  ⏭ ${n.id}（${n.capability}）没跑：${n.reason || '条件不成立'}`
          : `${n.ok ? '  ✅' : '  ❌'} ${n.id}（${n.capability}）${n.ms}ms${n.error ? '：' + n.error : ''}`);
        if (!r.ok) { status(''); showResult(`没跑通：${r.error || '未知原因'}\n\n${(r.nodes || []).map((n) => line(n).trim()).join('\n')}`); return; }
        const skipped = (r.nodes || []).filter((n) => n.skipped).length;
        status(`${r.summary} · ${r.ms}ms · 只演练，没有副作用${skipped ? ` · ${skipped} 个节点没跑（条件不成立）` : ''}`);
        showResult([
          '节点：',
          ...(r.nodes || []).map(line),
          '',
          '本来会做的事（planned，未执行）：',
          ...(r.planned || []).map((a) => `  · ${a.type} —— ${a.summary}${a.path ? `\n      → ${a.path}` : ''}`),
          (r.planned || []).length ? '' : '  （这张图不产生写动作）',
        ].join('\n'));
      } catch (e) { status(''); showResult(`失败：${e.message || ''}`); }
    };

    const save = el.querySelector('#fb-save');
    if (save) save.onclick = async () => {
      const id = (el.querySelector('#fb-new-id').value || '').trim();
      const name = (el.querySelector('#fb-new-name').value || '').trim();
      if (!id) { toast('先给这个功能起个 id（小写字母/数字/连字符）', 'red'); return; }
      status('保存中…');
      try {
        const r = await api('POST', '/api/flows/save', { id, name, spec: spec() });
        status('');
        toast(`已存成新功能：${r.id}（用 cairn mod test ${r.id} 试一下）`, 'green');
        showResult(`已保存 modules/${r.id}/\n声明能力：${(r.capabilities || []).join(', ')}\n权限：${(r.permissions || []).join(', ') || '（无）'}`);
        await load();
      } catch (e) { status(''); toast(`没存上：${e.message || ''}`, 'red'); }
    };

    // 台阶 1：同样的图，直接存成一条**能力**（下次在素材栏里就能选它）
    const saveCap = el.querySelector('#fb-save-cap');
    if (saveCap) saveCap.onclick = async () => {
      const id = (el.querySelector('#fb-new-cap-id').value || '').trim();
      const name = (el.querySelector('#fb-new-name').value || '').trim();
      if (!id) { toast('先给这条能力起个 id —— 要写成点分的，例如 my.flow', 'red'); return; }
      if (!id.includes('.')) { toast('能力 id 要是点分的「域.动作」，例如 my.flow', 'red'); return; }
      status('保存中…');
      try {
        const r = await api('POST', '/api/flows/save', { id, name, spec: spec(), target: 'capability' });
        status('');
        toast(`已存成新能力：${r.id}`, 'green');
        showResult([
          `已保存 ${r.file || `capabilities/${r.id}.json`}`,
          `用到的能力：${(r.capabilities || []).join(', ')}`,
          `权限：${(r.permissions || []).join(', ') || '（无）'}`,
          '',
          '它现在出现在上面的素材栏里了 —— 可以像自带能力一样被拼进别的图。',
        ].join('\n'));
        await load();
      } catch (e) { status(''); toast(`没存上：${e.message || ''}`, 'red'); }
    };
  }

  await load();
  window.addEventListener?.('resize', drawLines);
}
