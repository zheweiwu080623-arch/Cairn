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
        <span class="dim">提醒档位：</span>
        ${STEP_CHOICES.map((s) => `<label class="dim" style="display:flex;align-items:center;gap:4px">
          <input type="checkbox" class="ddl-step" data-ms="${s.ms}" ${steps.includes(s.ms) ? 'checked' : ''} style="width:auto" />${esc(s.label)}
        </label>`).join('')}
        <label class="dim" style="display:flex;align-items:center;gap:6px">
          <input type="checkbox" id="ddl-bark" ${prefs.bark ? 'checked' : ''} style="width:auto" />推手机（只发一句话）
        </label>
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
    const steps = () => [...el.querySelectorAll('.ddl-step')].filter((x) => x.checked).map((x) => Number(x.dataset.ms));
    const save = el.querySelector('#ddl-save');
    if (save) save.onclick = async () => {
      status('保存中…');
      try {
        payload = await api('POST', '/api/ddl', {
          prefs: {
            enabled: el.querySelector('#ddl-enabled').checked,
            bark: el.querySelector('#ddl-bark').checked,
            steps: steps(),
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
