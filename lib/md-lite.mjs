// md-lite.mjs —— 极简 Markdown → HTML（R2 之后新加的小工具）
//
// 为什么自己写：这个仓库**零第三方依赖**是刻意守住的一条线（别人 clone 下来不用 npm install）。
// 但我们希望「数据源配置教程」这类文档能在应用窗口里直接读，而不是让人去翻文件夹。
// 所以只实现我们文档里真正用到的那一小撮语法：
//
//   标题 # ## ### · 段落 · 无序/有序列表 · 表格 · 引用 · 分隔线 ·
//   围栏代码块 · 行内代码 · 粗体 · 链接
//
// 安全：**先做 HTML 转义再套标签**，所以文档里写 <script> 也只会原样显示，不会被执行。

const ESC = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
export const escapeHtml = (s) => String(s ?? '').replace(/[&<>"']/g, (m) => ESC[m]);

/** 行内语法：`code`、**bold**、[文字](链接) —— 顺序很重要，代码先处理。 */
function inline(text) {
  let s = escapeHtml(text);
  // 行内代码（先把里面的内容保护起来，免得被后面的规则改动）
  const codes = [];
  s = s.replace(/`([^`]+)`/g, (_, code) => {
    codes.push(code);
    return `\u0000${codes.length - 1}\u0000`;
  });
  s = s.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
  // 链接：只允许 http(s) 与相对路径，挡掉 javascript:
  s = s.replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, (m, label, href) => {
    const safe = /^(https?:\/\/|\/|#|\.\/|\.\.\/)/i.test(href) ? href : '#';
    return `<a href="${safe}" target="_blank" rel="noopener">${label}</a>`;
  });
  s = s.replace(/\u0000(\d+)\u0000/g, (_, i) => `<code>${codes[Number(i)]}</code>`);
  return s;
}

const isTableRow = (line) => /^\s*\|.*\|\s*$/.test(line);
const isTableSep = (line) => /^\s*\|[\s:|-]+\|\s*$/.test(line);
const cellsOf = (line) => line.trim().replace(/^\||\|$/g, '').split('|').map((c) => c.trim());

/**
 * Markdown → HTML 片段（不生成 <html>/<body>，由调用方包）。
 * 不认识的语法**原样当段落输出**，不会丢内容。
 */
export function markdownToHtml(md) {
  const lines = String(md ?? '').replace(/\r\n?/g, '\n').split('\n');
  const out = [];
  let i = 0;
  let para = [];

  const flushPara = () => {
    if (para.length) {
      out.push(`<p>${inline(para.join(' '))}</p>`);
      para = [];
    }
  };

  while (i < lines.length) {
    const line = lines[i];

    // 围栏代码块
    if (/^\s*```/.test(line)) {
      flushPara();
      const lang = line.trim().replace(/^```/, '').trim();
      const buf = [];
      i += 1;
      while (i < lines.length && !/^\s*```/.test(lines[i])) { buf.push(lines[i]); i += 1; }
      i += 1;   // 跳过结束的 ```
      out.push(`<pre><code${lang ? ` class="lang-${escapeHtml(lang)}"` : ''}>${escapeHtml(buf.join('\n'))}</code></pre>`);
      continue;
    }

    // 分隔线
    if (/^\s*(-{3,}|\*{3,})\s*$/.test(line)) { flushPara(); out.push('<hr>'); i += 1; continue; }

    // 标题
    const h = /^(#{1,6})\s+(.*)$/.exec(line);
    if (h) {
      flushPara();
      const level = h[1].length;
      out.push(`<h${level}>${inline(h[2].trim())}</h${level}>`);
      i += 1;
      continue;
    }

    // 表格（当前行是表头，下一行是分隔行）
    if (isTableRow(line) && i + 1 < lines.length && isTableSep(lines[i + 1])) {
      flushPara();
      const head = cellsOf(line);
      i += 2;
      const rows = [];
      while (i < lines.length && isTableRow(lines[i])) { rows.push(cellsOf(lines[i])); i += 1; }
      out.push(
        `<table><thead><tr>${head.map((c) => `<th>${inline(c)}</th>`).join('')}</tr></thead>`
        + `<tbody>${rows.map((r) => `<tr>${r.map((c) => `<td>${inline(c)}</td>`).join('')}</tr>`).join('')}</tbody></table>`,
      );
      continue;
    }

    // 引用
    if (/^\s*>\s?/.test(line)) {
      flushPara();
      const buf = [];
      while (i < lines.length && /^\s*>\s?/.test(lines[i])) { buf.push(lines[i].replace(/^\s*>\s?/, '')); i += 1; }
      out.push(`<blockquote>${inline(buf.join(' '))}</blockquote>`);
      continue;
    }

    // 无序列表
    if (/^\s*[-*]\s+/.test(line)) {
      flushPara();
      const buf = [];
      while (i < lines.length && /^\s*[-*]\s+/.test(lines[i])) { buf.push(lines[i].replace(/^\s*[-*]\s+/, '')); i += 1; }
      out.push(`<ul>${buf.map((t) => `<li>${inline(t)}</li>`).join('')}</ul>`);
      continue;
    }

    // 有序列表
    if (/^\s*\d+[.)]\s+/.test(line)) {
      flushPara();
      const buf = [];
      while (i < lines.length && /^\s*\d+[.)]\s+/.test(lines[i])) { buf.push(lines[i].replace(/^\s*\d+[.)]\s+/, '')); i += 1; }
      out.push(`<ol>${buf.map((t) => `<li>${inline(t)}</li>`).join('')}</ol>`);
      continue;
    }

    // 空行 = 段落结束
    if (!line.trim()) { flushPara(); i += 1; continue; }

    para.push(line.trim());
    i += 1;
  }
  flushPara();
  return out.join('\n');
}

