// 模块：从这里开始（getting-started）—— 「用户入门的体验感」的落点，挂在「今日」页最上面。
//
// 三件事它做对了就算成功：
//   1) 新用户打开就能看到"接下来该干嘛"（四步，能跳过）；
//   2) 每一步的勾是**真实状态**推出来的（改过名字 / 配过数据源 / 模型能用），不是"点过就算"；
//   3) 老用户嫌烦可以「不再显示」，状态记在本机。
//
// 与其他模块同一套做法：导出纯函数 renderCard()（可测试）+ mount()（交互）。

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (m) => ({
  '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
}[m]));

const DOCS = {
  works: '/docs/HOW_IT_WORKS.md',
  sources: '/docs/CONNECT_SOURCES.md',
};

/** 单个步骤右边的"去做"区域（纯函数，测试直接查字符串）。 */
export function stepAction(step = {}, { appName = 'Cairn' } = {}) {
  const id = step.id;
  if (id === 'name') {
    return `
      <div class="flex" style="gap:8px;flex-wrap:wrap;align-items:center;margin-top:6px">
        <input type="text" id="gs-name" maxlength="24" placeholder="${esc(appName)}" value="${esc(step.done ? appName : '')}" style="width:220px" />
        <button class="btn small primary" id="gs-name-save">保存名字</button>
        <span class="dim">现在叫「${esc(appName)}」；留空恢复默认名 Cairn</span>
      </div>`;
  }
  if (id === 'source') {
    return `
      <div class="flex" style="gap:8px;flex-wrap:wrap;margin-top:6px">
        <button class="btn small primary" data-gs-nav="connectors">去「数据源」页</button>
        <a class="btn small" href="${DOCS.sources}" target="_blank" rel="noreferrer">看《数据源配置教程》</a>
        <span class="dim">RSS / 日历订阅只要一个网址，不用账号</span>
      </div>`;
  }
  if (id === 'agent') {
    return `
      <div class="flex" style="gap:8px;flex-wrap:wrap;margin-top:6px">
        <button class="btn small" data-gs-nav="connectors">去「数据源 → Agent 接入」</button>
        <span class="dim">可选：不接也能用（排序 / 筛选 / 日报都是本机算的）</span>
      </div>`;
  }
  if (id === 'docs') {
    return `
      <div class="flex" style="gap:8px;flex-wrap:wrap;margin-top:6px">
        <a class="btn small" href="${DOCS.works}" target="_blank" rel="noreferrer">打开《它是怎么运作的》</a>
        <button class="btn small" id="gs-docs-done">我看过了</button>
      </div>`;
  }
  return '';
}

/** 整张卡。返回空串 = 这一版不显示（看完了 / 点了"不再显示"）。 */
export function renderCard(payload = {}) {
  const on = payload.onboarding || {};
  const sum = on.summary || {};
  const steps = Array.isArray(on.steps) ? on.steps : [];
  if (!sum.show || !steps.length) return '';
  const appName = (payload.brand && payload.brand.app_name) || 'Cairn';
  const nextTitle = sum.next ? sum.next.title : '';

  return `
    <div class="card mt" id="getting-started">
      <div class="between" style="flex-wrap:wrap;gap:8px">
        <h3 style="margin:0">🚀 从这里开始 <span class="muted">第一次用只要四步，都可以跳过</span></h3>
        <span class="dim">完成 ${esc(sum.required_done)}/${esc(sum.required_total)}${nextTitle ? ` · 建议下一步：${esc(nextTitle)}` : ''}</span>
      </div>
      ${steps.map((s) => `
        <div class="list-item" style="align-items:flex-start">
          <span class="pill ${s.done ? 'status' : 'pending'}">${s.done ? '✓ 完成' : '待做'}</span>
          <div class="title">${s.icon || '•'} ${esc(s.title)}${s.optional ? '（可选）' : ''}
            ${s.auto ? '<span class="dim">· 已自动检测到</span>' : ''}
          </div>
          <div class="meta">${esc(s.hint || '')}</div>
          ${s.done ? '' : stepAction(s, { appName })}
        </div>`).join('')}
      <div class="flex" style="gap:10px;flex-wrap:wrap;margin-top:10px">
        <button class="btn small" id="gs-dismiss">不再显示（以后在「数据源」页也能找到这些入口）</button>
        <span class="dim" id="gs-status" style="align-self:center"></span>
      </div>
    </div>`;
}

/** 交互：拉偏好 → 画 → 绑定按钮。 */
export async function mount(el, ctx = {}) {
  const { api, toast = () => {}, refresh, nav } = ctx;
  let prefs = {};

  const draw = () => {
    el.innerHTML = renderCard(prefs);
    if (!el.innerHTML) return;
    bind();
  };

  const status = (t) => { const s = el.querySelector('#gs-status'); if (s) s.textContent = t || ''; };

  async function load() {
    try {
      prefs = await api('GET', '/api/prefs');
    } catch {
      el.innerHTML = '';   // 入门卡拿不到偏好时安静消失，不打扰主界面
      return;
    }
    draw();
  }

  function bind() {
    // 「去数据源」之类：交给外壳切页；没有 nav（老版本）就提示一下
    el.querySelectorAll?.('[data-gs-nav]').forEach((b) => {
      b.onclick = () => {
        if (typeof nav === 'function') nav(b.dataset.gsNav);
        else toast('请点左侧「数据源」页', 'red');
      };
    });

    const nameSave = el.querySelector('#gs-name-save');
    if (nameSave) nameSave.onclick = async () => {
      const input = el.querySelector('#gs-name');
      const value = input ? input.value : '';
      try {
        prefs = await api('POST', '/api/prefs', { app_name: value });
        toast(value.trim() ? `名字已改成「${prefs.brand.app_name}」` : '已恢复默认名 Cairn', 'green');
        if (refresh) await refresh();
        draw();
      } catch (e) { toast('改名失败：' + e.message, 'red'); }
    };

    const docsDone = el.querySelector('#gs-docs-done');
    if (docsDone) docsDone.onclick = async () => {
      try {
        prefs = await api('POST', '/api/prefs', { onboarding: { done: { docs: true } } });
        draw();
      } catch (e) { toast('保存失败：' + e.message, 'red'); }
    };

    const dismiss = el.querySelector('#gs-dismiss');
    if (dismiss) dismiss.onclick = async () => {
      status('正在收起…');
      try {
        prefs = await api('POST', '/api/prefs', { onboarding: { dismissed: true } });
        el.innerHTML = '';
      } catch (e) { toast('收起失败：' + e.message, 'red'); status(''); }
    };
  }

  await load();
}
