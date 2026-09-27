// 模块：我关心什么 · 信息筛选（第一个可插拔模块）
//
// 约定（见 contracts/module.v1.schema.json 与 modules/filter-profile/README.md）：
//   * 导出 mount(el, ctx)：框架把容器与上下文给你，你负责渲染与交互。
//   * 顺便导出一个纯函数 renderCard(profile, learned, esc)：不依赖 DOM，方便测试。
//   * 不直接碰 DOM 之外的东西：数据读写一律走 ctx.api。

export const PF_ORIGIN_LABEL = {
  empty: '尚未设置', manual: '手动填写', derived: '自动派生', 'longterm-memory': '长期记忆导入',
};

export const DEFAULT_PROFILE = {
  enabled: false, keywords: [], courseCodes: [], allowSenders: [],
  denyKeywords: [], denySenders: [], pushAt: 3, dropAt: -3, semantic: 'off', origin: 'empty',
};

/** 纯函数：把画像 + 学习记录渲染成一段 HTML（不依赖 DOM，测试直接调它）。 */
export function renderCard(profile, learned, esc = (s) => String(s ?? '')) {
  const p = { ...DEFAULT_PROFILE, ...(profile || {}) };
  const l = learned || { enabled: true, notes: [] };
  const list = (arr) => (arr || []).join(', ');
  return `
    <div class="card mt" id="profile-card">
      <h3>🧭 我关心什么 <span class="muted">决定外部信息里哪些值得打扰你</span></h3>
      <div class="dim" style="margin-bottom:10px">
        不启用时一切照旧。启用后按这里的内容给外部条目打分：命中课程代码 / 关注词 / 关注发件人加分，
        促销与自动通知减分；分数 ≥ <b>${p.pushAt}</b> 自动推送，≤ <b>${p.dropAt}</b> 判为「建议忽略」，中间进「待批准」。
      </div>
      <div class="between" style="flex-wrap:wrap;gap:12px;margin-bottom:10px">
        <label class="dim" style="display:flex;align-items:center;gap:6px">
          <input type="checkbox" id="pf-enabled" ${p.enabled ? 'checked' : ''} style="width:auto" /> 启用筛选
        </label>
        <span class="dim">画像来源：${esc(PF_ORIGIN_LABEL[p.origin] || p.origin)}</span>
        <span style="flex:1"></span>
        <button class="btn small" id="pf-derive">从我的数据自动派生</button>
        <button class="btn small" id="pf-import">从长期记忆导入…</button>
        <button class="btn primary small" id="pf-save">保存</button>
      </div>
      <div class="field"><label>关注的关键词（逗号分隔）</label>
        <input id="pf-keywords" value="${esc(list(p.keywords))}" placeholder="例如 TOEFL, ACM, 科研" /></div>
      <div class="field"><label>我的课程代码</label>
        <input id="pf-courses" value="${esc(list(p.courseCodes))}" placeholder="例如 MATH1860J, STAT1000J" /></div>
      <div class="field"><label>关注的人 / 组织</label>
        <input id="pf-senders" value="${esc(list(p.allowSenders))}" placeholder="例如 advisor@example.edu" /></div>
      <div class="field"><label>不想看的词</label>
        <input id="pf-deny" value="${esc(list(p.denyKeywords))}" placeholder="例如 促销, 优惠, 社团招新" /></div>
      <div class="field"><label>屏蔽的发件人</label>
        <input id="pf-deny-senders" value="${esc(list(p.denySenders))}" placeholder="例如 noreply@example.net" /></div>
      <div style="display:flex;gap:14px;flex-wrap:wrap;margin-top:6px">
        <label class="dim">自动推送阈值 <input type="number" id="pf-push-at" value="${p.pushAt}" style="width:74px" /></label>
        <label class="dim">建议忽略阈值 <input type="number" id="pf-drop-at" value="${p.dropAt}" style="width:74px" /></label>
        <label class="dim" style="display:flex;align-items:center;gap:6px">
          语义兜底
          <select id="pf-semantic" style="width:auto">
            <option value="off" ${p.semantic === 'batch' ? '' : 'selected'}>关闭</option>
            <option value="batch" ${p.semantic === 'batch' ? 'selected' : ''}>非高峰自动跑</option>
          </select>
        </label>
        <button class="btn small" id="pf-semantic-run">立即跑一次</button>
      </div>
      <div id="pf-draft" class="dim" style="margin-top:10px"></div>
      <div class="dim" style="margin-top:10px;border-top:1px solid var(--line);padding-top:10px">
        行为学习：${l.enabled ? '开' : '关'}
        <button class="btn small" id="pf-learn-clear" style="margin-left:8px">清空学习记录</button>
        ${l.notes && l.notes.length
    ? `<div style="margin-top:6px">已从你的操作里学到：<br>${l.notes.map((n) => '· ' + esc(n)).join('<br>')}</div>`
    : '<div style="margin-top:6px">还没学到规则 —— 同一个来源/发件人被你删 3 次、或批准 2 次，就会开始学</div>'}
      </div>
    </div>`;
}

