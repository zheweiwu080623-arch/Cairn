// 模块：DDL 提醒（ddl-card）—— 挂在「任务」页。renderCard 是纯函数，mount 管交互。

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (m) => ({
  '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
}[m]));

/** 五档的复选清单（界面直接用这一份，别在别处再抄一遍档位）。 */
export const STEP_CHOICES = [
  { ms: 7 * 86400000, label: '剩 7 天' },
  { ms: 3 * 86400000, label: '剩 3 天' },
  { ms: 86400000, label: '剩 1 天' },
  { ms: 3 * 3600000, label: '剩 3 小时' },
  { ms: 30 * 60000, label: '剩 30 分钟' },
];

/** 一行"接下来什么时候叫"。 */
export function renderRow(u = {}) {
  const nx = u.next_step;
  const next = nx
    ? `${nx.label}（${String(nx.at).slice(5, 16).replace('T', ' ')}）${nx.sent ? ' · 已提醒' : ''}`
    : '这一档之后不会再提醒';
  return `<div class="list-item">
    <div class="title">${esc(u.title)}</div>
    <div class="meta">${esc(u.countdown || '')}${u.due_at ? ` · 截止 ${esc(String(u.due_at).slice(0, 16).replace('T', ' '))}` : ''}</div>
    <div class="meta">下一次提醒：${esc(next)}</div>
  </div>`;
}

/** 整张卡（纯函数）。 */
export function renderCard(payload = {}) {
  const prefs = payload.prefs || {};
  const steps = Array.isArray(prefs.steps) ? prefs.steps : [];
  const upcoming = Array.isArray(payload.upcoming) ? payload.upcoming : [];
  return `
    <div class="card mt" id="ddl-card">
      <div class="between" style="flex-wrap:wrap;gap:8px">
        <h3 style="margin:0">⏳ DDL 提醒 <span class="muted">到点就提醒，别真忘了</span></h3>
        <span class="dim">${prefs.enabled ? '已开启' : '已关闭'} · 已提醒 ${esc(payload.seen_count ?? 0)} 次</span>
      </div>
      <div class="dim" style="margin-top:6px">
        每一档只响一次；**做完的（状态=已完成）不再提醒**；电脑睡醒后 15 分钟内也会补上那一档。
      </div>

      <div class="flex" style="gap:12px;flex-wrap:wrap;margin-top:10px;align-items:center">
        <label class="dim" style="display:flex;align-items:center;gap:6px">
          <input type="checkbox" id="ddl-enabled" ${prefs.enabled ? 'checked' : ''} style="width:auto" />开启
        </label>
        <!-- 2026-09-28：档位与"推手机"这两个细项搬进页头那颗 ⚙（"谁的东西放谁的页面上"，
             卡片上只留一行指路，免得卡片越长越乱）-->
        <span class="dim">档位与"推手机"在右上角 <b>⚙ 功能设置</b> 里改 · 现在 ${steps.length || 0} 档${prefs.bark ? ' · 会推手机' : ''}</span>
        <button class="btn small primary" id="ddl-save">保存</button>
        <button class="btn small" id="ddl-check">试试现在会提醒什么</button>
        <span class="dim" id="ddl-status"></span>
      </div>
      <pre id="ddl-result" class="dim" style="display:none;white-space:pre-wrap;max-height:180px;overflow:auto;margin-top:8px"></pre>

      <details style="margin-top:10px" ${upcoming.length ? 'open' : ''}>
        <summary class="dim" style="cursor:pointer">接下来会被叫的任务（${upcoming.length} 个）</summary>
        <div style="margin-top:8px">
          ${upcoming.length ? upcoming.map(renderRow).join('') : '<div class="empty">现在没有带截止时间的待办。加了截止时间之后，这里会列出"下一次什么时候提醒"。</div>'}
        </div>
      </details>
    </div>`;
}

