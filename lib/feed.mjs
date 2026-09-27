// 通用 RSS / Atom 解析（W4 续：通用数据源适配器的第一块）。
//
// 为什么单独一个文件：解析是纯函数（输入 XML 文本、输出条目数组），
// 不联网、不碰数据库，方便测试与复用（RSS 也是标准的、最容易接入的一类信息源）。
//
// 现实中的 feed 很脏：命名空间五花八门、标签大小写不一、CDATA、实体、自闭合标签……
// 所以这里用**容错式**解析：抓 <item>/<entry> 块，再逐个标签找内容，坏块跳过而不是整份失败。

const ENTITIES = {
  amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ',
  '#39': "'", '#34': '"', '#38': '&', '#60': '<', '#62': '>',
};

/** 解码常见实体（含数字实体）。 */
export function decodeEntities(text) {
  return String(text ?? '').replace(/&(#x?[0-9a-f]+|[a-z]+);/gi, (all, code) => {
    if (ENTITIES[code]) return ENTITIES[code];
    if (code.startsWith('#x') || code.startsWith('#X')) {
      const n = parseInt(code.slice(2), 16);
      return Number.isFinite(n) ? String.fromCodePoint(n) : all;
    }
    if (code.startsWith('#')) {
      const n = parseInt(code.slice(1), 10);
      return Number.isFinite(n) ? String.fromCodePoint(n) : all;
    }
    return all;
  });
}

/** 去掉标签、解实体、压空白（描述里常带一整段 HTML）。 */
export function stripHtml(text, max = 500) {
  const s = decodeEntities(String(text ?? ''))
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  return s.length > max ? s.slice(0, max) + '…' : s;
}

/** 取一个块里的标签内容（容忍 CDATA、自闭合、属性）。 */
function tag(block, ...names) {
  for (const name of names) {
    const re = new RegExp(`<${name}(?:\\s[^>]*)?>([\\s\\S]*?)<\\/${name}>`, 'i');
    const m = re.exec(block);
    if (m) {
      const raw = m[1].trim();
      const cdata = /^<!\[CDATA\[([\s\S]*?)\]\]>$/.exec(raw);
      return decodeEntities(cdata ? cdata[1] : stripHtml(raw, 800));
    }
    // Atom 的 <link href="…" />
    const self = new RegExp(`<${name}(?:\\s[^>]*)?\\bhref=["']([^"']+)["'][^>]*/?>`, 'i').exec(block);
    if (self) return decodeEntities(self[1]);
  }
  return '';
}

/** 解析时间：RFC822（RSS）与 ISO8601（Atom）都要认。 */
export function parseFeedDate(value) {
  const s = String(value || '').trim();
  if (!s) return null;
  const t = Date.parse(s);
  if (Number.isFinite(t)) return new Date(t).toISOString();
  // RSS 里偶尔有 "GMT" 写成 "UT" 之类
  const t2 = Date.parse(s.replace(/\bUT\b/i, 'GMT'));
  return Number.isFinite(t2) ? new Date(t2).toISOString() : null;
}

/**
 * 解析一份 feed。
 * 返回 { title, items: [{ id, title, url, at, summary }] }
 * 不合法的块会被跳过；整份解析不出东西时返回空数组（不抛）。
 */
export function parseFeed(xml) {
  const text = String(xml ?? '');
  const feedTitle = tag(text.slice(0, 4000), 'title') || '';
  const blocks = [
    ...text.matchAll(/<item(?:\s[^>]*)?>([\s\S]*?)<\/item>/gi),
    ...text.matchAll(/<entry(?:\s[^>]*)?>([\s\S]*?)<\/entry>/gi),
  ].map((m) => m[1]);

  const items = [];
  for (const block of blocks) {
    const title = tag(block, 'title');
    const url = tag(block, 'link', 'guid', 'id');
    const at = parseFeedDate(tag(block, 'pubDate', 'published', 'updated', 'dc:date', 'date'));
    const summaryRaw = tag(block, 'description', 'summary', 'content:encoded', 'content');
    const id = tag(block, 'guid', 'id') || url || title;
    if (!title && !url) continue;                       // 空块跳过
    items.push({ id: String(id).slice(0, 300), title: title || url, url, at, summary: stripHtml(summaryRaw || '') });
  }
  return { title: feedTitle, items };
}

/** 只保留最近 N 天、按时间倒序、按 id 去重、再限量。 */
export function selectFeedItems(items, { sinceDays = 7, maxResults = 30, now = Date.now(),
  include = [], exclude = [] } = {}) {
  const cutoff = now - Math.max(1, sinceDays) * 86400000;
  const withInclude = (it) => {
    if (!include.length) return true;
    const hay = `${it.title} ${it.summary}`.toLowerCase();
    return include.some((k) => hay.includes(String(k).toLowerCase()));
  };
  const withExclude = (it) => {
    if (!exclude.length) return false;
    const hay = `${it.title} ${it.summary}`.toLowerCase();
    return exclude.some((k) => hay.includes(String(k).toLowerCase()));
  };
  const seen = new Set();
  return items
    .filter((it) => !it.at || Date.parse(it.at) >= cutoff)   // 没有时间的当作新的，别丢
    .filter(withInclude)
    .filter((it) => !withExclude(it))
    .filter((it) => (seen.has(it.id) ? false : (seen.add(it.id), true)))
    .sort((a, b) => (Date.parse(b.at || 0) || 0) - (Date.parse(a.at || 0) || 0))
    .slice(0, Math.max(1, maxResults));
}

/** feed 条目 → 平台的条目形状（默认进「通知」，与邮箱/arXiv 一致）。 */
export function feedItemToPlanner(item, { source, kind = 'reminder', label = '' } = {}) {
  return {
    kind,
    external_id: item.id,
    title: label ? `${label}: ${item.title}` : item.title,
    url: item.url || null,
    due_at: null,
    start_at: null,
    end_at: null,
    notes: [item.at ? `发布于 ${item.at.slice(0, 16).replace('T', ' ')}` : '', item.summary].filter(Boolean).join('\n'),
    payload: { from: source },
  };
}
