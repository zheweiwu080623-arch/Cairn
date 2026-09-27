// 通用 RSS/Atom 解析测试（通用数据源适配器 ①）。
//
//   node tests/feed.test.mjs

import {
  decodeEntities, feedItemToPlanner, parseFeed, parseFeedDate, selectFeedItems, stripHtml,
} from '../lib/feed.mjs';

let failures = 0;
const ok = (label, cond, detail = '') => {
  if (cond) console.log(`  PASS ${label}`);
  else {
    failures += 1;
    console.log(`  FAIL ${label}${detail ? ` -- ${detail}` : ''}`);
  }
};

console.log('feed.test.mjs');

// ---------- 1. 小工具 ----------
ok('实体解码（命名 + 数字 + 十六进制）',
  decodeEntities('a &amp; b &#65; &#x42;') === 'a & b A B', decodeEntities('a &amp; b &#65; &#x42;'));
ok('未知实体原样保留', decodeEntities('&weird;') === '&weird;');
ok('去 HTML：标签、脚本、样式、压空白',
  stripHtml('<p>你好  <b>世界</b></p><script>x()</script>', 100) === '你好 世界', stripHtml('<p>你好  <b>世界</b></p><script>x()</script>', 100));
ok('去 HTML 会截断超长描述', stripHtml('x'.repeat(900), 100).length <= 101);
ok('RFC822 时间能解析', parseFeedDate('Tue, 16 Sep 2026 08:00:00 GMT')?.startsWith('2026-09-16') === true,
  String(parseFeedDate('Tue, 16 Sep 2026 08:00:00 GMT')));
ok('ISO 时间能解析', parseFeedDate('2026-09-16T08:00:00Z')?.startsWith('2026-09-16') === true);
ok('坏时间返回 null 而不是抛错', parseFeedDate('昨天') === null && parseFeedDate('') === null);

// ---------- 2. 解析 RSS ----------
const rss = `<?xml version="1.0"?>
<rss version="2.0" xmlns:dc="http://purl.org/dc/elements/1.1/">
  <channel>
    <title>示例公告</title>
    <item>
      <title>关于选课系统维护的通知</title>
      <link>https://example.edu/notice/1</link>
      <guid>notice-1</guid>
      <pubDate>Tue, 16 Sep 2026 08:00:00 GMT</pubDate>
      <description><![CDATA[<p>系统将于 <b>9月20日</b> 维护。</p>]]></description>
    </item>
    <item>
      <title>讲座：AI 与教育</title>
      <link>https://example.edu/notice/2</link>
      <pubDate>Tue, 15 Sep 2026 10:30:00 GMT</pubDate>
      <description>欢迎参加</description>
    </item>
    <item><title></title></item>
  </channel>
</rss>`;
const parsed = parseFeed(rss);
ok('拿到 feed 标题', parsed.title === '示例公告', parsed.title);
ok('拿到 2 条（空块被跳过）', parsed.items.length === 2, String(parsed.items.length));
ok('标题/链接/时间都对',
  parsed.items[0].title === '关于选课系统维护的通知'
  && parsed.items[0].url === 'https://example.edu/notice/1'
  && parsed.items[0].at.startsWith('2026-09-16'), JSON.stringify(parsed.items[0]));
ok('CDATA 里的 HTML 被清成纯文本',
  parsed.items[0].summary === '系统将于 9月20日 维护。', parsed.items[0].summary);
ok('没有 guid 时用链接当 id', parsed.items[1].id === 'https://example.edu/notice/2', parsed.items[1].id);

// ---------- 3. 解析 Atom（含 link href 与 content） ----------
const atom = `<?xml version="1.0"?>
<feed xmlns="http://www.w3.org/2005/Atom">
  <title>Example Blog</title>
  <entry>
    <title>Post one</title>
    <link rel="alternate" href="https://blog.example.org/1"/>
    <id>tag:blog.example.org,2026:1</id>
    <updated>2026-09-16T12:00:00Z</updated>
    <content>Hello &amp; welcome</content>
  </entry>
</feed>`;
const a = parseFeed(atom);
ok('Atom：标题与条目都拿到', a.title === 'Example Blog' && a.items.length === 1, JSON.stringify(a));
ok('Atom：link href 被取到', a.items[0].url === 'https://blog.example.org/1', a.items[0].url);
ok('Atom：content 里的实体被解码', a.items[0].summary === 'Hello & welcome', a.items[0].summary);

// ---------- 4. 筛选（时间 / 关键词 / 去重 / 限量） ----------
const now = Date.parse('2026-09-17T00:00:00Z');
const items = [
  { id: 'a', title: '新公告', summary: '', at: '2026-09-16T00:00:00Z' },
  { id: 'b', title: '很旧的公告', summary: '', at: '2026-08-01T00:00:00Z' },
  { id: 'a', title: '新公告（重复）', summary: '', at: '2026-09-16T00:00:00Z' },
  { id: 'c', title: '讲座：科研方法', summary: '', at: '2026-09-15T00:00:00Z' },
  { id: 'd', title: '促销通知', summary: '', at: '2026-09-15T00:00:00Z' },
  { id: 'e', title: '没有时间的公告', summary: '', at: null },
];
const picked = selectFeedItems(items, { sinceDays: 7, maxResults: 10, now });
ok('按时间过滤掉太旧的', !picked.some((x) => x.id === 'b'), JSON.stringify(picked.map((x) => x.id)));
ok('按 id 去重', picked.filter((x) => x.id === 'a').length === 1);
ok('没有时间的条目保留（别丢新公告）', picked.some((x) => x.id === 'e'));
ok('按时间倒序', picked[0].id === 'a', JSON.stringify(picked.map((x) => x.id)));
ok('include 关键词过滤', selectFeedItems(items, { now, include: ['科研'] }).every((x) => /科研/.test(x.title)));
ok('exclude 关键词过滤', !selectFeedItems(items, { now, exclude: ['促销'] }).some((x) => /促销/.test(x.title)));
ok('maxResults 生效', selectFeedItems(items, { now, maxResults: 2 }).length === 2);
ok('空输入不崩', parseFeed('').items.length === 0 && selectFeedItems([]).length === 0 && parseFeed(null).items.length === 0);

// ---------- 5. 转成平台条目 ----------
const mapped = feedItemToPlanner(parsed.items[0], { source: 'rss', label: '示例公告' });
ok('转成 reminder 且带来源标记',
  mapped.kind === 'reminder' && mapped.payload.from === 'rss', JSON.stringify(mapped));
ok('标题带上 feed 名', mapped.title === '示例公告: 关于选课系统维护的通知', mapped.title);
ok('备注里有发布时间与摘要', mapped.notes.includes('2026-09-16') && mapped.notes.includes('维护'), mapped.notes);

console.log('');
console.log(failures === 0 ? 'feed.test: PASS' : `feed.test: FAIL (${failures})`);
process.exit(failures === 0 ? 0 : 1);
