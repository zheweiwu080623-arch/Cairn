// 极简 CalDAV 客户端（无第三方依赖）：把 Planner 的课程 / DDL 直接写进 iCloud 日历。
// 相比「局域网订阅」的好处：手机在任何网络（含蜂窝）都能看到，原生提醒，多设备同步。
// 只需要 Apple ID + App 专用密码（appleid.apple.com 生成），不需要公网 IP 或服务器。
import https from 'node:https';
import http from 'node:http';
import { URL } from 'node:url';

export const CALDAV_PRESETS = {
  global: 'https://caldav.icloud.com',
  china: 'https://caldav.icloud.com.cn',
};

const XML_HEADER = '<?xml version="1.0" encoding="UTF-8"?>';

const decodeXml = (s) => String(s || '')
  .replace(/&lt;/g, '<').replace(/&gt;/g, '>')
  .replace(/&quot;/g, '"').replace(/&apos;/g, "'")
  .replace(/&amp;/g, '&');

const findAll = (xml, tag) => {
  const re = new RegExp(`<(?:[A-Za-z0-9_-]+:)?${tag}(?:\\s[^>]*)?>([\\s\\S]*?)</(?:[A-Za-z0-9_-]+:)?${tag}>`, 'gi');
  const out = [];
  let m;
  while ((m = re.exec(xml))) out.push(m[1]);
  return out;
};

const firstHref = (xml) => {
  const m = String(xml || '').match(/<(?:[A-Za-z0-9_-]+:)?href(?:\s[^>]*)?>([\s\S]*?)<\/(?:[A-Za-z0-9_-]+:)?href>/i);
  return m ? decodeXml(m[1].trim()) : '';
};

function describe(res) {
  if (res.error) {
    const hint = /EACCES|EPERM/i.test(res.error) ? '（本机网络被拦截，或代理/防火墙不允许访问）'
      : /ENOTFOUND|EAI_AGAIN/i.test(res.error) ? '（域名解析失败，检查网络或改用另一个区域）'
        : /TIMEOUT|ETIMEDOUT|超时/i.test(res.error) ? '（连接超时，检查网络或代理）' : '';
    return `${res.error}${hint}`;
  }
  if (!res.status) return '连接失败：没有收到服务器响应（网络或代理被拦截）';
  if (res.status === 401) return '认证失败：Apple ID 或 App 专用密码不正确';
  if (res.status === 403) return '被拒绝：请确认用的是「App 专用密码」（不是登录密码），且账号已开启双重认证';
  if (res.status === 404) return '地址不存在：服务器地址可能选错了（中国区账号用 caldav.icloud.com.cn）';
  if (res.status === 507) return 'iCloud 存储空间不足';
  const snippet = String(res.body || '').replace(/\s+/g, ' ').slice(0, 200);
  return `HTTP ${res.status}${snippet ? ` · ${snippet}` : ''}`;
}

export function httpRequest({ url, method = 'GET', auth, headers = {}, body = null, timeout = 25000 }) {
  return new Promise((resolve) => {
    let u;
    try { u = new URL(url); } catch (e) { resolve({ ok: false, error: `地址无效：${e.message}` }); return; }
    const mod = u.protocol === 'http:' ? http : https;
    const payload = body == null ? null : Buffer.from(body, 'utf8');
    const req = mod.request({
      protocol: u.protocol,
      hostname: u.hostname,
      port: u.port || (u.protocol === 'http:' ? 80 : 443),
      path: `${u.pathname}${u.search}`,
      method,
      headers: {
        'User-Agent': 'CodexPlanner/1.0 (CalDAV)',
        ...(auth && auth.user ? { Authorization: `Basic ${Buffer.from(`${auth.user}:${auth.pass}`).toString('base64')}` } : {}),
        ...(payload ? { 'Content-Length': payload.length } : {}),
        ...headers,
      },
      timeout,
    }, (res) => {
      let data = '';
      res.setEncoding('utf8');
      res.on('data', (c) => { data += c; });
      res.on('end', () => resolve({
        ok: res.statusCode < 400, status: res.statusCode, headers: res.headers, body: data,
      }));
    });
    req.on('timeout', () => req.destroy(new Error('请求超时')));
    req.on('error', (e) => resolve({ ok: false, error: (e && (e.message || e.code)) || '连接失败（原因未知）' }));
    if (payload) req.write(payload);
    req.end();
  });
}

const propfind = (base, path, body, depth, auth) => httpRequest({
  url: new URL(path, base).toString(),
  method: 'PROPFIND',
  auth,
  headers: { Depth: String(depth), 'Content-Type': 'application/xml; charset=utf-8' },
  body,
});

/**
 * 发现账号的主目录与日历集合。
 * @returns {{ok:boolean, base?:string, principal?:string, home?:string, error?:string}}
 */
