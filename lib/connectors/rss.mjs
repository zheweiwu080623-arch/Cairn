// 通用 RSS / Atom 连接器（通用数据源适配器 ①）。
//
// 为什么先做它：RSS/Atom 是**最便宜的一类信息源** —— 只要一个网址，不需要账号、不需要授权，
// 而且覆盖面极广（博客、新闻站、很多校园公告、GitHub Release、知乎/掘金专栏…）。
// 有了它，"再加一个信息源"就不再需要改代码。
import { feedItemToPlanner, parseFeed, selectFeedItems } from '../feed.mjs';
import { rssSample } from './samples.mjs';

export const meta = {
  id: 'rss',
  name: '通用 RSS / Atom 订阅',
  icon: '📡',
  notify: true,                     // 这条很重要：抓来的内容进「通知」，与邮箱/arXiv 行为一致
  description: '贴一个 RSS/Atom 网址就能订阅：博客、新闻、校园公告、GitHub 更新……不需要账号。',
  fields: [
    { key: 'url', label: 'RSS / Atom 网址', type: 'text', required: true, placeholder: 'https://example.com/feed.xml' },
    { key: 'label', label: '给这个源的短名字（可选）', type: 'text', required: false, placeholder: '如：学院公告' },
    { key: 'since_days', label: '只看最近 N 天（默认 7）', type: 'text', required: false, placeholder: '7' },
    { key: 'max_results', label: '每次最多收几条（默认 30）', type: 'text', required: false, placeholder: '30' },
    { key: 'include', label: '只要包含这些词（逗号分隔，可留空）', type: 'text', required: false, placeholder: '选课, 讲座' },
    { key: 'exclude', label: '排除包含这些词（逗号分隔，可留空）', type: 'text', required: false, placeholder: '促销, 广告' },
  ],
};

const splitList = (v) => String(v || '').split(/[,，;；]+/).map((s) => s.trim()).filter(Boolean);

async function fetchText(url, timeoutMs = 30000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      signal: controller.signal,
      headers: { 'User-Agent': 'Cairn/0.1 (+local planner; RSS reader)', Accept: 'application/rss+xml, application/atom+xml, application/xml, text/xml, */*' },
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return await res.text();
  } catch (e) {
    // 把底层错误码透出来（ENOTFOUND / ECONNREFUSED / EAI_AGAIN…），人话化才有依据
    if (e?.name === 'AbortError') throw new Error('aborted（等满 30 秒还没响应）');
    const code = e?.cause?.code || e?.code || '';
    if (code) throw new Error(`${code}: 无法连接 ${url}`);
    throw e;
  } finally {
    clearTimeout(timer);
  }
}

/** 抓一个 feed 并转成平台条目。config: 见上面的 fields。 */
export async function fetchAll(config = {}) {
  const url = String(config.url || '').trim();
  if (!url) throw new Error('缺少 RSS 网址');
  if (!/^https?:\/\//i.test(url)) throw new Error('网址要以 http:// 或 https:// 开头');

  const xml = await fetchText(url);
  const parsed = parseFeed(xml);
  if (!parsed.items.length) {
    throw new Error('这个网址看起来不是 RSS/Atom（没解析出条目）。请确认是 feed 地址，而不是普通网页。');
  }
  const picked = selectFeedItems(parsed.items, {
    sinceDays: Number(config.since_days) || 7,
    maxResults: Number(config.max_results) || 30,
    include: splitList(config.include),
    exclude: splitList(config.exclude),
  });
  const label = String(config.label || parsed.title || '').trim();
  return {
    items: picked.map((it) => feedItemToPlanner(it, { source: 'rss', label })),
    raw: { feed_title: parsed.title, fetched: parsed.items.length, kept: picked.length, url },
  };
}

/** 离线示例：没网也能在「示例演示」里看到效果。 */
export function fromSample() {
  const parsed = parseFeed(rssSample());
  const picked = selectFeedItems(parsed.items, { sinceDays: 30, maxResults: 20 });
  return {
    items: picked.map((it) => feedItemToPlanner(it, { source: 'rss', label: parsed.title || '示例订阅' })),
    raw: { feed_title: parsed.title, fetched: parsed.items.length, kept: picked.length, demo: true },
  };
}
