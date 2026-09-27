// 模块：每日摘要预览 —— 一个最小的 gadget 示例（复制这个目录就能写你自己的模块）。

/** 纯函数：渲染卡片骨架（内容由 mount 里的按钮异步填充）。 */
export function renderCard(esc = (s) => String(s ?? '')) {
  return `
    <div class="card mt" id="digest-preview">
      <h3>📰 每日摘要预览 <span class="muted">和每天发到你手机的那份一样</span></h3>
      <div class="between" style="flex-wrap:wrap;gap:10px">
        <div class="dim">不用等邮件 —— 现在就能看到今天的安排、逾期项，以及被筛选拦下等你确认的条目。</div>
        <button class="btn small" id="dp-load">预览今日摘要</button>
      </div>
      <pre id="dp-body" class="dim" style="margin-top:10px;white-space:pre-wrap;max-height:340px;overflow:auto;display:none"></pre>
    </div>`;
}

export async function mount(el, ctx = {}) {
  const { api, toast = () => {} } = ctx;
  el.innerHTML = renderCard();
  const btn = el.querySelector('#dp-load');
  const body = el.querySelector('#dp-body');
  if (btn) btn.onclick = async () => {
    btn.textContent = '读取中…';
    try {
      // /api/mobile/today.txt 返回纯文本（就是每天发到手机的那份），所以直接取 text
      const res = await fetch('/api/mobile/today.txt');
      const text = await res.text();
      if (body) {
        body.textContent = text || '（摘要为空）';
        body.style.display = '';
      }
    } catch (e) {
      toast('摘要读取失败：' + e.message, 'red');
    }
    btn.textContent = '预览今日摘要';
  };
  return { rerender: () => { el.innerHTML = renderCard(); } };
}
