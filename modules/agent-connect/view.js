// 模块：Agent / 模型接入 —— 让"只有一个 API Key 的人"也能用起来。

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (m) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[m]));

export const PROVIDER_OPTIONS = [
  { id: 'codex-cli', label: '本机 Codex CLI（默认，无需配置）' },
  { id: 'codex-config', label: '沿用本机 Codex 的模型配置（例如 DeepSeek 跑在 Codex 壳子里）' },
  { id: 'openai', label: 'OpenAI 兼容接口（OpenAI / DeepSeek / vLLM / LM Studio…）' },
  { id: 'anthropic', label: 'Anthropic（Claude）' },
  { id: 'ollama', label: '本地模型（Ollama）' },
];

/** 纯函数：卡片骨架。 */
export function renderCard(agent = {}) {
  const p = { provider: 'codex-cli', enabled: true, base_url: '', model: '', has_key: false, ready: true, why: '', label: '本机 Codex CLI', ...agent };
  const opts = PROVIDER_OPTIONS.map((o) => `<option value="${o.id}" ${p.provider === o.id ? 'selected' : ''}>${esc(o.label)}</option>`).join('');
  const isCli = p.provider === 'codex-cli';
  const isLocal = p.provider === 'codex-config';
  const local = p.local || {};
  const localLine = isLocal
    ? (local.found
      ? `<div class="dim" style="margin-bottom:10px">
          在你这台机器上读到：<b>${esc(local.name || local.id)}</b> · 模型 <b>${esc(local.model || '（未写）')}</b>
          · 接口 ${esc(String(local.wire_api || '').toUpperCase())}${local.local ? '（本机地址）' : ''}
          · 令牌 ${local.has_token ? esc(local.token_masked) : '（没读到）'}
          <div style="margin-top:4px">地址与令牌<b>只在每次调用时</b>从 <code>~/.codex/config.toml</code> 读取，不会复制到本应用里。</div>
         </div>`
      : `<div class="dim" style="margin-bottom:10px;color:var(--red)">
           没有读到本机 Codex 配置（~/.codex/config.toml）。如果 Codex 自己能正常对话，请确认配置文件在这个位置。
         </div>`)
    : '';
  return `
    <div class="card mt" id="agent-connect">
      <h3>🤖 Agent / 模型接入 <span class="muted">决定"谁帮你判断与干活"</span></h3>
      <div class="dim" style="margin-bottom:10px">
        默认用本机的 Codex CLI（什么都不用配）。如果你只有一个 API Key，或想用本地模型，
        在这里换一个 provider 即可 —— 语义筛选、答疑这类要动脑的功能会走它。
      </div>
      <div class="dim" style="margin-bottom:10px">
        小提示：如果 Codex 里换成别的模型（例如 DeepSeek）在用，但本机没有 <code>codex</code> 命令行，
        选上面第二项「沿用本机 Codex 的模型配置」，它会直接复用那份配置 —— <b>不用再粘一次 Key</b>。
      </div>
      ${localLine}
      <div class="between" style="flex-wrap:wrap;gap:12px;margin-bottom:10px">
        <label class="dim">provider
          <select id="ag-provider" style="width:auto;margin-left:6px">${opts}</select>
        </label>
        <label class="dim" style="display:flex;align-items:center;gap:6px">
          <input type="checkbox" id="ag-enabled" ${p.enabled ? 'checked' : ''} style="width:auto" /> 启用
        </label>
        <span class="dim">当前：${esc(p.label)}${p.ready ? '' : `（${esc(p.why)}）`}</span>
      </div>
      <div id="ag-fields" ${isCli || isLocal ? 'style="display:none"' : ''}>
        <div class="field"><label>接口地址（base URL）</label>
          <input id="ag-base" value="${esc(p.base_url)}" placeholder="例如 https://api.openai.com/v1 或 http://127.0.0.1:11434" /></div>
        <div class="field"><label>模型名</label>
          <input id="ag-model" value="${esc(p.model)}" placeholder="例如 gpt-4o-mini / claude-3-5-haiku-latest / qwen2.5:7b" /></div>
        <div class="field"><label>API Key（本机地址可留空）</label>
          <input type="password" id="ag-key" value="${esc(p.api_key || '')}" placeholder="粘贴服务商给的 Key" /></div>
      </div>
      <div style="display:flex;gap:8px;flex-wrap:wrap;margin-top:6px">
        <button class="btn small" id="ag-test">测试</button>
        <button class="btn primary small" id="ag-save">保存</button>
        <span class="dim" id="ag-result" style="align-self:center"></span>
      </div>
    </div>`;
}

export async function mount(el, ctx = {}) {
  const { api, toast = () => {}, refresh = async () => {}, DB = {} } = ctx;
  const agent = DB.agent || {};

  const val = (sel) => { const n = el.querySelector(sel); return n ? n.value : ''; };
  const chk = (sel) => { const n = el.querySelector(sel); return n ? n.checked : false; };
  const show = (text, ok) => {
    const box = el.querySelector('#ag-result');
    if (box) box.innerHTML = `<span style="color:${ok ? 'var(--green, #3ecf8e)' : 'var(--red, #ff6b6b)'}">${esc(text)}</span>`;
  };

  const paint = () => {
    el.innerHTML = renderCard(agent);
    const sel = el.querySelector('#ag-provider');
    if (sel) sel.onchange = () => {
      // 「本机 Codex CLI」和「沿用本机 Codex 配置」这两种都不用手填地址/Key
      const noFields = sel.value === 'codex-cli' || sel.value === 'codex-config';
      const box = el.querySelector('#ag-fields');
      if (box) box.style.display = noFields ? 'none' : '';
    };
    const save = el.querySelector('#ag-save');
    if (save) save.onclick = async () => {
      await api('POST', '/api/agent', {
        provider: val('#ag-provider'),
        enabled: chk('#ag-enabled'),
        base_url: val('#ag-base'),
        model: val('#ag-model'),
        api_key: val('#ag-key'),
      });
      await refresh();
      toast('模型接入设置已保存（Key 会加密存盘）', 'green');
    };
    const test = el.querySelector('#ag-test');
    if (test) test.onclick = async () => {
      test.textContent = '测试中…';
      show('正在真的发一句话给模型…', true);
      try {
        // 先保存再测，保证测的就是界面上这套配置
        await api('POST', '/api/agent', {
          provider: val('#ag-provider'),
          enabled: chk('#ag-enabled'),
          base_url: val('#ag-base'),
          model: val('#ag-model'),
          api_key: val('#ag-key'),
        });
        const r = await api('POST', '/api/agent/test', {});
        show(r.message || (r.ok ? '可用' : '不可用'), r.ok);
      } catch (e) {
        show('测试失败：' + e.message, false);
      }
      test.textContent = '测试';
    };
  };

  paint();
  return { rerender: paint };
}
