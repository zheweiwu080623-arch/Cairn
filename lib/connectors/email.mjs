import tls from 'node:tls';
import { emailSample } from './samples.mjs';

export const meta = {
  id: 'email',
  name: '邮箱 (IMAP)',
  icon: '📧',
  description: '通过 IMAP 读取收件箱邮件（支持 Gmail / Zimbra / 任意标准 IMAP），转为任务或提醒。',
  fields: [
    { key: 'host', label: 'IMAP 服务器', type: 'text', required: true, placeholder: 'imap.gmail.com' },
    { key: 'port', label: '端口(SSL)', type: 'number', required: true, placeholder: '993', default: 993 },
    { key: 'user', label: '邮箱账号', type: 'text', required: true, placeholder: 'you@example.com' },
    { key: 'password', label: '密码 / 应用专用密码', type: 'password', required: true, placeholder: '••••••••' },
    { key: 'since_days', label: '最近 N 天', type: 'number', required: false, placeholder: '7', default: 7 },
    { key: 'gmail_exclude_categories', label: 'Gmail 排除的分类', type: 'text', required: false, placeholder: 'social,promotions,forums', default: 'social,promotions,forums' },
    { key: 'block_senders', label: '屏蔽的发件域名（逗号分隔）', type: 'text', required: false, placeholder: 'instagram.com,redditmail.com,...' },
  ],
};

// 默认屏蔽：社交媒体 + 推送型广告。留空（或在设置里删掉）即不过滤。
const DEFAULT_BLOCK_SENDERS = [
  'instagram.com', 'facebookmail.com', 'facebook.com', 'redditmail.com', 'reddit.com',
  'twitter.com', 'x.com', 'tiktok.com', 'snapchat.com', 'pinterest.com',
  'quora.com', 'grammarly.com', 'adobe.com', 'suno.com', 'uber.com', 'spotify.com',
].join(',');

const DEFAULT_GMAIL_EXCLUDE = 'social,promotions,forums';

// ---- minimal IMAP over TLS client (no deps) ----
function imapConnect({ host, port = 993, user, password, timeout = 20000 }) {
  return new Promise((resolve, reject) => {
    const socket = tls.connect({ host, port, rejectUnauthorized: false });
    let buffer = Buffer.alloc(0);
    let inLiteral = false;
    let literalRemaining = 0;
    let lineAcc = '';
    let tagSeq = 0;
    const untagged = [];
    let readyResolve = null;

    const send = (cmd) => { socket.write(cmd + '\r\n'); };

    const processBuffer = () => {
      for (;;) {
        if (inLiteral) {
          if (buffer.length < literalRemaining) return;
          lineAcc += buffer.slice(0, literalRemaining).toString('utf8');
          buffer = buffer.slice(literalRemaining);
          inLiteral = false;
          continue;
        }
        const idx = buffer.indexOf('\r\n');
        if (idx < 0) return;
        let line = buffer.slice(0, idx).toString('utf8');
        buffer = buffer.slice(idx + 2);
        const litMatch = line.match(/\{(\d+)\}\s*$/);
        if (litMatch) {
          lineAcc += line.slice(0, litMatch.index);
          inLiteral = true;
          literalRemaining = parseInt(litMatch[1], 10);
          continue;
        }
        const full = lineAcc + line;
        lineAcc = '';
        handleLine(full);
      }
    };

    const handleLine = (line) => {
      if (/^\+ /.test(line)) return; // continuation — ignore for LOGIN (we send literal-style)
      if (/^\* /.test(line)) {
        untagged.push(line);
        return;
      }
      const m = line.match(/^([A-Za-z0-9.-]+) (OK|NO|BAD|BYE)\b(.*)$/);
      if (m) {
        const ok = m[2] === 'OK';
        const payload = { ok, text: m[3].trim(), untagged: untagged.splice(0) };
        if (pendingCommand) {
          const cb = pendingCommand;
          pendingCommand = null;
          cb(payload);
        } else if (readyResolve) {
          const r = readyResolve; readyResolve = null;
          r();
        }
        if (!ok && m[2] !== 'OK') return;
      }
    };

    let pendingCommand = null;
    const command = (cmd, tagPrefix = 'A') => {
      tagSeq += 1;
      const tag = `${tagPrefix}${tagSeq}`;
      return new Promise((res, rej) => {
        pendingCommand = (p) => (p.ok ? res(p) : rej(new Error(p.text || p.untagged.join(' '))));
        send(`${tag} ${cmd}`);
      });
    };

    socket.on('data', (chunk) => {
      buffer = Buffer.concat([buffer, chunk]);
      processBuffer();
    });
    socket.on('error', reject);
    socket.on('close', () => { if (readyResolve) { const r = readyResolve; readyResolve = null; r(); } });
    socket.on('connect', () => {
      // On TLS connect, the server sends a greeting `* OK ...` then we're ready.
      readyResolve = () => {
        resolve({
          command,
          logout: () => command('LOGOUT').catch(() => {}).finally(() => socket.end()),
          socket,
        });
      };
      setTimeout(() => { if (readyResolve) { const r = readyResolve; readyResolve = null; r(); } }, 1500);
    });
    socket.setTimeout(timeout, () => reject(new Error('连接超时')));
  });
}

