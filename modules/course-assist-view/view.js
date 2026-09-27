// 模块：课程辅助（course-assist-view）—— **自己的一页**（kind: view）。
//
// 与其他模块同一套规矩：`renderPage()` 是纯函数（可测），`mount()` 负责交互；
// 页面只调两个接口 —— `GET /api/course`（状态与产物）、`POST /api/localdirs`（改目录）、
// `POST /api/modules/course-assist/run`（跑功能，**默认演练**）。

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (m) => ({
  '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
}[m]));

/** `<数据目录>/study` —— 产物目录（跨平台：看数据目录用的是哪种分隔符）。 */
export function studyDirOf(dataDir) {
  const d = String(dataDir || '').replace(/[\\/]+$/, '');
  if (!d) return '';
  const sep = d.includes('\\') ? '\\' : '/';
  return `${d}${sep}study`;
}

/** 六项能力各自的进度（如实写：没做的就写"计划中"）。 */
export const ABILITIES = [
  { n: '①', name: '资料信息整理整合', out: 'material-index.md', done: true, note: '按课程/周次列材料 + 类型 + 关键词' },
  { n: '②', name: '作业时间估算', out: 'weekly-workload.md', done: false, note: '按题量与类型的经验估算，样本不足会明说' },
  { n: '③', name: '每周巩固文件', out: 'week-N-巩固.md', done: false, note: '考点清单 + 例题 + 易错点 + 自测题' },
  { n: '④', name: '常见错误总结', out: 'common-errors.md', done: false, note: '要等错题本有料（期中前后）' },
  { n: '⑤', name: '考前"抱佛脚"', out: 'cram-<考试名>.md', done: false, note: '按考前 7/3/1 天三档给出' },
  { n: '⑥', name: '练习反馈', out: 'practice-feedback.md', done: false, note: '自己写反馈 → 指到"具体哪个概念不会"' },
];

const fmtSize = (n) => (n >= 1048576 ? `${(n / 1048576).toFixed(1)} MB` : `${Math.max(1, Math.round((n || 0) / 1024))} KB`);

// ---------- 「⚙ 功能设置」抽屉里的内容（2026-09-27）----------
// 主程序只负责"把抽屉滑出来"，这一页到底有哪些设置由**这个模块自己**说 ——
// 所以"能用的变量"和"默认模板"都从 /api/fn-settings 拿（服务端声明是唯一来源，不在前端再抄一份）。
// 下面两个 render 都是纯函数：给一份数据 → 一段 HTML，方便对着真实数据测。

/** 实时预览那一段（拿你自己台账里的材料名算的）。 */
export function renderNamePreview(p = null) {
  if (!p || !Array.isArray(p.samples) || !p.samples.length) {
    return '<div class="dim">改上面的模板，这里会立刻显示"你的文件会变成什么样"。</div>';
  }
  const counts = p.counts || {};
  return `<div class="dim">按这个模板，材料会叫：</div>`
    + p.samples.map((s) => `<div class="fn-preview-row">
        <div class="fn-preview-from">${esc(s.from)}</div>
        <div class="fn-preview-to">${esc(s.to)}</div>
        ${s.course ? `<div class="dim">${esc(s.course)}${s.sample ? ' · 样例' : ''}</div>` : ''}
      </div>`).join('')
    + (counts.ledger
      ? `<div class="dim" style="margin-top:6px">台账里 ${counts.ledger} 份材料，按这个模板有 <b>${counts.would_rename}</b> 份名字会变。</div>`
      : '')
    + (p.warnings || []).map((w) => `<div class="fn-warn">⚠️ ${esc(w)}</div>`).join('');
}