export async function discover(base, auth) {
  const root = base.replace(/\/+$/, '');
  const r1 = await propfind(root, '/', `${XML_HEADER}<d:propfind xmlns:d="DAV:"><d:prop><d:current-user-principal/></d:prop></d:propfind>`, 0, auth);
  if (!r1.ok) return { ok: false, error: describe(r1), status: r1.status };
  const principalBlock = findAll(r1.body, 'current-user-principal')[0] || '';
  const principalHref = firstHref(principalBlock) || firstHref(r1.body);
  if (!principalHref) return { ok: false, error: '无法从响应中找到用户主目录（账号或服务器地址可能有误）' };
  const principal = new URL(principalHref, root).toString();

  const r2 = await propfind(root, principal, `${XML_HEADER}<d:propfind xmlns:d="DAV:" xmlns:c="urn:ietf:params:xml:ns:caldav"><d:prop><c:calendar-home-set/></d:prop></d:propfind>`, 0, auth);
  if (!r2.ok) return { ok: false, error: describe(r2), status: r2.status };
  const homeBlock = findAll(r2.body, 'calendar-home-set')[0] || r2.body;
  const homeHref = firstHref(homeBlock);
  if (!homeHref) return { ok: false, error: '无法找到日历集合（calendar-home-set）' };
  const home = new URL(homeHref, root).toString();
  return { ok: true, base: root, principal, home, user: auth.user };
}

/**
 * 列出日历集合（home 下 Depth:1）。
 * @returns {{ok:boolean, calendars?:Array<{url:string, name:string}>, error?:string}}
 */
export async function listCalendars(base, home, auth) {
  const homeUrl = new URL(home, base).toString();
  const r = await propfind(base, homeUrl, `${XML_HEADER}<d:propfind xmlns:d="DAV:"><d:prop><d:resourcetype/><d:displayname/></d:prop></d:propfind>`, 1, auth);
  if (!r.ok) return { ok: false, error: describe(r), status: r.status };
  const calendars = [];
  for (const block of findAll(r.body, 'response')) {
    if (!/<(?:[A-Za-z0-9_-]+:)?calendar[\s/>]/i.test(block)) continue;
    const href = firstHref(block);
    if (!href) continue;
    const name = decodeXml((findAll(block, 'displayname')[0] || '').trim());
    calendars.push({ url: new URL(href, homeUrl).toString(), name });
  }
  return { ok: true, calendars };
}

/** 没有就叫这个名字的日历就新建一个。 */
export async function ensureCalendar(base, home, auth, name = 'Planner') {
  const homeUrl = new URL(home, base).toString();
  const list = await listCalendars(base, home, auth);
  if (!list.ok) return { ok: false, error: list.error, status: list.status };
  const want = String(name).trim().toLowerCase();
  const found = list.calendars.find((c) => c.name.trim().toLowerCase() === want)
    || list.calendars.find((c) => c.name.trim().toLowerCase().includes(want));
  if (found) return { ok: true, created: false, url: found.url, name: found.name, calendars: list.calendars };

  const slug = `${String(name).replace(/[^\w.-]+/g, '-') || 'Planner'}/`;
  const target = new URL(slug, homeUrl).toString();
  const body = `${XML_HEADER}<c:mkcalendar xmlns:d="DAV:" xmlns:c="urn:ietf:params:xml:ns:caldav"><d:set><d:prop><d:displayname>${String(name).replace(/&/g, '&amp;').replace(/</g, '&lt;')}</d:displayname><c:supported-calendar-component-set><c:comp name="VEVENT"/></c:supported-calendar-component-set></d:prop></d:set></c:mkcalendar>`;
  const r = await httpRequest({
    url: target, method: 'MKCALENDAR', auth,
    headers: { 'Content-Type': 'application/xml; charset=utf-8' },
    body,
  });
  if (!r.ok) {
    // 实测：iCloud 对第三方客户端的 MKCALENDAR 一律回 403（各种写法、UA 都试过），
    // 因此这里给一条能直接照做的指引，而不是含糊的「被拒绝」。
    const hint = r.status === 403
      ? `iCloud 不允许程序自动新建日历：请先在 iPhone「日历」App 里手动加一个名为「${name}」的日历（日历 → 底部「日历」→ 编辑 → 添加日历），然后再同步一次。`
      : describe(r);
    return { ok: false, error: hint, status: r.status, calendars: list.calendars, needs_manual_calendar: r.status === 403 };
  }
  return { ok: true, created: true, url: target, name, calendars: list.calendars };
}

/** 列出集合里已有的资源（用于清理我们写过但已失效的事件）。 */
export async function listResources(base, calendarUrl, auth) {
  const r = await propfind(base, calendarUrl, `${XML_HEADER}<d:propfind xmlns:d="DAV:"><d:prop><d:getetag/></d:prop></d:propfind>`, 1, auth);
  if (!r.ok) return { ok: false, error: describe(r), status: r.status };
  const items = [];
  for (const block of findAll(r.body, 'response')) {
    const href = firstHref(block);
    if (!href) continue;
    const etag = (findAll(block, 'getetag')[0] || '').trim();
    items.push({ url: new URL(href, calendarUrl).toString(), etag });
  }
  return { ok: true, items };
}

