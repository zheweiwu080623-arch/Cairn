// 模块：日报 / 晚报（daily-brief）—— 挂在「今日」页。
//
// 和其他模块同一套做法：导出**纯函数** renderCard() / applyAgentAdvice()（可测试）+ mount()（交互）。
// 分工：本文件只管"怎么显示"；"哪条重要"在 lib/priority.mjs、"摘要长什么样"在 lib/digest.mjs（服务端）。

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (m) => ({
  '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
}[m]));

export const KIND_LABEL = { morning: '早报', evening: '晚报' };

/** 把 agent 写的建议替换进摘要的【建议】一节（纯函数，便于测试）。 */
export function applyAgentAdvice(brief, text) {
  const src = String(text || '').trim();
  if (!brief || !src) return brief;
  const lines = String(brief.text || '').split('\n');
  const at = lines.findIndex((l) => l.trim() === '【建议】');
  if (at < 0) return { ...brief, advice_source: 'agent' };
  const tailAt = lines.findIndex((l, i) => i > at && l.startsWith('本摘要由'));
  const head = lines.slice(0, at + 1);
  const tail = tailAt >= 0 ? lines.slice(tailAt) : [];
  const body = src.split('\n')
    .map((l) => l.replace(/^[-*·]\s*/, '').trim())
    .filter(Boolean)
    .map((l) => `  · ${l}`);
  return {
    ...brief,
    advice_source: 'agent',
    advice: body.map((l) => ({ id: 'agent', level: 'info', text: l.trim().replace(/^·\s*/, '') })),
    text: [...head, ...body, '', ...tail].join('\n'),
  };
}

/** 纯函数：整张卡。 */
export function renderCard(brief = {}, { kind = 'morning', status = '' } = {}) {
  const k = KIND_LABEL[kind] ? kind : 'morning';
  const body = String(brief?.text || '').trim() || '（还没有内容，点「刷新」再试一次）';
  const source = brief?.advice_source === 'agent' ? 'agent 版建议' : '规则版建议';
  const counts = brief?.counts || {};

  return `
    <div class="card mt" id="daily-brief">
      <div class="between" style="flex-wrap:wrap;gap:8px">
        <h3 style="margin:0">🌅 日报 / 晚报 <span class="muted">最值得先看的几条 + 建议</span></h3>
        <span class="dim">${brief?.date ? esc(brief.date) : ''} ${brief?.weekday ? esc(brief.weekday) : ''} · ${source}</span>
      </div>
      <div class="dim" style="margin-top:6px">
        早报看今天、晚报看明天；排序和「重要信息」用的是同一套（按你的未来规划）。
        参考：重要 ${counts.high || 0} / 一般 ${counts.normal || 0} / 低 ${counts.low || 0} 条。
      </div>
      <div class="flex" style="gap:8px;margin:10px 0;flex-wrap:wrap">
        <button class="btn small ${k === 'morning' ? 'primary' : ''}" id="db-morning">🌅 早报</button>
        <button class="btn small ${k === 'evening' ? 'primary' : ''}" id="db-evening">🌙 晚报</button>
        <button class="btn small" id="db-load">刷新</button>
        <button class="btn small" id="db-push">推到手机</button>
        <button class="btn small" id="db-agent">让 agent 写建议</button>
        <span class="dim" id="db-status" style="align-self:center">${esc(status)}</span>
      </div>
      <pre id="db-body" class="dim" style="margin:0;white-space:pre-wrap;max-height:420px;overflow:auto">${esc(body)}</pre>
    </div>`;
}

/** 交互：拉摘要 → 画 → 绑定按钮。 */
export async function mount(el, ctx = {}) {
  const { api, toast = () => {}, refresh } = ctx;
  let kind = 'morning';
  let brief = {};
  let status = '';

  const draw = () => { el.innerHTML = renderCard(brief, { kind, status }); bind(); };
  const setStatus = (t) => { status = t || ''; const s = el.querySelector('#db-status'); if (s) s.textContent = status; };

  async function load(next) {
    if (next) kind = next;
    try {
      const r = await api('GET', `/api/digest?kind=${kind}`);
      brief = (r && r.brief) || {};
    } catch (e) {
      el.innerHTML = `<div class="card mt"><h3>🌅 日报 / 晚报</h3><div class="dim">加载失败：${esc(e.message)}</div></div>`;
      return;
    }
    draw();
  }

  function bind() {
    const on = (id, fn) => { const b = el.querySelector(id); if (b) b.onclick = fn; };

    on('#db-morning', () => load('morning'));
    on('#db-evening', () => load('evening'));
    on('#db-load', () => load().then(() => (refresh ? refresh() : null)).catch(() => {}));

    on('#db-push', async () => {
      setStatus('正在推…');
      try {
        const r = await api('POST', '/api/digest/push', { kind });
        if (r && r.ok) { toast('已推到手机', 'green'); setStatus('已推到手机'); }
        else { toast((r && r.error) || '推送没有成功', 'red'); setStatus((r && r.error) || '推送失败'); }
      } catch (e) {
        toast('推送失败：' + e.message, 'red');
        setStatus('推送失败');
      }
    });

    on('#db-agent', async () => {
      setStatus('正在让 agent 分析…（可能要几十秒）');
      try {
        const r = await api('POST', '/api/digest/advice', { kind });
        if (r && r.ok && r.text) {
          brief = applyAgentAdvice(brief, r.text);
          draw();
          setStatus('已换成 agent 版建议');
        } else {
          toast((r && (r.message || r.error)) || 'agent 没返回内容', 'red');
          setStatus('');
        }
      } catch (e) {
        toast('分析失败：' + e.message, 'red');
        setStatus('');
      }
    });
  }

  await load();
}