export async function fetchAll(config) {
  if (!config?.host || !config?.user || !config?.password) throw new Error('缺少主机/账号/密码');
  const sinceDays = parseInt(config.since_days || '7', 10) || 7;
  const isGmail = /(^|\.)(gmail|googlemail)\.com$/i.test(String(config.host)) || /gmail/i.test(String(config.host));
  const excludeCats = String(config.gmail_exclude_categories === undefined ? DEFAULT_GMAIL_EXCLUDE : config.gmail_exclude_categories)
    .split(',').map((s) => s.trim()).filter(Boolean);
  const blockDomains = String(config.block_senders === undefined ? DEFAULT_BLOCK_SENDERS : config.block_senders)
    .split(',').map((s) => s.trim().toLowerCase().replace(/^@/, '')).filter(Boolean);
  const client = await imapConnect(config);
  const { command, logout } = client;
  try {
    // login
    const login = await command(`LOGIN "${escQ(config.user)}" "${escQ(config.password)}"`);
    await command('SELECT INBOX');
    const sinceDate = fmtImapDate(new Date(Date.now() - sinceDays * 86400000));
    // Gmail：按分类排除社媒/促销/论坛（X-GM-RAW 是 Gmail 的扩展搜索）。
    let search;
    let categoryFiltered = false;
    if (isGmail && excludeCats.length) {
      const raw = excludeCats.map((c) => `-category:${c}`).join(' ');
      try {
        search = await command(`UID SEARCH SINCE ${sinceDate} X-GM-RAW "${raw}"`);
        categoryFiltered = true;
      } catch {
        search = null; // 服务器不支持就退回普通搜索
      }
    }
    if (!search) search = await command(`UID SEARCH SINCE ${sinceDate}`);
    const uids = parseSearch(search.untagged);
    const items = [];
    let blocked = 0;
    if (uids.length) {
      const set = uids.join(',');
      const fetched = await command(`UID FETCH ${set} (UID ENVELOPE)`);
      for (const line of fetched.untagged.filter((l) => /FETCH/.test(l))) {
        const env = parseEnvelope(line);
        if (!env) continue;
        // 第二层：发件域名黑名单（社交媒体 / 广告推送）
        if (blockDomains.length && senderBlocked(env.from, blockDomains)) { blocked++; continue; }
        items.push({
          kind: 'task',
          external_id: env.uid,
          title: env.subject || '（无主题邮件）',
          due_at: env.date || null,
          url: buildMailUrl(config, env),
          notes: `发件人：${env.from || '未知'}`,
          raw: 'imap',
        });
      }
    }
    return { items, raw: { messages: items.length, skipped_social_ads: blocked, category_filter: categoryFiltered } };
  } finally {
    try { await logout(); } catch { /* ignore */ }
  }
}

// 从 "Name <user@host>" 里取域名判断是否命中黑名单
function senderBlocked(from, domains) {
  const s = String(from || '').toLowerCase();
  const m = s.match(/<([^>]+)>/);
  const addr = m ? m[1] : s;
  const at = addr.lastIndexOf('@');
  if (at < 0) return false;
  const host = addr.slice(at + 1).trim();
  return domains.some((d) => host === d || host.endsWith('.' + d));
}