export async function putEvent(base, calendarUrl, auth, uid, ics) {
  const target = new URL(`${encodeURIComponent(uid)}.ics`, calendarUrl).toString();
  // iCloud 偶发限流（429/503）；退避重试两次，避免首次全量同步时丢条目。
  let r;
  for (let attempt = 0; attempt < 3; attempt++) {
    r = await httpRequest({
      url: target, method: 'PUT', auth,
      headers: { 'Content-Type': 'text/calendar; charset=utf-8' },
      body: ics,
    });
    // 429/500/502/503 都当作可重试的服务端抖动（实测 iCloud 在连续推送时会偶发 500）。
    if (r.ok || ![429, 500, 502, 503].includes(r.status)) break;
    await new Promise((done) => setTimeout(done, 600 * (attempt + 1)));
  }
  if (!r.ok) return { ok: false, error: describe(r), status: r.status };
  return { ok: true, status: r.status, url: target };
}

export async function deleteResource(base, url, auth) {
  const r = await httpRequest({ url, method: 'DELETE', auth });
  // 404 说明目标已不在，视为成功。
  if (!r.ok && r.status !== 404) return { ok: false, error: describe(r), status: r.status };
  return { ok: true, status: r.status };
}

async function mapLimit(items, limit, worker) {
  const out = [];
  let idx = 0;
  const runners = Array.from({ length: Math.min(limit, items.length) }, async () => {
    for (;;) {
      const i = idx++;
      if (i >= items.length) return;
      out[i] = await worker(items[i], i);
    }
  });
  await Promise.all(runners);
  return out;
}

/**
 * 把一批事件同步到日历：只上传有变化的，删掉已不在列表里的。
 * @param {object} opts
 * @param {Array<{uid:string, ics:string}>} opts.units
 * @param {Record<string,string>} [opts.hashes] 上次同步的内容指纹（uid -> hash），用于增量
 */
export async function syncEvents({ base, user, pass, host = 'global', calendarName = 'Planner', units, hashes = {}, log = () => {} }) {
  const auth = { user, pass };
  const server = CALDAV_PRESETS[host] || host;
  const disc = await discover(server, auth);
  if (!disc.ok) return { ok: false, stage: 'discover', error: disc.error };
  log(`[caldav] 主目录 ${disc.principal}`);
  const cal = await ensureCalendar(disc.base, disc.home, auth, calendarName);
  if (!cal.ok) {
    return {
      ok: false, stage: 'calendar', error: cal.error,
      needs_manual_calendar: !!cal.needs_manual_calendar,
      calendars: cal.calendars || [],
    };
  }
  log(`[caldav] 日历 ${cal.created ? '已新建' : '已存在'}：${cal.name} (${cal.url})`);

  const existing = await listResources(disc.base, cal.url, auth);
  if (!existing.ok) return { ok: false, stage: 'list', error: existing.error };

  const { createHash } = await import('node:crypto');
  const wanted = new Map();
  for (const u of units) {
    // 指纹要忽略每次生成都会变的 DTSTAMP，否则「内容没变」也会被当成变化而全量重推。
    wanted.set(u.uid, createHash('sha1').update(u.ics.replace(/^DTSTAMP:.*$/m, '')).digest('hex'));
  }

  const toPut = units.filter((u) => hashes[u.uid] !== wanted.get(u.uid));
  const toDelete = existing.items.filter((it) => {
    const file = decodeURIComponent(it.url.split('/').pop() || '');
    if (!file.endsWith('.ics')) return false;
    const uid = file.slice(0, -4);
    return !wanted.has(uid) && hashes[uid];
  });

  let failed = 0;
  const okUids = new Set();
  const results = await mapLimit(toPut, 4, async (u) => {
    // 连续大量写入时稍微让一让，降低被限流的概率。
    if (toPut.length > 30) await new Promise((done) => setTimeout(done, 20));
    const r = await putEvent(disc.base, cal.url, auth, u.uid, u.ics);
    if (!r.ok) { failed += 1; log(`[caldav] 上传失败 ${u.uid}：${r.error}`); }
    else okUids.add(u.uid);
    return r.ok;
  });
  let deleted = 0;
  for (const it of toDelete) {
    const r = await deleteResource(disc.base, it.url, auth);
    if (r.ok) deleted += 1;
  }

  const nextHashes = { ...hashes };
  // 只有真正推上去的才更新指纹（未变的沿用旧指纹，失败的留空以便下次重试）。
  for (const u of units) {
    if (okUids.has(u.uid)) nextHashes[u.uid] = wanted.get(u.uid);
    else if (hashes[u.uid]) nextHashes[u.uid] = hashes[u.uid];
    else delete nextHashes[u.uid];
  }
  for (const it of toDelete) delete nextHashes[decodeURIComponent(it.url.split('/').pop() || '').slice(0, -4)];

  return {
    ok: failed === 0,
    stage: 'done',
    calendar: { name: cal.name, url: cal.url, created: cal.created },
    total: units.length,
    pushed: results.filter(Boolean).length,
    unchanged: units.length - toPut.length,
    deleted,
    failed,
    hashes: nextHashes,
  };
}
