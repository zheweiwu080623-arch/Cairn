// 模块：设置（settings）—— 一页收齐「数据源 / 外观 / 模式 / 功能 / 后台 / 开发」。
//
// 用户 2026-09-26 的要求（原话）：「真做设置页，把数据源、外观、模式选择、功能调整几个部分放进去，
// 删掉数据源部分整合到设置中去，并将设置放在现在的风格位置，用一个如上图标（齿轮），
// 光标放在此处显示设置的方式做好」。
//
// 两个实现上的取舍：
//   1) **数据源那一块是"寄存"**：原来的 `#view-connectors` 整块（含它的事件）被搬进来，
//      不再自己写一遍 —— 两套界面迟早会不一致；
//   2) 每个页签的"重活"都交给接口/宿主，这一页只负责显示与转发（和别的 view 模块一个规矩）。

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (m) => ({
  '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
}[m]));

/**
 * 实例 id → 类型（`rss@2` → `rss`）。
 * 约定与 `lib/connectors/instances.mjs` 一致；浏览器拿不到 /lib 下的文件
 * （静态表只服务 /modules 与 /public），所以这里留一份最小的。
 */
const instanceTypeOf = (id) => { const s = String(id || ''); const i = s.indexOf('@'); return i < 0 ? s : s.slice(0, i); };

export const TABS = [
  { id: 'sources', name: '数据源', note: '连接 · 导入' },
  // 2026-09-26 用户要求：分析偏好要能"随时改动"，所以从向导里的一份搬进设置页常驻。
  { id: 'profile', name: '分析偏好', note: '关心什么 · 打分' },
  // 2026-09-26 晚第二版（用户要求）：**不单独给学生开一页**（非学生也要用这个应用），
  // 把「是不是学生 / 主菜单怎么点 / 学期」都收进这一页「偏好」里。
  { id: 'prefs', name: '偏好', note: '学生模式 · 点击方式' },
  { id: 'look', name: '外观', note: '主题 · 名字' },
  { id: 'mode', name: '模式', note: '用户 / 开发者' },
  { id: 'features', name: '功能', note: '要哪些 · 什么顺序' },
  // 2026-09-28（P1「自定义补齐」）：以前壁纸目录 / 课程目录 / pdftotext 路径这些东西
  // 散在别处，或者干脆只能改配置文件、环境变量。收成这一页 —— 目录、可选外部工具、导出格式。
  { id: 'local', name: '本机', note: '目录 · 工具 · 导出' },
  { id: 'runtime', name: '后台', note: '服务 · 开机自启' },
];

export function tabsFor(payload = {}) {
  return TABS.filter((t) => !t.devOnly || payload.mode === 'dev');
}

/** 页签条（纯函数）。 */
export function renderTabs(payload = {}) {
  const cur = payload.tab || 'sources';
  // 2026-09-26 深夜（用户："做成大概这样的设置样貌"——照 Codex 设置页那样）：
  // 左边一列窄栏、按组分、每一项"图标 + 名字"小字；右边才是内容。
  const GROUPS = [
    { name: '数据', ids: ['sources'] },
    { name: '个人', ids: ['profile', 'prefs', 'look', 'features'] },
    { name: '系统', ids: ['mode', 'local', 'runtime'] },
    { name: '开发者', ids: ['dev'] },
  ];
  const tabs = tabsFor(payload);
  const item = (t) => `<button class="set-rail-item ${t.id === cur ? 'active' : ''}" data-set-tab="${t.id}" title="${esc(t.note || '')}">
      <span class="sri-ico">${esc(RAIL_ICON[t.id] || '•')}</span><span class="sri-name">${esc(t.name)}</span></button>`;
  return `<button class="set-rail-back" id="set-back-app">← 返回应用</button>
    ${GROUPS.map((g) => {
    const list = g.ids.map((id) => tabs.find((t) => t.id === id)).filter(Boolean);
    if (!list.length) return '';
    return `<div class="set-rail-group">${esc(g.name)}</div>${list.map(item).join('')}`;
  }).join('')}`;
}

/** 左栏每一项的小图标（照 Codex 设置页那种"图标 + 名字"的感觉，不占宽度）。 */
const RAIL_ICON = {
  sources: '🔌', profile: '🧭', prefs: '⚙️', look: '🎨',
  mode: '👤', features: '🧩', local: '📁', runtime: '🖥', dev: '🛠',
};

export function renderRuntime(payload = {}) {
  const h = payload.health || {};
  const up = h.uptime_sec ? `${Math.floor(h.uptime_sec / 3600)} 小时 ${Math.round((h.uptime_sec % 3600) / 60)} 分` : '—';
  const auto = (h.autostart || {}).enabled;
  const autoSupported = (h.autostart || {}).supported;
  // 每日开工（2026-09-27 补界面入口）：设置来自 GET /api/daily
  const daily = payload.daily || {};
  daily.prefs = daily.prefs || { enabled: true, at: '18:00', weekly: true, push: false };
  const last = daily.last || null;
  const dailyLine = `${last
    ? `上次开工：${String(last.date || '').slice(0, 10)}（${last.counts ? `${last.counts.overdue || 0} 逾期 / ${last.counts.today || 0} 今天 / ${last.counts.tomorrow || 0} 明天` : '已跑'}）`
    : '还没有开工过'}${daily.due && daily.due.ok ? ` · <b>今天还没开工</b>` : ' · 今天已经开过工'}`;
  return `<div class="card">
    <b>后台运行</b>
    <div class="dim">服务与看门狗都没在跑的时候，定时同步、DDL 提醒、每日开工都不会发生。</div>
    <div class="ob-row"><div style="flex:1">
      <div>后台服务 ${h.state === 'ok' ? '<span class="pill status">在跑</span>' : '<span class="pill pending">没在跑</span>'}</div>
      <div class="dim">pid ${esc(h.pid || '—')} · 已运行 ${esc(up)}</div>
    </div></div>
    <!-- 2026-09-26 深夜（用户要求）：开机自启的开关搬到「偏好」那一页了，这里只留状态 -->
    <div class="ob-row"><div style="flex:1">
      <div>开机自启 ${auto && autoSupported !== false
        ? '<span class="pill status">已开启</span>'
        : (autoSupported === false ? '<span class="pill pending">这个平台不支持</span>' : '<span class="pill pending">未开启</span>')}</div>
      <div class="dim">开关在「偏好」页里（和"是不是学生 / 主菜单怎么点"放一起）</div>
    </div></div>
    <div class="dim" style="margin-top:8px">如果你发现"后台自己没了"：先去「偏好」确认自启是开的；托盘（看门狗）每 20 秒探活一次，掉线会自己拉起来。</div>
  </div>

  <div class="card mt">
    <b>每日开工</b>
    <div class="dim" style="margin:4px 0 8px">到点自己开工：<b>刷新本周巩固包 + 汇总今天的事</b>，
      一天一条通知。默认 18:00、只准备不打扰 —— 作息不一样就把时间改掉。
      （这块以前只有接口、界面里没有入口，2026-09-27 补上。）</div>
    <div style="display:flex;gap:12px;flex-wrap:wrap;align-items:flex-end">
      <div class="field ob-field" style="margin:0;max-width:170px"><label>几点开工</label>
        <input type="time" id="set-daily-at" value="${esc(daily.prefs.at || '18:00')}" /></div>
      <label class="dim" style="display:flex;align-items:center;gap:6px;margin-bottom:6px">
        <input type="checkbox" id="set-daily-enabled" ${daily.prefs.enabled ? 'checked' : ''} style="width:auto" />开启</label>
      <label class="dim" style="display:flex;align-items:center;gap:6px;margin-bottom:6px">
        <input type="checkbox" id="set-daily-weekly" ${daily.prefs.weekly ? 'checked' : ''} style="width:auto" />顺手刷新本周巩固包</label>
      <label class="dim" style="display:flex;align-items:center;gap:6px;margin-bottom:6px">
        <input type="checkbox" id="set-daily-push" ${daily.prefs.push ? 'checked' : ''} style="width:auto" />推手机（会响，默认关）</label>
      <button class="btn primary" id="set-daily-save">保存</button>
      <button class="btn small" id="set-daily-dry">现在跑一次（演练）</button>
    </div>
    <div class="dim" style="margin-top:8px">${dailyLine}</div>
  </div>`;
}

/** 提炼关键词时要丢掉的填充词（“只看”“不要”这种，不是关键词）。 */
const PF_FILLER = ['只看', '不要', '优先', '出现', '字样', '可以', '需要', '以及', '这些', '那些',
  '还有', '如果', '然后', '别的', '一律', '最好', '尽量', '比如', '因为', '所以', '但是', '而且',
  '现在', '之后', '之前', '一样', '一些', '一个', '什么', '怎么', '哪些', '就行', '即可'];

/**
 * 从一段话里**粗**提炼关键词（和向导第②步用的同一套规则，改一处记得改另一处）。
 *
 * 规则收紧过一次（2026-09-26）：以前按标点切完就全收，中文长句会被切成
 * "提交」字样的优先推给我" 这种碎片塞进关键词里。现在：
 *   * 还带括号/引号的 ⇒ 是句子碎片，丢掉；
 *   * 纯 ASCII 的照收（TOEFL / ACM / arXiv 这种才有用），2~24 字；
 *   * 中文短语只收 2~6 字。
 */