function escQ(s) { return String(s).replace(/\\/g, '\\\\').replace(/"/g, '\\"'); }
function fmtImapDate(d) {
  const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  return `${d.getDate()}-${months[d.getMonth()]}-${d.getFullYear()}`;
}
function parseSearch(lines) {
  const out = [];
  for (const l of lines) {
    const m = l.match(/^\* SEARCH(\s[\d ]+)?$/);
    if (m) out.push(...(m[1] || '').trim().split(/\s+/).filter(Boolean).map(Number));
  }
  return out;
}

function parseEnvelope(line) {
  const fetchM = line.match(/^\* \d+ FETCH \((.*)\)\s*$/);
  if (!fetchM) return null;
  const tokens = tokenize(fetchM[1]);
  // tokens look like [.., 'UID', '123', 'ENVELOPE', [date, subject, addr, ...], ...]
  const envIndex = tokens.indexOf('ENVELOPE');
  if (envIndex < 0) return null;
  const env = tokens[envIndex + 1];
  if (!Array.isArray(env)) return null;
  const [date, subject, fromList] = env;
  const uidTok = tokens[tokens.indexOf('UID') + 1];
  return {
    uid: uidTok,
    date: parseImapDate(date),
    subject: decodeMime(subject),
    from: decodeMime(parseAddress(fromList)),
    // ENVELOPE 第 10 个字段是 Message-ID，用它可以直达邮件本体
    messageId: decodeMime(env[9]) || null,
  };
}

// 生成「打开这封邮件」的链接：Gmail 用 rfc822msgid 直达，Zimbra 用搜索定位。
function buildMailUrl(config, env) {
  const host = String(config.host || '').toLowerCase();
  const msgId = env.messageId ? String(env.messageId).trim() : '';
  const subject = String(env.subject || '').trim();
  if (host.includes('gmail') || host.includes('googlemail')) {
    if (msgId) return `https://mail.google.com/mail/u/0/#search/rfc822msgid:${encodeURIComponent(msgId)}`;
    if (subject) return `https://mail.google.com/mail/u/0/#search/${encodeURIComponent(subject)}`;
    return 'https://mail.google.com/mail/u/0/#inbox';
  }
  // Zimbra（交大邮箱）：modern 界面的搜索路由
  const base = `https://${config.host}/modern/`;
  if (subject) return `${base}#search?query=${encodeURIComponent(`subject:"${subject}"`)}`;
  return base;
}

// RFC 2047 解码：把 =?UTF-8?B?...?= / =?GBK?Q?...?= 还原为可读文本
function decodeMime(value) {
  if (!value || typeof value !== 'string' || value.indexOf('=?') < 0) return value;
  const joined = value.replace(/\?=\s+=\?/g, '?==?'); // 相邻编码字之间不应有空格
  return joined.replace(/=\?([^?]+)\?([BbQq])\?([^?]*)\?=/g, (whole, charset, enc, data) => {
    try {
      let bytes;
      if (enc.toUpperCase() === 'B') {
        bytes = Buffer.from(data, 'base64');
      } else {
        const raw = data.replace(/_/g, ' ')
          .replace(/=([0-9A-Fa-f]{2})/g, (_, h) => String.fromCharCode(parseInt(h, 16)));
        bytes = Buffer.from(raw, 'binary');
      }
      const label = String(charset).toLowerCase();
      const decoder = new TextDecoder(label === 'gb2312' ? 'gbk' : label, { fatal: false });
      return decoder.decode(bytes);
    } catch {
      try { return new TextDecoder('utf-8', { fatal: false }).decode(bytes); } catch { return whole; }
    }
  });
}

function tokenize(str) {
  const tokens = [];
  let i = 0;
  const n = str.length;
  while (i < n) {
    const ch = str[i];
    if (ch === ' ' || ch === '\t') { i++; continue; }
    if (ch === '(') { tokens.push('('); i++; continue; }
    if (ch === ')') { tokens.push(')'); i++; continue; }
    if (ch === '"') {
      let j = i + 1, out = '';
      while (j < n && str[j] !== '"') { if (str[j] === '\\' && j + 1 < n) { out += str[j + 1]; j += 2; } else { out += str[j]; j++; } }
      tokens.push(out); i = j + 1; continue;
    }
    // atom
    let j = i;
    while (j < n && !/[\s()]/.test(str[j])) j++;
    tokens.push(str.slice(i, j));
    i = j;
  }
  // build nested array from () tokens
  return buildTree(tokens, 0).value;
}

function buildTree(tokens, idx) {
  const arr = [];
  let i = idx;
  while (i < tokens.length) {
    const t = tokens[i];
    if (t === '(') { const r = buildTree(tokens, i + 1); arr.push(r.value); i = r.next; continue; }
    if (t === ')') return { value: arr, next: i + 1 };
    arr.push(t); i++;
  }
  return { value: arr, next: i };
}

function parseAddress(list) {
  if (!Array.isArray(list)) return null;
  // ENVELOPE 的 from/to 结构是「地址结构数组」：[[name, adl, mailbox, host], ...]
  // 兼容对方只给单个地址结构（未再包一层）的情况。
  const entries = list.every((x) => Array.isArray(x)) ? list : [list];
  const parts = entries.map((a) => {
    if (!Array.isArray(a)) return null;
    const [rawName, , mailbox, host] = a;
    // IMAP 用 NIL 表示缺失值，别把它当成人名显示
    const name = rawName && String(rawName).toUpperCase() !== 'NIL' ? rawName : '';
    const addr = mailbox && host ? `${mailbox}@${host}` : (mailbox || '');
    return name ? `${name} <${addr}>` : addr;
  }).filter(Boolean);
  return parts.join(', ') || null;
}

function parseImapDate(str) {
  if (!str) return null;
  // IMAP INTERNALDATE is like "12-May-2026 09:30:00 +0800"
  const m = String(str).match(/(\d{1,2})-([A-Za-z]{3})-(\d{4}) (\d{2}):(\d{2}):(\d{2})(?: ([+-]\d{4}))?/);
  if (!m) return null;
  const months = { Jan: 0, Feb: 1, Mar: 2, Apr: 3, May: 4, Jun: 5, Jul: 6, Aug: 7, Sep: 8, Oct: 9, Nov: 10, Dec: 11 };
  return new Date(Date.UTC(+m[3], months[m[2]], +m[1], +m[4], +m[5], +m[6])).toISOString();
}

export function fromSample() {
  return {
    items: emailSample.messages.map((m) => ({
      kind: 'task', external_id: `mail-${m.uid}`, title: m.subject,
      due_at: m.date, url: null, notes: `发件人：${m.from}。${m.body || ''}`,
      raw: 'sample',
    })),
    raw: { messages: emailSample.messages.length },
  };
}

// Exported for validation/tests.
export { tokenize, parseEnvelope, parseImapDate, parseSearch, imapConnect };
