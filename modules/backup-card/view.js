// 模块：数据备份（backup-card）—— 挂在「统计」页。与其它模块同一套：renderCard 纯函数 + mount 交互。

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (m) => ({
  '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
}[m]));

const fmtSize = (n) => (n >= 1048576 ? `${(n / 1048576).toFixed(1)} MB` : `${Math.max(1, Math.round((n || 0) / 1024))} KB`);

/** 快照清单（纯函数）。 */
export function renderFiles(files = []) {
  if (!files.length) return '<div class="empty">还没有快照。点一次「立即备份（真备）」就有了。</div>';
  return `<table class="table">
    <thead><tr><th>快照</th><th>大小</th><th>时间</th></tr></thead>
    <tbody>${files.map((f) => `<tr>
      <td><code>${esc(f.name)}</code></td><td>${esc(fmtSize(f.size))}</td>
      <td>${esc(String(f.mtime || '').slice(0, 16).replace('T', ' '))}</td>
    </tr>`).join('')}</tbody></table>`;
}

/** 整张卡（纯函数）。 */
export function renderCard(payload = {}) {
  const prefs = payload.prefs || {};
  const last = payload.last || null;
  const lastLine = last
    ? `上次备份：${esc(String(last.at || '').slice(0, 16).replace('T', ' '))}${last.bytes ? ` · ${esc(fmtSize(last.bytes))}` : ''}`
    : '还没有备份过。';

  return `
    <div class="card mt" id="backup-card">
      <div class="between" style="flex-wrap:wrap;gap:8px">
        <h3 style="margin:0">💾 数据备份 <span class="muted">全部数据就在一个文件里，坏一次就全没</span></h3>
        <span class="dim">${prefs.enabled ? `每 ${esc(prefs.every_hours ?? 24)} 小时 · 留 ${esc(prefs.keep ?? 7)} 份` : '已关闭'} · 现有 ${(payload.files || []).length} 份 / ${esc(fmtSize(payload.bytes || 0))}</span>
      </div>
      <div class="dim" style="margin-top:6px">
        用 SQLite 自带的 VACUUM INTO 存一份**一致**快照（不会拷到写了一半的库）；库里没变过就不重复备。
        把备份目录指到**网盘同步文件夹**，就得到一份离开这台机器的副本 —— 不需要任何云账号。
      </div>
      <details style="margin-top:8px">
        <summary class="dim" style="cursor:pointer">出事时怎么恢复？（点开看三步）</summary>
        <ol class="dim" style="margin:6px 0 0 18px;padding:0">
          <li>先退出应用（托盘右键退出 / 关掉那个黑窗口，等 5 秒）。</li>
          <li>把要用的那份快照复制进数据目录，改名成 <code>codex-planner.db</code>，覆盖原来那个；
              顺手把同目录的 <code>codex-planner.db-wal</code>、<code>-shm</code> 也清掉（它们是旧库的残留）。</li>
          <li>重新启动应用 → 用「统计」页的条数对一眼（任务 / 通知 数量应该跟快照时间点一致）。</li>
        </ol>
        <div class="dim" style="margin-top:6px">
          ⚠️ 快照里**只有数据库**：里面的凭据是加密的，密钥在同目录的 <code>.secret.key</code>。
          换台机器恢复时要带上那把密钥，否则数据都在、只是凭据要重新填一次。密钥**不建议**跟快照一起丢上网盘。
        </div>
      </details>

      <div class="flex" style="gap:10px;flex-wrap:wrap;align-items:center;margin-top:10px">
        <label class="dim" style="display:flex;align-items:center;gap:6px">
          <input type="checkbox" id="bk-enabled" ${prefs.enabled ? 'checked' : ''} style="width:auto" />自动备份
        </label>
        <label class="dim" style="display:flex;align-items:center;gap:6px">
          每 <input type="number" id="bk-every" min="1" max="336" value="${esc(prefs.every_hours ?? 24)}" style="width:70px" /> 小时
        </label>
        <label class="dim" style="display:flex;align-items:center;gap:6px">
          留 <input type="number" id="bk-keep" min="1" max="60" value="${esc(prefs.keep ?? 7)}" style="width:60px" /> 份
        </label>
        <button class="btn small primary" id="bk-save">保存</button>
      </div>

      <div class="flex" style="gap:8px;flex-wrap:wrap;margin-top:10px">
        <input id="bk-dir" placeholder="备份目录（留空 = 数据目录下的 backups）" value="${esc(prefs.dir || payload.dir || '')}" style="flex:1;min-width:260px" />
        <button class="btn small" id="bk-dir-pick">📂 选择文件夹…</button>
        <button class="btn small" id="bk-open">📁 打开备份文件夹</button>
      </div>

      <div class="flex" style="gap:10px;flex-wrap:wrap;align-items:center;margin-top:10px">
        <button class="btn small" id="bk-dry">立即备份（演练）</button>
        <button class="btn small primary" id="bk-run">立即备份（真备）</button>
        <span class="dim" id="bk-status"></span>
      </div>
      <div class="dim" style="margin-top:6px">${lastLine}</div>
      <pre id="bk-result" class="dim" style="display:none;white-space:pre-wrap;max-height:160px;overflow:auto;margin-top:6px"></pre>

      <div style="margin-top:12px">
        <div class="dim" style="margin-bottom:6px">现有快照（只列最近 20 份）</div>
        ${renderFiles(payload.files || [])}
      </div>
    </div>`;
}