export async function mount(el, ctx = {}) {
  const { api, toast = () => {} } = ctx;
  let payload = {};
  const draw = () => { el.innerHTML = renderCard(payload); bind(); };
  const status = (t) => { const s = el.querySelector('#ddl-status'); if (s) s.textContent = t || ''; };
  const show = (t) => { const p = el.querySelector('#ddl-result'); if (p) { p.textContent = t; p.style.display = ''; } };

  async function load() {
    try { payload = await api('GET', '/api/ddl'); } catch { payload = {}; }
    draw();
  }

  function bind() {
    const save = el.querySelector('#ddl-save');
    if (save) save.onclick = async () => {
      status('保存中…');
      try {
        // 只改"开/关"，档位与推手机沿用当前值（它们在抽屉里改，别在这里被顺手清掉）
        payload = await api('POST', '/api/ddl', {
          prefs: {
            enabled: el.querySelector('#ddl-enabled').checked,
            bark: !!(payload.prefs && payload.prefs.bark),
            steps: (payload.prefs && payload.prefs.steps) || [],
          },
        });
        draw();
        toast('DDL 提醒设置已保存', 'green');
      } catch (e) { status(''); toast(`没保存上：${e.message || ''}`, 'red'); }
    };
    const check = el.querySelector('#ddl-check');
    if (check) check.onclick = async () => {
      status('检查中…');
      try {
        const r = await api('POST', '/api/ddl/check', {});
        status('');
        const lines = (r.items || []).map((i) => `· ${i.label}：${i.title}`);
        show(r.fired ? `${r.fired} 条提醒${r.pushed ? `（手机 ${r.pushed} 条）` : ''}\n${lines.join('\n')}`
          : `现在没有到档位的任务（${r.reason || ''}）`);
        await load();
      } catch (e) { status(''); show('失败：' + (e.message || '')); }
    };
  }

  await load();
}

// ---------------- 抽屉里的设置（页头 ⚙ 功能设置；2026-09-28） ----------------
/**
 * 抽屉内容（纯函数，方便测）：档位多选 + 推手机。
 * 卡片上不再重复写一遍这两项 —— 改一处就够，免得两边说法打架。
 */
export function renderSettings(state = {}) {
  const prefs = state.prefs || {};
  const steps = Array.isArray(prefs.steps) ? prefs.steps : [];
  return `<div class="fn-section-title">提醒档位</div>
    <div class="dim">到这些档位各提醒一次（每档只响一次，做完的不提醒）。一个都不勾 = 回到默认五档。</div>
    <div class="flex" style="gap:12px;flex-wrap:wrap;margin:10px 0">
      ${STEP_CHOICES.map((s) => `<label class="dim" style="display:flex;align-items:center;gap:5px">
        <input type="checkbox" class="ddl-set-step" data-ms="${s.ms}" ${steps.includes(s.ms) ? 'checked' : ''} style="width:auto" />${esc(s.label)}
      </label>`).join('')}
    </div>
    <div class="fn-section-title">要不要推手机</div>
    <label class="dim" style="display:flex;align-items:center;gap:6px">
      <input type="checkbox" id="ddl-set-bark" ${prefs.bark ? 'checked' : ''} style="width:auto" />推手机（Bark，只发一句话）
    </label>
    <div class="flex" style="gap:8px;align-items:center;margin-top:12px">
      <button class="btn small primary" id="ddl-set-save">保存</button>
      <span class="dim" id="ddl-set-note">${esc(state.note || '')}</span>
    </div>`;
}

export async function settings(host, ctx = {}) {
  const { api, toast = () => {}, reloadPage = () => {} } = ctx;
  const state = { prefs: {}, note: '' };
  const note = (t) => { state.note = t; const n = host.querySelector('#ddl-set-note'); if (n) n.textContent = t || ''; };
  const draw = () => { host.innerHTML = renderSettings(state); bind(); };

  async function load() {
    try {
      const r = await api('GET', '/api/ddl');
      state.prefs = (r && r.prefs) || {};
    } catch (e) {
      host.innerHTML = `<div class="empty">读不到设置：${esc((e && e.message) || '')}</div>`;
      return;
    }
    draw();
  }

  function bind() {
    const save = host.querySelector('#ddl-set-save');
    if (!save) return;
    save.onclick = async () => {
      const steps = [...host.querySelectorAll('.ddl-set-step')].filter((x) => x.checked).map((x) => Number(x.dataset.ms));
      const bark = !!(host.querySelector('#ddl-set-bark') || {}).checked;
      note('保存中…');
      try {
        // 开关沿用卡片上的当前值（这里只负责档位与推手机）
        const r = await api('POST', '/api/ddl', { prefs: { enabled: state.prefs.enabled !== false, bark, steps } });
        state.prefs = (r && r.prefs) || state.prefs;
        note(`已保存：${(state.prefs.steps || []).length} 档${state.prefs.bark ? ' · 推手机' : ''}`);
        toast('DDL 提醒的档位已保存', 'green');
        reloadPage('tasks');                       // 卡片上那行"现在 N 档"跟着变
      } catch (e) { note(''); toast(`没保存上：${e.message || ''}`, 'red'); }
    };
  }

  await load();
}