/** 抽屉整段（纯函数）。 */
export function renderSettings(p = {}) {
  const dir = p.dir || '';
  const vars = Array.isArray(p.vars) ? p.vars : [];
  const scope = p.scope === 'all' ? 'all' : 'future';
  const note = p.note || '';
  return `
    <div class="fn-section">
      <div class="fn-section-title">① 课程资料放在哪</div>
      <div class="dim" style="margin-bottom:8px">
        课件下载到这里，下面按课程分子文件夹。和「本机目录 → 课程资料目录」、
        课程辅助页上那个框是<b>同一处</b>，改哪边都一样、都是立刻生效。
      </div>
      <input id="ca-set-dir" value="${esc(dir)}" placeholder="例如 桌面\\FA26课程资料" style="width:100%" />
      <div class="dim" style="margin-top:6px">${p.dirExists === false ? '⚠️ 这个目录现在不在了（下面保存前先确认）' : (dir ? '' : '还没设置 → 会用桌面上的默认文件夹')}</div>
      <div class="flex" style="gap:8px;flex-wrap:wrap;margin-top:8px">
        <button class="btn small" id="ca-set-pick">📂 选择文件夹…</button>
        <button class="btn small primary" id="ca-set-dir-save">保存</button>
      </div>
    </div>

    <div class="fn-section">
      <div class="fn-section-title">② 文件怎么命名</div>
      <div class="dim">点一个变量就插到光标处；扩展名（.pdf / .docx…）自动保留，不用写。</div>
      <div class="fn-vars">${vars.map((v) => `<button class="fn-var" data-ca-var="${esc(v.key)}" title="${esc(v.note || '')}">{${esc(v.key)}}</button>`).join('')}</div>
      <input id="ca-set-tpl" value="${esc(p.template || '')}" placeholder="例如 {课程号}_{原名}" style="width:100%;font-family:var(--font-mono,monospace)" />
      <div class="fn-preview" id="ca-set-preview">${renderNamePreview(p.preview)}</div>
      <div class="fn-scope">
        <label><input type="radio" name="ca-scope" value="future" ${scope === 'future' ? 'checked' : ''} style="width:auto;margin-top:3px" />
          <span><b>只影响以后</b><div class="dim">已经躺在文件夹里的材料不动</div></span></label>
        <label><input type="radio" name="ca-scope" value="all" ${scope === 'all' ? 'checked' : ''} style="width:auto;margin-top:3px" />
          <span><b>顺便把已有材料也改名</b><div class="dim">按新模板重命名现在文件夹里的材料（撞名的挪进「_重名或重复（可删）」）</div></span></label>
      </div>
      <div class="flex" style="gap:8px;flex-wrap:wrap;align-items:center;margin-top:10px">
        <button class="btn small primary" id="ca-set-save">保存</button>
        <button class="btn small" id="ca-set-reset" ${p.defaultTpl ? '' : 'disabled'}>恢复默认</button>
        <span class="dim" id="ca-set-note">${esc(note)}</span>
      </div>
      <div id="ca-set-apply" class="dim" style="margin-top:8px"></div>
    </div>`;
}