/** 把渲染结果包成一个能直接看的 HTML 页面（自带最小样式，配色跟应用一致）。 */
export function markdownPage(title, md, { footer = '' } = {}) {
  return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="UTF-8" />
<meta name="viewport" content="width=device-width, initial-scale=1.0" />
<title>${escapeHtml(title)}</title>
<style>
  :root { color-scheme: light dark; }
  body { margin: 0 auto; max-width: 860px; padding: 32px 20px 80px;
         font: 15px/1.75 -apple-system, "Segoe UI", "Microsoft YaHei", sans-serif; }
  h1 { font-size: 26px; margin: 0 0 8px; }
  h2 { font-size: 20px; margin: 32px 0 8px; padding-top: 12px; border-top: 1px solid rgba(128,128,128,.25); }
  h3 { font-size: 17px; margin: 24px 0 6px; }
  p, li { margin: 6px 0; }
  code { background: rgba(128,128,128,.16); padding: 1px 5px; border-radius: 4px;
         font-family: ui-monospace, Consolas, monospace; font-size: 13px; }
  pre { background: rgba(128,128,128,.12); padding: 12px 14px; border-radius: 8px; overflow: auto; }
  pre code { background: none; padding: 0; }
  table { border-collapse: collapse; width: 100%; margin: 12px 0; font-size: 14px; }
  th, td { border: 1px solid rgba(128,128,128,.3); padding: 6px 10px; text-align: left; vertical-align: top; }
  th { background: rgba(128,128,128,.12); }
  blockquote { margin: 12px 0; padding: 8px 14px; border-left: 3px solid rgba(128,128,128,.5);
               background: rgba(128,128,128,.08); border-radius: 0 6px 6px 0; }
  hr { border: none; border-top: 1px solid rgba(128,128,128,.3); margin: 28px 0; }
  a { color: #4f7cff; }
  .docnav { font-size: 13px; opacity: .8; margin-bottom: 20px; }
  .docfoot { margin-top: 48px; font-size: 13px; opacity: .7; }
</style>
</head>
<body>
${footer}
${markdownToHtml(md)}
</body>
</html>`;
}
