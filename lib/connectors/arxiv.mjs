// arXiv 论文订阅连接器
// ------------------------------------------------------------------
// 三条取数路径，按可靠性自动降级（可手动指定）：
//   1) rss    —— arXiv 官方 RSS（按分类），每天更新、覆盖全、几乎不限流，本地再按关键词过滤（默认首选）；
//   2) arxiv  —— 官方 Atom API，支持「分类 AND 关键词」检索，最精确，但会限流（429 / 超时）；
//   3) openalex —— OpenAlex 检索 API（JSON），覆盖到期刊/会议，作为最后兜底。
// 结果统一转成「通知」类条目，external_id 用论文号（去版本号）保证跨轮次去重。
// 本连接器不需要任何密钥。

import { mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const UA = 'codex-planner/1.4 (personal research feed)';
const ARXIV_ENDPOINTS = ['https://export.arxiv.org/api/query', 'http://export.arxiv.org/api/query'];
const RSS_BASE = 'https://rss.arxiv.org/rss/';
const OPENALEX = 'https://api.openalex.org/works';
const DEFAULT_CATEGORIES = ['cs.AI'];

// 本地缓存：arXiv 对连续请求敏感（会回 400 / 429），同一份数据在 TTL 内不重复拉。
const CACHE_DIR = fileURLToPath(new URL('../../data/connector-cache/arxiv/', import.meta.url));

function cacheFile(key) {
  return join(CACHE_DIR, String(key).replace(/[^a-zA-Z0-9._-]/g, '_') + '.txt');
}
function cacheGet(key, ttlMs) {
  try {
    const p = cacheFile(key);
    const st = statSync(p);
    if (Date.now() - st.mtimeMs <= ttlMs) return { body: readFileSync(p, 'utf8'), ageMs: Date.now() - st.mtimeMs };
  } catch { /* 无缓存 */ }
  return null;
}
function cacheSet(key, body) {
  try {
    mkdirSync(CACHE_DIR, { recursive: true });
    writeFileSync(cacheFile(key), body, 'utf8');
  } catch { /* 缓存失败不影响主流程 */ }
}

export const meta = {
  id: 'arxiv',
  name: 'arXiv 论文订阅',
  icon: '📄',
  description: '按「关键词 + arXiv 分类」订阅最新论文（无需密钥）。官方接口限流时自动降级到 arXiv RSS / OpenAlex。新论文进入「通知」，点开直达摘要页。',
  fields: [
    { key: 'keywords', label: '关键词（逗号/空格分隔，多个词=任中）', type: 'text', required: false, placeholder: 'agent memory, tool use, autonomous planning' },
    { key: 'categories', label: 'arXiv 分类（空格分隔，留空则只按关键词）', type: 'text', required: false, placeholder: 'cs.AI cs.CL cs.LG' },
    { key: 'exclude', label: '排除词（命中即丢弃）', type: 'text', required: false, placeholder: 'survey, position paper' },
    { key: 'lookback_days', label: '只看最近 N 天（默认 3）', type: 'number', required: false, placeholder: '3' },
    { key: 'max_results', label: '每轮最多收录（默认 12）', type: 'number', required: false, placeholder: '12' },
    { key: 'cache_hours', label: '本地缓存小时数（默认 6，避免被限流）', type: 'number', required: false, placeholder: '6' },
    { key: 'source', label: '取数路径：auto / arxiv / rss / openalex', type: 'text', required: false, placeholder: 'auto' },
  ],
};

// ---------- 小工具 ----------
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const toInt = (v, dflt) => {
  const n = parseInt(String(v ?? '').trim(), 10);
  return Number.isFinite(n) ? n : dflt;
};
const clamp = (n, lo, hi) => Math.min(Math.max(n, lo), hi);

function splitList(s) {
  return String(s || '').split(/[,，;；\n]+/).map((x) => x.trim()).filter(Boolean);
}

// 关键词里可能带空格（如 "tool use"），所以逗号分隔优先，其次按空格拆
function splitKeywords(s) {
  const raw = String(s || '').trim();
  if (!raw) return [];
  const byComma = raw.split(/[,，;；\n]+/).map((x) => x.trim()).filter(Boolean);
  if (byComma.length > 1) return byComma;
  // 单个词、或 "a b c" 这种没分隔符的，按空格拆成多个关键词
  const single = byComma[0] || '';
  return single.split(/\s+/).filter(Boolean);
}

// arXiv 分类：逗号 / 分号 / 空格 / 换行都能分隔（cs.AI, cs.CL 与 cs.AI cs.CL 等价）。
// 注意：不能沿用 splitList —— 它只按逗号拆，会把 "cs.AI cs.CL" 当成一个分类，
// 拼出的 RSS 地址（/rss/cs.AI%20cs.CL）会被 arXiv 直接判 400。
function splitCategories(s) {
  return String(s || '')
    .split(/[,，;；\s\n]+/)
    .map((x) => x.trim())
    .filter(Boolean)
    .map((x) => (x.startsWith('arXiv:') ? x.slice(6) : x));
}

function stripTags(s) {
  return decodeEntities(String(s || '').replace(/<[^>]*>/g, ' ')).replace(/\s+/g, ' ').trim();
}

function decodeEntities(s) {
  return String(s || '')
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"').replace(/&#0?39;/g, "'").replace(/&apos;/g, "'")
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(Number(d)))
    .replace(/&amp;/g, '&');
}