export function extractKeywords(text, max = 12) {
  const out = [];
  for (const piece of String(text || '').split(/[,，、。;；:：\s\n\r\t/|]+/)) {
    const s = piece.replace(/^[「『（(\[【"'“]+/, '').replace(/[」』）)\]】"'”]+$/, '').trim();
    if (!s) continue;
    if (/[「」『』（）()\[\]【】]/.test(s)) continue;
    if (PF_FILLER.includes(s)) continue;                 // 明显的口语填充词，别当关键词
    if (/^[\x20-\x7e]+$/.test(s)) { if (s.length >= 2 && s.length <= 24) out.push(s); }
    else if (s.length >= 2 && s.length <= 6) out.push(s);
  }
  return [...new Set(out)].slice(0, max);
}

/**
 * 分析偏好（2026-09-26 用户要求搬回设置页，随时可改）。
 *
 * 两块：
 *   1. 「写一段话」—— 想说啥写啥，也可以导入本地文件；保存时顺手提炼关键词（只加不减）；
 *   2. 下面挂 `filter-profile` 那一整块「我关心什么」（关键词 / 课程代码 / 发件人 /
 *      阈值 / 语义兜底 / 行为学习），就是向导第②步背后那个东西。
 */
export function renderProfile(payload = {}) {
  const notes = payload.notes || '';
  const kw = payload.keywords || [];
  const kwLine = kw.length
    ? `当前关键词 ${kw.length} 个：${esc(kw.slice(0, 10).join('、'))}${kw.length > 10 ? ' …' : ''}`
    : '还没有关键词；写一段话保存，会自动从里面提炼';
  return `<div class="card">
    <b>分析偏好</b>
    <div class="dim">决定"外部进来的信息里哪些值得打扰你"。随时可以改 —— 首次向导里写的那一份就是这个。</div>
    <div class="field" style="margin-top:12px">
      <label>写一段话（可以很长，也可以导入本地文件）</label>
      <textarea id="set-pf-notes" rows="10"
        placeholder="例如：这学期先把两门专业课的作业和考试时间盯住；出现「作业 / 实验 / 提交」字样的优先推给我；广告促销一律不要。">${esc(notes)}</textarea>
    </div>
    <div style="display:flex;gap:10px;align-items:center;flex-wrap:wrap">
      <label class="btn small" for="set-pf-file">📂 导入本地文件</label>
      <input type="file" id="set-pf-file" accept=".txt,.md,.markdown,.json,.csv" style="display:none" />
      <span class="dim" id="set-pf-file-note">收 txt / md / json / csv —— 读到的内容并进上面那段话（最多 4000 字）</span>
    </div>
    <div style="display:flex;gap:10px;align-items:center;margin-top:10px;flex-wrap:wrap">
      <button class="btn primary" id="set-pf-notes-save">保存这段话</button>
      <span class="dim">${payload.note ? esc(payload.note) : kwLine}</span>
    </div>
    <div id="set-pf-host" style="margin-top:16px;padding-top:14px;border-top:1px solid var(--line)">
      <div class="dim">正在读筛选面板…</div>
    </div>
  </div>`;
}

/**
 * 偏好（2026-09-26 晚第二版）：**不单独给学生开一页** —— 这个应用非学生也要用。
 * 这一页收三样：
 *   1. 你是不是学生（学生模式）：可以自动判断，也可以自己定；
 *   2. 主菜单点击方式（审核的人要的"点一次就进"）；
 *   3. 学期（**只有学生模式才显示**）：开学日 + 周数 → 页头显示"第 N 周 / 共 M 周"。
 */
export function renderPrefs(payload = {}) {
  const sm = payload.studentMode || { mode: 'general', explicit: false, why: '' };
  const isStudent = sm.mode === 'student';
  const sem = payload.semester || {};
  const info = payload.semesterInfo || null;
  const quiet = payload.quiet || { focus_mute: true, start: '', end: '', exceptions: { ddl_final: true, starred: false } };
  const ex = quiet.exceptions || { ddl_final: true, starred: false };
  // 高峰时段（2026-09-27 可配）：windows 用"当天分钟数"，这里换回 HH:MM 显示
  const peak = payload.peak || { windows: [[540, 720], [840, 1080]], weekend_free: true, tz_offset: 8 };
  const hm = (m) => (Number.isFinite(Number(m)) && Number(m) >= 0 && Number(m) <= 1440
    ? `${String(Math.floor(Number(m) / 60)).padStart(2, '0')}:${String(Number(m) % 60).padStart(2, '0')}` : '');
  const w0 = peak.windows[0] || [null, null];
  const w1 = peak.windows[1] || [null, null];
  // 「重点来源」：勾选框列出这台机器上真实出现过的来源（名字从数据源元信息里取）
  const prio = Array.isArray(payload.prioritySources) ? payload.prioritySources : ['email_sjtu', 'canvas'];
  const prioAvail = Array.isArray(payload.priorityAvailable) && payload.priorityAvailable.length
    ? payload.priorityAvailable : prio.map((id) => ({ id, count: 0 }));
  const srcName = (id) => {
    const m = (payload.connectors || []).find((c) => c.id === id);
    return m ? `${m.icon || ''} ${m.name || id}` : id;
  };
  const preview = info && info.configured
    ? `<b>${esc(info.label)}</b>${info.end ? `<span class="dim"> · 学期最后一天约 ${esc(info.end)}</span>` : ''}`
    : '<span class="dim">还没填开学日 —— 页头那一行会空着</span>';
  return `<div class="card">
    <b>模式</b>
    <div class="dim">这个应用学生和不是学生的人都会用，所以"学生"只是一个可选的模式，不是一整页设置。
      你写「分析偏好」的时候如果提到课程 / 作业 / 考试这些，它会**自动**认成学生模式并告诉你原因。</div>
    <div style="display:flex;gap:8px;flex-wrap:wrap;margin-top:10px">
      <button class="btn ${isStudent ? 'primary' : ''}" data-set-student="student">我是学生（开学生模式）</button>
      <button class="btn ${isStudent ? '' : 'primary'}" data-set-student="general">不是 / 先别开</button>
      <button class="btn small" data-set-student="auto">回到自动判断</button>
    </div>
    <div class="dim" style="margin-top:8px">
      当前：<b>${isStudent ? '学生模式' : '通用模式'}</b>
      ${sm.explicit ? '（你自己设的）' : '（自动判断）'} · ${esc(sm.why || '')}
      ${(sm.hits || []).length ? `<br>看出来的依据：${esc((sm.hits || []).slice(0, 6).join('、'))}` : ''}
    </div>
    <div class="dim" style="margin-top:6px">学生模式打开后：页头会显示"第 N 周 / 共 M 周"（要先填下面的学期），
      数据源里 Canvas 这类学生刚需会排在前面。</div>
  </div>

  <div class="card mt">
    <b>主菜单怎么点</b>
    <div class="dim" style="margin:4px 0 8px">默认是"点一次就进"（审核的人反馈原来要点两下）。</div>
    <div style="display:flex;gap:8px;flex-wrap:wrap">
      <button class="btn ${payload.hubClick === 'twice' ? '' : 'primary'}" data-set-hub-click="once">点一次就进（推荐）</button>
      <button class="btn ${payload.hubClick === 'twice' ? 'primary' : ''}" data-set-hub-click="twice">点一次选中，再点一次才进</button>
    </div>
    ${payload.hubClickNote ? `<div class="dim" style="margin-top:8px">${esc(payload.hubClickNote)}</div>` : ''}
  </div>

  <div class="card mt">
    <b>免打扰</b>
    <div class="dim" style="margin:4px 0 8px">“什么时候别打扰我”。免打扰期间到点的提醒<b>不弹、也不推手机</b>，
      也<u>不会</u>被标成“已经提醒过” —— 等免打扰结束会一起补上，不会丢。</div>
    <div style="display:flex;gap:8px;flex-wrap:wrap;align-items:center">
      <span class="dim">专注时免打扰</span>
      <button class="btn ${quiet.focus_mute ? 'primary' : ''}" data-quiet-focus="1">开</button>
      <button class="btn ${quiet.focus_mute ? '' : 'primary'}" data-quiet-focus="0">关</button>
      <span class="dim">（开 = 番茄钟在跑的时候静音，默认开）</span>
    </div>
    <div style="display:flex;gap:12px;flex-wrap:wrap;align-items:flex-end;margin-top:12px">
      <div class="field ob-field" style="margin:0;max-width:150px"><label>安静时段 · 从</label>
        <input type="time" id="set-quiet-start" value="${esc(quiet.start || '')}" /></div>
      <div class="field ob-field" style="margin:0;max-width:150px"><label>到</label>
        <input type="time" id="set-quiet-end" value="${esc(quiet.end || '')}" /></div>
      <button class="btn primary" id="set-quiet-save">保存</button>
      <button class="btn small" id="set-quiet-clear">清空（不设）</button>
    </div>
    <div class="dim" style="margin-top:8px">${quiet.start && quiet.end
      ? `现在：<b>${esc(quiet.start)} → ${esc(quiet.end)}</b> 之间不打扰`
      : '现在：<b>没有安静时段</b>（只有上面那个“专注时免打扰”生效）'}</div>
    <div class="dim" style="margin-top:12px;padding-top:10px;border-top:1px solid var(--line)">
      例外：下面这些“重要的”即使正在免打扰，也照响（应用内提醒 + 手机推送）。</div>
    <div style="display:flex;gap:8px;flex-wrap:wrap;align-items:center;margin-top:8px">
      <span class="dim">DDL 最后一档 / 已逾期</span>
      <button class="btn ${ex.ddl_final ? 'primary' : ''}" data-quiet-ex="ddl_final" data-quiet-ex-on="1">开</button>
      <button class="btn ${ex.ddl_final ? '' : 'primary'}" data-quiet-ex="ddl_final" data-quiet-ex-on="0">关</button>
      <span class="dim">（剩 30 分钟以内，或已经逾期；默认开）</span>
    </div>
    <div style="display:flex;gap:8px;flex-wrap:wrap;align-items:center;margin-top:8px">
      <span class="dim">标了「重点」的提醒</span>
      <button class="btn ${ex.starred ? 'primary' : ''}" data-quiet-ex="starred" data-quiet-ex-on="1">开</button>
      <button class="btn ${ex.starred ? '' : 'primary'}" data-quiet-ex="starred" data-quiet-ex-on="0">关</button>
      <span class="dim">（交大邮箱 / Canvas 这类；默认关）</span>
    </div>
  </div>

  <div class="card mt">
    <b>哪些提醒算「重点」</b>
    <div class="dim" style="margin:4px 0 8px">重点来源的通知会<b>置顶</b>、标「重点」，也是免打扰里那个
      「重点例外」认的对象。默认是交大邮箱 + Canvas —— 你重点看别的源（比如 arXiv / 飞书 / 某条 RSS）就改这里。</div>
    <div class="flex" style="flex-wrap:wrap;gap:10px 18px">
      ${prioAvail.map((s) => `<label class="dim" style="display:flex;align-items:center;gap:6px">
        <input type="checkbox" data-prio-src="${esc(s.id)}" ${prio.includes(s.id) ? 'checked' : ''} style="width:auto" />
        ${esc(srcName(s.id))}${s.count ? `<span class="dim">（${s.count} 条）</span>` : ''}
      </label>`).join('')}
    </div>
    <div style="margin-top:10px"><button class="btn primary" id="set-prio-save">保存</button>
      <span class="dim" style="margin-left:8px">取消所有勾选 = 谁都不算重点</span></div>
  </div>

  <div class="card mt">
    <b>高峰时段</b>
    <div class="dim" style="margin:4px 0 8px">"高峰"是模型单价翻倍的时段：<b>费脑子的事（让 agent 分析、
      语义兜底）会排到非高峰去做</b>，省钱。默认工作日 09:00–12:00 / 14:00–18:00、周末不算 ——
      作息不一样就自己改；留空 = 这一档没有。</div>
    <div style="display:flex;gap:12px;flex-wrap:wrap;align-items:flex-end">
      <div class="field ob-field" style="margin:0;max-width:220px"><label>上午高峰</label>
        <div style="display:flex;gap:6px;align-items:center">
          <input type="time" id="set-peak-0a" value="${hm(w0[0])}" />
          <span class="dim">–</span>
          <input type="time" id="set-peak-0b" value="${hm(w0[1])}" />
        </div></div>
      <div class="field ob-field" style="margin:0;max-width:220px"><label>下午高峰</label>
        <div style="display:flex;gap:6px;align-items:center">
          <input type="time" id="set-peak-1a" value="${hm(w1[0])}" />
          <span class="dim">–</span>
          <input type="time" id="set-peak-1b" value="${hm(w1[1])}" />
        </div></div>
      <div class="field ob-field" style="margin:0;max-width:170px"><label>你所在时区</label>
        <input type="number" id="set-peak-tz" min="-12" max="14" step="1" value="${esc(String(peak.tz_offset))}" /></div>
      <label class="dim" style="display:flex;align-items:center;gap:6px;margin-bottom:6px">
        <input type="checkbox" id="set-peak-weekend" ${peak.weekend_free ? 'checked' : ''} style="width:auto" />周末全天非高峰</label>
      <button class="btn primary" id="set-peak-save">保存</button>
    </div>
    <div class="dim" style="margin-top:8px">现在：<b>${payload.peakNow ? '高峰（单价翻倍）' : '非高峰（半价）'}</b>
      ${payload.peakLabel ? ` · ${esc(payload.peakLabel)}` : ''}</div>
  </div>

  ${isStudent ? `<div class="card mt">
    <b>学期</b>
    <div class="dim">填一次就行：按"开学第一周的周一"对齐，页头就会显示"第 N 周 / 共 M 周"，
      最后两周自动标成「考试周」。留空 = 不显示。</div>
    <div style="display:flex;gap:12px;flex-wrap:wrap;align-items:flex-end;margin-top:12px">
      <div class="field ob-field" style="margin:0"><label>开学第一周的周一</label>
        <input type="date" id="set-sem-start" value="${esc(sem.start || '')}" /></div>
      <div class="field ob-field" style="margin:0;max-width:140px"><label>学期周数</label>
        <input type="number" id="set-sem-weeks" min="1" max="60" value="${esc(sem.weeks || 18)}" /></div>
      <button class="btn primary" id="set-sem-save">保存</button>
    </div>
    <div style="margin-top:12px">${preview}</div>
  </div>` : ''}

  <div class="card mt">
    <b>开机自启</b>
    <div class="dim">让后台服务跟着开机一起起来（Windows 用「启动」文件夹的快捷方式，macOS 用 LaunchAgent；
      在 macOS 上它同时充当"挂了自动拉起"的看门狗）。</div>
    <div class="ob-row" style="margin-top:8px;border-bottom:none;padding-left:0">
      <span class="ob-row-ico">${payload.autostartSupported === false ? '🚫' : (payload.autostart ? '✅' : '⭕')}</span>
      <div style="flex:1">
        <div>${payload.autostartSupported === false ? '这个平台暂不支持' : (payload.autostart ? '已开启' : '未开启')}</div>
        <div class="dim">${esc(payload.autostartPath || (payload.autostartSupported === false
          ? '目前只支持 Windows 与 macOS（用命令行 start / launchctl 手动起也可以）'
          : '（还没建快捷方式）'))}</div>
      </div>
      ${payload.autostartSupported === false ? ''
        : `<button class="btn small ${payload.autostart ? '' : 'primary'}" id="set-autostart">${payload.autostart ? '关掉自启' : '开启自启'}</button>`}
    </div>
  </div>`;
}

export function renderLook(payload = {}) {
  const themes = [{ id: 'p5', name: 'Persona 5 · 黑红' }, { id: 'p3r', name: 'Persona 3R · 克莱因蓝' }];
  const cur = payload.theme || 'p5';
  return `<div class="card">
    <b>外观</b>
    <div class="dim">点一下立刻生效（和右上角那个按钮以前做的事一样，现在收进这里）。</div>
    <div style="display:flex;gap:8px;flex-wrap:wrap;margin:10px 0">
      ${themes.map((t) => `<button class="btn ${cur === t.id ? 'primary' : ''}" data-set-theme="${t.id}">${esc(t.name)}</button>`).join('')}
    </div>
    <div class="field ob-field"><label>应用显示名</label>
      <input id="set-appname" value="${esc(payload.appName || '')}" placeholder="留空 = Cairn" /></div>
    <div style="display:flex;gap:8px;align-items:center">
      <button class="btn primary" id="set-appname-save">保存名字</button>
      <span class="dim">${payload.note ? esc(payload.note) : '外观存本机；名字存 data/brand.json'}</span>
    </div>
    <div id="set-wp-host" style="margin-top:18px;padding-top:16px;border-top:1px solid var(--line)">
      <div class="dim">正在读壁纸库…</div>
    </div>
  </div>`;
}

/**
 * 本机（2026-09-28，P1「自定义补齐」）：三类"以前只能改配置文件 / 环境变量"的东西。
 *
 *   1. **本机目录** —— 壁纸目录、课程资料目录（校验、写回都在 lib/routes/localdirs.mjs）；
 *   2. **本机工具** —— pdftotext / pdftoppm 这类**可选的**外部工具。它们本来是"有就用、
 *      没有就降级"，所以这里要说清**现在到底用的是什么**（环境变量 / 设置里配的 /
 *      应用自己找到的 / 根本没找到），别让人对着一个空框猜；
 *   3. **计划导出格式** —— 导出哪几种文件（md / json / ics / csv）。
 *
 * 这一页只负责画和转发：取值走 /api/localdirs 与 /api/fn-settings/plan_export，
 * 落盘走同一套接口 —— 不在这里另存一份状态。
 */
export function renderLocal(payload = {}) {
  const dirs = payload.localDirs || {};
  const tools = payload.localTools || {};
  const fx = payload.planExport || {};
  const fmtOn = new Set(String((fx.values || {}).formats || 'md,json').split(',').map((s) => s.trim()).filter(Boolean));

  const dirRow = (key, d) => {
    if (!d) return '';
    const state = !d.configured ? '<span class="pill pending">未配置</span>'
      : (d.exists && d.is_dir !== false) ? '<span class="pill status">在</span>'
        : '<span class="pill p0">找不到了</span>';
    const from = d.from === 'env' ? '现在来自环境变量（会压过这里的设置）' : (d.configured ? '现在用的是设置里的值' : '');
    return `<div class="ob-row" style="align-items:flex-start">
      <div style="flex:1;min-width:240px">
        <div>${esc(d.label)} ${state}</div>
        <div class="dim">${esc(d.hint || '')}</div>
        <input id="loc-dir-${esc(key)}" value="${esc(d.dir || '')}" placeholder="点右边「选择…」，或把路径粘到这里" style="width:100%;margin-top:6px" />
        ${from ? `<div class="dim">${esc(from)}</div>` : ''}
      </div>
      <div style="display:flex;gap:6px;flex-direction:column">
        <button class="btn small" data-loc-dir-pick="${esc(key)}">选择…</button>
        <button class="btn small primary" data-loc-dir-save="${esc(key)}">保存</button>
        <button class="btn small" data-loc-dir-clear="${esc(key)}">清空</button>
      </div>
    </div>`;
  };

  const toolRow = (key, t) => {
    if (!t) return '';
    const usable = Boolean(t.effective);
    const state = usable ? '<span class="pill status">有</span>' : '<span class="pill pending">没找到</span>';
    const fromLabel = t.effective_from === 'env' ? '环境变量'
      : t.effective_from === 'config' ? '设置里配的'
        : t.effective_from === 'auto' ? '应用自己找到的' : '';
    const statusLine = usable
      ? `<div class="dim" style="word-break:break-all">现在用的：${esc(t.effective)}${fromLabel ? `（${esc(fromLabel)}）` : ''}</div>`
      : `<div class="dim">${esc(t.effect || '')}</div>`;
    return `<div class="ob-row" style="align-items:flex-start">
      <div style="flex:1;min-width:240px">
        <div>${esc(t.label)} ${state}</div>
        <div class="dim">${esc(t.hint || '')}</div>
        ${statusLine}
        <input id="loc-tool-${esc(key)}" value="${esc(t.path || '')}" placeholder="点右边「选择…」，或粘一个完整路径 / 命令名" style="width:100%;margin-top:6px" />
      </div>
      <div style="display:flex;gap:6px;flex-direction:column">
        <button class="btn small" data-loc-tool-pick="${esc(key)}">选择…</button>
        <button class="btn small primary" data-loc-tool-save="${esc(key)}">保存</button>
        <button class="btn small" data-loc-tool-clear="${esc(key)}">自动找</button>
      </div>
    </div>`;
  };

  const opts = (fx.fields && fx.fields[0] && fx.fields[0].options) || [
    { value: 'md', label: 'Markdown', note: '给 Codex 和人看的正文（daily-plan.md）' },
    { value: 'json', label: 'JSON', note: '给程序读的完整结构（plan.json）' },
    { value: 'ics', label: 'ICS 日历', note: '导进手机 / 办公本日历（daily-plan.ics）' },
    { value: 'csv', label: 'CSV 表格', note: '一行一件事，导进 Excel / 飞书表格（daily-plan.csv）' },
  ];
  return `<div class="card">
    <b>本机目录</b>
    <div class="dim">每个人的机器不一样，所以这些路径只存本机（不进仓库）。改完<b>立刻生效</b>，不用重启。</div>
    ${Object.keys(dirs).map((k) => dirRow(k, dirs[k])).join('') || '<div class="dim">读不到本机目录清单（后台服务没在跑？）</div>'}
  </div>

  <div class="card mt">
    <b>本机工具（可选）</b>
    <div class="dim">这两个是 Poppler 的小工具，<b>不装也能用</b> —— 装了只是能多读 / 多还原一批材料。
      没配就在这里点「选择…」指一个，或者把命令名（如 pdftotext）填进去，会自动去 PATH 里找。</div>
    ${Object.keys(tools).map((k) => toolRow(k, tools[k])).join('') || '<div class="dim">读不到工具清单（后台服务没在跑？）</div>'}
  </div>

  <div class="card mt">
    <b>计划导出</b>
    <div class="dim">导给 Codex 的「每日计划与安排」要写成哪几种文件。默认 Markdown + JSON（和以前一样）。</div>
    <div style="display:flex;gap:14px;flex-wrap:wrap;margin:10px 0">
      ${opts.map((o) => `<label class="dim" style="display:flex;align-items:flex-start;gap:6px">
        <input type="checkbox" data-loc-fmt="${esc(o.value)}" ${fmtOn.has(o.value) ? 'checked' : ''} style="width:auto;margin-top:3px" />
        <span><b>${esc(o.label)}</b><br /><span class="dim">${esc(o.note || '')}</span></span></label>`).join('')}
    </div>
    <div style="display:flex;gap:8px;align-items:center;flex-wrap:wrap">
      <button class="btn primary" id="loc-fmt-save">保存格式</button>
      <span class="dim">勾全去掉 = 回到默认（至少留一份，不然导完什么都没有）</span>
    </div>
    <div class="dim" style="margin-top:12px">现在就能下载（不管上面勾没勾）：</div>
    <div style="display:flex;gap:8px;flex-wrap:wrap;margin-top:6px">
      <a class="btn small" href="/api/plan.md" target="_blank" rel="noopener">看 Markdown</a>
      <a class="btn small" href="/api/plan.json?download=1">下载 JSON</a>
      <a class="btn small" href="/api/plan.ics?download=1">下载 ICS 日历</a>
      <a class="btn small" href="/api/plan.csv?download=1">下载 CSV 表格</a>
    </div>
  </div>`;
}

export function renderMode(payload = {}) {
  const dev = payload.mode === 'dev';
  return `<div class="card">
    <b>模式</b>
    <div class="dim">用户模式：只看到能用的东西。开发者模式：多出「开发 · 能力」这一块（在<b>能力搭建</b>页里，写能力 / 注册 / 试跑）。</div>
    <div style="display:flex;gap:8px;margin-top:10px">
      <button class="btn ${dev ? '' : 'primary'}" data-set-mode="user">用户模式</button>
      <button class="btn ${dev ? 'primary' : ''}" data-set-mode="dev">开发者模式</button>
    </div>
    ${dev ? `<div class="dim" style="margin-top:8px">现在是开发者模式 —— 左边的「开发」页签里可以真的写一条能力并试跑。</div>` : ''}
  </div>`;
}

export function renderFeatures(payload = {}) {
  // 用户 2026-09-26：**主菜单上的每一项都是功能**（今日/日程/任务/养成/通知/统计/音乐/课程辅助…），
  // 都要能勾选、能排序；「设置」「五步上手」不在此列（前者走齿轮、后者是向导）。
  const mods = payload.pages || payload.modules || [];
  const picked = Array.isArray(payload.picked) ? payload.picked : mods.map((m) => m.id);
  const order = Array.isArray(payload.order) && payload.order.length ? payload.order : mods.map((m) => m.id);
  const ordered = order.map((id) => mods.find((m) => m.id === id)).filter(Boolean);
  return `<div class="card">
    <b>功能</b>
    <div class="dim">勾上想要的、用 ↑↓ 排序。保存后主页就按这个摆；**没勾的在应用里一概不出现**。核心页（今日 / 任务 / 通知…）一直都在。</div>
    <div style="margin-top:10px">
      ${ordered.map((m, i) => `<div class="ob-row">
        <input type="checkbox" class="ob-check" data-set-um="${esc(m.id)}" ${picked.includes(m.id) ? 'checked' : ''} />
        <span class="ob-row-ico">${esc(m.icon || '◆')}</span>
        <div style="flex:1"><div>${esc(m.name)}</div><div class="dim">${esc(m.sub || '功能模块')}</div>
          ${m.settings ? '<div class="dim">有专属设置 → 去那一页右上角 ⚙ 功能设置</div>' : ''}
          ${m.privacy ? `<div class="dim" title="这个功能会碰什么">🧾 ${esc(m.privacy)}</div>` : ''}</div>
        <button class="btn small" data-set-up="${esc(m.id)}" ${i === 0 ? 'disabled' : ''}>↑</button>
        <button class="btn small" data-set-down="${esc(m.id)}" ${i === ordered.length - 1 ? 'disabled' : ''}>↓</button>
      </div>`).join('') || '<div class="empty">还没有可选的功能模块。</div>'}
    </div>
    <div style="display:flex;gap:8px;align-items:center;margin-top:10px">
      <button class="btn primary" id="set-features-save">保存</button>
      <span class="dim">${payload.note ? esc(payload.note) : `已选 ${picked.length} / ${mods.length}`}</span>
    </div>
    <!-- 2026-09-26 晚：主菜单的点击方式（审核的人反馈"要点两下才起作用"） -->
    <div style="margin-top:18px;padding-top:14px;border-top:1px solid var(--line)">
      <b>主菜单怎么点</b>
      <div class="dim" style="margin:4px 0 8px">影响主菜单那一列大标题。默认是"点一次就进"。</div>
      <div style="display:flex;gap:8px;flex-wrap:wrap">
        <button class="btn ${payload.hubClick === 'twice' ? '' : 'primary'}" data-set-hub-click="once">点一次就进（推荐）</button>
        <button class="btn ${payload.hubClick === 'twice' ? 'primary' : ''}" data-set-hub-click="twice">点一次选中，再点一次才进</button>
      </div>
      <div class="dim" style="margin-top:8px">${esc(payload.hubClickNote || '')}</div>
    </div>
  </div>`;
}

/** 开发页签：写能力 → 注册 → 试跑（单文件，不改内核）。 */
export function renderDev(payload = {}) {
  const caps = payload.userCaps || [];
  const code = payload.devCode !== undefined ? payload.devCode : DEV_TEMPLATE;
  return `<div class="card">
    <b>开发 · 能力</b>
    <div class="dim">
      一条能力就是一个单文件（放在&lt;数据目录&gt;/capabilities/ 下），<b>不用改内核、不用改主程序</b>。
      写好点「保存并注册」，它会立刻出现在能力清单里（能力搭建的素材栏也能用它），点「试跑」就地跑一次看看产出。
    </div>
    <div class="ob-row" style="align-items:flex-start;gap:10px;margin-top:8px">
      <div class="field ob-field" style="width:150px"><label>能力 id</label><input id="dev-cap-id" placeholder="demo.upper" /></div>
      <div class="field ob-field" style="width:150px"><label>显示名</label><input id="dev-cap-name" placeholder="转大写（示例）" /></div>
      <div class="field ob-field" style="width:120px"><label>类型</label>
        <select id="dev-cap-kind" class="select-inline"><option value="compute">compute</option><option value="read">read</option><option value="write">write</option><option value="outbound">outbound</option></select></div>
    </div>
    <textarea id="dev-cap-code" spellcheck="false" style="width:100%;min-height:200px;background:var(--panel2);border:1px solid var(--line2);color:var(--text);border-radius:10px;padding:10px;font-family:ui-monospace,Consolas,monospace;font-size:12px">${esc(code)}</textarea>
    <div style="display:flex;gap:8px;flex-wrap:wrap;margin-top:10px">
      <button class="btn primary" id="dev-save">保存并注册</button>
      <button class="btn" id="dev-run">试跑（用下面这段输入）</button>
      <input id="dev-input" class="select-inline" value='{"text":"hello"}' size="28" />
      <span class="dim" id="dev-note">${payload.note ? esc(payload.note) : ''}</span>
    </div>
    <div style="margin-top:12px">
      <b>你已经写的能力</b>
      ${caps.length ? caps.map((c) => `<div class="ob-row">
        <span class="ob-row-ico">🧩</span>
        <div style="flex:1"><div>${esc(c.id)} <span class="dim">${esc(c.name || '')}</span>${c.error ? ` <span class="pill p0">坏了</span>` : ''}</div>
          <div class="dim">${c.error ? esc(c.error) : `kind=${esc(c.kind || '')} · ${esc(c.file || '')}`}</div></div>
        <button class="btn small" data-dev-load="${esc(c.id)}">打开</button>
        <button class="btn small" data-dev-run="${esc(c.id)}">试跑</button>
      </div>`).join('') : '<div class="empty">还没有自己写的能力。</div>'}
    </div>
  </div>`;
}

export const DEV_TEMPLATE = `// 一条能力 = 一个文件。导出 meta（描述）与 run（干活）。
export const meta = {
  id: 'demo.upper',            // 点分「域.动作」；不能和平台自带的重名
  name: '把文字转成大写',
  kind: 'compute',             // read | compute | write | outbound
  permissions: [],             // 要动磁盘/网络才需要，例如 ['fs:read:data']
  idempotent: true,
  cost: 'none',
  ui: { label: '转大写', group: '示例' },
};

export async function run(input = {}) {
  return { upper: String(input.text || '').toUpperCase() };
}
`;

/**
 * 数据源（设置页自己就能画）。
 *
 * 2026-09-26 的教训：原来只是"把主程序画好的那一块搬进来"，一旦主程序那半边是旧版本
 * （浏览器缓存了旧 app.js），搬进来的就是**空壳** —— 用户看到"数据源没东西"。
 * 现在设置页**自己**从 /api/connectors 取数并渲染（列表 + 就地配置表单），
 * 只有在主程序那一块**已经有内容**时才改成"寄存"它（避免两套界面并存）。
 */
export function renderSources(payload = {}) {
  if (payload.hostFilled) {
    return `<div class="card">
      <b>数据源</b>
      <div class="dim">这一块是原来的「数据源」页（导航上不再单独占一格）。</div>
      <div id="set-sources-host" style="margin-top:8px"></div>
    </div>`;
  }
  const list = payload.connectors || [];
  const counts = payload.counts || {};
  const configs = payload.configs || [];
  // 2026-09-26 用户要求：这一页改成**和五步上手第①步同一个格式**（教程 + 添加按钮 + 1、2…列表）。
  // 用的就是向导那套 .ob-* 样式类，所以两边看起来是同一个东西。
  const meta = new Map(list.map((c) => [c.id, c]));
  const rank = new Map(list.map((c, i) => [c.id, i]));
  // 顺序跟"数据源优先级"一致（常用在前），不按字母序。
  // 学生模式（2026-09-26 晚）：Canvas 这类学生刚需提到前面 —— 就排在两个邮箱后面。
  const isStudent = (payload.studentMode || {}).mode === 'student';
  const STUDENT_BOOST = { canvas: 2.4, email_sjtu: 2.1, arxiv: 2.7 };
  const rankOfRow = (src) => {
    const t = instanceTypeOf(src);
    const base = rank.has(t) ? rank.get(t) : 99;
    return isStudent && STUDENT_BOOST[t] !== undefined ? STUDENT_BOOST[t] : base;
  };
  const ordered = configs.slice().sort((a, b) => {
    const d = rankOfRow(a.source) - rankOfRow(b.source);
    return d !== 0 ? d : String(a.source).localeCompare(String(b.source));
  });

  if (payload.openSource) {
    const isNew = payload.openSource === NEW_SOURCE;
    const typeId = isNew ? '' : payload.openSource;          // 表单当前选中的**类型**
    const instId = payload.openInstance || '';               // 正在改的那条**实例**（新建时为空）
    const c = typeId ? (meta.get(typeId) || null) : null;
    let saved = {};
    if (c) {
      const hit = configs.find((x) => x.source === (instId || c.id));
      try { saved = JSON.parse((hit || {}).config_json || '{}'); } catch { saved = {}; }
    }
    const fields = c ? (c.fields || []).map((f) => `<div class="field ob-field">
        <label>${esc(f.label)}${f.required ? ' *' : ''}</label>
        <input data-set-conn-field="${esc(f.key)}"
          type="${f.type === 'password' ? 'password' : (f.type === 'number' ? 'number' : 'text')}"
          placeholder="${esc(f.placeholder || '')}"
          value="${esc(saved[f.key] !== undefined ? saved[f.key] : (f.default !== undefined ? f.default : ''))}" />
      </div>`).join('') : '';
    return `<div class="card">
      <div class="ob-setup-row">
        <label class="ob-setup-label" for="set-conn-type">选择数据类型</label>
        <select id="set-conn-type" class="select-inline ob-select">
          <option value="">请选择一种数据源…</option>
          ${list.map((x) => `<option value="${esc(x.id)}"${x.id === typeId ? ' selected' : ''}>${esc((x.icon ? x.icon + ' ' : '') + x.name)}</option>`).join('')}
        </select>
      </div>
      <div class="ob-config">
        <div class="ob-config-head">配置部分${c ? ' · ' + esc((c.icon || '') + ' ' + c.name) : ''}</div>
        <div class="dim" style="margin-bottom:12px">${esc(c ? (c.description || '') : '先在上面选一种数据类型，这里就会列出它要你提供的信息。')}</div>
        ${fields ? `<div class="ob-formgrid" style="grid-template-columns:1fr">${fields}</div>`
    : (c ? '<div class="dim">这种类型不需要填东西，直接点下面的按钮即可。</div>' : '')}
      </div>
      <div class="ob-hint-row">
        <button class="btn primary" id="set-conn-save" ${c ? '' : 'disabled'}>保存并试一次</button>
        <button class="btn small" id="set-conn-back">‹ 返回列表</button>
        <a class="btn small" href="/docs/CONNECT_SOURCES.md" target="_blank" rel="noreferrer">📖 数据源配置教程</a>
        <span class="dim">${payload.note ? esc(payload.note) : '凭据只存本机（加密），不进仓库'}</span>
        ${c && instId ? `<span style="flex:1"></span><button class="btn small danger" data-set-conn-del="${esc(instId)}">删掉这一条</button>` : ''}
      </div>
    </div>`;
  }

  const rows = ordered.map((c, i) => {
    const m = meta.get(c.type || c.source) || { icon: '◆', name: c.source };
    let cfg = {};
    try { cfg = JSON.parse(c.config_json || '{}'); } catch { cfg = {}; }
    const who = cfg.label || cfg.user || cfg.host || '';
    const n = Number((payload.countsByInstance || {})[c.source] ?? counts[c.type || c.source] ?? 0);
    const bad = c.last_error ? String(c.last_error).slice(0, 40) : (c.status === 'error' ? '上次连的时候出错了' : '');
    const flag = bad ? ` · 没连上：${bad}`
      : (c.status === 'configured' ? ' · 已配置，还没同步过' : (c.status === 'empty' ? ' · 还没收到数据' : ''));
    return `<div class="ob-src-row">
      <span class="ob-src-n">${i + 1}</span>
      <span class="ob-src-ico">${esc(m.icon || '◆')}</span>
      <span class="ob-src-txt">
        <b>${esc((m.name || c.source) + (c.suffix || ''))}</b>
        <i>${esc(who ? String(who) + ' · ' : '')}已收到 ${n} 条${esc(flag)}</i>
      </span>
      <button class="btn small" data-set-conn-open="${esc(c.source)}">改一下</button>
      <button class="btn small danger" data-set-conn-del="${esc(c.source)}">删除</button>
    </div>`;
  }).join('');

  return `<div class="card">
    <b>数据源</b>
    <div class="ob-src-top" style="margin-top:10px">
      <a class="ob-tut" href="/docs/CONNECT_SOURCES.md" target="_blank" rel="noreferrer">
        <span class="ob-tut-ico">📖</span>
        <span class="ob-tut-txt">
          <b>如何上手数据源配置</b>
          <i>每个字段填什么、去哪拿密钥 / 授权码、连不上怎么查 —— 第一次配建议先扫一眼</i>
        </span>
        <span class="ob-tut-go">打开教程 ›</span>
      </a>
      <button class="btn primary" id="set-conn-add">＋ 添加数据源</button>
    </div>
    ${payload.note ? `<div class="ob-src-note">${esc(payload.note)}</div>` : ''}
    ${configs.length
    ? `<div class="ob-src-title">已经添加的（${configs.length}）</div><div class="ob-src-list">${rows}</div>`
    : '<div class="ob-src-empty">还没有添加任何数据源。点上面的「＋ 添加数据源」开始。</div>'}
    <!-- 2026-09-26：这三块原来长在旧「数据源」页上，那个页面没了以后就谁也够不着了，接回来。
         用户 2026-09-26 晚要求：**Agent 接入排到最前**（在连接向导之前）—— */
    <div id="set-agent-host" style="margin-top:18px;padding-top:14px;border-top:1px solid var(--line)">
      <div class="dim">正在读 Agent 接入…</div>
    </div>
    <div id="set-conn-wizard" style="margin-top:18px;padding-top:14px;border-top:1px solid var(--line)">
      <div class="dim">正在读连接向导…</div>
    </div>
    <div id="set-digest-host" style="margin-top:18px;padding-top:14px;border-top:1px solid var(--line)">
      <div class="dim">正在读摘要预览…</div>
    </div>
    <!-- 2026-09-26 深夜（用户要求）：**9 种数据源不要铺成一长条**，收成"一个下拉框"来选
         —— 点「＋ 添加数据源」后的「选择数据类型」下拉就是全部类型（9 种）。 -->
    <div class="dim" style="margin-top:14px">
      想接新的：点上面的「＋ 添加数据源」，在「<b>选择数据类型</b>」下拉里选（一共 ${list.length} 种，每种要填什么会在下面列出来）。
    </div>
  </div>`;
}

/** 「＋ 添加数据源」时用的哨兵值（区别于"正在改某一个"）。 */
export const NEW_SOURCE = '__new__';

export function renderPage(payload = {}) {
  const tab = payload.tab || 'sources';
  const body = tab === 'sources' ? renderSources(payload)
    : tab === 'profile' ? renderProfile(payload)
    : tab === 'prefs' ? renderPrefs(payload)
    : tab === 'look' ? renderLook(payload)
      : tab === 'mode' ? renderMode(payload)
        : tab === 'features' ? renderFeatures(payload)
          : tab === 'local' ? renderLocal(payload)
            : tab === 'runtime' ? renderRuntime(payload)
              : renderDev(payload);
  return `<div class="set-wrap">
    <aside class="set-rail">${renderTabs(payload)}</aside>
    <section class="set-main">
      <div class="set-main-head">
        <h3>${esc((TABS.find((t) => t.id === tab) || {}).name || '设置')}</h3>
        <span class="dim">${esc((TABS.find((t) => t.id === tab) || {}).note || '')}
          · ${payload.mode === 'dev' ? '开发者模式' : '用户模式'}</span>
      </div>
      ${body}
    </section>
  </div>`;
}

export async function mount(el, ctx = {}) {
  const { api, toast = () => {}, DB, refresh = async () => {} } = ctx;
  // 「切到数据源」这类外部请求会先写 window.__cairnSettingsWanted（见 app.js 的 switchTab）
  const wanted = (ctx && ctx.initialTab) || window.__cairnSettingsWanted || 'sources';
  try { delete window.__cairnSettingsWanted; } catch { window.__cairnSettingsWanted = ''; }
  const S = {
    tab: wanted, mode: 'user', theme: 'p5', appName: '', note: '',
    modules: [], picked: [], order: [], userCaps: [], health: {}, moved: false,
    connectors: [], configs: [], counts: {}, countsByInstance: {},
    openSource: null, openInstance: null, hostFilled: false,
    notes: '', keywords: [], hubClick: 'once',
    semester: { start: '', weeks: 18 }, semesterInfo: null,
    studentMode: { mode: 'general', explicit: false, why: '', hits: [] },
    quiet: { focus_mute: true, start: '', end: '', exceptions: { ddl_final: true, starred: false } },
    peak: { windows: [[540, 720], [840, 1080]], weekend_free: true, tz_offset: 8 },
    peakNow: false, peakLabel: '',
    prioritySources: ['email_sjtu', 'canvas'], priorityAvailable: [],
    daily: null,
    localDirs: {}, localTools: {}, planExport: null,
  };
  const q = (s) => el.querySelector(s);
  const qa = (s) => [...el.querySelectorAll(s)];
  const on = (s, fn) => { const x = q(s); if (x) x.onclick = fn; };
  const onAll = (s, fn) => qa(s).forEach((x) => { x.onclick = fn; });
  const readJson = async (p) => {
    const r = await fetch(p + (p.includes('?') ? '&' : '?') + '_t=' + Date.now(), { cache: 'no-store' });
    const d = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(d.error || `HTTP ${r.status}`);
    return d;
  };

  const draw = () => { el.innerHTML = renderPage(S); bind(); placeSources(); placeWallpaper(); placeProfile(); placeSourceGadgets(); };

  /**
   * 旧「数据源」页上原本挂着三块（连接向导 / Agent·模型接入 / 每日摘要预览）。
   * 那一页从导航里撤掉之后它们就谁也够不着了 —— 2026-09-26 接回设置页的数据源页签。
   */
  function placeSourceGadgets() {
    if (S.tab !== 'sources' || S.hostFilled) return;
    // 顺序 = 用户 2026-09-26 晚定的：**Agent 接入 → 连接向导 → 摘要预览**
    const pairs = [['#set-agent-host', 'agent-connect'], ['#set-conn-wizard', 'connect-wizard'], ['#set-digest-host', 'digest-preview']];
    for (const [sel, id] of pairs) {
      // 2026-09-27 凌晨：这两块**必须出现**。以前只查模板里的容器，容器一旦不在就整块静默消失
      //（用户报的就是"数据源里 agent 接入没有了"）。现在容器不在就**现建一个**挂在页面末尾。
      let host = q(sel);
      if (!host) {
        host = document.createElement('div');
        host.id = sel.slice(1);
        host.style.cssText = 'margin-top:18px;padding-top:14px;border-top:1px solid var(--line)';
        (q('.set-main') || el).appendChild(host);
      }
      if (!host || host.dataset.mounted === '1') continue;
      host.dataset.mounted = '1';
      // 优先用主程序给的出口；**拿不到就自己按 /api/modules 里的入口去取**
      // （2026-09-26 深夜：以前这里 `typeof ctx.mountModule !== 'function'` 直接 return，
      //   于是"Agent 接入 / 连接向导 / 摘要预览"三块**静默消失**，用户看到的就是数据源里没有 agent 接入。）
      if (typeof ctx.mountModule === 'function') { ctx.mountModule(host, id); continue; }
      mountModuleByPath(host, id);
    }
    // 第四块不是模块：课程资料自动同步（含每日清理），由主程序画好、这里搬过来
    let csHost = q('#set-coursesync-host');
    if (!csHost) {
      csHost = document.createElement('div');
      csHost.id = 'set-coursesync-host';
      csHost.style.cssText = 'margin-top:18px;padding-top:14px;border-top:1px solid var(--line)';
      (q('.set-main') || el).appendChild(csHost);
    }
    adoptCourseSync();
  }

  /** 兜底：自己问 /api/modules 拿入口文件名 + 版本，再 import 进来挂上。 */
  async function mountModuleByPath(host, id) {
    try {
      const r = await readJson('/api/modules');
      const m = (r.modules || []).find((x) => x.id === id);
      if (!m || !m.entry || !m.entry.view) { host.innerHTML = `<div class="dim">没找到模块 ${esc(id)}</div>`; return; }
      const mod = await import('/modules/' + m.id + '/' + m.entry.view + '?v=' + encodeURIComponent((m.version || '0') + '-' + (m.mtime || 0)));
      if (typeof mod.mount === 'function') await mod.mount(host, ctx);
      else host.innerHTML = `<div class="dim">模块 ${esc(id)} 没有 mount()</div>`;
    } catch (e) {
      host.innerHTML = `<div class="dim">这块没加载起来：${esc((e && e.message) || '')}（多半是后台服务刚重启，刷新一下）</div>`;
    }
  }

  /**
   * 「课程资料自动同步」那一整块（Canvas → 桌面 → 办公本 / 邮件，连带每日清理）也是数据源的一部分，
   * 但它一直是主程序画在 `#view-connectors` 里的 —— 那一页从导航撤掉之后，**这一块整个失联**
   * （和用户报过的"数据源里 agent 接入没有了"是同一类问题，2026-09-27 实测确认）。
   * 这里把它搬进设置页：容器不在就现建，主程序每次重画后也会叫 `__cairnAdoptCourseSync` 再搬一次，
   * 保证搬过来的是最新那一帧（旧的先挪走，不留下两张同 id 的卡片）。
   */
  function adoptCourseSync() {
    const host = q('#set-coursesync-host');
    const src = document.getElementById('view-connectors');
    if (!host) return;
    let card = src ? src.querySelector('#course-sync-card') : null;
    if (!card && typeof window.__cairnRenderConnectors === 'function') {
      try { window.__cairnRenderConnectors(); } catch { /* ignore */ }
      card = src ? src.querySelector('#course-sync-card') : null;
    }
    if (!card) card = document.getElementById('course-sync-card');
    if (!card) return;
    const stale = host.querySelector('#course-sync-card');
    if (stale && stale !== card) stale.remove();
    if (card.parentElement !== host) host.appendChild(card);
  }
  window.__cairnAdoptCourseSync = adoptCourseSync;      // 主程序重画后叫我们一声

  /** 「分析偏好」页签：把 filter-profile 那一整块挂进来（和向导第②步背后是同一份）。 */
  function placeProfile() {
    if (S.tab !== 'profile') return;
    const host = q('#set-pf-host');
    if (!host || host.dataset.mounted === '1') return;
    host.dataset.mounted = '1';
    if (typeof ctx.mountProfile === 'function') ctx.mountProfile(host);
    else host.innerHTML = '<div class="dim">这一块要在应用里才能用。</div>';
  }

  /** 「外观」页签里的壁纸那一块：让主程序把同一份壁纸界面挂进来（含 Wallpaper Engine 目录）。 */
  function placeWallpaper() {
    if (S.tab !== 'look') return;
    const host = q('#set-wp-host');
    if (!host || host.dataset.mounted === '1') return;
    host.dataset.mounted = '1';
    if (typeof ctx.mountWallpaper === 'function') ctx.mountWallpaper(host);
    else host.innerHTML = '<div class="dim">壁纸这一块要在应用里才能用。</div>';
  }

  /** 把原来的「数据源」整块搬进来（第一次搬过就不再搬，免得反复挪动）。 */
  function placeSources() {
    if (S.tab !== 'sources') return;
    const host = q('#set-sources-host');
    const src = document.getElementById('view-connectors');
    if (!host) return;                       // 自己画的那种布局里没有这个容器，就不用搬
    // 1) 那一块是空的（比如服务刚重启、上一帧没取到数）⇒ 请主程序重画一次
    if (src && !src.innerHTML.trim() && typeof window.__cairnRenderConnectors === 'function') {
      try { window.__cairnRenderConnectors(); } catch { /* ignore */ }
    }
    // 2) 搬到设置页里（寄存；事件绑定跟着走）
    if (src && src.parentElement !== host) host.appendChild(src);
  }

  async function load() {
    let prefs = {};
    try { prefs = await readJson('/api/prefs'); } catch { prefs = {}; }
    // 数据源：设置页自己取（不依赖主程序那半边是不是新版本）
    try {
      const c = await readJson('/api/connectors');
      S.connectors = c.connectors || []; S.configs = c.configs || []; S.counts = c.counts || {};
      S.countsByInstance = c.counts_by_instance || {};
    } catch { S.connectors = []; S.configs = []; S.counts = {}; S.countsByInstance = {}; }
    // 2026-09-26：不再走"寄存主程序那一块"的路线 —— 那条路只要主程序那半边是旧版本/还没渲染，
    // 设置页就只剩一个空壳（用户看到"数据源不显示"）。设置页**自己画**，永远有内容。
    S.hostFilled = false;
    S.mode = prefs.ui_mode === 'dev' ? 'dev' : 'user';
    S.hubClick = prefs.hub_click === 'twice' ? 'twice' : 'once';
    S.semester = prefs.semester || { start: '', weeks: 18 };
    S.semesterInfo = prefs.semester_info || null;
    S.studentMode = prefs.student_mode || { mode: 'general', explicit: false, why: '', hits: [] };
    S.quiet = prefs.quiet || { focus_mute: true, start: '', end: '', exceptions: { ddl_final: true, starred: false } };
    // 高峰时段 / 重点来源（2026-09-27 新增两块可调）
    S.peak = prefs.peak || { windows: [[540, 720], [840, 1080]], weekend_free: true, tz_offset: 8 };
    S.peakNow = !!prefs.peak_now;
    S.peakLabel = prefs.peak_label || '';
    S.prioritySources = Array.isArray(prefs.priority_sources) ? prefs.priority_sources : ['email_sjtu', 'canvas'];
    S.priorityAvailable = Array.isArray(prefs.priority_sources_available) ? prefs.priority_sources_available : [];
    // 每日开工（GET /api/daily）：以前只有接口、界面没入口
    try { S.daily = await readJson('/api/daily'); } catch { S.daily = null; }
    // 本机目录 / 本机工具 / 导出格式（设置 → 本机）
    try {
      const ld = await readJson('/api/localdirs');
      S.localDirs = ld.dirs || {};
      S.localTools = ld.tools || {};
    } catch { S.localDirs = {}; S.localTools = {}; }
    try { S.planExport = await readJson('/api/fn-settings/plan_export'); } catch { S.planExport = null; }
    S.theme = prefs.theme || 'p5';
    S.appName = (prefs.brand && prefs.brand.custom ? prefs.brand.app_name : '') || '';
    // 分析偏好：当前已存的这段话与关键词（保存时"只加不减"，不冲掉你手填的）
    try {
      const p = await readJson('/api/profile');
      S.notes = (p.profile && p.profile.notes) || '';
      S.keywords = (p.profile && p.profile.keywords) || [];
    } catch { S.notes = ''; S.keywords = []; }
    const ui = prefs.ui_modules || {};
    let mods = [];
    if (Array.isArray(ctx.pickablePages) && ctx.pickablePages.length) {
      mods = ctx.pickablePages;                        // 主程序把"能挑的页"整份传进来（含核心页）
    } else {
      try {
        const m = await readJson('/api/modules');
        mods = (m.modules || []).filter((x) => !x.error && x.kind === 'view' && x.id !== 'settings' && x.id !== 'onboarding' && x.boot !== true)
          .map((x) => ({ id: x.id, name: x.name, sub: x.sub, icon: x.icon, settings: x.settings === true }));
      } catch { mods = []; }
    }
    S.modules = mods;
    S.picked = Array.isArray(ui.enabled) ? ui.enabled.filter((id) => mods.some((m) => m.id === id)) : mods.map((m) => m.id);
    S.order = [...(Array.isArray(ui.order) ? ui.order : []).filter((id) => mods.some((m) => m.id === id)),
      ...mods.map((m) => m.id).filter((id) => !(ui.order || []).includes(id))];
    try { S.health = await readJson('/api/health'); } catch { S.health = {}; }
    // 自启状态必须**等 /api/health 回来再读**（2026-09-27 修：以前读在 health 之前，
    // 于是「偏好」页那张卡片永远显示"未开启/还没建快捷方式"，而「后台」页却显示"已开启"）。
    const auto = (S.health || {}).autostart || {};
    S.autostart = !!auto.enabled;
    S.autostartPath = auto.path || '';
    // 「这个平台支不支持自启」由服务端说了算（Windows 快捷方式 / macOS LaunchAgent / 其它不支持）
    S.autostartSupported = auto.supported !== false;
    try { const d = await readJson('/api/capabilities/dev'); S.userCaps = d.capabilities || []; } catch { S.userCaps = []; }
    draw();
  }

  const savePrefs = async (patch, okMsg) => {
    try { await api('POST', '/api/prefs', patch); if (okMsg) toast(okMsg, 'green'); }
    catch (e) { toast(`没保存上：${e.message || ''}`, 'red'); }
  };

  function bind() {
    onAll('[data-set-tab]', (e) => { S.tab = e.currentTarget.dataset.setTab; S.note = ''; draw(); });
    on('#set-back-app', () => { if (ctx.nav) ctx.nav('hub'); });
    // 数据源：点开某个源的配置表单 / 返回 / 保存并试一次
    // 「改一下」带的是**实例 id**（可能是 `rss@2`）：类型用来渲染表单，实例用来取回已存的值
    onAll('[data-set-conn-open]', (e) => {
      const inst = e.currentTarget.dataset.setConnOpen;
      S.openInstance = inst;
      S.openSource = instanceTypeOf(inst);
      S.note = ''; draw();
    });
    on('#set-conn-back', () => { S.openSource = null; S.openInstance = null; draw(); });
    // 「＋ 添加数据源」→ 打开"选类型 + 配置部分"那一屏（和五步上手第①步同一个流程）
    on('#set-conn-add', () => { S.openSource = NEW_SOURCE; S.openInstance = null; S.note = ''; draw(); });
    {
      const sel = q('#set-conn-type');
      if (sel) sel.onchange = () => {
        S.openInstance = null;                       // 换类型 = 重新选，不再是"改某一条"
        S.openSource = sel.value || NEW_SOURCE;
        S.note = ''; draw();
      };
    }
    // 删掉一个已经配好的数据源（2026-09-26 用户要求）。二次确认 + 说清连带删什么。
    onAll('[data-set-conn-del]', async (e) => {
      const id = e.currentTarget.dataset.setConnDel;
      const meta = (S.connectors || []).find((x) => x.id === id) || {};
      const n = Number((S.counts || {})[id] || 0);
      const okGo = window.confirm(
        `删掉「${meta.name || id}」？\n\n`
        + `· 会一并删掉它导入进来的 ${n} 条数据\n`
        + '· 已经推送到日程 / 任务的不会动\n'
        + '· 配置和凭据也会一起删掉（想再用就重新配一次）');
      if (!okGo) return;
      S.note = '正在删除…'; draw();
      try {
        const r = await api('DELETE', `/api/connectors/${id}`);
        S.note = `已删掉「${meta.name || id}」${r.removed_items ? `（连带 ${r.removed_items} 条导入数据）` : ''}`;
        toast('已经删掉', 'green');
        S.openSource = null;
        await load();
      } catch (err) { S.note = `没删掉：${err.message || ''}`; draw(); }
    });
    on('#set-conn-save', async () => {
      const id = S.openSource === NEW_SOURCE ? '' : S.openSource;
      if (!id) { S.note = '先选一种数据类型'; draw(); return; }
      const config = {};
      qa('[data-set-conn-field]').forEach((x) => { config[x.dataset.setConnField] = x.value; });
      S.note = '正在连接并试一次…'; draw();
      try {
        // 带 instance ⇒ 改这一条；否则 create:true ⇒ **新建一条**（类型没人用就用类型本身，
        // 已经有就 rss@2）。这让"再加一个 RSS"和"刷新已有 RSS"是两件不同的事。
        const r = await api('POST', `/api/connectors/${id}/import`, {
          config, instance: S.openInstance || undefined, create: S.openInstance ? undefined : true,
        });
        S.note = `配好了，试了一次：收到 ${r.inserted || 0} 条${r.instance > 1 ? `（这是这个类型的第 ${r.instance} 条）` : ''}`;
        toast(S.note, 'green');
        S.openSource = null; S.openInstance = null;
        await load();
      } catch (e) { S.note = `没连上：${e.message || ''}`; draw(); }
    });
    // 分析偏好：写一段话 + 导入本地文件 + 保存（顺手提炼关键词，只加不减）
    const pfFile = q('#set-pf-file');
    if (pfFile) pfFile.onchange = () => {
      const f = pfFile.files && pfFile.files[0];
      if (!f) return;
      const rd = new FileReader();
      rd.onload = () => {
        const text = String(rd.result || '').slice(0, 4000);
        const ta = q('#set-pf-notes');
        if (ta) ta.value = (ta.value ? ta.value + '\n\n' : '') + text;
        const tip = q('#set-pf-file-note');
        if (tip) tip.textContent = `已导入：${f.name}（记得点「保存这段话」）`;
      };
      rd.readAsText(f, 'utf-8');
    };
    on('#set-pf-notes-save', async () => {
      const ta = q('#set-pf-notes');
      const text = (ta ? ta.value : '') || '';
      const fresh = extractKeywords(text);
      // 只加不减：向导那边也可能写过关键词，别把已有的一把冲掉
      const merged = [...new Set([...(S.keywords || []), ...fresh])].slice(0, 40);
      S.note = '保存中…'; draw();
      try {
        const r = await api('POST', '/api/profile', { enabled: true, notes: text, keywords: merged });
        S.notes = (r.profile && r.profile.notes) || text;
        S.keywords = (r.profile && r.profile.keywords) || merged;
        S.note = `存好了：${text.length} 字 · 关键词 ${S.keywords.length} 个（新提炼出 ${fresh.length} 个）`;
        toast('分析偏好已保存', 'green');
        try { await refresh(); } catch { /* ignore */ }   // 让下面那块筛选面板也拿到新值
        await load();
      } catch (e) { S.note = `没保存上：${e.message || ''}`; draw(); }
    });

    onAll('[data-set-theme]', (e) => {
      const id = e.currentTarget.dataset.setTheme;
      S.theme = id;
      // 交给主程序：它会把主题、壁纸、全屏切换动画一起换掉（用户要求"改外观时壁纸同时换"）
      if (typeof window.__cairnApplyTheme === 'function') window.__cairnApplyTheme(id);
      else {
        document.body.dataset.theme = id;
        try { localStorage.setItem('planner-theme', id); } catch { /* ignore */ }
        api('POST', '/api/prefs', { theme: id }).catch(() => {});
      }
      S.note = `主题换成「${id}」`; draw();
    });
    on('#set-appname-save', async () => {
      const v = (q('#set-appname') || {}).value || '';
      try {
        const r = await api('POST', '/api/prefs', { app_name: v.trim() });
        const nm = (r.brand && r.brand.app_name) || 'Cairn';
        const bn = document.getElementById('app-name-brand'); if (bn) bn.textContent = nm;
        const bw = document.getElementById('app-name-wb'); if (bw) bw.textContent = nm;
        S.appName = v.trim(); S.note = `名字改成「${nm}」`;
      } catch (e) { S.note = `没保存上：${e.message || ''}`; }
      draw();
    });
    onAll('[data-set-mode]', async (e) => {
      const m = e.currentTarget.dataset.setMode === 'dev' ? 'dev' : 'user';
      await savePrefs({ ui_mode: m }, m === 'dev' ? '已切到开发者模式' : '已切回用户模式');
      S.mode = m; if (m === 'user' && S.tab === 'dev') S.tab = 'sources';
      draw();
    });
    onAll('[data-set-um]', (e) => {
      const id = e.currentTarget.dataset.setUm;
      S.picked = S.picked.includes(id) ? S.picked.filter((x) => x !== id) : [...S.picked, id];
      draw();
    });
    const move = (id, d) => {
      const from = S.order.indexOf(id); const to = from + d;
      if (from < 0 || to < 0 || to >= S.order.length) return;
      const next = S.order.slice(); next.splice(to, 0, next.splice(from, 1)[0]); S.order = next; draw();
    };
    onAll('[data-set-up]', (e) => move(e.currentTarget.dataset.setUp, -1));
    onAll('[data-set-down]', (e) => move(e.currentTarget.dataset.setDown, 1));
    on('#set-features-save', async () => {
      try {
        await api('POST', '/api/prefs', { ui_modules: { enabled: S.picked, order: S.order } });
        if (ctx.applyLayout) await ctx.applyLayout();
        S.note = `已保存：${S.picked.length} 个功能`; toast('清单保存了（主页已重排）', 'green');
      } catch (e) { S.note = `没保存上：${e.message || ''}`; }
      draw();
    });
    // 主菜单点击方式：改完立刻生效（app.js 那边的 HUB_CLICK 会跟着变）
    onAll('[data-set-hub-click]', async (e) => {
      const want = e.currentTarget.dataset.setHubClick === 'twice' ? 'twice' : 'once';
      try {
        await api('POST', '/api/prefs', { hub_click: want });
        S.hubClick = want;
        S.hubClickNote = want === 'twice' ? '现在是：先点一下选中，再点一下进入。' : '现在是：点一次就进入。';
        toast(want === 'twice' ? '已切成"先选中再进入"' : '已切成"点一次就进"', 'green');
        try { if (typeof window.__cairnApplyHubClick === 'function') window.__cairnApplyHubClick(want); } catch { /* ignore */ }
      } catch (err) { toast(`没改成：${err.message || ''}`, 'red'); }
      draw();
    });
    // 学生模式：自己点过就听自己的（'student' / 'general'），点"回到自动判断"就给空串
    onAll('[data-set-student]', async (e) => {
      const want = e.currentTarget.dataset.setStudent;   // student | general | auto
      try {
        const r = await api('POST', '/api/prefs', { student_mode: want === 'auto' ? '' : want });
        S.studentMode = r.student_mode || { mode: 'general', explicit: false, why: '', hits: [] };
        toast(want === 'auto' ? '改回自动判断了'
          : (want === 'student' ? '已打开学生模式' : '已按通用模式走'), 'green');
        try { if (typeof window.__cairnApplyStudent === 'function') window.__cairnApplyStudent(S.studentMode.mode); } catch { /* ignore */ }
      } catch (err) { toast(`没改成：${err.message || ''}`, 'red'); }
      draw();
    });
    // 免打扰（2026-09-27）：专注时静音 开/关 + 安静时段（起止）
    onAll('[data-quiet-focus]', async (e) => {
      const want = e.currentTarget.dataset.quietFocus !== '0';
      await savePrefs({ quiet: { focus_mute: want } },
        want ? '专注时会静音了' : '专注时也照常提醒');
      S.quiet = { ...(S.quiet || {}), focus_mute: want };
      draw();
    });
    on('#set-quiet-save', async () => {
      const start = ((q('#set-quiet-start') || {}).value || '').trim();
      const end = ((q('#set-quiet-end') || {}).value || '').trim();
      if (!start || !end) { S.note = '要填「从」和「到」两个时间；只想取消就点右边那个「清空」'; draw(); return; }
      await savePrefs({ quiet: { start, end } }, `已保存：${start} → ${end} 之间不打扰`);
      S.quiet = { ...(S.quiet || {}), start, end };
      draw();
    });
    on('#set-quiet-clear', async () => {
      await savePrefs({ quiet: { start: '', end: '' } }, '已取消安静时段');
      S.quiet = { ...(S.quiet || {}), start: '', end: '' };
      draw();
    });
    // 重要例外：哪些"重要的"可以在免打扰期间照响（一个一个开关，只改这一个）
    onAll('[data-quiet-ex]', async (e) => {
      const kind = e.currentTarget.dataset.quietEx;              // ddl_final | starred
      const on = e.currentTarget.dataset.quietExOn !== '0';
      if (kind !== 'ddl_final' && kind !== 'starred') return;
      const label = kind === 'ddl_final' ? 'DDL 最后一档 / 已逾期' : '「重点」提醒';
      await savePrefs({ quiet: { exceptions: { [kind]: on } } },
        on ? `${label}：免打扰时也照响` : `${label}：免打扰时不响（攒着）`);
      S.quiet = { ...(S.quiet || {}), exceptions: { ...((S.quiet || {}).exceptions || {}), [kind]: on } };
      draw();
    });
    // 哪些来源算「重点」（2026-09-27 可配）：勾完保存；改完立刻对通知列表的置顶/标记生效
    on('#set-prio-save', async () => {
      const picked = qa('[data-prio-src]').filter((x) => x.checked).map((x) => x.dataset.prioSrc);
      try {
        const r = await api('POST', '/api/prefs', { priority_sources: picked });
        S.prioritySources = r.priority_sources || picked;
        S.note = `重点来源已保存（${S.prioritySources.length} 个）`;
        toast(picked.length ? `已保存：${picked.length} 个重点来源` : '已保存：取消所有重点来源', 'green');
        try { await refresh(); } catch { /* ignore */ }   // 让通知列表的置顶/标记跟着变
      } catch (e) { S.note = `没保存上：${e.message || ''}`; }
      draw();
    });
    // 高峰时段（2026-09-27 可配）：两个时段 + 时区 + 周末开关
    on('#set-peak-save', async () => {
      const toMin = (v) => { const m = /^(\d{1,2}):(\d{2})$/.exec(String(v || '').trim()); return m ? Number(m[1]) * 60 + Number(m[2]) : null; };
      const rows = [[q('#set-peak-0a'), q('#set-peak-0b')], [q('#set-peak-1a'), q('#set-peak-1b')]];
      const windows = [];
      for (const [a, b] of rows) {
        const s = toMin((a || {}).value); const e = toMin((b || {}).value);
        if (s !== null && e !== null && s < e) windows.push([s, e]);
      }
      const peak = {
        windows,
        weekend_free: !!((q('#set-peak-weekend') || {}).checked),
        tz_offset: Number((q('#set-peak-tz') || {}).value) || 0,
      };
      try {
        const r = await api('POST', '/api/prefs', { peak });
        S.peak = r.peak || peak;
        S.peakNow = !!r.peak_now; S.peakLabel = r.peak_label || '';
        toast(windows.length ? `高峰时段已保存：${S.peakLabel}` : '已保存：没有高峰时段', 'green');
      } catch (e) { toast(`没保存上：${e.message || ''}`, 'red'); }
      draw();
    });
    // 每日开工（2026-09-27 补的界面入口）：时间 / 开关 / 顺手刷新 / 推手机
    on('#set-daily-save', async () => {
      const at = String(((q('#set-daily-at') || {}).value) || '18:00').trim();
      try {
        const r = await api('POST', '/api/daily', { prefs: {
          at,
          enabled: !!((q('#set-daily-enabled') || {}).checked),
          weekly: !!((q('#set-daily-weekly') || {}).checked),
          push: !!((q('#set-daily-push') || {}).checked),
        } });
        S.daily = r;
        toast(`每日开工：${r.prefs.enabled ? '开' : '关'} · ${r.prefs.at}`, 'green');
      } catch (e) { toast(`没保存上：${e.message || ''}`, 'red'); }
      draw();
    });
    on('#set-daily-dry', async () => {
      try {
        const r = await api('POST', '/api/daily/run', { dry_run: true });
        toast(`演练：${(r.plan && r.plan.counts) ? `逾期 ${r.plan.counts.overdue || 0} / 今天 ${r.plan.counts.today || 0} / 明天 ${r.plan.counts.tomorrow || 0}` : '会做但不写任何东西'}`, 'green');
        S.daily = r.status || S.daily;
      } catch (e) { toast(`演练失败：${e.message || ''}`, 'red'); }
      draw();
    });
    // 学期（学生特化）：开学日 + 周数；存完立刻重算预览与页头那一行
    on('#set-sem-save', async () => {
      const start = ((q('#set-sem-start') || {}).value || '').trim();
      const weeks = Number(((q('#set-sem-weeks') || {}).value) || 18);
      S.note = '保存中…'; draw();
      try {
        const r = await api('POST', '/api/prefs', { semester: { start, weeks } });
        S.semester = r.semester || { start, weeks };
        const info = r.semester_info || null;      // 服务端算好的（界面不重复算一遍）
        S.semesterInfo = info;
        S.note = info && info.configured ? `已保存：${info.label}` : '已清空学期设置';
        toast(S.note, 'green');
        try { await refresh(); } catch { /* ignore */ }   // 让页头那一行也跟着变
      } catch (e) { S.note = `没保存上：${e.message || ''}`; }
      draw();
    });
    on('#set-autostart', async () => {
      const want = !((S.health.autostart || {}).enabled);
      try {
        const r = await api('POST', '/api/autostart', { enabled: want });
        S.health = { ...S.health, autostart: r };
        S.autostart = !!r.enabled;
        S.autostartPath = r.path || '';
        S.autostartSupported = r.supported !== false;
        // 2026-09-27 修：以前不看服务端结果，非 Windows 上点了会弹一句假的「已开启」。现在如实说。
        if (r.supported === false) toast('这个平台暂不支持开机自启', 'red');
        else if (r.ok === false) toast(`没改成：${r.error || '未知原因'}`, 'red');
        else toast(want ? '已开启开机自启' : '已关闭开机自启', want ? 'green' : '');
      } catch (e) { toast(`没改成功：${e.message || ''}`, 'red'); }
      draw();
    });

    // ---- 本机页签（2026-09-28）：本机目录 / 本机工具 / 导出格式 ----
    // 这一块和别处一样：**值不在界面里存**，改完就问一次接口、拿服务端回的整份状态重画。
    const afterLocalWrite = (r, okMsg) => {
      if (r && r.dirs) { S.localDirs = r.dirs; S.localTools = r.tools || S.localTools; }
      toast(okMsg, 'green');
      draw();
    };
    onAll('[data-loc-dir-save]', async (e) => {
      const key = e.currentTarget.dataset.locDirSave;
      const dir = String(((q('#loc-dir-' + key) || {}).value) || '').trim();
      try {
        const r = await api('POST', '/api/localdirs', { key, dir });
        afterLocalWrite(r, `${(r.dirs && r.dirs[key] && r.dirs[key].label) || key} 已保存（立刻生效）`);
      } catch (err) { toast(`没保存上：${err.message || ''}`, 'red'); }
    });
    onAll('[data-loc-dir-clear]', async (e) => {
      const key = e.currentTarget.dataset.locDirClear;
      try {
        const r = await api('POST', '/api/localdirs', { key, dir: '' });
        afterLocalWrite(r, `${(r.dirs && r.dirs[key] && r.dirs[key].label) || key} 已清空`);
      } catch (err) { toast(`没清掉：${err.message || ''}`, 'red'); }
    });
    onAll('[data-loc-dir-pick]', async (e) => {
      const key = e.currentTarget.dataset.locDirPick;
      try {
        const r = await api('POST', '/api/localdirs/pick', { key });
        if (r.cancelled) return;
        if (!r.ok || !r.dir) { toast(r.error || '没能打开选择框（可以手动粘贴路径）', 'red'); return; }
        // 只回填、**不落盘**：确认无误再点「保存」（和接口的约定一致）
        S.localDirs = { ...S.localDirs, [key]: { ...(S.localDirs[key] || {}), dir: r.dir } };
        toast('选好了：确认无误就点「保存」', '');
        draw();
      } catch (err) { toast(`选择框没打开：${err.message || ''}`, 'red'); }
    });
    onAll('[data-loc-tool-save]', async (e) => {
      const key = e.currentTarget.dataset.locToolSave;
      const path = String(((q('#loc-tool-' + key) || {}).value) || '').trim();
      try {
        const r = await api('POST', '/api/localdirs', { key, path });
        const t = (r.tools || {})[key] || {};
        afterLocalWrite(r, t.effective ? `${t.label || key} 已保存 · 现在用的是 ${t.effective}` : `${t.label || key} 已保存`);
      } catch (err) { toast(`没保存上：${err.message || ''}`, 'red'); }
    });
    onAll('[data-loc-tool-clear]', async (e) => {
      const key = e.currentTarget.dataset.locToolClear;
      try {
        const r = await api('POST', '/api/localdirs', { key, path: '' });
        const t = (r.tools || {})[key] || {};
        afterLocalWrite(r, t.effective ? `改回自动找：${t.effective}` : '已清空 —— 这台机器上没找到它（可选，不影响已能用的部分）');
      } catch (err) { toast(`没清掉：${err.message || ''}`, 'red'); }
    });
    onAll('[data-loc-tool-pick]', async (e) => {
      const key = e.currentTarget.dataset.locToolPick;
      try {
        const r = await api('POST', '/api/localdirs/pick', { key });
        if (r.cancelled) return;
        if (!r.ok || !r.path) { toast(r.error || '没能打开选择框（可以手动粘贴路径）', 'red'); return; }
        S.localTools = { ...S.localTools, [key]: { ...(S.localTools[key] || {}), path: r.path } };
        toast('选好了：确认无误就点「保存」', '');
        draw();
      } catch (err) { toast(`选择框没打开：${err.message || ''}`, 'red'); }
    });
    on('#loc-fmt-save', async () => {
      const picked = qa('[data-loc-fmt]').filter((x) => x.checked).map((x) => x.dataset.locFmt);
      try {
        S.planExport = await api('POST', '/api/fn-settings', { fn: 'plan_export', patch: { formats: picked.join(',') } });
        const got = String(((S.planExport.values || {}).formats) || '');
        toast(picked.length ? `导出格式已保存：${got}` : `一个都没勾 —— 已改回默认：${got}`, 'green');
      } catch (e) { toast(`没保存上：${e.message || ''}`, 'red'); }
      draw();
    });

    // 开发页签
    on('#dev-save', async () => {
      const id = ((q('#dev-cap-id') || {}).value || '').trim();
      const name = ((q('#dev-cap-name') || {}).value || '').trim();
      const kind = ((q('#dev-cap-kind') || {}).value || 'compute');
      const code = (q('#dev-cap-code') || {}).value || '';
      S.note = '保存中…'; draw();
      try {
        const r = await api('POST', '/api/capabilities/dev/save', { id, name, kind, code });
        S.note = r.ok ? `已注册能力「${r.id}」` : `没注册上：${r.error || ''}`;
        if (r.ok) toast(`能力「${r.id}」已注册（能力搭建里可以用它了）`, 'green');
        await load();
      } catch (e) { S.note = `没注册上：${e.message || ''}`; draw(); }
    });
    const runDev = async (id) => {
      let input = {};
      try { input = JSON.parse((q('#dev-input') || {}).value || '{}'); } catch { input = {}; }
      S.note = `试跑 ${id} …`; draw();
      try {
        const r = await api('POST', '/api/capabilities/dev/run', { id, input });
        S.note = r.ok ? `试跑成功：${JSON.stringify(r.output).slice(0, 160)}` : `试跑失败：${r.error || ''}`;
      } catch (e) { S.note = `试跑失败：${e.message || ''}`; }
      draw();
    };
    on('#dev-run', () => runDev(((q('#dev-cap-id') || {}).value || '').trim()));
    onAll('[data-dev-run]', (e) => runDev(e.currentTarget.dataset.devRun));
    onAll('[data-dev-load]', async (e) => {
      try {
        const r = await readJson('/api/capabilities/dev?id=' + encodeURIComponent(e.currentTarget.dataset.devLoad));
        q('#dev-cap-id').value = r.id || '';
        q('#dev-cap-name').value = r.name || '';
        q('#dev-cap-kind').value = r.kind || 'compute';
        q('#dev-cap-code').value = r.code || '';
        S.note = `已打开 ${r.id}`; draw();
        q('#dev-cap-id').value = r.id || '';
        q('#dev-cap-name').value = r.name || '';
        q('#dev-cap-code').value = r.code || '';
      } catch (err) { S.note = `打不开：${err.message || ''}`; draw(); }
    });
  }

  await load();
  if (ctx.applyLayout) { /* 由页面按钮触发，这里不主动重排 */ }
  // 给外部一个"切到某个页签"的入口（导航里点"数据源"时会被指到这里）
      window.__cairnSettings = { open: (tabId) => { S.tab = tabId || 'sources'; draw(); } };
}
