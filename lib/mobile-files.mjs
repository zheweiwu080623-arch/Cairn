// mobile-files.mjs —— 手机端「文件」页（/f/<token>/）：不插线地跟平板互相传文件。
//
// 场景（2026-10-08）：平板与电脑之间一直是"MTP 拖拽"或"邮件附件"，前者要插线、后者有 20 MB 上限。
// 这里给局域网小服务加一个页面：平板浏览器打开就能
//   ① 下载电脑这份目录里的文件（GET  dl/<名字>）
//   ② 把平板上的文件传回电脑这份目录（POST up/<名字>，请求体就是文件字节）
//
// 安全边界（与只读小服务的其它路径一致，由 lib/mobile-server.mjs 统一把 token 关）：
//   * token 不对 → 404（连"这个路径存在"都不告诉外面）
//   * **只在一个目录里读写**，不递归、不出目录：文件名必须是单个路径段；
//     隐藏文件（`.` 开头）既不列、也不许下载或上传（免得碰到 .git / 凭据文件）
//   * 单文件大小上限（默认 50 MB，硬上限 200 MB）；超了回 413，不落盘
//   * 上传用"原始字节当请求体"，**不解析 multipart** —— 少一个解析器就少一类漏洞，
//     页面里的 fetch(up/<name>, {method:'POST', body:file}) 正好就是这么发的。

import { mkdirSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { writeFile } from 'node:fs/promises';
import { basename, join } from 'node:path';

export const FILE_MAX_MB_DEFAULT = 50;
/** 再离谱也不给超过这个数（配置写错了也不会把磁盘灌满）。 */
export const FILE_MAX_MB_HARD = 200;

/** 把请求里给的名字洗成可用的文件名；不合法返回 null。 */
export function safeShareName(raw) {
  const name = String(raw ?? '');
  if (!name || name.length > 120) return null;
  if (name !== basename(name)) return null;            // 带 "/" 或 "\" 一律拒
  if (name === '.' || name === '..') return null;
  if (name.startsWith('.')) return null;               // 隐藏文件不碰
  if (/[\\/:*?"<>|]/.test(name)) return null;          // Windows 侧非法字符
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u001f\u007f]/.test(name)) return null; // 控制字符
  if (name !== name.trim()) return null;               // 首尾空格会让同名词打架
  return name;
}

/** 目录里可分享的文件（只看这一层；隐藏文件和子目录都不列）。 */
export function listShareFiles(dir) {
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return [];                                        // 目录还不存在 = 空
  }
  const out = [];
  for (const entry of entries) {
    if (!entry.isFile()) continue;
    const name = safeShareName(entry.name);
    if (!name) continue;
    try {
      const st = statSync(join(dir, entry.name));
      out.push({ name, size: st.size, mtime: st.mtime.toISOString() });
    } catch { /* 刚好被删掉之类，跳过 */ }
  }
  out.sort((a, b) => (a.mtime < b.mtime ? 1 : -1));
  return out;
}

export function ensureShareDir(dir) {
  try { mkdirSync(dir, { recursive: true }); } catch { /* 下面写的时候还会再报一次 */ }
  return dir;
}

/** 写文件；名字不合法/超限/写失败都返回 {ok:false, code, error}。 */
export async function saveShareFile(dir, rawName, buf) {
  const name = safeShareName(rawName);
  if (!name) return { ok: false, code: 400, error: '文件名不合法' };
  ensureShareDir(dir);
  try {
    await writeFile(join(dir, name), buf);
  } catch (e) {
    return { ok: false, code: 500, error: `写入失败：${(e && e.message) || e}` };
  }
  return { ok: true, name, size: buf.length };
}

