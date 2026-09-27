// 模块：重要信息（priority-feed）—— 挂在「今日」页顶部。
//
// 与其他模块同一套做法：导出**纯函数** renderCard()/renderGoals()（可测试）+ mount()（交互）。
// 分工：本文件只管"怎么显示"；"怎么算重要性"在 lib/priority.mjs（服务端），
// 这样换界面（原生外壳 / 邮件 / Markdown）时用的是同一套排序结果。

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (m) => ({
  '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
}[m]));

const BAND_LABEL = { high: '重要', normal: '一般', low: '低' };
const BAND_CLS = { high: 'p0', normal: 'pending', low: 'off' };
const LEVEL_CLS = { high: 'p0', warn: 'pending', info: 'status' };

/** 时间戳 → "MM-DD HH:MM"（本地时间；空值或坏值给空串）。 */
function shortTime(iso) {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  const p = (n) => String(n).padStart(2, '0');
  return `${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

/** 时间那一列：有几天说几天，过期就说"已过期"。 */
export function whenLabel(item) {
  if (item.daysLeft === null || item.daysLeft === undefined) return '无时间';
  if (item.daysLeft < 0) return '已过期';
  if (item.daysLeft === 0) return '今天';
  if (item.daysLeft === 1) return '明天';
  return `${item.daysLeft} 天后`;
}

/** 一条信息一行。 */
export function renderItem(item) {
  const cls = BAND_CLS[item.band] || 'off';
  return `
    <div class="list-item">
      <span class="pill ${cls}">${BAND_LABEL[item.band] || item.band} ${item.importance}</span>
      <div class="title">${esc(item.title)}</div>
      <div class="meta">${whenLabel(item)} · ${esc(item.source || '')} · ${esc(item.why || '')}</div>
    </div>`;
}

/** 建议列表。 */
export function renderAdvice(advice = [], { source = 'rules' } = {}) {
  if (!advice.length) return '';
  return `
    <div style="margin:12px 0 4px">
      ${advice.map((a) => `<div class="dim" style="margin:4px 0">
        <span class="pill ${LEVEL_CLS[a.level] || ''}">${a.level === 'high' ? '要紧' : a.level === 'warn' ? '注意' : '提示'}</span>
        ${esc(a.text)}
      </div>`).join('')}
      <div class="dim" style="font-size:12px;margin-top:6px">
        ${source === 'agent' ? '以上由你的 agent 基于同一份数据写出的建议。' : '以上是规则版建议（不联网、随时可用）。'}
      </div>
    </div>`;
}

/** 「我的未来规划」编辑区。 */
export function renderGoals(goals = []) {
  return `
    <div style="margin-top:12px">
      <div class="dim" style="margin-bottom:6px">
        我的未来规划（一行一条，会参与上面的重要性判断，例如"11 月要考托福"）
      </div>
      <textarea id="pf-goals" rows="${Math.max(2, Math.min(6, goals.length + 1))}"
        style="width:100%;font-family:inherit"
        placeholder="11 月要考托福&#10;这学期 GPA 上 3.8">${esc(goals.join('\n'))}</textarea>
      <div class="flex" style="gap:8px;margin-top:6px;flex-wrap:wrap">
        <button class="btn small primary" id="pf-save">保存规划</button>
        <button class="btn small" id="pf-agent">让 agent 分析</button>
        <button class="btn small" id="pf-refresh">刷新</button>
        <span class="dim" id="pf-status" style="align-self:center"></span>
      </div>
    </div>`;
}

/**
 * 「自动推送」开关（默认关）。
 * 这是把"重要信息"真的送到你面前的那一步：≥阈值的新信息会自己进通知 / 推手机。
 * 设置与预览都由服务端算好（`/api/priority` 的 `autopush` 字段），这里只负责显示与提交。
 */
export function renderAutopush(ap = {}) {
  const cfg = ap.cfg || {};
  const preview = Array.isArray(ap.preview) ? ap.preview : [];
  const last = ap.last || null;
  const describe = ap.describe || '';
  const previewText = preview.length
    ? `按当前设置，下一次会推 ${preview.length} 条：${preview.slice(0, 3).map((x) => `「${esc(x.title)}」`).join(' ')}`
    : '按当前设置，暂时没有需要自动推送的条目（没有 ≥ 阈值且未推过的信息）。';
  const lastText = last
    ? `${last.dry ? '上次预览' : '上次推送'} ${shortTime(last.at)} · ${last.dry ? `${last.count} 条候选` : `进通知 ${last.notified || 0} 条 / 推手机 ${last.pushed || 0} 条`}`
    : '还没有推送过';

  return `
    <div style="margin-top:14px;padding-top:10px;border-top:1px dashed var(--line, #3336)">
      <div class="dim" style="margin-bottom:6px">
        ⚡ <b>自动推送</b>（默认关）—— 打开后，达到阈值的「重要」信息会<b>自己</b>进通知 / 推手机，不用你来翻。
      </div>
      <div class="flex" style="gap:10px;flex-wrap:wrap;align-items:center">
        <label class="dim" style="display:flex;align-items:center;gap:6px">
          <input type="checkbox" id="pf-ap-enabled" ${cfg.enabled ? 'checked' : ''} style="width:auto" />启用自动推送
        </label>
        <label class="dim" style="display:flex;align-items:center;gap:6px">
          <input type="checkbox" id="pf-ap-notify" ${cfg.notify ? 'checked' : ''} style="width:auto" />进通知
        </label>
        <label class="dim" style="display:flex;align-items:center;gap:6px">
          <input type="checkbox" id="pf-ap-bark" ${cfg.bark ? 'checked' : ''} style="width:auto" />推手机
        </label>
        <label class="dim" style="display:flex;align-items:center;gap:6px">
          阈值 <input type="number" id="pf-ap-threshold" min="45" max="100" step="5" value="${esc(cfg.threshold ?? 70)}" style="width:72px" />
        </label>
        <label class="dim" style="display:flex;align-items:center;gap:6px">
          每次最多 <input type="number" id="pf-ap-max" min="1" max="10" value="${esc(cfg.max_per_run ?? 3)}" style="width:60px" /> 条
        </label>
        <button class="btn small primary" id="pf-ap-save">保存</button>
        <button class="btn small" id="pf-ap-run">现在跑一次</button>
      </div>
      <div class="dim" style="margin-top:6px">${esc(describe)}</div>
      <div class="dim" style="margin-top:4px">${previewText}</div>
      <div class="dim" style="margin-top:4px">${esc(lastText)}</div>
    </div>`;
}

/** 整张卡（纯函数，测试直接喂数据进来）。 */
export function renderCard(payload = {}) {
  const ctx = payload.context || {};
  const counts = payload.counts || { high: 0, normal: 0, low: 0 };
  const ranked = payload.ranked || [];
  const goals = ctx.goals || [];
  const upcoming = ctx.upcoming || [];
  const hasAnything = ranked.length > 0 || upcoming.length > 0 || goals.length > 0;

  return `
    <div class="card mt" id="priority-feed">
      <div class="between" style="flex-wrap:wrap;gap:8px">
        <h3 style="margin:0">🔥 重要信息 <span class="muted">按你的未来规划排序</span></h3>
        <span class="dim">
          ${counts.high} 条重要 · ${counts.normal} 条一般 · 参考 ${goals.length} 条规划 / ${upcoming.length} 项未来安排
        </span>
      </div>

      ${renderAdvice(payload.advice || [], { source: payload.advice_source })}

      ${ranked.length
    ? ranked.slice(0, 10).map(renderItem).join('')
    : `<div class="empty">暂时没有需要排优先级的信息。导入一个数据源后，这里会自动出现最重要的几条。</div>`}

      ${hasAnything ? '' : '<div class="dim" style="margin-top:8px">提示：先在上面写下你的规划，排序会更准。</div>'}

      ${renderGoals(goals)}

      ${renderAutopush(payload.autopush || {})}
    </div>`;
}

/** 交互：拉数据 → 画 → 绑定按钮。 */
export async function mount(el, ctx) {
  const { api, toast, refresh } = ctx;
  let payload = {};

  const draw = () => { el.innerHTML = renderCard(payload); bind(); };

  async function load() {
    try {
      payload = await api('GET', '/api/priority');
    } catch (e) {
      el.innerHTML = `<div class="card mt"><h3>🔥 重要信息</h3><div class="dim">加载失败：${esc(e.message)}</div></div>`;
      return;
    }
    draw();
  }

  function status(text) {
    const s = el.querySelector('#pf-status');
    if (s) s.textContent = text;
  }

  function bind() {
    const save = el.querySelector('#pf-save');
    if (save) {
      save.onclick = async () => {
        const raw = (el.querySelector('#pf-goals') || {}).value || '';
        const goals = raw.split('\n').map((x) => x.trim()).filter(Boolean);
        try {
          await api('POST', '/api/plan/goals', { goals });
          toast(`已保存 ${goals.length} 条规划`, 'green');
          await load();
        } catch (e) { toast('保存失败：' + e.message, 'red'); }
      };
    }

    const agent = el.querySelector('#pf-agent');
    if (agent) {
      agent.onclick = async () => {
        agent.disabled = true;
        status('正在让 agent 分析…（可能要几十秒）');
        try {
          const r = await api('POST', '/api/priority/advice', {});
          if (r.ok && r.text) {
            payload.advice = [{ id: 'agent', level: 'info', text: r.text }];
            payload.advice_source = 'agent';
            draw();
            status('');
          } else {
            toast(r.message || r.error || 'agent 没返回内容', 'red');
            status('');
          }
        } catch (e) {
          toast('分析失败：' + e.message, 'red');
          status('');
        } finally {
          const again = el.querySelector('#pf-agent');
          if (again) again.disabled = false;
        }
      };
    }

    const again = el.querySelector('#pf-refresh');
    if (again) again.onclick = () => { load().then(() => (refresh ? refresh() : null)).catch(() => {}); };

    // ---- 自动推送开关 ----
    const apSave = el.querySelector('#pf-ap-save');
    if (apSave) {
      apSave.onclick = async () => {
        const num = (sel, d) => { const n = el.querySelector(sel); const v = Number(n && n.value); return Number.isFinite(v) && v > 0 ? v : d; };
        const on = (sel) => { const n = el.querySelector(sel); return !!(n && n.checked); };
        try {
          const r = await api('POST', '/api/priority/autopush', {
            enabled: on('#pf-ap-enabled'),
            notify: on('#pf-ap-notify'),
            bark: on('#pf-ap-bark'),
            threshold: num('#pf-ap-threshold', 70),
            max_per_run: num('#pf-ap-max', 3),
          });
          payload.autopush = r;
          draw();
          toast(r.cfg && r.cfg.enabled ? '自动推送已开启' : '自动推送已关闭（默认就是不打扰）', 'green');
        } catch (e) { toast('保存失败：' + e.message, 'red'); }
      };
    }

    const apRun = el.querySelector('#pf-ap-run');
    if (apRun) {
      apRun.onclick = async () => {
        apRun.disabled = true;
        status('正在按当前设置跑一次…');
        try {
          const r = await api('POST', '/api/priority/autopush/run', {});
          if (r.ok) toast(r.dry ? `预览：${r.count} 条候选` : `已推送：进通知 ${r.notified} 条 / 推手机 ${r.pushed} 条`, 'green');
          else if (r.skipped === 'disabled') toast('自动推送还没打开：先勾上"启用"再保存', 'red');
          else if (r.skipped === 'no-channel') toast('至少要勾一个渠道（进通知 / 推手机）', 'red');
          else toast('这次没有可推送的内容', 'red');
        } catch (e) { toast('运行失败：' + e.message, 'red'); }
        status('');
        await load();
      };
    }
  }

  await load();
}