/** 抽屉的接线：读当前值 → 画 → 实时预览（敲完停 180ms 算一次，不每键一发）→ 存。 */
export async function settings(host, ctx = {}) {
  const { api, toast = () => {}, reloadPage = () => {} } = ctx;
  const state = { dir: '', dirExists: true, template: '', vars: [], defaultTpl: '', preview: null, scope: 'future', note: '' };
  let timer = null;
  const draw = () => { host.innerHTML = renderSettings(state); bind(); };
  const setNote = (t) => { state.note = t; const n = host.querySelector('#ca-set-note'); if (n) n.textContent = t || ''; };

  async function refreshPreview() {
    try {
      state.preview = await api('POST', '/api/fn-settings/preview', { fn: 'course_assist', template: state.template });
    } catch { state.preview = null; }
    const box = host.querySelector('#ca-set-preview');
    if (box) box.innerHTML = renderNamePreview(state.preview);
  }

  async function load() {
    try {
      const [fns, dirs] = await Promise.all([api('GET', '/api/fn-settings'), api('GET', '/api/localdirs')]);
      const f = ((fns && fns.functions) || {}).course_assist || {};
      const field = (f.fields || []).find((x) => x.key === 'name_template') || {};
      state.vars = field.vars || [];
      // 默认模板不在前端再抄一份：服务端声明是唯一来源（抄一份迟早会跟 lib/naming.mjs 分叉）
      state.defaultTpl = (f.defaults || {}).name_template || field.default || '';
      state.template = (f.values || {}).name_template || state.defaultTpl;
      state.scope = (f.values || {}).rename_scope === 'all' ? 'all' : 'future';
      const d = ((dirs && dirs.dirs) || {}).course || {};
      state.dir = d.dir || '';
      state.dirExists = d.exists !== false;
    } catch (e) {
      host.innerHTML = `<div class="empty">读不到设置：${esc((e && e.message) || '')}</div>`;
      return;
    }
    await refreshPreview();
    draw();
  }

  function bind() {
    const tpl = host.querySelector('#ca-set-tpl');
    if (tpl) {
      tpl.oninput = () => {
        state.template = tpl.value;
        if (timer) clearTimeout(timer);
        timer = setTimeout(refreshPreview, 180);      // 停手 180ms 再算，别每敲一个字打一次服务
      };
    }
    host.querySelectorAll('[data-ca-var]').forEach((b) => {
      b.onclick = () => {
        const token = `{${b.dataset.caVar}}`;
        const el = host.querySelector('#ca-set-tpl');
        if (!el) return;
        const at = el.selectionStart == null ? el.value.length : el.selectionStart;
        el.value = el.value.slice(0, at) + token + el.value.slice(el.selectionEnd == null ? at : el.selectionEnd);
        el.focus();
        el.setSelectionRange(at + token.length, at + token.length);
        state.template = el.value;
        if (timer) clearTimeout(timer);
        timer = setTimeout(refreshPreview, 60);
      };
    });
    host.querySelectorAll('input[name="ca-scope"]').forEach((r) => { r.onchange = () => { state.scope = r.value; }; });

    const dirInput = host.querySelector('#ca-set-dir');
    const pick = host.querySelector('#ca-set-pick');
    if (pick) pick.onclick = async () => {
      pick.textContent = '⏳ 等你在弹出的窗口里选…';
      let r = null;
      try { r = await api('POST', '/api/localdirs/pick', { key: 'course' }); }
      catch (e) { pick.textContent = '📂 选择文件夹…'; toast(`选择框没能打开：${e.message || ''}——可以直接把路径粘到输入框`, 'red'); return; }
      pick.textContent = '📂 选择文件夹…';
      if (!r || !r.dir) { toast((r && r.error) || '没有选择文件夹', r && r.error ? 'red' : ''); return; }
      if (dirInput) dirInput.value = r.dir;
      await saveDir(r.dir);
    };
    const dirSave = host.querySelector('#ca-set-dir-save');
    if (dirSave) dirSave.onclick = () => saveDir(dirInput ? dirInput.value.trim() : '');

    const save = host.querySelector('#ca-set-save');
    if (save) save.onclick = async () => {
      setNote('保存中…');
      try {
        await api('POST', '/api/fn-settings', { fn: 'course_assist', patch: { name_template: state.template, rename_scope: state.scope } });
        setNote('已保存');
        toast('课程辅助的命名规则已保存', 'green');
        await refreshPreview();
        await reloadPage('course-assist-view');
        if (state.scope === 'all') await planRename();
      } catch (e) { setNote(''); toast(`没保存上：${e.message || ''}`, 'red'); }
    };
    const reset = host.querySelector('#ca-set-reset');
    if (reset) reset.onclick = async () => {
      state.template = state.defaultTpl;
      const el = host.querySelector('#ca-set-tpl');
      if (el) el.value = state.defaultTpl;
      await refreshPreview();
      setNote('已填回默认模板，别忘了点保存');
    };
  }

  async function saveDir(dir) {
    setNote('保存目录中…');
    try {
      await api('POST', '/api/localdirs', { key: 'course', dir });
      state.dir = dir;
      state.dirExists = true;
      setNote('目录已保存');
      toast(dir ? '课程资料文件夹已更新' : '已清空课程资料文件夹', 'green');
      await reloadPage('course-assist-view');
      draw();
    } catch (e) { setNote(''); toast(`没保存上：${e.message || ''}`, 'red'); }
  }

  // 「顺便把已有材料也改名」= 先跑一次**演练**（dry run），把"要改几个"如实摆出来，
  // 由用户再点一下才真改 —— 改名是不可逆的，不该藏在"保存"后面。
  async function planRename() {
    const box = host.querySelector('#ca-set-apply');
    if (box) box.innerHTML = '<div class="dim">正在算"哪些文件要改名"（不会动任何文件）…</div>';
    try {
      const r = await api('POST', '/api/course-sync/rename', { dry_run: true });
      const ren = ((r.desktop || {}).renamed || []);
      const dev = ((r.device || {}).renamed || []);
      if (!ren.length && !dev.length) { if (box) box.innerHTML = '<div class="dim">现有文件已经都符合这个模板，不用改。</div>'; return; }
      if (box) {
        box.innerHTML = `<div>演练：桌面 <b>${ren.length}</b> 个文件、办公本 <b>${dev.length}</b> 个条目要改名：</div>`
          + ren.slice(0, 3).map((x) => `<div class="fn-preview-row"><div class="fn-preview-from">${esc(x.from)}</div><div class="fn-preview-to">${esc(x.to)}</div></div>`).join('')
          + `<button class="btn small primary" id="ca-set-apply-go" style="margin-top:8px">现在改（${ren.length} 个）</button>`;
        const go = host.querySelector('#ca-set-apply-go');
        if (go) go.onclick = async () => {
          go.textContent = '改名中…';
          try {
            const done = await api('POST', '/api/course-sync/rename', {});
            const d = ((done.desktop || {}).renamed || []).length;
            const m = ((done.desktop || {}).moved || []).length;
            const dv = ((done.device || {}).renamed || []).length;
            box.innerHTML = `<div>已改名：桌面 ${d} 个 · 挪走重复 ${m} 个 · 办公本 ${dv} 个。</div>`;
            toast('已有材料已按新模板改名', 'green');
            await reloadPage('course-assist-view');
          } catch (e) { go.textContent = '现在改'; toast(`改名失败：${e.message || ''}`, 'red'); }
        };
      }
    } catch (e) {
      if (box) box.innerHTML = `<div class="dim">算不出来：${esc(e.message || '')}（可以先点课程辅助页上的「统一命名（预览）」）</div>`;
    }
  }

  await load();
}

