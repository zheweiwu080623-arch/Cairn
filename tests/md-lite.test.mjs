// 极简 Markdown 渲染的验证（应用内读文档靠它）。
//
//   node tests/md-lite.test.mjs

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import { escapeHtml, markdownPage, markdownToHtml } from '../lib/md-lite.mjs';

let failures = 0;
const ok = (label, cond, detail = '') => {
  if (cond) console.log(`  PASS ${label}`);
  else {
    failures += 1;
    console.log(`  FAIL ${label}${detail ? ` -- ${detail}` : ''}`);
  }
};

console.log('md-lite.test.mjs');

// ---------------- 1. 转义（安全底线） ----------------
ok('尖括号被转义', escapeHtml('<b>') === '&lt;b&gt;');
ok('引号被转义', escapeHtml('"a" \'b\'') === '&quot;a&quot; &#39;b&#39;');
ok('& 先被处理（不会二次转义）', escapeHtml('&amp;') === '&amp;amp;');
{
  const html = markdownToHtml('# 标题\n\n<script>alert(1)</script>');
  ok('**文档里的 script 不会变成标签**', !html.includes('<script>'), html);
  ok('script 原样显示出来（内容不丢）', html.includes('&lt;script&gt;'));
}
{
  const html = markdownToHtml('[点我](javascript:alert(1))');
  ok('javascript: 链接被换成 #', html.includes('href="#"'), html);
  const ok2 = markdownToHtml('[点我](https://example.com)');
  ok('http 链接正常', ok2.includes('href="https://example.com"') && ok2.includes('target="_blank"'));
}

// ---------------- 2. 各种语法 ----------------
ok('一级标题', markdownToHtml('# 你好') === '<h1>你好</h1>');
ok('二三级标题', markdownToHtml('## A\n### B') === '<h2>A</h2>\n<h3>B</h3>');
ok('段落合并成一行', markdownToHtml('第一行\n第二行') === '<p>第一行 第二行</p>');
ok('两个段落分开', markdownToHtml('A\n\nB') === '<p>A</p>\n<p>B</p>');
ok('分隔线', markdownToHtml('---') === '<hr>');
ok('粗体', markdownToHtml('这是 **重点**') === '<p>这是 <strong>重点</strong></p>');
ok('行内代码', markdownToHtml('填 `token` 就行') === '<p>填 <code>token</code> 就行</p>');
ok('无序列表', markdownToHtml('- a\n- b') === '<ul><li>a</li><li>b</li></ul>');
ok('有序列表', markdownToHtml('1. 一\n2. 二') === '<ol><li>一</li><li>二</li></ol>');
ok('引用', markdownToHtml('> 注意这句话') === '<blockquote>注意这句话</blockquote>');
{
  const html = markdownToHtml('```\nconst a = 1;\n```');
  ok('围栏代码块', html.startsWith('<pre><code>') && html.includes('const a = 1;'), html);
  const js = markdownToHtml('```js\nlet x;\n```');
  ok('代码块保留语言标记', js.includes('class="lang-js"'), js);
  ok('代码块里的 <> 也转义', markdownToHtml('```\n<span>\n```').includes('&lt;span&gt;'));
}
{
  const md = '| 字段 | 说明 |\n| --- | --- |\n| `url` | 网址 |\n| label | 短名字 |';
  const html = markdownToHtml(md);
  ok('表格：表头两列', html.includes('<th>字段</th><th>说明</th>'), html);
  ok('表格：两行数据', (html.match(/<tr>/g) || []).length === 3);
  ok('表格：单元格里的行内代码也生效', html.includes('<td><code>url</code></td>'));
}
{
  // 不是表格的管道符行不该被吃掉
  const html = markdownToHtml('| 只是随便写了 | 一个管道 |');
  ok('缺少分隔行的管道行按段落处理', html.startsWith('<p>'), html);
}

// ---------------- 3. 不认识的语法不丢内容 ----------------
{
  const html = markdownToHtml('#### 四级标题\n普通文字\n- 列表\n> 引用\n\n结尾');
  ok('混合内容不丢文字',
    html.includes('四级标题') && html.includes('普通文字') && html.includes('列表') && html.includes('引用') && html.includes('结尾'));
  ok('空输入返回空串', markdownToHtml('') === '' && markdownToHtml(null) === '');
}

// ---------------- 4. 整页包装 ----------------
{
  const page = markdownPage('测试', '# 标题');
  ok('整页有 DOCTYPE 与 charset', page.startsWith('<!DOCTYPE html>') && page.includes('<meta charset="UTF-8" />'));
  ok('整页标题被转义', markdownPage('<危险>', '') .includes('&lt;危险&gt;'));
  ok('整页里有正文', page.includes('<h1>标题</h1>'));
}

// ---------------- 5. 真的能渲染我们自己的两份文档 ----------------
{
  const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
  for (const f of ['CONNECT_SOURCES.md', 'HOW_IT_WORKS.md', 'WRITING_A_MODULE.md']) {
    let md = '';
    try { md = readFileSync(join(ROOT, 'docs', f), 'utf8'); } catch { continue; }
    const html = markdownToHtml(md);
    ok(`${f} 能渲染出内容（${html.length} 字符）`, html.length > 500);
    ok(`${f} 的表格被渲染成 <table>`, html.includes('<table>'));
    ok(`${f} 没有漏出来的原始标题标记`, !/<h1># /.test(html));
  }
  const connect = readFileSync(join(ROOT, 'docs', 'CONNECT_SOURCES.md'), 'utf8');
  ok('教程里九个数据源都提到了',
    ['RSS', '日历订阅', 'JSON 接口', '本地文件', 'arXiv', 'Canvas', '交大邮箱', '通用邮箱', '飞书']
      .every((k) => connect.includes(k)));
  ok('教程讲了三个按钮的区别', connect.includes('示例演示') && connect.includes('导入 / 同步') && connect.includes('推送到日程/任务'));
  ok('教程有报错对照表', connect.includes('报错对照表'));
}

console.log('');
console.log(failures === 0 ? 'md-lite.test: PASS' : `md-lite.test: FAIL (${failures})`);
process.exit(failures === 0 ? 0 : 1);
