// 应用内文档页的验证（/docs/*）。
//
//   node tests/docs-route.test.mjs
//
// 重点在**安全**：这个路由会把文件内容变成网页，所以必须只读、只认 .md、挡目录穿越。

import { mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { DOC_NAME_RE, createDocsRoutes, titleOf } from '../lib/routes/docs.mjs';

let failures = 0;
const ok = (label, cond, detail = '') => {
  if (cond) console.log(`  PASS ${label}`);
  else {
    failures += 1;
    console.log(`  FAIL ${label}${detail ? ` -- ${detail}` : ''}`);
  }
};

console.log('docs-route.test.mjs');

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const base = process.env.PLANNER_TEST_TMP || tmpdir();
const docsDir = join(mkdtempSync(join(base, 'docs-')), 'docs');
mkdirSync(docsDir, { recursive: true });
writeFileSync(join(docsDir, 'a.md'), '# 甲文档\n\n正文 **加粗**。\n', 'utf8');
writeFileSync(join(docsDir, 'b.md'), '没有一级标题的文档\n', 'utf8');
writeFileSync(join(docsDir, 'notes.txt'), '不是 markdown\n', 'utf8');
writeFileSync(join(base, '外泄.md'), '# 不该被读到\n', 'utf8');   // 放在 docs 之外，用来验证穿越被挡

const mkRes = () => ({
  code: null, body: null, headers: null,
  writeHead(code, headers) { this.code = code; this.headers = headers; },
  end(data) { this.body = data; },
});
const sendHtml = (res, code, html) => { res.code = code; res.body = html; res.headers = { ct: 'text/html' }; };
const sendError = (res, code, message) => { res.code = code; res.body = { error: message }; };

const docs = createDocsRoutes({ docsDir, sendHtml, sendError });
const req = (method = 'GET') => ({ method });
const urlOf = (p) => new URL('http://127.0.0.1:3210' + p);

// ---------------- 1. 文件名规则（安全第一道门） ----------------
for (const good of ['a.md', 'CONNECT_SOURCES.md', 'how_it_works.md', 'a-b.c.md']) {
  ok(`允许的文件名：${good}`, DOC_NAME_RE.test(good));
}
for (const bad of ['../secret.md', 'a/b.md', 'a\\b.md', 'a.txt', 'a.md.exe', '', 'a b.md', '../../x.md']) {
  ok(`拒绝的文件名：${bad || '(空)'}`, !DOC_NAME_RE.test(bad));
}

// ---------------- 2. 标题推断 ----------------
ok('标题取第一个一级标题', titleOf('# 你好\n正文', '兜底') === '你好');
ok('没有一级标题就用兜底名', titleOf('正文而已', 'a.md') === 'a.md');
ok('空内容也不炸', titleOf('', 'x.md') === 'x.md' && titleOf(null, 'x.md') === 'x.md');

// ---------------- 3. 目录页 ----------------
{
  const res = mkRes();
  await docs.handleDocs(req(), res, urlOf('/docs'));
  ok('目录页 200 且是 HTML', res.code === 200 && String(res.body).includes('<!DOCTYPE html>'));
  ok('目录页列出 .md 文档', res.body.includes('甲文档') && res.body.includes('a.md'));
  ok('目录页不列非 .md 文件', !res.body.includes('notes.txt'));
  ok('目录页带文档导航', res.body.includes('/docs/a.md'));
}
{
  const res = mkRes();
  await docs.handleDocs(req(), res, urlOf('/docs/'));
  ok('/docs/（带斜杠）也当目录页', res.code === 200 && res.body.includes('甲文档'));
}

// ---------------- 4. 渲染单篇 ----------------
{
  const res = mkRes();
  await docs.handleDocs(req(), res, urlOf('/docs/a.md'));
  ok('单篇 200', res.code === 200);
  ok('渲染出标题与正文', res.body.includes('<h1>甲文档</h1>') && res.body.includes('<strong>加粗</strong>'));
  ok('页面标题也用文档标题', res.body.includes('<title>甲文档</title>'));
  ok('Content-Type 是 html', res.headers && res.headers.ct === 'text/html');
}
{
  const res = mkRes();
  await docs.handleDocs(req(), res, urlOf('/docs/b.md'));
  ok('没有一级标题的文档也能读（用文件名当标题）', res.code === 200 && res.body.includes('没有一级标题的文档'));
}

// ---------------- 5. 拒绝与不存在的路径 ----------------
for (const bad of ['/docs/notes.txt', '/docs/../外泄.md', '/docs/a%2Fb.md', '/docs/nope.md']) {
  const res = mkRes();
  await docs.handleDocs(req(), res, urlOf(bad));
  ok(`${bad} → 404`, res.code === 404, String(res.code));
}
{
  const res = mkRes();
  await docs.handleDocs({ method: 'POST' }, res, urlOf('/docs/a.md'));
  ok('POST 被拒（只允许 GET）', res.code === 405);
}

// ---------------- 6. 与真实 docs/ 目录配合 ----------------
{
  const real = createDocsRoutes({ docsDir: join(ROOT, 'docs'), sendHtml, sendError });
  const list = real.listDocs();
  ok('真实 docs/ 下至少三篇文档', list.length >= 3, JSON.stringify(list.map((d) => d.file)));
ok('列表里包含数据源配置教程', list.some((d) => d.file === 'CONNECT_SOURCES.md'));
ok('列表里包含《开发者与审阅指南》（给审阅代码的人）', list.some((d) => d.file === 'DEVELOPER_GUIDE.md'));
  ok('列表里包含《外部邮件桥》', list.some((d) => d.file === 'MAIL_BRIDGE.md'));
  ok('列表里的标题是从正文里取的（不是文件名）',
    list.find((d) => d.file === 'CONNECT_SOURCES.md').title.includes('数据源配置教程'),
    JSON.stringify(list));
  const res = mkRes();
  await real.handleDocs(req(), res, urlOf('/docs/CONNECT_SOURCES.md'));
  ok('教程能整页渲染出来', res.code === 200 && res.body.length > 5000, String(res.body && res.body.length));
}

// ---------------- 7. server.mjs 接线 ----------------
{
  const srv = readFileSync(join(ROOT, 'server.mjs'), 'utf8');
  ok('server.mjs 引入并接线了文档路由',
    srv.includes('createDocsRoutes(') && srv.includes('docsRoutes.handleDocs(req, res, url)'));
  ok('文档路由排在静态文件之前（否则会被静态 404 抢走）',
    srv.indexOf('docsRoutes.handleDocs') < srv.indexOf('return serveStatic(req, res, p)'));
  const appJs = readFileSync(join(ROOT, 'public', 'app.js'), 'utf8');
  ok('数据源页有教程入口', appJs.includes('/docs/CONNECT_SOURCES.md'));
  ok('教程链接在新标签打开', /href="\/docs\/CONNECT_SOURCES\.md"[^>]*target="_blank"/.test(appJs));
}

console.log('');
console.log(failures === 0 ? 'docs-route.test: PASS' : `docs-route.test: FAIL (${failures})`);
process.exit(failures === 0 ? 0 : 1);