export function renderAbilityRow(a = {}) {
  return `<tr>
    <td><span class="pill ${a.done ? 'status' : 'pending'}">${a.done ? '已有' : '计划中'}</span></td>
    <td>${esc(a.n)} ${esc(a.name)}<div class="dim">${esc(a.note || '')}</div></td>
    <td><code>${esc(a.out)}</code></td>
  </tr>`;
}

export function renderOutputs(outputs = [], studyDir = '') {
  if (!outputs.length) {
    return '<div class="empty">还没生成过东西。第一次建议先点「生成资料索引（演练）」，看看会写到哪。</div>';
  }
  return `<table class="table">
    <thead><tr><th>文件</th><th>大小</th><th>生成时间</th></tr></thead>
    <tbody>${outputs.map((o) => `<tr>
      <td><code>${esc(o.name)}</code></td>
      <td>${esc(fmtSize(o.size))}</td>
      <td>${esc(String(o.mtime || '').slice(0, 16).replace('T', ' '))}</td>
    </tr>`).join('')}</tbody>
  </table>
  <div class="dim" style="margin-top:6px">目录：<code>${esc(studyDir)}</code>（不进仓库、不进任何分享包）</div>`;
}

/** 搜索结果（纯函数）：说清"在哪门课、哪个文件、第几段附近"。 */
export function renderHits(hits = []) {
  if (!hits.length) return '<div class="empty">没找到。换个说法再试（它是**逐字**找的，不猜同义词）。</div>';
  return `<div class="list">${hits.map((h) => `<div class="list-item">
    <div class="title">${esc(h.name)} <span class="muted">${esc(h.course)}</span></div>
    <div class="meta">${h.where === '文件名' ? '命中的是**文件名**' : (h.segment ? `第 ${h.segment} 段（≈第 ${h.segment} 页）附近` : '正文命中')} · ${esc(h.context || '')}</div>
  </div>`).join('')}</div>`;
}

