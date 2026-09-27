// 模块：连接向导 —— 选数据源 → 填字段 → 测试连接 → 保存并导入。
//
// 与 filter-profile 一样：导出纯函数 renderCard()（可测试）与 mount(el, ctx)（交互）。

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (m) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[m]));

/** 纯函数：卡片骨架。 */
export function renderCard(connectors = [], current = '') {
  const options = (connectors || []).map((c) =>
    `<option value="${esc(c.id)}" ${c.id === current ? 'selected' : ''}>${esc(c.icon || '·')} ${esc(c.name)}</option>`).join('');
  return `
    <div class="card mt" id="connect-wizard">
      <h3>🪄 连接向导 <span class="muted">三步接上一个外部数据源</span></h3>
      <div class="between" style="flex-wrap:wrap;gap:10px;margin-bottom:10px">
        <label class="dim">① 选数据源
          <select id="cw-source" style="width:auto;margin-left:6px">${options || '<option value="">（还没有可用的数据源）</option>'}</select>
        </label>
        <span class="dim" id="cw-hint"></span>
      </div>
      <div id="cw-fields" class="dim">② 选好数据源后，这里会出现要填的字段。</div>
      <div style="display:flex;gap:8px;flex-wrap:wrap;margin-top:10px">
        <button class="btn small" id="cw-test">③ 测试连接</button>
        <button class="btn primary small" id="cw-import">保存并导入</button>
        <span class="dim" id="cw-result" style="align-self:center"></span>
      </div>
      <div class="dim" style="margin-top:10px;font-size:12px">
        不知道这个数据源要准备什么？
        <a href="/docs/CONNECT_SOURCES.md" target="_blank" rel="noopener">看《数据源配置教程》</a>
        （里面有每个字段怎么填、报错是什么意思）
      </div>
    </div>`;
}

/** 纯函数：把某个数据源的字段渲染成表单（已保存的值会回填，凭据是掩码）。 */
export function renderFields(meta, savedConfig = {}) {
  if (!meta) return '<div class="dim">没有这个数据源的信息。</div>';
  const fields = meta.fields || [];
  if (!fields.length) return '<div class="dim">这个数据源不需要填任何东西。</div>';
  return fields.map((f) => `
    <div class="field">
      <label>${esc(f.label || f.key)}${f.required ? ' *' : ''}</label>
      <input type="${esc(f.type || 'text')}" data-cwkey="${esc(f.key)}"
             placeholder="${esc(f.placeholder || '')}"
             value="${esc(savedConfig[f.key] ?? '')}" />
      ${f.placeholder ? `<div class="dim" style="font-size:12px">例如：${esc(f.placeholder)}</div>` : ''}
    </div>`).join('');
}

export async function mount(el, ctx = {}) {
  const { api, toast = () => {}, refresh = async () => {}, DB = {} } = ctx;
  const connectors = (DB.connectors && DB.connectors.meta) || [];
  const configs = (DB.connectors && DB.connectors.configs) || [];
  let current = connectors[0]?.id || '';

  const paint = () => {
    el.innerHTML = renderCard(connectors, current);
    const sel = el.querySelector('#cw-source');
    if (sel) sel.onchange = () => { current = sel.value; paintFields(); };
    const test = el.querySelector('#cw-test');
    if (test) test.onclick = () => runTest(test);
    const imp = el.querySelector('#cw-import');
    if (imp) imp.onclick = () => runImport(imp);
    paintFields();
  };

  const savedOf = (id) => {
    const row = configs.find((c) => c.source === id);
    try { return row ? JSON.parse(row.config_json || '{}') : {}; } catch { return {}; }
  };

  const paintFields = () => {
    const box = el.querySelector('#cw-fields');
    const meta = connectors.find((c) => c.id === current);
    if (box) box.innerHTML = '<div style="margin-top:4px">② 填下面的字段：</div>' + renderFields(meta, savedOf(current));
    const hint = el.querySelector('#cw-hint');
    if (hint) hint.textContent = meta?.auth_hint || (meta?.description ? String(meta.description).slice(0, 46) : '');
    const result = el.querySelector('#cw-result');
    if (result) result.textContent = '';
  };

  const collect = () => {
    const out = {};
    el.querySelectorAll('[data-cwkey]').forEach((inp) => { out[inp.dataset.cwkey] = inp.value; });
    return out;
  };

  const show = (text, ok) => {
    const box = el.querySelector('#cw-result');
    if (!box) return;
    box.innerHTML = `<span style="color:${ok ? 'var(--green, #3ecf8e)' : 'var(--red, #ff6b6b)'}">${esc(text)}</span>`;
  };

  const runTest = async (btn) => {
    if (!current) { show('先选一个数据源', false); return; }
    btn.textContent = '测试中…';
    show('正在真拉一次数据…大来源（如 Canvas 全部课程）可能要 30–60 秒，请稍等', true);
    try {
      const r = await api('POST', `/api/connectors/${current}/test`, { config: collect() });
      show(r.message || (r.ok ? '连接成功' : '连接失败'), r.ok);
    } catch (e) {
      show('测试失败：' + e.message, false);
    }
    btn.textContent = '③ 测试连接';
  };

  const runImport = async (btn) => {
    if (!current) { show('先选一个数据源', false); return; }
    btn.textContent = '导入中…';
    try {
      const r = await api('POST', `/api/connectors/${current}/import`, { config: collect() });
      if (r.error) show(r.error, false);
      else show(`导入完成：${r.inserted} 条`, true);
      await refresh();
      toast(r.error ? '导入失败' : `已导入 ${r.inserted} 条`, r.error ? 'red' : 'green');
    } catch (e) {
      show('导入失败：' + e.message, false);
    }
    btn.textContent = '保存并导入';
  };

  paint();
  return { rerender: paint };
}