export async function mount(el, ctx = {}) {
  const { api, toast = () => {} } = ctx;
  let payload = {};
  const draw = () => { el.innerHTML = renderCard(payload); bind(); };
  const status = (t) => { const s = el.querySelector('#bk-status'); if (s) s.textContent = t || ''; };
  const showResult = (t) => { const p = el.querySelector('#bk-result'); if (p) { p.textContent = t; p.style.display = ''; } };

  async function load() {
    try { payload = await api('GET', '/api/backups'); } catch { payload = {}; }
    draw();
  }

  function bind() {
    const val = (sel, d) => { const n = el.querySelector(sel); const v = Number(n && n.value); return Number.isFinite(v) ? v : d; };
    const chk = (sel) => { const n = el.querySelector(sel); return !!(n && n.checked); };

    const save = el.querySelector('#bk-save');
    if (save) save.onclick = async () => {
      status('保存中…');
      try {
        payload = await api('POST', '/api/backups', {
          prefs: { enabled: chk('#bk-enabled'), every_hours: val('#bk-every', 24), keep: val('#bk-keep', 7) },
        });
        draw();
        toast('备份设置已保存', 'green');
      } catch (e) { status(''); toast(`没保存上：${e.message || ''}`, 'red'); }
    };

    const pick = el.querySelector('#bk-dir-pick');
    if (pick) pick.onclick = async () => {
      pick.textContent = '⏳ 等你在弹出的窗口里选…';
      let r = null;
      try { r = await api('POST', '/api/localdirs/pick', { initial: payload.dir || '' }); }
      catch (e) { draw(); toast(`选择框没能打开：${e.message || ''}——可以直接把路径粘到输入框`, 'red'); return; }
      if (!r || !r.dir) { draw(); toast((r && r.error) || '没有选择文件夹', r && r.error ? 'red' : ''); return; }
      try {
        payload = await api('POST', '/api/backups', { prefs: { dir: r.dir } });
        draw();
        toast('备份目录已改：' + r.dir, 'green');
      } catch (e) { draw(); toast('没改成：' + (e.message || ''), 'red'); }
    };
    const dirInput = el.querySelector('#bk-dir');
    if (dirInput) dirInput.addEventListener('keydown', async (e) => {
      if (e.key !== 'Enter') return;
      e.preventDefault();
      try {
        payload = await api('POST', '/api/backups', { prefs: { dir: dirInput.value.trim() } });
        draw();
        toast('备份目录已更新', 'green');
      } catch (err) { toast('没改成：' + (err.message || ''), 'red'); }
    });

    const open = el.querySelector('#bk-open');
    if (open) open.onclick = async () => {
      const d = payload.auto_dir || payload.dir;
      if (!d) { toast('还不知道备份目录在哪', 'red'); return; }
      try { await api('POST', '/api/mobile/open-folder', { dir: d }); toast('已打开：' + d, 'green'); }
      catch (e) { toast('打不开：' + (e.message || d), 'red'); }
    };

    const runOnce = async (dryRun) => {
      status(dryRun ? '演练中…' : '备份中…');
      try {
        const r = await api('POST', '/api/backups/run', { dry_run: dryRun });
        status('');
        if (!r.ok) { showResult(`没跑成：${r.error || '未知原因'}`); return; }
        showResult([
          r.ran ? `已备份：${r.file}（${fmtSize(r.bytes)}）${(r.pruned || []).length ? ` · 清掉 ${r.pruned.length} 份旧的` : ''}`
            : `没有备份：${r.reason || ''}${r.file ? `\n会写到：${r.file}` : ''}`,
        ].join('\n'));
        await load();
      } catch (e) { status(''); showResult('失败：' + (e.message || '')); }
    };
    const dry = el.querySelector('#bk-dry');
    if (dry) dry.onclick = () => runOnce(true);
    const real = el.querySelector('#bk-run');
    if (real) real.onclick = () => runOnce(false);
  }

  await load();
}
