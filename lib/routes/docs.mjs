// routes/docs.mjs —— 把仓库里的 docs/*.md 变成应用内可读的网页
// （R2 后新增；配合 lib/md-lite.mjs）
//
// 为什么要它：数据源配置教程这种东西，写在仓库里只有开发者看得见。
// 现在应用窗口里点一下就能读，不需要用户去找文件夹。
//
// 安全边界（只有三条，但都是硬要求）：
//   1. **只读**：只读仓库 `docs/` 下的文件，不做任何写入；
//   2. **只认 .md**：文件名必须匹配 `^[A-Za-z0-9._-]+\.md$`，挡掉 `..`、`/`、`\`；
//   3. **只回 HTML**：内容一律经 md-lite 转义后渲染，文档里写 <script> 也不会执行。

import { readFileSync, readdirSync, existsSync, statSync } from 'node:fs';
import { join } from 'node:path';

import { markdownPage } from '../md-lite.mjs';

export const DOC_NAME_RE = /^[A-Za-z0-9._-]+\.md$/;

/** 文档标题：取正文里第一个 `# 标题`，没有就用文件名。 */
export function titleOf(md, fallback) {
  const m = /^#\s+(.+)$/m.exec(String(md || ''));
  return (m && m[1].trim()) || fallback;
}

export function createDocsRoutes(ctx) {
  const { docsDir, sendHtml, sendError } = ctx;

  /** 列出 docs/ 下所有可读的 markdown（给目录页用）。 */
  function listDocs() {
    try {
      if (!existsSync(docsDir)) return [];
      return readdirSync(docsDir)
        .filter((f) => DOC_NAME_RE.test(f))
        .sort()
        .map((f) => {
          let title = f;
          try { title = titleOf(readFileSync(join(docsDir, f), 'utf8'), f); } catch { /* 读不到就用文件名 */ }
          return { file: f, title };
        });
    } catch {
      return [];
    }
  }

  /** /docs 或 /docs/ → 目录页；/docs/<name>.md → 渲染那一篇。 */
  async function handleDocs(req, res, url) {
    const seg = url.pathname.split('/').filter(Boolean);   // ['docs', name?]
    if (req.method !== 'GET') return sendError(res, 405, '只支持 GET');
    // 防御：必须真的是 /docs 开头的路径。
    // （`/docs/../外泄.md` 会被 URL 规范化成 `/外泄.md`，那时 seg[0] 不是 docs，这里直接挡掉。）
    if (seg[0] !== 'docs') return sendError(res, 404, '找不到这篇文档');
    const name = seg[1];

    if (!name) {
      const items = listDocs();
      const md = [
        '# 文档',
        '',
        '这些是仓库 `docs/` 目录里的说明文档，点开就能在窗口里读。',
        '',
        ...items.map((d) => `- [${d.title}](/docs/${d.file})`),
        '',
        '> 提示：数据源怎么配、报错怎么办，看《数据源配置教程》；',
        '> 想知道程序的每一层在干嘛，看《它是怎么运作的》；',
        '> 想知道重要信息怎么排序、日报晚报怎么来，看《重要信息是怎么排的》《日报与晚报是怎么来的》；',
        '> 要审代码、想二次开发（技术栈 / 架构 / 代码地图 / 扩展指南），看《开发者与审阅指南》；',
        '> 想把信发到手机 / 办公本（可选的外部邮件桥），看《外部邮件桥》。',
        '> 想自己写一个可插拔功能，看《怎么写一个模块》。',
        '> 想让 Cairn 帮你做一件事（再处理功能），看《怎么写一个再处理功能》。',
        '',
      ].join('\n');
      return sendHtml(res, 200, navigation() + markdownPage('文档', md));
    }

    // 安全性：名字必须先过关，再拼路径
    if (!DOC_NAME_RE.test(name) || name.includes('..')) return sendError(res, 404, '找不到这篇文档');
    const file = join(docsDir, name);
    try {
      if (!statSync(file).isFile()) return sendError(res, 404, '找不到这篇文档');
    } catch {
      return sendError(res, 404, '找不到这篇文档');
    }

    let md = '';
    try { md = readFileSync(file, 'utf8'); } catch { return sendError(res, 404, '读不到这篇文档'); }
    const title = titleOf(md, name);
    return sendHtml(res, 200, markdownPage(title, md, { footer: navigation() }));
  }

  function navigation() {
    const items = listDocs();
    const links = items.map((d) => `<a href="/docs/${d.file}">${d.title}</a>`).join(' · ');
    return `<div class="docnav">📚 ${links} · <a href="/docs/">文档目录</a></div>`;
  }

  return { handleDocs, listDocs };
}