/** 整页（纯函数）。 */
export function renderPage(payload = {}) {
  const dir = payload.dir?.dir || '';
  const studyDir = payload.study_dir || '';
  const run = payload.last_run || null;
  const mats = Array.isArray(payload.materials) ? payload.materials : [];
  const lastLine = run
    ? `上次运行：${esc(String(run.at || '').slice(11, 16))} · ${esc(run.summary || '')}${run.dry_run ? '（演练）' : ''}`
    : '还没有跑过。';

  return `
    <div class="card">
      <div class="between" style="flex-wrap:wrap;gap:8px">
        <h3 style="margin:0">📚 课程辅助 <span class="muted">把课件变成能直接拿去学的东西</span></h3>
        <span class="dim">${dir ? '资料目录已设置' : '还没设置资料目录'}${payload.dir?.exists === false ? ' · ⚠️ 但目录不在了' : ''}</span>
      </div>
      <div class="dim" style="margin-top:6px">
        选一个**课程资料文件夹**（里面按课程分子文件夹，例如 <code>MATH1860J 高等数学B1/</code>）。
        这一页只读你的课件，不改名、不移动；产物写在 <code>${esc(studyDir || '<数据目录>\\study')}</code>。
      </div>
      <div class="dim" style="margin-top:6px">
        文件命名：<code>${esc(payload.name_template || '（默认规则）')}</code>
        —— 想换一种叫法（或顺手把已有材料改名）在右上角 <b>⚙ 功能设置</b> 里改。
      </div>
      <div class="flex" style="gap:8px;flex-wrap:wrap;margin-top:12px">
        <input id="ca-dir" placeholder="课程资料文件夹，例如 桌面\\FA26课程资料" value="${esc(dir)}" style="flex:1;min-width:280px" />
        <button class="btn small primary" id="ca-save">保存目录</button>
        <button class="btn small" id="ca-pick">📂 选择文件夹…</button>
      </div>
    </div>

    <div class="card mt">
      <h3>生成 <span class="muted">演练不写任何文件，只告诉你"会写到哪"</span></h3>
      <div class="flex" style="gap:10px;flex-wrap:wrap;align-items:center;margin-top:8px">
        <button class="btn small" id="ca-dry">生成资料索引（演练）</button>
        <button class="btn small primary" id="ca-run">生成（真写）</button>
        <button class="btn small" id="ca-open">📁 打开输出文件夹</button>
        <span class="dim" id="ca-status"></span>
      </div>
      <div class="flex" style="gap:10px;flex-wrap:wrap;align-items:center;margin-top:8px">
        <button class="btn small" id="ca-week-dry">生成第 ${esc(payload.week || '?')} 周巩固包（演练）</button>
        <button class="btn small" id="ca-week-run">生成第 ${esc(payload.week || '?')} 周巩固包（真写）</button>
        <span class="dim">${payload.week ? `按校历算，现在是第 ${esc(payload.week)} 周` : '还没设校历 → 暂时不知道是第几周（生成时会提醒）'}</span>
      </div>
      <div class="dim" style="margin-top:8px">${lastLine}</div>
      <pre id="ca-result" class="dim" style="display:none;white-space:pre-wrap;max-height:260px;overflow:auto;margin-top:8px"></pre>
    </div>

    <div class="card mt">
      <h3>在课件里找一段话 <span class="muted">这道题 / 这个说法在哪份材料里</span></h3>
      <div class="flex" style="gap:8px;flex-wrap:wrap;margin-top:8px">
        <input id="ca-q" placeholder="例如 exercise 3 / 泰勒展开 / Lagrange remainder" style="flex:1;min-width:260px" />
        <button class="btn small primary" id="ca-search">找一下</button>
        <span class="dim" id="ca-search-status"></span>
      </div>
      <div id="ca-hits" style="margin-top:10px"></div>
    </div>

    <div class="card mt">
      <h3>📐 公式转 LaTeX <span class="muted">把课件里的数学还原成能读、能搜的 Markdown</span></h3>
      <div class="dim" style="margin-top:6px">
        PDF 里的公式是"排版成品"，直接抽文字会丢空格、把 ¬∧∨→ 变成近似符号。这里把抽出来的文字交给
        <b>你自己的 agent</b> 还原成 Markdown + LaTeX（行内 <code>$...$</code>、独立 <code>$$...$$</code>），
        结果写在 <code>${esc(studyDir || '<数据目录>\\study')}\\&lt;材料名&gt;.公式.md</code>。
        <b>扫描件（图片版 PDF）没有文字层，转不了</b> —— 它会直接告诉你，而不是编一段公式出来。
      </div>
      <div class="flex" style="gap:8px;flex-wrap:wrap;margin-top:10px;align-items:center">
        <select id="ca-latex-file" style="flex:1;min-width:320px">
          ${mats.length ? mats.map((m) => `<option value="${esc(m.rel || m.file)}" data-file="${esc(m.file)}" data-course="${esc(m.course)}" data-readable="${m.readable ? '1' : '0'}">${esc(m.course)} · ${esc(m.rel || m.file)}${m.readable ? '' : '（读不出文字）'}</option>`).join('') : '<option value="">（课程资料里还没扫到材料 —— 先在上面配好目录）</option>'}
        </select>
        <button class="btn primary small" id="ca-latex-go" ${mats.length ? '' : 'disabled'}>转成 LaTeX</button>
        <span class="dim" id="ca-latex-status"></span>
      </div>
      <div class="flex" style="gap:8px;flex-wrap:wrap;margin-top:6px;align-items:center">
        <span class="dim">视觉路线（给"文字层是字形编号"的 LaTeX/PPT 版 PDF 用）：第</span>
        <input type="number" id="ca-latex-from" value="1" min="1" style="width:70px" />
        <span class="dim">到</span>
        <input type="number" id="ca-latex-to" value="2" min="1" style="width:70px" />
        <span class="dim">页</span>
        <button class="btn small" id="ca-latex-vision" ${mats.length ? '' : 'disabled'}>🖼 用视觉读（渲染成图再转）</button>
        <span class="dim">每页一次调用，一次最多 5 页</span>
      </div>
      ${payload.materials_error ? `<div class="fn-warn">⚠️ ${esc(payload.materials_error)}</div>` : ''}
      <div id="ca-latex-out" style="margin-top:10px"></div>
    </div>

    <div class="card mt">
      <h3>已生成的文件 <span class="muted">${(payload.outputs || []).length} 个</span></h3>
      <div style="margin-top:8px">${renderOutputs(payload.outputs || [], studyDir)}</div>
    </div>

    <div class="card mt">
      <h3>六项能力 <span class="muted">按计划推进，做到哪写到哪</span></h3>
      <table class="table" style="margin-top:8px">
        <thead><tr><th>状态</th><th>能力</th><th>产物</th></tr></thead>
        <tbody>${ABILITIES.map(renderAbilityRow).join('')}</tbody>
      </table>
    </div>`;
}