function pick(re, s) {
  const m = String(s || '').match(re);
  return m ? m[1] : '';
}

function cut(s, n) {
  const t = String(s || '').replace(/\s+/g, ' ').trim();
  return t.length > n ? t.slice(0, n - 1) + '…' : t;
}

function ymd(d) {
  const x = d instanceof Date ? d : new Date(d);
  return `${x.getFullYear()}-${String(x.getMonth() + 1).padStart(2, '0')}-${String(x.getDate()).padStart(2, '0')}`;
}

function parseDate(s) {
  if (!s) return NaN;
  const t = Date.parse(String(s).trim());
  return Number.isFinite(t) ? t : NaN;
}

async function fetchText(url, ms = 20000) {
  const res = await fetch(url, {
    headers: { 'User-Agent': UA, Accept: '*/*' },
    signal: AbortSignal.timeout(ms),
  });
  const body = await res.text();
  return { status: res.status, ok: res.ok, body };
}

// 关键词命中：标题 + 摘要，大小写不敏感；返回命中次数（0 = 未命中）
function hitCount(item, keywords) {
  if (!keywords.length) return 1;
  const hay = `${item.title} ${item.abstract}`.toLowerCase();
  let n = 0;
  for (const k of keywords) {
    const needle = k.toLowerCase();
    if (needle && hay.includes(needle)) n++;
  }
  return n;
}

function isExcluded(item, exclude) {
  if (!exclude.length) return false;
  const hay = `${item.title} ${item.abstract}`.toLowerCase();
  return exclude.some((e) => e && hay.includes(e.toLowerCase()));
}

