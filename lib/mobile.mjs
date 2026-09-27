// 手机 / 办公本同步：Bark 推送、每日邮件摘要、日历订阅地址、文件中转。
import os from 'node:os';
import { randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { buildPlan } from './plan-export.mjs';
import { buildIcs, buildIcsUnits } from './ics.mjs';
import { whenText } from './digest.mjs';
import { barkPush, BARK_DEFAULT_SERVER } from './bark.mjs';
import { sendMail } from './smtp.mjs';
import { syncEvents, discover, listCalendars, CALDAV_PRESETS } from './caldav.mjs';

const pad = (n) => String(n).padStart(2, '0');
const ymd = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const hm = (d) => `${pad(d.getHours())}:${pad(d.getMinutes())}`;
const WEEK = ['日', '一', '二', '三', '四', '五', '六'];

export const MOBILE_KEYS = {
  bark_enabled: 'mobile_bark_enabled',
  bark_key: 'mobile_bark_key',
  bark_server: 'mobile_bark_server',
  bark_sources: 'mobile_bark_sources',
  digest_enabled: 'mobile_digest_enabled',
  digest_time: 'mobile_digest_time',
  digest_to: 'mobile_digest_to',
  digest_from: 'mobile_digest_from',
  digest_last: 'mobile_digest_last',
  digest_result: 'mobile_digest_result',
  // 晚报（2026-09-22 新增）：和早报各自独立的开关 / 时间 / 记录
  digest_evening_enabled: 'mobile_digest_evening_enabled',
  digest_evening_time: 'mobile_digest_evening_time',
  digest_evening_last: 'mobile_digest_evening_last',
  digest_evening_result: 'mobile_digest_evening_result',
  cal_token: 'mobile_cal_token',
  lan_enabled: 'mobile_lan_enabled',
  mobile_dir: 'mobile_dir',
  icloud_enabled: 'mobile_icloud_enabled',
  icloud_host: 'mobile_icloud_host',
  icloud_user: 'mobile_icloud_user',
  icloud_pass: 'mobile_icloud_pass',
  icloud_calendar: 'mobile_icloud_calendar',
  icloud_time: 'mobile_icloud_time',
  icloud_last: 'mobile_icloud_last',
  icloud_result: 'mobile_icloud_result',
  icloud_hashes: 'mobile_icloud_hashes',
  icloud_identity: 'mobile_icloud_identity',
};

// ---------- 设置读写 ----------
export function getMobilePrefs(store) {
  const g = (k, d) => { const v = store.getSync(k); return v === null || v === undefined || v === '' ? d : v; };
  return {
    bark_enabled: g(MOBILE_KEYS.bark_enabled, '1') === '1',
    bark_key: g(MOBILE_KEYS.bark_key, ''),
    bark_server: g(MOBILE_KEYS.bark_server, BARK_DEFAULT_SERVER),
    bark_sources: g(MOBILE_KEYS.bark_sources, 'email_sjtu,canvas'),
    digest_enabled: g(MOBILE_KEYS.digest_enabled, '0') === '1',
    digest_time: g(MOBILE_KEYS.digest_time, '07:00'),
    digest_to: g(MOBILE_KEYS.digest_to, ''),
    digest_from: g(MOBILE_KEYS.digest_from, 'email_sjtu'),
    digest_last: g(MOBILE_KEYS.digest_last, ''),
    digest_result: g(MOBILE_KEYS.digest_result, ''),
    digest_evening_enabled: g(MOBILE_KEYS.digest_evening_enabled, '0') === '1',
    digest_evening_time: g(MOBILE_KEYS.digest_evening_time, '21:00'),
    digest_evening_last: g(MOBILE_KEYS.digest_evening_last, ''),
    digest_evening_result: g(MOBILE_KEYS.digest_evening_result, ''),
    cal_token: g(MOBILE_KEYS.cal_token, ''),
    lan_enabled: g(MOBILE_KEYS.lan_enabled, '1') === '1',
    mobile_dir: g(MOBILE_KEYS.mobile_dir, ''),
    icloud_enabled: g(MOBILE_KEYS.icloud_enabled, '0') === '1',
    icloud_host: g(MOBILE_KEYS.icloud_host, 'china'),
    icloud_user: g(MOBILE_KEYS.icloud_user, ''),
    icloud_pass: g(MOBILE_KEYS.icloud_pass, ''),
    icloud_calendar: g(MOBILE_KEYS.icloud_calendar, 'Planner'),
    icloud_time: g(MOBILE_KEYS.icloud_time, '07:00'),
    icloud_last: g(MOBILE_KEYS.icloud_last, ''),
    icloud_result: g(MOBILE_KEYS.icloud_result, ''),
  };
}

export function saveMobilePrefs(store, patch = {}) {
  const set = (k, v) => store.setSync(k, v);
  if (patch.bark_enabled !== undefined) set(MOBILE_KEYS.bark_enabled, patch.bark_enabled ? '1' : '0');
  if (patch.bark_key !== undefined) set(MOBILE_KEYS.bark_key, String(patch.bark_key || '').trim());
  if (patch.bark_server !== undefined) set(MOBILE_KEYS.bark_server, String(patch.bark_server || BARK_DEFAULT_SERVER).trim());
  if (patch.bark_sources !== undefined) set(MOBILE_KEYS.bark_sources, String(patch.bark_sources || '').trim());
  if (patch.digest_enabled !== undefined) set(MOBILE_KEYS.digest_enabled, patch.digest_enabled ? '1' : '0');
  if (patch.digest_time !== undefined) set(MOBILE_KEYS.digest_time, String(patch.digest_time || '07:00').trim());
  if (patch.digest_to !== undefined) set(MOBILE_KEYS.digest_to, String(patch.digest_to || '').trim());
  if (patch.digest_from !== undefined) set(MOBILE_KEYS.digest_from, String(patch.digest_from || 'email_sjtu').trim());
  if (patch.digest_evening_enabled !== undefined) set(MOBILE_KEYS.digest_evening_enabled, patch.digest_evening_enabled ? '1' : '0');
  if (patch.digest_evening_time !== undefined) set(MOBILE_KEYS.digest_evening_time, String(patch.digest_evening_time || '21:00').trim());
  if (patch.lan_enabled !== undefined) set(MOBILE_KEYS.lan_enabled, patch.lan_enabled ? '1' : '0');
  if (patch.mobile_dir !== undefined) set(MOBILE_KEYS.mobile_dir, String(patch.mobile_dir || '').trim());
  if (patch.icloud_enabled !== undefined) set(MOBILE_KEYS.icloud_enabled, patch.icloud_enabled ? '1' : '0');
  if (patch.icloud_host !== undefined) set(MOBILE_KEYS.icloud_host, String(patch.icloud_host || 'china').trim());
  if (patch.icloud_user !== undefined) set(MOBILE_KEYS.icloud_user, String(patch.icloud_user || '').trim());
  if (patch.icloud_pass !== undefined) set(MOBILE_KEYS.icloud_pass, String(patch.icloud_pass || '').trim());
  if (patch.icloud_calendar !== undefined) set(MOBILE_KEYS.icloud_calendar, String(patch.icloud_calendar || 'Planner').trim() || 'Planner');
  if (patch.icloud_time !== undefined) set(MOBILE_KEYS.icloud_time, String(patch.icloud_time || '07:00').trim());
  return getMobilePrefs(store);
}

// ---------- 日历订阅 ----------
export function ensureCalToken(store, { reset = false } = {}) {
  const cur = store.getSync(MOBILE_KEYS.cal_token);
  if (cur && !reset) return cur;
  const token = randomBytes(8).toString('hex');
  store.setSync(MOBILE_KEYS.cal_token, token);
  return token;
}

export function lanAddresses() {
  const out = [];
  try {
    for (const [name, list] of Object.entries(os.networkInterfaces())) {
      for (const a of list || []) {
        if (a.family === 'IPv4' && !a.internal) out.push({ name, address: a.address });
      }
    }
  } catch { /* ignore */ }
  return out;
}

export function calendarInfo(store, { port = 3211 } = {}) {
  const token = ensureCalToken(store);
  const prefs = getMobilePrefs(store);
  const hosts = lanAddresses();
  const urls = hosts.map((h) => ({
    name: h.name,
    ip: h.address,
    ics: `http://${h.address}:${port}/cal/${token}.ics`,
    webcal: `webcal://${h.address}:${port}/cal/${token}.ics`,
    txt: `http://${h.address}:${port}/cal/${token}.txt`,
    page: `http://${h.address}:${port}/cal/${token}`,
  }));
  return { token, port, enabled: prefs.lan_enabled, urls };
}

export function calendarPayload(store, opts = {}) {
  const built = buildIcs(store, opts);
  return built;
}

// ---------- 每日摘要（早报 / 晚报）----------
const DIGEST_BANDS = { high: '重要', normal: '一般', low: '低' };

/**
 * 点开就是"今天要干嘛"的白菜清单；`brief` 传进来时，最前面多一段
 * 「最值得先看的 3 条 + 建议」（由 lib/digest.mjs 算好，排序和「重要信息」同一套）。
 */
export function buildDigestText(store, { days = 2, appName = 'Cairn', kind = 'morning', brief = null } = {}) {
  const plan = buildPlan(store, { days });
  const now = new Date();
  const L = [];
  L.push(`${appName} · ${ymd(now)} 周${WEEK[now.getDay()]} ${hm(now)}`);
  L.push('='.repeat(34));
  L.push(`未完成 ${plan.stats.open_tasks} 项 · 逾期 ${plan.backlog.overdue.length} 项 · 日程 ${plan.stats.events} 项`);
  L.push('');
  if (brief && ((brief.top || []).length || (brief.advice || []).length)) {
    const focus = kind === 'evening' ? '明天' : '今天';
    L.push(`【${focus}最值得先看的 ${(brief.top || []).length} 条】（按你的未来规划排序）`);
    if (!(brief.top || []).length) L.push('  （暂时没有需要特别优先处理的信息）');
    (brief.top || []).forEach((x, i) => {
      const where = [whenText(x.daysLeft), x.source].filter(Boolean).join(' · ');
      const tag = `${DIGEST_BANDS[x.band] || '待看'}${x.importance != null ? ` ${x.importance}` : ''}`;
      L.push(`  ${i + 1}. [${tag}] ${x.title}${where ? `（${where}）` : ''}`);
      if (x.why) L.push(`     · 为什么：${x.why}`);
    });
    if (kind === 'evening' && brief.stats) {
      L.push(`  今天到期 ${brief.stats.today_due || 0} 项：完成 ${brief.stats.today_done || 0} · 还没做完 ${brief.stats.today_open || 0}`);
    }
    if ((brief.advice || []).length) {
      L.push('【建议】');
      for (const a of (brief.advice || []).slice(0, 3)) L.push(`  · ${a.text}`);
    }
    L.push('');
  }
  for (const d of plan.days.slice(0, Math.max(1, days))) {
    const label = d.is_today ? '今天' : '明天';
    L.push(`【${label}】${d.date} 周${d.weekday}`);
    if (d.academic.length) L.push(`  校历：${d.academic.map((a) => a.title).join('、')}`);
    for (const c of d.courses) {
      L.push(`  ${c.start}  ${c.course}${c.location ? ` @${c.location}` : ''}`);
    }
    for (const e of d.events) {
      L.push(`  ${e.all_day ? '全天' : e.start.slice(11)}  ${e.title}`);
    }
    const pending = d.due_tasks.filter((t) => t.status !== 'done');
    for (const t of pending) L.push(`  [截止] ${t.title}`);
    for (const r of d.reminders) L.push(`  [提醒] ${r.at.slice(11)} ${r.title}`);
    if (d.milestones.length) L.push(`  [里程碑] ${d.milestones.map((m) => m.title).join('、')}`);
    if (!d.courses.length && !d.events.length && !pending.length && !d.reminders.length) L.push('  （无固定安排）');
    L.push('');
  }
  if (plan.backlog.overdue.length) {
    L.push('【逾期未完成】');
    for (const t of plan.backlog.overdue.slice(0, 12)) L.push(`  · ${t.title}（原截止 ${t.due}）`);
    if (plan.backlog.overdue.length > 12) L.push(`  · 还有 ${plan.backlog.overdue.length - 12} 项`);
    L.push('');
  }
  // 投递三档里的"摘要档"（P1）：被筛选拦下、等你确认的条目，集中出现在这里，
  // 不用你专门去数据源页翻「待批准」。
  const blocked = (() => {
    try {
      return (store.listPending ? store.listPending() : [])
        .filter((r) => r && (r.verdict === 'review' || r.verdict === 'drop'))
        .slice(0, 10);
    } catch { return []; }
  })();
  if (blocked.length) {
    L.push('【被筛选拦下，等你确认】');
    for (const r of blocked) {
      const tag = r.verdict === 'drop' ? '建议忽略' : '待确认';
      const why = (() => {
        try {
          const rs = (JSON.parse(r.reasons || '[]') || []).filter((x) => x.delta);
          return rs.length ? ` —— ${rs[0].note || rs[0].rule}` : '';
        } catch { return ''; }
      })();
      L.push(`  · [${tag}] ${r.title}${why}`);
    }
    L.push('  （在「数据源 → 待批准」里可以批准或删除；删几次之后系统会学着自动处理）');
    L.push('');
  }
  L.push(`附件：planner-calendar.ics 可直接导入 iPhone 日历；today-plan.txt 适合放到办公本阅读。`);
  L.push('本邮件由本机 Planner 自动发送。');
  return L.join('\r\n');
}

export function digestAttachments(store, { dateLabel = ymd(new Date()), kind = 'morning', brief = null, appName = 'Cairn' } = {}) {
  const text = buildDigestText(store, { days: 2, kind, brief, appName });
  const ics = buildIcs(store, {});
  return [
    { filename: `${kind === 'evening' ? 'evening' : 'today'}-plan-${dateLabel}.txt`, contentType: 'text/plain; charset=utf-8', content: Buffer.concat([Buffer.from([0xEF, 0xBB, 0xBF]), Buffer.from(text, 'utf8')]) },
    { filename: 'planner-calendar.ics', contentType: 'text/calendar; charset=utf-8; method=PUBLISH', content: Buffer.from(ics.ics, 'utf8') },
  ];
}

// 从连接器配置里取发信账号（IMAP 的账号密码与 SMTP 通用）。
export function mailAccount(store, source = 'email_sjtu') {
  const order = [source, 'email_sjtu', 'email'];
  for (const s of order) {
    const row = store.getConnector ? store.getConnector(s) : null;
    if (!row) continue;
    let cfg = {};
    try { cfg = JSON.parse(row.config_json || '{}'); } catch { /* ignore */ }
    if (!cfg.user || !cfg.password) continue;
    const host = String(cfg.host || '');
    const smtpHost = cfg.smtp_host
      || (/gmail/i.test(host) ? 'smtp.gmail.com'
        : /sjtu/i.test(host) ? 'mail.sjtu.edu.cn'
          : host.replace(/^imap\./i, 'smtp.'));
    return {
      source: s,
      smtp_host: smtpHost,
      smtp_port: Number(cfg.smtp_port || 465),
      user: cfg.user,
      pass: cfg.password,
    };
  }
  return null;
}

/**
 * 立刻发送一封「今日安排」到手机 / 办公本邮箱。
 */
export async function sendDigest(store, { dataDir, force = false, appName = 'Cairn', kind = 'morning', brief = null } = {}) {
  const prefs = getMobilePrefs(store);
  const evening = kind === 'evening';
  const resultKey = evening ? MOBILE_KEYS.digest_evening_result : MOBILE_KEYS.digest_result;
  const lastKey = evening ? MOBILE_KEYS.digest_evening_last : MOBILE_KEYS.digest_last;
  const acct = mailAccount(store, prefs.digest_from);
  if (!acct) {
    const r = { ok: false, at: new Date().toISOString(), error: '还没有可用的发信邮箱（请先在「数据源」里配好交大邮箱或 Gmail）' };
    store.setSync(resultKey, JSON.stringify(r));
    return r;
  }
  const to = (prefs.digest_to || acct.user).split(/[,;，；\s]+/).filter(Boolean);
  const now = new Date();
  const subject = evening
    ? `今晚复盘 · 明天安排 ${ymd(now)} 周${WEEK[now.getDay()]}`
    : `今日安排 ${ymd(now)} 周${WEEK[now.getDay()]}`;
  const sendRes = await sendMail({
    host: acct.smtp_host,
    port: acct.smtp_port,
    user: acct.user,
    pass: acct.pass,
    from: acct.user,
    to,
    subject,
    text: buildDigestText(store, { days: 2, appName, kind, brief }),
    attachments: digestAttachments(store, { appName, kind, brief }),
  });
  const result = {
    ok: !!sendRes.ok,
    at: now.toISOString(),
    kind,
    from: acct.user,
    smtp: `${acct.smtp_host}:${acct.smtp_port}`,
    to,
    error: sendRes.error || null,
    forced: !!force,
  };
  store.setSync(resultKey, JSON.stringify(result));
  if (sendRes.ok) store.setSync(lastKey, ymd(now));
  // 本地留一份，办公本也能用数据线直接拷。
  try { writeMobileFiles(store, { dataDir }); } catch { /* ignore */ }
  return result;
}

export function digestDue(store, { kind = 'morning' } = {}) {
  const prefs = getMobilePrefs(store);
  const evening = kind === 'evening';
  if (evening ? !prefs.digest_evening_enabled : !prefs.digest_enabled) return false;
  const now = new Date();
  if ((evening ? prefs.digest_evening_last : prefs.digest_last) === ymd(now)) return false;
  const fallback = evening ? '21:00' : '07:00';
  const m = String((evening ? prefs.digest_evening_time : prefs.digest_time) || fallback).match(/^(\d{1,2}):(\d{2})$/);
  const hh = m ? Number(m[1]) : (evening ? 21 : 7);
  const mm = m ? Number(m[2]) : 0;
  return now.getHours() * 60 + now.getMinutes() >= hh * 60 + mm;
}

/**
 * 到点就发（早报 / 晚报各看一次）。
 *
 * `briefFor(kind)` 由 server 传进来：摘要要用「重要信息」那套排序结果，
 * 而那个只在服务端算得出来（保持"哪条重要"全项目一个定义）。
 */
export async function sendDueDigests(store, {
  dataDir, appName = 'Cairn', briefFor = null, kinds = ['morning', 'evening'],
  log = () => {}, warn = () => {},
} = {}) {
  const out = [];
  for (const kind of kinds) {
    if (!digestDue(store, { kind })) continue;
    const label = kind === 'evening' ? '晚报' : '早报';
    try {
      const r = await sendDigest(store, { dataDir, appName, kind, brief: briefFor ? briefFor(kind) : null });
      out.push(r);
      if (r.ok) log(`[digest] ${label}已发送：${(r.to || []).join(', ')}`);
      else warn(`[digest] ${label}发送失败：${r.error}`);
    } catch (e) {
      warn(`[digest] ${label}发送出错：${e && e.message ? e.message : e}`);
    }
  }
  return out;
}

/** 手动发（「立即发送一封」按钮）：kind = morning | evening | both。 */
export async function sendDigestNow(store, { dataDir, appName = 'Cairn', kind = 'morning', briefFor = null } = {}) {
  const kinds = kind === 'both' ? ['morning', 'evening'] : [kind === 'evening' ? 'evening' : 'morning'];
  const results = [];
  for (const k of kinds) {
    results.push(await sendDigest(store, { dataDir, force: true, appName, kind: k, brief: briefFor ? briefFor(k) : null }));
  }
  // 只发一封时保持原来的返回形状（老界面/老脚本不用改）
  return results.length === 1 ? results[0] : { ok: results.every((r) => r.ok), results };
}

// ---------- iCloud 日历直推（CalDAV） ----------
function icloudConfigError(prefs) {
  if (!prefs.icloud_user) return '还没有填 Apple ID';
  if (!prefs.icloud_pass) return '还没有填 App 专用密码';
  return '';
}

/** 只做发现与列日历，不写入任何东西；用于「测试连接」。 */
export async function testIcloud(store) {
  const prefs = getMobilePrefs(store);
  const bad = icloudConfigError(prefs);
  if (bad) return { ok: false, error: bad };
  const server = CALDAV_PRESETS[prefs.icloud_host] || prefs.icloud_host;
  const auth = { user: prefs.icloud_user, pass: prefs.icloud_pass };
  const disc = await discover(server, auth);
  if (!disc.ok) return { ok: false, stage: 'discover', error: disc.error };
  const list = await listCalendars(disc.base, disc.home, auth);
  if (!list.ok) return { ok: false, stage: 'list', error: list.error };
  return {
    ok: true,
    server,
    principal: disc.principal,
    home: disc.home,
    calendars: list.calendars.map((c) => c.name || '(未命名)'),
    target_exists: list.calendars.some((c) => String(c.name || '').trim().toLowerCase() === String(prefs.icloud_calendar).trim().toLowerCase()),
  };
}

/**
 * 把当前的课程 / 校历 / DDL / 里程碑直接写进 iCloud 日历（增量：只推进有变化的）。
 */
export async function syncIcloud(store, { force = false, log = () => {} } = {}) {
  const prefs = getMobilePrefs(store);
  const bad = icloudConfigError(prefs);
  if (bad) {
    const r = { ok: false, at: new Date().toISOString(), error: bad };
    store.setSync(MOBILE_KEYS.icloud_result, JSON.stringify(r));
    return r;
  }
  let hashes = {};
  try { hashes = JSON.parse(store.getSync(MOBILE_KEYS.icloud_hashes) || '{}'); } catch { hashes = {}; }
  // 换了账号或日历就当作全新同步（否则新日历会因为「内容没变」而一直是空的）。
  const identity = `${prefs.icloud_host}|${prefs.icloud_user}|${prefs.icloud_calendar}`;
  if (store.getSync(MOBILE_KEYS.icloud_identity) !== identity) hashes = {};

  const { units } = buildIcsUnits(store, {});
  const res = await syncEvents({
    host: prefs.icloud_host,
    user: prefs.icloud_user,
    pass: prefs.icloud_pass,
    calendarName: prefs.icloud_calendar,
    units,
    hashes,
    log,
  });
  const result = {
    ok: !!res.ok,
    at: new Date().toISOString(),
    forced: !!force,
    total: res.total,
    pushed: res.pushed,
    unchanged: res.unchanged,
    deleted: res.deleted,
    failed: res.failed,
    calendar: res.calendar || null,
    stage: res.stage || null,
    needs_manual_calendar: !!res.needs_manual_calendar,
    calendars: res.calendars || null,
    error: res.error || (res.failed ? `${res.failed} 条上传失败` : null),
  };
  if (res.hashes) {
    // 部分失败时也保存成功的部分，避免每次都全量重推；失败条目靠指纹缺失在下次自动重试。
    store.setSync(MOBILE_KEYS.icloud_identity, identity);
    store.setSync(MOBILE_KEYS.icloud_hashes, JSON.stringify(res.hashes));
  }
  // 无论成功与否都记下「今天试过了」，否则 4 秒一次的调度器会不停重试同一件事。
  store.setSync(MOBILE_KEYS.icloud_last, ymd(new Date()));
  store.setSync(MOBILE_KEYS.icloud_result, JSON.stringify(result));
  return result;
}

export function icloudDue(store) {
  const prefs = getMobilePrefs(store);
  if (!prefs.icloud_enabled) return false;
  if (icloudConfigError(prefs)) return false;
  const now = new Date();
  if (prefs.icloud_last === ymd(now)) return false;
  const m = String(prefs.icloud_time || '07:00').match(/^(\d{1,2}):(\d{2})$/);
  const hh = m ? Number(m[1]) : 7;
  const mm = m ? Number(m[2]) : 0;
  return now.getHours() * 60 + now.getMinutes() >= hh * 60 + mm;
}

// ---------- 本地文件（数据线 / 网盘中转） ----------
export function writeMobileFiles(store, { dataDir } = {}) {
  const prefs = getMobilePrefs(store);
  const now = new Date();
  const label = ymd(now);
  const dirs = [];
  if (dataDir) dirs.push(join(dataDir, 'mobile'));
  if (prefs.mobile_dir && existsSync(prefs.mobile_dir)) dirs.push(prefs.mobile_dir);
  const written = [];
  const ics = buildIcs(store, {});
  for (const dir of dirs) {
    try {
      mkdirSync(dir, { recursive: true });
      const txt = join(dir, `today-plan-${label}.txt`);
      writeFileSync(txt, Buffer.concat([Buffer.from([0xEF, 0xBB, 0xBF]), Buffer.from(buildDigestText(store, { days: 2 }), 'utf8')]));
      const cal = join(dir, 'planner-calendar.ics');
      writeFileSync(cal, ics.ics, 'utf8');
      written.push(txt, cal);
    } catch { /* 单个目录失败不影响其它 */ }
  }
  return { written, ics_events: ics.count };
}

// ---------- Bark 推送 ----------
export async function pushBarkNotification(store, { title, body = '', url = '', level = 'active', force = false } = {}) {
  const prefs = getMobilePrefs(store);
  if (!force && (!prefs.bark_enabled || !prefs.bark_key)) return { ok: false, skipped: 'not-configured' };
  if (!prefs.bark_key) return { ok: false, error: '还没有填写 Bark 密钥' };
  const res = await barkPush({
    key: prefs.bark_key,
    server: prefs.bark_server,
    title,
    body,
    url: url || undefined,
    level,
    group: 'Planner',
  });
  return res;
}

export function barkSourceAllowed(store, source) {
  const prefs = getMobilePrefs(store);
  if (!prefs.bark_enabled || !prefs.bark_key) return false;
  const list = String(prefs.bark_sources || '').split(/[,;，；\s]+/).filter(Boolean);
  if (!list.length) return true;
  return list.includes(source);
}
