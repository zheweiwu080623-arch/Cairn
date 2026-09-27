// 模块：上课前检查（preclass-card）—— 挂在「今日」页，给"上课前 30 分钟查 Canvas"一个看得见的地方。
//
// 与其他模块同一套：renderCard() 是纯函数（可测），mount() 负责交互。
// 它只读写 `/api/preclass`（设置 + 接下来要上的课 + 上次结果），手动试跑走 `POST /api/modules/preclass-check/run`。

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (m) => ({
  '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
}[m]));

/** 一节课一行：还有几分钟 + 这节课查过没有。 */
export function renderSession(s = {}) {
  const mins = Number(s.minutesLeft);
  const tag = s.checked ? '<span class="pill status">已查</span>' : '<span class="pill pending">待查</span>';
  return `
    <div class="list-item">
      ${tag}
      <div class="title">${esc(s.courseCode || '')} · ${esc(s.courseName || '')}</div>
      <div class="meta">${Number.isFinite(mins) ? `${mins} 分钟后上课` : '即将上课'}${s.location ? ` · @${esc(s.location)}` : ''}</div>
    </div>`;
}

/** 整张卡（纯函数）。 */
export function renderCard(payload = {}) {
  const prefs = payload.prefs || {};
  const upcoming = Array.isArray(payload.upcoming) ? payload.upcoming : [];
  const last = payload.last || null;
  const lastLine = last
    ? `上次运行：${esc(last.at ? String(last.at).slice(11, 16) : '')} · ${esc(last.summary || '')}`
    : '还没有跑过（到点会自动跑）';

  return `
    <div class="card mt" id="preclass-card">
      <div class="between" style="flex-wrap:wrap;gap:8px">
        <h3 style="margin:0">⏱️ 上课前检查 <span class="muted">快上课时自动看一眼这门课的 Canvas</span></h3>
        <span class="dim">${prefs.enabled ? '已开启' : '已关闭'} · 提前 ${esc(prefs.lead_minutes ?? 30)} 分钟</span>
      </div>
      <div class="dim" style="margin-top:6px">
        只查**这一门课**的文件 / 页面 / 公告 / 作业 / 小测（只读），只报新出现的；没有新东西就不打扰你。
      </div>

      ${upcoming.length
    ? upcoming.map(renderSession).join('')
    : '<div class="empty">接下来没有马上要上的课。到点它会自动检查，有新东西才提醒你。</div>'}

      <div class="flex" style="gap:10px;flex-wrap:wrap;margin-top:10px;align-items:center">
        <label class="dim" style="display:flex;align-items:center;gap:6px">
          提前 <input type="number" id="pc-lead" min="5" max="180" value="${esc(prefs.lead_minutes ?? 30)}" style="width:70px" /> 分钟
        </label>
        <label class="dim" style="display:flex;align-items:center;gap:6px">
          <input type="checkbox" id="pc-enabled" ${prefs.enabled ? 'checked' : ''} style="width:auto" />启用
        </label>
        <label class="dim" style="display:flex;align-items:center;gap:6px">
          <input type="checkbox" id="pc-notify" ${prefs.notify_in_app ? 'checked' : ''} style="width:auto" />进通知
        </label>
        <label class="dim" style="display:flex;align-items:center;gap:6px">
          <input type="checkbox" id="pc-bark" ${prefs.bark ? 'checked' : ''} style="width:auto" />推手机（只发一句话）
        </label>
        <label class="dim" style="display:flex;align-items:center;gap:6px">
          只看最近 <input type="number" id="pc-since" min="1" max="336" value="${esc(prefs.since_hours ?? 48)}" style="width:70px" /> 小时
        </label>
        <button class="btn small primary" id="pc-save">保存</button>
        <button class="btn small" id="pc-dry">试一次（演练）</button>
        <button class="btn small" id="pc-run">现在真查一次</button>
        <span class="dim" id="pc-status" style="align-self:center"></span>
      </div>
      <div class="dim" style="margin-top:6px">${lastLine}</div>
      <pre id="pc-result" class="dim" style="display:none;white-space:pre-wrap;max-height:200px;overflow:auto;margin-top:6px"></pre>
    </div>`;
}

export async function mount(el, ctx = {}) {
  const { api, toast = () => {} } = ctx;
  let payload = {};
  const draw = () => { el.innerHTML = renderCard(payload); bind(); };
  const status = (t) => { const s = el.querySelector('#pc-status'); if (s) s.textContent = t || ''; };
  const showResult = (text) => {
    const pre = el.querySelector('#pc-result');
    if (pre) { pre.textContent = text; pre.style.display = ''; }
  };

  async function load() {
    try { payload = await api('GET', '/api/preclass'); } catch { el.innerHTML = ''; return; }
    draw();
  }

  function bind() {
    const val = (sel, d) => { const n = el.querySelector(sel); const v = Number(n && n.value); return Number.isFinite(v) ? v : d; };
    const chk = (sel) => { const n = el.querySelector(sel); return !!(n && n.checked); };

    const save = el.querySelector('#pc-save');
    if (save) save.onclick = async () => {
      status('保存中…');
      try {
        payload = await api('POST', '/api/preclass', {
          prefs: {
            enabled: chk('#pc-enabled'), lead_minutes: val('#pc-lead', 30),
            notify_in_app: chk('#pc-notify'), bark: chk('#pc-bark'), since_hours: val('#pc-since', 48),
          },
        });
        draw();
        toast('上课前检查的设置已保存', 'green');
      } catch (e) { toast('保存失败：' + e.message, 'red'); status(''); }
    };

    const runOnce = async (dryRun) => {
      status(dryRun ? '演练中…' : '检查中…（可能要几秒）');
      try {
        // 用"下一节要上的课"当输入；没有课就用第一条课表当样例
        const target = (payload.upcoming && payload.upcoming[0]) || null;
        const input = target ? { meta: { courseCode: target.courseCode, courseName: target.courseName, minutesLeft: target.minutesLeft, dateKey: target.dateKey, sinceMs: Date.now() - (payload.prefs?.since_hours || 48) * 3600000 } } : {};
        const r = await api('POST', '/api/modules/preclass-check/run', { dry_run: dryRun, input });
        status('');
        if (!r.ok) { showResult(`没跑成：${r.error || '未知原因'}`); return; }
        const lines = (r.actions || []).map((a) => `· ${a.type} ${a.status}：${a.summary}`);
        showResult(`${r.summary}\n${lines.join('\n') || '（没有产生动作 —— 说明没有新东西，或这门课查不到）'}`);
        await load();
      } catch (e) { status(''); showResult('试跑失败：' + e.message); }
    };
    const dry = el.querySelector('#pc-dry');
    if (dry) dry.onclick = () => runOnce(true);
    const real = el.querySelector('#pc-run');
    if (real) real.onclick = () => runOnce(false);
  }

  await load();
}