/** 框架会这样调用：mount(容器, 上下文)。上下文里给了 api/esc/toast/refresh 等。 */
export async function mount(el, ctx = {}) {
  const { api, esc = (s) => String(s ?? ''), toast = () => {}, refresh = async () => {}, DB = {} } = ctx;
  const render = () => {
    el.innerHTML = renderCard(DB.profile, DB.profile_learned, esc);
    bind();
  };

  const val = (sel) => { const n = el.querySelector(sel); return n ? n.value : ''; };
  const chk = (sel) => { const n = el.querySelector(sel); return n ? n.checked : false; };
  const split = (sel) => val(sel).split(',').map((s) => s.trim()).filter(Boolean);

  const showDraft = (draft, label) => {
    const box = el.querySelector('#pf-draft');
    if (!box) return;
    box.innerHTML = `草稿（${esc(label)}）：课程 ${(draft.courseCodes || []).length} 个 · 关注词 ${(draft.keywords || []).length} 个 · 屏蔽词 ${(draft.denyKeywords || []).length} 个
      <button class="btn small" id="pf-accept" style="margin-left:8px">用这份草稿（并启用）</button>`;
    const accept = el.querySelector('#pf-accept');
    if (accept) accept.onclick = async () => {
      await api('POST', '/api/profile', { ...draft, enabled: true });
      await refresh();
      toast('已应用草稿并启用筛选', 'green');
    };
  };

  function bind() {
    const save = el.querySelector('#pf-save');
    if (save) save.onclick = async () => {
      await api('POST', '/api/profile', {
        enabled: chk('#pf-enabled'),
        keywords: split('#pf-keywords'),
        courseCodes: split('#pf-courses'),
        allowSenders: split('#pf-senders'),
        denyKeywords: split('#pf-deny'),
        denySenders: split('#pf-deny-senders'),
        pushAt: Number(val('#pf-push-at')),
        dropAt: Number(val('#pf-drop-at')),
        semantic: val('#pf-semantic'),
        origin: 'manual',
      });
      await refresh();
      toast('筛选画像已保存', 'green');
    };

    const derive = el.querySelector('#pf-derive');
    if (derive) derive.onclick = async () => {
      const r = await api('POST', '/api/profile/derive', { preview: true });
      showDraft(r.draft || {}, '自动派生');
    };

    const imp = el.querySelector('#pf-import');
    if (imp) imp.onclick = async () => {
      const text = prompt('把长期记忆（或任意 markdown 文本）粘进来，我会自动提取课程代码、关注关键词与屏蔽词：');
      if (!text) return;
      const r = await api('POST', '/api/profile/import', { text });
      showDraft(r.draft || {}, '长期记忆导入');
    };

    const learnClear = el.querySelector('#pf-learn-clear');
    if (learnClear) learnClear.onclick = async () => {
      await api('POST', '/api/profile/learning', { clear: true });
      await refresh();
      toast('已清空学习记录（手填的画像不受影响）', 'green');
    };

    const semRun = el.querySelector('#pf-semantic-run');
    if (semRun) semRun.onclick = async () => {
      semRun.textContent = '判断中…';
      try {
        const r = await api('POST', '/api/profile/semantic/run', { force: true });
        await refresh();
        if (r.skipped) toast(r.hint || `已跳过（${r.skipped}）`, '');
        else if (!r.ok) toast(r.error || '语义判断失败', 'red');
        else if (!r.candidates) toast(r.hint || '没有拿不准的条目', '');
        else toast(`语义判断完成：放行 ${r.pushed} 条、忽略 ${r.dropped} 条`, 'green');
      } catch (e) {
        toast('语义判断失败：' + e.message, 'red');
      }
      semRun.textContent = '立即跑一次';
    };
  }

  render();

  // 数据刷新后重画（框架每次 refresh 会重新调用模块的 mount 或 rerender）
  return { rerender: render };
}
