// dashboard-cards.js —— 首页卡片：渲染 + 把原生面板搬进来 + 自由添加 / 换位 / 改宽 / 删除（改造项 3）。
//
// 三条必须记住的教训（前两条都踩过）：
//   1. **只用页面已有的组件与主题令牌**（.card/.list-item，--panel/--line2/--green…），
//      自造样式在别的主题下会非常突兀。
//   2. **观察器不能触发自己**——第一版观察 #main 的 subtree，而重画又写 #main 内部，
//      于是自己触发自己，卡片每 300ms 重画一次 = 狂闪。现在：只在 needsRepair() 为真时
//      才动手，且动手之后一定收敛（画完还不对就熔断，宁可退回老版面也不再重画）。
//   3. **原生面板是"搬"进来的**：搬的是 app.js 画好的**同一个 DOM 节点**（不是复制），
//      所以里面的按钮、事件、数据绑定全都还在。重画时只清掉自己生成的那些节点
//      （[data-dash-gen]），**绝不清空整个网格**，否则会把搬进来的面板一起抹掉。
//
// 摘掉的方式：删掉 index.html 里那一行 <script>，其余一切照旧（首页退回原来的老版面）。
(function () {
  var HOST_ID = 'dash-cards';
  var SPAN = { sm: 2, md: 3, lg: 6 };   // 6 列网格上的跨度：1/3 · 1/2 · 整行
  var LEVEL_COLOR = {
    ok: 'var(--green)', warn: 'var(--yellow)', error: 'var(--red)', info: 'var(--accent)', muted: 'var(--muted)',
  };
  var last = null;
  var types = [];
  var scheduled = false;
  var paintTimes = [];

  // 唯一自加的样式：网格列数、等级→已有颜色令牌，工具条与按钮只在悬停时出现（平时不打扰）。
  //
  // 布局是 **窄屏优先** 写的，别改回"桌面优先 + max-width 覆盖"：
  //   ① 基础（窄屏）：一列，卡片不设跨度 —— 任何情况下都不会被挤成一条缝；
  //   ② 宽屏（≥1101px）：6 列，才分得出 1/3（sm）、1/2（md）、整行（lg）三档。
  // 为什么不能用 `@media (max-width:1100px){.card{grid-column:1/-1}}` 反着写：
  // 那个选择器比 `.card.dash-sm` **少一个类**，权重不够，覆盖不掉跨度
  // （2026-10-02 实测：窄窗口下卡片被挤成 41px，就是踩了这个）。
  var css = document.createElement('style');
  css.textContent =
    // minmax(0,1fr) 不是可选写法：1fr 的最小值是"内容最小宽度"，一张长内容的卡会把整列撑歪。
    '#' + HOST_ID + '{display:grid;gap:16px;grid-template-columns:minmax(0,1fr);margin:0 0 20px}'
    + '#' + HOST_ID + ' .card{min-width:0}'
    + '@media (min-width:1101px){'
    + '#' + HOST_ID + '{grid-template-columns:repeat(6,minmax(0,1fr))}'
    + '#' + HOST_ID + ' .card.dash-sm{grid-column:span 2}'
    + '#' + HOST_ID + ' .card.dash-md{grid-column:span 3}'
    + '#' + HOST_ID + ' .card.dash-lg{grid-column:span 6}'
    + '}'
    + '#' + HOST_ID + ' .dash-v{font-weight:600;font-variant-numeric:tabular-nums;margin-left:8px}'
    + '#' + HOST_ID + ' .dash-bar{grid-column:1/-1;display:flex;gap:8px;align-items:center;opacity:0;transition:opacity .15s}'
    + '#' + HOST_ID + ':hover .dash-bar{opacity:1}'
    + '#' + HOST_ID + ' .dash-acts{display:flex;gap:4px;margin-left:auto;opacity:0;transition:opacity .15s}'
    + '#' + HOST_ID + ' .card:hover .dash-acts{opacity:1}'
    + '#' + HOST_ID + ' .dash-head{display:flex;align-items:center;gap:8px}'
    + '#' + HOST_ID + ' .dash-acts .btn{padding:2px 7px;font-size:12px;line-height:1.4}'
    + '#' + HOST_ID + ' .dash-sel{background:var(--panel2);color:var(--text);border:1px solid var(--line2);border-radius:6px;padding:4px 8px;font-size:12px}';
  document.head.appendChild(css);

  function el(tag, cls, text) {
    var n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text != null) n.textContent = text;
    return n;
  }

  function ensure() {
    var view = document.getElementById('view-today');
    if (!view) return null;
    var h = document.getElementById(HOST_ID);
    if (!h || h.parentNode !== view) {
      h = el('section');
      h.id = HOST_ID;
      view.insertBefore(h, view.firstChild);
    }
    return h;
  }

  // ---------------- 原生面板：认出来 → 搬进网格 ----------------

  /** 宽度：只换 dash-sm/md/lg 这一个类，别的类（card / student-card…）都留着。 */
  function setWidth(node, size) {
    var cls = String(node.className || '')
      .replace(/\bdash-(sm|md|lg)\b/g, '')
      .replace(/(^|\s)mt(\s|$)/g, ' ');
    node.className = (cls.replace(/\s+/g, ' ').replace(/^[\s]+|[\s]+$/g, '') + ' dash-' + (SPAN[size] ? size : 'md')).replace(/^[\s]+/, '');
    return node;
  }

  // 面板 id → 标题来自 /api/dashboard/available 的 kind==='native' 那一批（唯一真相源在后端），
  // 前端只拿标题去比对 app.js 画出来的 <h3> 文字。唯一硬编码的是学生卡：它的头部不是 h3。

  function nativeTypes() {
    return types.filter(function (t) { return t.kind === 'native'; });
  }

  /** 卡片自己的表头（原生面板的按钮就挂这儿）：优先 h3，其次学生卡的 .sc-head。 */
  function headerOf(card) {
    var kids = card.children || [];
    for (var i = 0; i < kids.length; i++) {
      var t = String(kids[i].tagName || '').toLowerCase();
      if (t === 'h3') return kids[i];
    }
    for (var j = 0; j < kids.length; j++) {
      if (String(kids[j].className || '').indexOf('sc-head') >= 0) return kids[j];
    }
    return null;
  }

  /** 这张卡片对应哪个原生面板？不是就返回 ''。 */
  function identify(node) {
    var tagged = node.getAttribute && node.getAttribute('data-panel');
    if (tagged) return tagged;
    if (node.id === 'student-card') return 'student';
    var head = headerOf(node);
    var text = head ? String(head.textContent || '').replace(/^\s+/, '') : '';
    if (!text) return '';
    var list = nativeTypes();
    for (var i = 0; i < list.length; i++) {
      if (list[i].id !== 'student' && text.indexOf(list[i].title) === 0) return list[i].id;
    }
    return '';
  }

  /** 找某张原生面板现在在页面上的那个节点（搬过一次之后就带 data-panel 标记）。 */
  function panelNode(view, host, cardId) {
    var tagged = view.querySelector('[data-panel="' + cardId + '"]');
    if (tagged) return tagged;
    var cards = view.querySelectorAll('.card');
    for (var i = 0; i < cards.length; i++) {
      var n = cards[i];
      if (host.contains(n)) continue;      // 自己画的那些卡不算
      if (n.getAttribute('data-panel')) continue;
      if (identify(n) === cardId) return n;
    }
    return null;
  }

  /** 首页上还有没有被漏在外面、或该走还没走的原生面板。 */
  function strayPanel(view, host) {
    var cards = view.querySelectorAll('.card');
    for (var i = 0; i < cards.length; i++) {
      var n = cards[i];
      if (host.contains(n)) continue;
      if (identify(n)) return n;
    }
    return null;
  }

  /** 卡片区是不是"确实需要修"：视图换过、被 renderToday 重建冲掉，或者原生面板没搬进来。 */
  function needsRepair() {
    var view = document.getElementById('view-today');
    if (!view || !last) return false;
    var h = document.getElementById(HOST_ID);
    if (!h || h.parentNode !== view) return true;
    return !!strayPanel(view, h);
  }

  // ---------------- 画 ----------------

  /** 改完卡片后把新状态直接套用，不再多打一次网络请求 */
  function apply(json) {
    if (json && json.dashboard) { last = json.dashboard; paint(); }
    else load();
  }

  function api(path, body) {
    return fetch(path, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body || {}),
    }).then(function (r) { return r.json(); });
  }

  function act(id, action, body) {
    return api('/api/dashboard/cards/' + encodeURIComponent(id) + '/' + action, body).then(apply);
  }

  function bar() {
    var b = el('div', 'dash-bar');
    b.setAttribute('data-dash-gen', '1');
    b.appendChild(el('span', 'muted', '首页卡片'));
    var onPage = {};
    ((last && last.cards) || []).forEach(function (c) { onPage[c.card_id] = 1; });
    var pool = types.filter(function (t) { return !onPage[t.id]; });
    var sel = el('select', 'dash-sel');
    pool.forEach(function (t) { var o = el('option', null, t.title); o.value = t.id; sel.appendChild(o); });
    var sizeOf = function (id) {
      var hit = types.filter(function (t) { return t.id === id; })[0];
      return (hit && hit.size) || 'md';
    };
    var add = el('button', 'btn', '＋ 添加');
    if (!pool.length) {
      sel.disabled = true; add.disabled = true;
      sel.appendChild(el('option', null, '（都已经在首页上了）'));
    }
    add.onclick = function () {
      if (!sel.value) return;
      add.disabled = true;
      // 用这张卡**默认的宽度**加回来（数据源是 1/3，不要因为加回来就变成 1/2）
      api('/api/dashboard/cards', { card_id: sel.value, size: sizeOf(sel.value) })
        .then(apply)
        .then(function () { add.disabled = false; })
        .catch(function () { add.disabled = false; });
    };
    b.appendChild(sel);
    b.appendChild(add);
    return b;
  }

  /** ↑ ↓ ⤢ ✕ —— 生成的卡和搬进来的原生面板共用同一套。 */
  function acts(c, idx, total) {
    var box = el('span', 'dash-acts');
    var up = el('button', 'btn', '↑'); up.title = '上移';
    var down = el('button', 'btn', '↓'); down.title = '下移';
    var big = el('button', 'btn', c.size === 'lg' ? '⤡' : '⤢'); big.title = '切换宽度';
    var del = el('button', 'btn', '✕'); del.title = '从首页移除这张卡（随时能再加回来）';
    up.disabled = idx === 0;
    down.disabled = idx === total - 1;
    var on = function (btn, fn) {
      btn.onclick = function (ev) {
        if (ev && ev.stopPropagation) ev.stopPropagation();
        fn();
      };
    };
    on(up, function () { act(c.id, 'move', { delta: -1 }); });
    on(down, function () { act(c.id, 'move', { delta: 1 }); });
    on(big, function () { act(c.id, 'resize', { size: c.size === 'lg' ? 'md' : 'lg' }); });
    on(del, function () { act(c.id, 'remove'); });
    box.appendChild(up); box.appendChild(down); box.appendChild(big); box.appendChild(del);
    return box;
  }

  function card(c, idx, total) {
    var node = el('div', 'card');
    node.setAttribute('data-dash-gen', '1');
    var title = el('h3');
    title.appendChild(document.createTextNode(c.title || ''));
    if (c.note) title.appendChild(el('span', 'muted', c.note));
    title.appendChild(acts(c, idx, total));
    node.appendChild(title);

    (c.rows || []).forEach(function (r) {
      var li = el('div', 'list-item');
      var t = el('div', 'title', r.label);
      if (LEVEL_COLOR[r.level]) t.style.color = LEVEL_COLOR[r.level];
      li.appendChild(t);
      var meta = el('div', 'meta');
      meta.appendChild(document.createTextNode(r.value));
      if (r.meta) meta.appendChild(el('span', 'dash-v', r.meta));
      li.appendChild(meta);
      node.appendChild(li);
    });
    return node;
  }

  /** 给搬进来的原生面板挂上同一套按钮（每轮重建，免得越挂越多）。 */
  function dress(node, c, idx, total) {
    node.setAttribute('data-panel', c.card_id);
    var old = node.querySelector('.dash-acts');
    if (old && old.parentNode) old.parentNode.removeChild(old);
    var head = headerOf(node);
    if (!head) return;
    if (head.className.indexOf('dash-head') < 0) head.className = (head.className + ' dash-head').replace(/^\s+/, '');
    head.appendChild(acts(c, idx, total));
  }

  /** 按顺序摆好；**只挪位置不对的那几个**（整片重插会重放动画 = 看着像在闪）。 */
  function place(host, nodes) {
    var cur = Array.prototype.slice.call(host.children);
    var same = cur.length === nodes.length && nodes.every(function (n, i) { return cur[i] === n; });
    if (same) return;
    nodes.forEach(function (n, i) {
      if (host.children[i] !== n) host.insertBefore(n, host.children[i] || null);
    });
  }

  function paint() {
    var view = document.getElementById('view-today');
    if (!view || !last) return;
    var host = ensure();
    if (!host) return;

    // ① 只清掉"上一轮自己生成的"节点；搬进来的原生面板原地不动（它们本来就是 app.js 的）
    Array.prototype.slice.call(host.children).forEach(function (n) {
      if (n.getAttribute && n.getAttribute('data-dash-gen') === '1') host.removeChild(n);
    });

    // ② 逐张摆位：原生面板去页面上找它自己那个节点（找不到 = 这会儿还没有，比如非学生模式下的学生卡）
    var cards = (last.cards || []);
    var nodes = [bar()];
    var placed = [];
    cards.forEach(function (c, idx) {
      var node = c.kind === 'native' ? panelNode(view, host, c.card_id) : null;
      if (c.kind === 'native') {
        if (!node) return;
        dress(node, c, idx, cards.length);
        placed.push(node);
      } else {
        node = card(c, idx, cards.length);
      }
      nodes.push(setWidth(node, c.size));
    });

    // ③ 用户删掉的原生面板：把它的节点从首页拿走（下次 renderToday 还会画出来，所以每轮都要拿一次）
    var all = view.querySelectorAll('.card');
    for (var i = 0; i < all.length; i++) {
      var n = all[i];
      if (host.contains(n) || placed.indexOf(n) >= 0) continue;
      var id = identify(n);
      if (id && !cards.some(function (c) { return c.card_id === id; })) {
        if (n.parentNode) n.parentNode.removeChild(n);
      }
    }

    // ④ 摆好
    place(host, nodes);

    // ⑤ 空壳容器：原来包着那些卡的 .grid 现在空了，留着会在页面上留一道缝
    Array.prototype.slice.call(view.children).forEach(function (n) {
      if (n === host || n.id === 'student-card') return;
      if (String(n.className || '').indexOf('grid') < 0) return;
      if (!n.children || n.children.length) return;
      if (!String(n.textContent || '').replace(/\s+/g, '')) n.parentNode.removeChild(n);
    });

    if (paintTimes.length > 8) paintTimes.shift();
    paintTimes.push(Date.now());
  }

  /** 短时间连着画太多次 = 大概率在自激（正是"狂闪"那种毛病）：停手，让页面停在当前样子。 */
  function runaway() {
    return paintTimes.length >= 8 && (Date.now() - paintTimes[0]) < 800;
  }

  var toJson = function (r) { return r.ok ? r.json() : null; };
  var noJson = function () { return null; };

  function load() {
    // 两份一起取：卡片清单 + 原生面板的标题（认面板要用）。
    // 拿不到就安静地不显示 / 不搬 —— 首页退回老样子，绝不因为"锦上添花"的东西白屏。
    return Promise.all([
      fetch('/api/dashboard', { cache: 'no-store' }).then(toJson, noJson),
      fetch('/api/dashboard/available', { cache: 'no-store' }).then(toJson, noJson),
    ])
      .then(function (r) {
        var changed = true;
        if (r[1] && r[1].types) types = r[1].types;
        if (r[0] && r[0].cards) {
          changed = !last || JSON.stringify(last.cards) !== JSON.stringify(r[0].cards);
          last = r[0];
        }
        if (last && (changed || needsRepair())) paint();
      });
  }

  function scheduleRepair() {
    if (scheduled) return;
    scheduled = true;
    // 微任务里修：赶在浏览器这一帧画出来之前，面板不会先在老位置闪一下
    var run = function () {
      scheduled = false;
      if (runaway() || !needsRepair()) return;
      paint();
    };
    if (typeof queueMicrotask === 'function') queueMicrotask(run);
    else setTimeout(run, 0);
  }

  function start() {
    load();
    var main = document.getElementById('main');
    if (main && window.MutationObserver) {
      new MutationObserver(function () {
        // 只处理"确实需要修"这一种情况；画完就收敛（paint 自己造成的改动不会再触发一次 paint）
        if (needsRepair()) scheduleRepair();
      }).observe(main, { childList: true, subtree: true });
    }
    setInterval(function () { if (!document.hidden) load(); }, 60000);
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start);
  else start();
})();