// ---------- 1) arXiv 官方 API ----------
function parseAtom(xml) {
  const entries = String(xml || '').match(/<entry>[\s\S]*?<\/entry>/g) || [];
  const out = [];
  for (const e of entries) {
    const rawId = stripTags(pick(/<id>([\s\S]*?)<\/id>/, e));
    const shortId = (rawId.match(/(\d{4}\.\d{4,5})(v\d+)?/) || [])[1] || rawId;
    const authors = (e.match(/<author>[\s\S]*?<\/author>/g) || [])
      .map((a) => stripTags(pick(/<name>([\s\S]*?)<\/name>/, a))).filter(Boolean);
    const cats = (e.match(/<category[^>]*term="([^"]+)"/g) || [])
      .map((c) => (c.match(/term="([^"]+)"/) || [])[1]).filter(Boolean);
    out.push({
      id: shortId,
      title: stripTags(pick(/<title>([\s\S]*?)<\/title>/, e)),
      abstract: stripTags(pick(/<summary>([\s\S]*?)<\/summary>/, e)),
      authors,
      cats: [...new Set(cats)],
      published: stripTags(pick(/<published>([\s\S]*?)<\/published>/, e)),
      url: shortId ? `https://arxiv.org/abs/${shortId}` : (rawId || null),
      via: 'arXiv 官方接口',
    });
  }
  return out;
}

async function fromArxivApi({ keywords, categories, max, ttlMs }) {
  const clauses = [];
  if (categories.length) clauses.push('(' + categories.map((c) => `cat:${c}`).join(' OR ') + ')');
  if (keywords.length) clauses.push('(' + keywords.map((k) => `all:"${k}"`).join(' OR ') + ')');
  if (!clauses.length) throw new Error('缺少关键词或分类');
  const params = new URLSearchParams({
    search_query: clauses.join(' AND '),
    start: '0',
    max_results: String(clamp(max * 3, 5, 100)),
    sortBy: 'submittedDate',
    sortOrder: 'descending',
  });
  const cacheKey = `api-${clauses.join(' AND ')}-${max}`;

  let lastErr = null;
  const cached = ttlMs > 0 ? cacheGet(cacheKey, ttlMs) : null;
  if (cached) return { items: parseAtom(cached.body), via: 'arXiv 官方接口（缓存）' };
  for (const base of ARXIV_ENDPOINTS) {
    for (let tryNo = 0; tryNo < 2; tryNo++) {
      try {
        const r = await fetchText(`${base}?${params}`, 20000);
        if (r.status === 429) { lastErr = new Error('arXiv 官方接口限流（429）'); await sleep(4000); continue; }
        if (!r.ok) { lastErr = new Error(`arXiv 官方接口返回 ${r.status}`); continue; }
        cacheSet(cacheKey, r.body);
        const items = parseAtom(r.body);
        return { items, via: 'arXiv 官方接口' };
      } catch (err) {
        lastErr = err;
      }
    }
  }
  throw lastErr || new Error('arXiv 官方接口不可用');
}

// ---------- 2) arXiv RSS（按分类，本地关键词过滤） ----------
async function fromRss({ categories, keywords, exclude, since, max, ttlMs }) {
  const cats = (categories.length ? categories : DEFAULT_CATEGORIES).slice(0, 3);
  const all = [];
  let okCats = 0;
  let cachedCats = 0;
  let lastErr = null;
  for (let i = 0; i < cats.length; i++) {
    const cat = cats[i];
    try {
      const cacheKey = `rss-${cat}`;
      let body = null;
      const hit = ttlMs > 0 ? cacheGet(cacheKey, ttlMs) : null;
      if (hit) { body = hit.body; cachedCats++; }
      else {
        // arXiv RSS 对连续请求敏感：分类之间间隔 5 秒，被限流时再等 10 秒重试一次。
        if (i > 0) await sleep(5000);
        let r = await fetchText(RSS_BASE + encodeURIComponent(cat), 25000);
        if (!r.ok && (r.status === 400 || r.status === 429 || r.status === 503)) {
          await sleep(10000);
          r = await fetchText(RSS_BASE + encodeURIComponent(cat), 25000);
        }
        if (!r.ok) { lastErr = new Error(`arXiv RSS（${cat}）返回 ${r.status}`); continue; }
        body = r.body;
        cacheSet(cacheKey, body);
      }
      okCats++;
      const blocks = String(body).match(/<item>[\s\S]*?<\/item>/g) || [];
      for (const it of blocks) {
        const announce = stripTags(pick(/<arxiv:announce_type>([\s\S]*?)<\/arxiv:announce_type>/, it));
        // 只收「新投稿」与「跨类新投稿」；replace / replace-cross 是已有论文的更新，跳过。
        if (announce && announce !== 'new' && announce !== 'cross') continue;
        const link = stripTags(pick(/<link>([\s\S]*?)<\/link>/, it));
        const guid = stripTags(pick(/<guid[^>]*>([\s\S]*?)<\/guid>/, it));
        const shortId = (link.match(/abs\/(\d{4}\.\d{4,5})/) || guid.match(/(\d{4}\.\d{4,5})/) || [])[1];
        if (!shortId) continue;
        const desc = stripTags(pick(/<description>([\s\S]*?)<\/description>/, it))
          .replace(/^arXiv:\S+\s*Announce Type:\s*\S+\s*Abstract:\s*/i, '');
        all.push({
          id: shortId,
          title: stripTags(pick(/<title>([\s\S]*?)<\/title>/, it)),
          abstract: desc,
          authors: splitList(pick(/<dc:creator>([\s\S]*?)<\/dc:creator>/, it)),
          cats: [cat],
          published: stripTags(pick(/<pubDate>([\s\S]*?)<\/pubDate>/, it)),
          url: link || `https://arxiv.org/abs/${shortId}`,
          via: announce === 'cross' ? 'arXiv RSS（跨类）' : 'arXiv RSS',
        });
      }
    } catch (err) {
      lastErr = err;
    }
  }
  if (!okCats) throw lastErr || new Error('arXiv RSS 不可用');
  const filtered = all.filter((it) => hitCount(it, keywords) > 0 && !isExcluded(it, exclude));
  const via = `arXiv RSS（${cats.join(' ')}${cachedCats ? ` · ${cachedCats} 个分类走缓存` : ''}）`;
  return { items: filtered.slice(0, max), via, scanned: all.length, cached: cachedCats };
}

// ---------- 3) OpenAlex（兜底，覆盖到期刊/会议） ----------
function abstractFromInverted(inv) {
  if (!inv || typeof inv !== 'object') return '';
  const slots = [];
  for (const [word, positions] of Object.entries(inv)) {
    for (const p of positions || []) slots[p] = word;
  }
  return slots.filter(Boolean).join(' ');
}

async function fromOpenAlex({ keywords, since, exclude, max }) {
  const search = keywords.join(' ');
  const params = new URLSearchParams({
    ...(search ? { search } : {}),
    filter: `from_publication_date:${ymd(since)},is_paratext:false,type:article`,
    sort: 'publication_date:desc',
    'per-page': String(clamp(max * 2, 5, 50)),
    mailto: 'planner@local',
  });
  const r = await fetchText(`${OPENALEX}?${params}`, 25000);
  if (!r.ok) throw new Error(`OpenAlex 返回 ${r.status}`);
  const j = JSON.parse(r.body);
  const out = [];
  for (const w of j.results || []) {
    const title = stripTags(w.title || w.display_name || '');
    if (!title) continue;
    const url = w.doi || w.primary_location?.landing_page_url || w.id || null;
    const id = (w.doi || w.id || title).replace(/^https?:\/\/(dx\.)?doi\.org\//, 'doi:');
    out.push({
      id,
      title,
      abstract: cut(abstractFromInverted(w.abstract_inverted_index), 700),
      authors: (w.authorships || []).slice(0, 3).map((a) => a.author?.display_name).filter(Boolean),
      cats: [w.primary_location?.source?.display_name].filter(Boolean),
      published: w.publication_date || '',
      url,
      via: 'OpenAlex',
    });
  }
  const filtered = out.filter((it) => hitCount(it, keywords) > 0 && !isExcluded(it, exclude));
  return { items: filtered.slice(0, max), via: 'OpenAlex', scanned: out.length };
}

// ---------- 主入口 ----------
export async function fetchAll(config = {}) {
  const keywords = splitKeywords(config.keywords);
  const categories = splitCategories(config.categories);
  const exclude = splitList(config.exclude);
  const lookbackDays = clamp(toInt(config.lookback_days, 3), 1, 90);
  const max = clamp(toInt(config.max_results, 12), 1, 50);
  const ttlMs = clamp(toInt(config.cache_hours, 6), 0, 168) * 3600 * 1000;
  const mode = String(config.source || 'auto').trim().toLowerCase() || 'auto';
  const since = Date.now() - lookbackDays * 86400000;

  if (!keywords.length && !categories.length) {
    throw new Error('请至少填一个关键词或一个 arXiv 分类');
  }

  // auto：先用最稳的 RSS（覆盖全 + 不限流），拿不到再退到官方 API 与 OpenAlex。
  const order = mode === 'auto' ? ['rss', 'arxiv', 'openalex'] : [mode];
  const tried = [];
  let picked = null;
  let lastErr = null;

  for (const step of order) {
    try {
      if (step === 'arxiv') {
        if (!keywords.length && !categories.length) continue;
        picked = await fromArxivApi({ keywords, categories, max, ttlMs });
      } else if (step === 'rss') {
        const rss = await fromRss({ categories, keywords, exclude, since, max, ttlMs });
        if (!rss.items.length) throw new Error('RSS 已取到但关键词无命中');
        picked = rss;
      } else if (step === 'openalex') {
        if (!keywords.length) throw new Error('OpenAlex 需要关键词');
        picked = await fromOpenAlex({ keywords, since, exclude, max });
      } else {
        throw new Error(`未知取数路径：${step}`);
      }
      tried.push(`${step}:ok`);
      break;
    } catch (err) {
      tried.push(`${step}:${err.message}`);
      lastErr = err;
      picked = null;
    }
  }

  if (!picked) {
    throw new Error(`全部取数路径都失败 —— ${tried.join(' / ')}${lastErr ? `（${lastErr.message}）` : ''}`);
  }

  // 统一后处理：时间窗过滤 → 排除词 → 去重（编号 + 标题）→ 排序 → 限额
  const seen = new Set();
  const seenTitles = new Set();
  const kept = [];
  for (const it of picked.items || []) {
    if (!it.id || seen.has(it.id)) continue;
    const titleKey = String(it.title || '').toLowerCase().replace(/[^a-z0-9\u4e00-\u9fff]+/g, '');
    if (titleKey && seenTitles.has(titleKey)) continue;
    const t = parseDate(it.published);
    if (Number.isFinite(t) && t < since) continue;
    if (isExcluded(it, exclude)) continue;
    seen.add(it.id);
    if (titleKey) seenTitles.add(titleKey);
    kept.push({ ...it, ts: Number.isFinite(t) ? t : 0 });
  }
  kept.sort((a, b) => b.ts - a.ts);
  const chosen = kept.slice(0, max);

  const items = chosen.map((it) => {
    const authors = (it.authors || []).slice(0, 3).join(', ') + ((it.authors || []).length > 3 ? ' 等' : '');
    const notes = [
      [authors, (it.cats || []).slice(0, 3).join(' '), it.published ? String(it.published).slice(0, 10) : ''].filter(Boolean).join(' · '),
      it.abstract ? `摘要：${cut(it.abstract, 260)}` : '',
      `来源：${it.via || picked.via}`,
    ].filter(Boolean).join('\n');
    return {
      kind: 'reminder',
      external_id: `arxiv-${it.id}`,
      title: `📄 ${cut(it.title, 150)}`,
      due_at: null,          // 不设时间 → 进「通知」列表而不触发弹窗
      start_at: null,
      end_at: null,
      notes,
      url: it.url || null,
      course: null,
      from: it.via || picked.via,
    };
  });

  return {
    items,
    raw: {
      path: picked.via,
      tried,
      matched: chosen.length,
      scanned: picked.scanned ?? picked.items.length,
      lookback_days: lookbackDays,
      keywords: keywords.length,
      categories: categories.length ? categories : DEFAULT_CATEGORIES,
    },
  };
}

// 离线示例（不联网，用于验证完整管线）
export function fromSample() {
  const base = Date.now();
  const sample = [
    {
      id: '2509.00001', title: 'Sample: Autonomous Tool Selection for Long-Horizon Agents',
      authors: ['A. Researcher', 'B. Scholar', 'C. Author', 'D. Extra'], cats: ['cs.AI', 'cs.CL'],
      abstract: 'We study how an agent decides which tools to call, when to switch models, and how to keep a long-term memory that stays cheap to query. (示例数据，非真实论文)',
      url: 'https://arxiv.org/abs/2509.00001', daysAgo: 0,
    },
    {
      id: '2509.00002', title: 'Sample: Evaluating Interruption Policies in Personal Agents',
      authors: ['E. Example'], cats: ['cs.HC'],
      abstract: 'A benchmark for deciding when an assistant should interrupt a user, trading off missed deadlines against annoyance. (示例数据，非真实论文)',
      url: 'https://arxiv.org/abs/2509.00002', daysAgo: 1,
    },
    {
      id: '2509.00003', title: 'Sample: Memory Routing between Structured Stores and Long Documents',
      authors: ['F. Sample', 'G. Demo'], cats: ['cs.IR'],
      abstract: 'We compare routing queries between a SQL store and a prose memory file. (示例数据，非真实论文)',
      url: 'https://arxiv.org/abs/2509.00003', daysAgo: 2,
    },
  ];
  const items = sample.map((s) => ({
    kind: 'reminder',
    external_id: `arxiv-${s.id}`,
    title: `📄 ${s.title}`,
    due_at: null, start_at: null, end_at: null,
    notes: [
      [s.authors.slice(0, 3).join(', ') + (s.authors.length > 3 ? ' 等' : ''), s.cats.join(' '), ymd(new Date(base - s.daysAgo * 86400000))].join(' · '),
      `摘要：${cut(s.abstract, 260)}`,
      '来源：离线示例',
    ].join('\n'),
    url: s.url, course: null, from: '离线示例',
  }));
  return { items, raw: { path: '离线示例', matched: items.length, scanned: items.length } };
}