export async function mount(el, ctx = {}) {
  const { api, toast = () => {} } = ctx;
  let payload = {};
  const draw = () => { el.innerHTML = renderPage(payload); bind(); };
  const status = (t) => { const s = el.querySelector('#ca-status'); if (s) s.textContent = t || ''; };
  const showResult = (text) => {
    const pre = el.querySelector('#ca-result');
    if (pre) { pre.textContent = text; pre.style.display = ''; }
  };

  async function load() {
    try {
      payload = await api('GET', '/api/course');
    } catch { payload = {}; }
    // 当前生效的命名模板（服务端声明是唯一来源：抽屉里能用的变量也从那边拿）
    try {
      const fns = await api('GET', '/api/fn-settings');
      payload.name_template = (((fns || {}).functions || {}).course_assist || {}).values?.name_template || '';
    } catch { payload.name_template = ''; }
    draw();
  }

  const saveDir = async (dir) => {
    status('保存中…');
    try {
      await api('POST', '/api/localdirs', { key: 'course', dir });
      await load();
      toast(dir ? '课程资料目录已保存' : '已清空课程资料目录', 'green');
    } catch (e) { status(''); toast(`没保存上：${e.message || ''}`, 'red'); }
  };

  function bind() {
    const save = el.querySelector('#ca-save');
    if (save) save.onclick = () => saveDir(el.querySelector('#ca-dir').value.trim());
    const input = el.querySelector('#ca-dir');
    if (input) input.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); saveDir(input.value.trim()); } });

    const pick = el.querySelector('#ca-pick');
    if (pick) pick.onclick = async () => {
      pick.textContent = '⏳ 等你在弹出的窗口里选…';
      let r = null;
      try { r = await api('POST', '/api/localdirs/pick', { key: 'course' }); }
      catch (e) { draw(); toast(`选择框没能打开：${e.message || ''}——可以直接把路径粘到输入框`, 'red'); return; }
      if (!r || !r.dir) { draw(); toast((r && r.error) || '没有选择文件夹', r && r.error ? 'red' : ''); return; }
      await saveDir(r.dir);
    };

    const runOnce = async (dryRun, mode = 'index') => {
      status(dryRun ? '演练中…' : '正在读课件（第一次可能要几十秒）…');
      try {
        const r = await api('POST', '/api/modules/course-assist/run', {
          dry_run: dryRun, input: { mode, week: mode === 'weekly' ? (payload.week || undefined) : undefined },
        });
        status('');
        if (!r.ok) { showResult(`没跑成：${r.error || '未知原因'}`); return; }
        const stats = r.actions?.[0]?.payload?.stats;
        const lines = (r.actions || []).map((a) => `· ${a.type} ${a.status}：${a.summary}${a.target?.path ? `\n  → ${a.target.path}` : ''}`);
        showResult([
          `${r.summary}${dryRun ? '（演练：没有写任何文件）' : ''}`,
          ...lines,
          stats ? `\n可读 ${stats.ok} · 不太清楚 ${stats.low_quality} · 乱码 ${stats.garbled} · 需 OCR ${stats.needs_ocr} · 读不了 ${stats.unreadable} · 不抽文字 ${stats.unsupported}` : '',
        ].filter(Boolean).join('\n'));
        await load();
      } catch (e) { status(''); showResult(`失败：${e.message || ''}`); }
    };
    const dry = el.querySelector('#ca-dry');
    if (dry) dry.onclick = () => runOnce(true);
    const real = el.querySelector('#ca-run');
    if (real) real.onclick = () => runOnce(false);
    const wDry = el.querySelector('#ca-week-dry');
    if (wDry) wDry.onclick = () => runOnce(true, 'weekly');
    const wRun = el.querySelector('#ca-week-run');
    if (wRun) wRun.onclick = () => runOnce(false, 'weekly');

    // 在课件里找一段话：现扫现读（几秒钟），所以给个状态提示
    const doSearch = async () => {
      const q = el.querySelector('#ca-q').value.trim();
      const box = el.querySelector('#ca-hits');
      const st = el.querySelector('#ca-search-status');
      if (!q) { if (st) st.textContent = '先写点要搜的东西'; return; }
      if (st) st.textContent = '正在翻课件（几秒钟）…';
      if (box) box.innerHTML = '';
      try {
        const r = await api('GET', `/api/course/search?q=${encodeURIComponent(q)}`);
        if (st) st.textContent = `翻了 ${r.scanned} 份材料，命中 ${r.hits.length} 处`;
        if (box) box.innerHTML = renderHits(r.hits);
      } catch (e) {
        if (st) st.textContent = '';
        if (box) box.innerHTML = `<div class="empty">没搜成：${esc(e.message || '')}</div>`;
      }
    };
    const searchBtn = el.querySelector('#ca-search');
    if (searchBtn) searchBtn.onclick = doSearch;
    const qInput = el.querySelector('#ca-q');
    if (qInput) qInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); doSearch(); } });

    // 📐 公式转 LaTeX：两条路 —— 读文字层（快、便宜）/ 渲染成图交给视觉模型（救"字形编号"的 PDF）
    const runLatex = async (btn, mode) => {
      const sel = el.querySelector('#ca-latex-file');
      const opt = sel && sel.selectedOptions && sel.selectedOptions[0];
      const rel = sel ? sel.value : '';
      const file = opt ? (opt.dataset.file || rel) : rel;
      const course = opt ? opt.dataset.course : '';
      const out = el.querySelector('#ca-latex-out');
      if (!rel) { if (out) out.innerHTML = '<div class="empty">先选一份课件。</div>'; return; }
      const st = el.querySelector('#ca-latex-status');
      const label = btn.textContent;
      btn.disabled = true;
      btn.textContent = mode === 'vision' ? '渲染 + 读图（每页几十秒）…' : '转写着（可能要几十秒）…';
      if (st) st.textContent = mode === 'vision' ? '正在把页面渲染成图，再让视觉模型读…' : '正在读课件、并让 agent 还原公式…';
      if (out) out.innerHTML = '';
      try {
        const body = { file, rel, course, mode };
        if (mode === 'vision') {
          body.first_page = Number((el.querySelector('#ca-latex-from') || {}).value) || 1;
          body.last_page = Number((el.querySelector('#ca-latex-to') || {}).value) || body.first_page;
        }
        const r = await api('POST', '/api/course/latex', body);
        if (!r.ok) {
          if (st) st.textContent = '';
          if (out) out.innerHTML = `<div class="fn-warn">⚠️ ${esc(r.error || '没转成')}</div>`
            + (r.suggest_vision ? '<div class="dim" style="margin-top:6px">👉 这份 PDF 的文字层救不回来 —— 用下面的「🖼 用视觉读」：把页面渲染成图，让视觉模型看着图转。</div>' : '')
            + (r.how_to ? `<div class="dim" style="margin-top:6px">${esc(r.how_to)}</div>` : '')
            + (r.level === 'blocked' && !r.suggest_vision && !r.how_to ? '<div class="dim" style="margin-top:6px">退路：把这几页截图发到 Codex 里，让它看着图转 —— 那属于"视觉模型"的活，比 OCR 更靠谱。</div>' : '');
        } else {
          // 先重画（load 会把整页重画，顺带刷新"已生成的文件"），**再**写结果 ——
          // 反过来写会被 load() 冲掉（2026-09-27 真机看到：跑成功了但卡片里空着）。
          await load();
          const st2 = el.querySelector('#ca-latex-status');
          const out2 = el.querySelector('#ca-latex-out');
          if (st2) st2.textContent = `已写到 ${r.out}`;
          if (out2) out2.innerHTML = `
            <div class="dim">${esc(r.note || '')}</div>
            <div class="dim" style="margin-top:4px">${r.mode === 'vision'
              ? `读了第 ${(r.pages || []).join('、')} 页`
              : `原文 ${r.chars} 字${r.truncated ? '（只转了前面一段）' : ''}`} · 产物 <code>${esc(r.out)}</code></div>
            <pre class="dim" style="white-space:pre-wrap;max-height:320px;overflow:auto;margin-top:8px">${esc(r.markdown || '')}</pre>`;
        }
      } catch (e) {
        if (st) st.textContent = '';
        if (out) out.innerHTML = `<div class="fn-warn">⚠️ ${esc(e.message || '失败')}</div>`;
      }
      btn.disabled = false;
      btn.textContent = label;
    };
    const latexBtn = el.querySelector('#ca-latex-go');
    if (latexBtn) latexBtn.onclick = () => runLatex(latexBtn, 'text');
    const visionBtn = el.querySelector('#ca-latex-vision');
    if (visionBtn) visionBtn.onclick = () => runLatex(visionBtn, 'vision');

    const open = el.querySelector('#ca-open');
    if (open) open.onclick = async () => {
      const d = payload.study_dir || studyDirOf('');
      if (!d) { toast('还不知道产物目录在哪', 'red'); return; }
      try { await api('POST', '/api/mobile/open-folder', { dir: d }); toast('已打开：' + d, 'green'); }
      catch (e) { toast('打不开：' + (e.message || d), 'red'); }
    };
  }

  await load();
}