function esc(s) {
  return String(s ?? '')
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

function humanSize(n) {
  if (!Number.isFinite(n)) return '';
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(0)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}

/**
 * 「文件」页本体。页面里的请求都用**相对路径**（list.json / dl/x / up/x），
 * 因为页面本身就挂在 `/f/<token>/` 下 —— 这样不需要把 token 再写进 JS 里。
 */
export function filePageHtml({ dir, appName = 'Cairn', maxMb = FILE_MAX_MB_DEFAULT, token = '' }) {
  return `<!doctype html><html lang="zh-CN"><head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover" />
<meta name="theme-color" content="#0f1115" />
<title>${esc(appName)} · 文件</title>
<style>
  :root{--bg:#0f1115;--card:#171a21;--card2:#1e222b;--line:#272c37;--fg:#e8eaf2;--dim:#9aa3b5;
        --accent:#7aa2ff;--ok:#3ddc97;--err:#ff6b6b;--r:14px;--pad:14px}
  @media (prefers-color-scheme:light){:root{--bg:#f6f7fb;--card:#fff;--card2:#f1f3f9;--line:#e3e6ef;--fg:#1b1e27;--dim:#6b7387}}
  *{box-sizing:border-box}
  body{margin:0;background:var(--bg);color:var(--fg);
       font:15px/1.55 -apple-system,BlinkMacSystemFont,"HarmonyOS Sans SC","PingFang SC","Microsoft YaHei",sans-serif;
       padding:env(safe-area-inset-top) 0 calc(24px + env(safe-area-inset-bottom))}
  header{position:sticky;top:0;z-index:5;background:var(--bg);padding:12px var(--pad) 8px;
         border-bottom:1px solid var(--line);display:flex;align-items:center;gap:10px}
  header h1{font-size:16px;margin:0;font-weight:600;flex:1}
  header a{color:var(--accent);text-decoration:none;font-size:13px}
  main{padding:var(--pad);display:grid;gap:var(--pad)}
  section{background:var(--card);border:1px solid var(--line);border-radius:var(--r);overflow:hidden}
  section > h2{font-size:13px;margin:0;padding:10px 14px;color:var(--dim);border-bottom:1px solid var(--line);
               font-weight:600;letter-spacing:.02em}
  ul{list-style:none;margin:0;padding:0}
  li{padding:11px 14px;border-bottom:1px solid var(--line);display:flex;gap:10px;align-items:center}
  li:last-child{border-bottom:0}
  li .nm{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
  li .sz{font-size:12px;color:var(--dim);white-space:nowrap}
  li a.dl{color:var(--accent);text-decoration:none;font-size:13px;white-space:nowrap}
  .empty{padding:14px;color:var(--dim);font-size:13px}
  .box{padding:14px;display:grid;gap:10px}
  button{font:inherit;color:inherit;background:var(--card2);border:1px solid var(--line);
         border-radius:10px;padding:10px 14px}
  button.primary{background:#3b6cf6;border-color:#3b6cf6;color:#fff}
  button:disabled{opacity:.5}
  .hint{font-size:12px;color:var(--dim);padding:0 14px 12px;word-break:break-all}
  .msg{font-size:13px;padding:0 14px 12px;color:var(--dim)}
  .msg.ok{color:var(--ok)} .msg.err{color:var(--err)}
  input[type=file]{color:var(--fg);font-size:13px;max-width:100%}
</style></head>
<body>
<header><h1>文件</h1><a href="../p/${esc(token)}/">回到首页</a></header>
<main>
  <section>
    <h2>上传到电脑（${esc(maxMb)} MB 以内）</h2>
    <div class="box">
      <input type="file" id="pick" multiple />
      <button class="primary" id="send">上传</button>
      <div class="hint" id="updir"></div>
    </div>
    <div class="msg" id="msg"></div>
  </section>
  <section>
    <h2>电脑上的文件（点右侧下载）</h2>
    <ul id="list"></ul>
    <div class="empty" id="empty" hidden>这个目录里还没有文件。</div>
    <div class="hint" id="dir"></div>
    <div class="box"><button id="refresh">刷新</button></div>
  </section>
</main>
<script>
const $ = (id) => document.getElementById(id);
const DIR = ${JSON.stringify(String(dir || ''))};
const msg = (t, cls) => { const m = $('msg'); m.textContent = t || ''; m.className = 'msg' + (cls ? ' ' + cls : ''); };
$('dir').textContent = '电脑目录：' + DIR;
$('updir').textContent = '传到：' + DIR;

function render(files) {
  const ul = $('list');
  ul.textContent = '';
  $('empty').hidden = files.length > 0;
  for (const f of files) {
    const li = document.createElement('li');
    const nm = document.createElement('div');
    nm.className = 'nm';
    nm.textContent = f.name;
    const sz = document.createElement('div');
    sz.className = 'sz';
    sz.textContent = f.size < 1024 ? f.size + ' B'
      : (f.size < 1048576 ? Math.round(f.size / 1024) + ' KB' : (f.size / 1048576).toFixed(1) + ' MB');
    const a = document.createElement('a');
    a.className = 'dl';
    a.textContent = '下载';
    a.href = 'dl/' + encodeURIComponent(f.name);
    a.setAttribute('download', f.name);
    li.append(nm, sz, a);
    ul.append(li);
  }
}

async function refresh() {
  try {
    const r = await fetch('list.json', { cache: 'no-store' });
    if (!r.ok) throw new Error('HTTP ' + r.status);
    render((await r.json()).files || []);
  } catch (e) { msg('读列表失败：' + e.message, 'err'); }
}

async function upload() {
  const files = Array.from($('pick').files || []);
  if (!files.length) { msg('先选文件', 'err'); return; }
  $('send').disabled = true;
  let done = 0;
  for (const f of files) {
    msg('正在上传 ' + (done + 1) + '/' + files.length + '：' + f.name);
    try {
      const r = await fetch('up/' + encodeURIComponent(f.name), { method: 'POST', body: f });
      const j = await r.json().catch(() => ({}));
      if (!r.ok) { msg('上传失败：' + (j.error || ('HTTP ' + r.status)), 'err'); $('send').disabled = false; return; }
      done += 1;
    } catch (e) { msg('上传失败：' + e.message, 'err'); $('send').disabled = false; return; }
  }
  $('send').disabled = false;
  $('pick').value = '';
  msg('已上传 ' + done + ' 个文件', 'ok');
  refresh();
}

$('send').addEventListener('click', upload);
$('refresh').addEventListener('click', refresh);
refresh();
</script>
</body></html>`;
}

/** 把请求体收成 Buffer；超过 limit 抛 {code:'TOO_LARGE'}。测试可以直接塞 req.body。 */
export async function readRequestBody(req, limit) {
  if (req && req.body !== undefined && req.body !== null && typeof req.on !== 'function') {
    const buf = Buffer.isBuffer(req.body) ? req.body : Buffer.from(String(req.body));
    if (buf.length > limit) { const e = new Error('too large'); e.code = 'TOO_LARGE'; throw e; }
    return buf;
  }
  const chunks = [];
  let total = 0;
  for await (const chunk of req) {
    total += chunk.length;
    if (total > limit) { const e = new Error('too large'); e.code = 'TOO_LARGE'; throw e; }
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

/**
 * `/f/<token>/…` 的处理器。调用方（lib/mobile-server.mjs）已经验过 token，这里只管业务。
 *   seg = ['f', '<token>', 动作?, 名字?]；head(code, type, extra) 写响应头。
 */
export async function handleFileRequest({ req, res, seg, url, head, dir, maxMb = FILE_MAX_MB_DEFAULT, appName = 'Cairn' }) {
  const action = seg[2] || '';
  let rawName = '';
  if (seg[3] !== undefined) {
    try { rawName = decodeURIComponent(seg[3]); } catch { rawName = ''; }
  }
  const limitBytes = Math.min(Number(maxMb) || FILE_MAX_MB_DEFAULT, FILE_MAX_MB_HARD) * 1024 * 1024;
  const sendJson = (code, obj) => {
    head(code, 'application/json; charset=utf-8');
    res.end(JSON.stringify(obj));
  };

  if (req.method === 'GET' && (action === '' || action === 'index.html')) {
    head(200, 'text/html; charset=utf-8');
    res.end(filePageHtml({ dir, appName, maxMb, token: seg[1] || '' }));
    return;
  }
  if (req.method === 'GET' && action === 'list.json') {
    sendJson(200, { schema: 'mobile-files.v1', dir: String(dir || ''), max_mb: limitBytes / 1024 / 1024, files: listShareFiles(dir) });
    return;
  }
  if (req.method === 'GET' && action === 'dl') {
    const name = safeShareName(rawName);
    if (!name) { sendJson(400, { error: '文件名不合法' }); return; }
    const full = join(dir, name);
    try {
      const st = statSync(full);
      if (!st.isFile()) throw new Error('not a file');
      head(200, 'application/octet-stream', {
        'Content-Length': String(st.size),
        'Content-Disposition': `attachment; filename*=UTF-8''${encodeURIComponent(name)}`,
      });
      res.end(readFileSync(full));
    } catch {
      sendJson(404, { error: '没有这个文件' });
    }
    return;
  }
  if (req.method === 'POST' && action === 'up') {
    const name = safeShareName(rawName);
    if (!name) { sendJson(400, { error: '文件名不合法（只允许单个文件名，不能带路径、不能以点开头）' }); return; }
    let buf;
    try {
      buf = await readRequestBody(req, limitBytes);
    } catch (e) {
      sendJson(e && e.code === 'TOO_LARGE' ? 413 : 400, { error: e && e.code === 'TOO_LARGE' ? `文件超过 ${limitBytes / 1024 / 1024} MB` : '读取请求体失败' });
      return;
    }
    const saved = await saveShareFile(dir, name, buf);
    if (!saved.ok) { sendJson(saved.code, { error: saved.error }); return; }
    sendJson(200, { ok: true, name: saved.name, size: saved.size });
    return;
  }
  sendJson(404, { error: 'Not Found' });
}
