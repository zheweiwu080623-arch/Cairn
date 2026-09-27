// 极简 SMTP 客户端（SSL 465，无第三方依赖）：把每日计划 / 日历文件发到邮箱，
// 手机与办公本都能收到。参考 work/tools/mail.py 里已验证可用的发信方式。
import tls from 'node:tls';
import net from 'node:net';

const B64 = (s) => Buffer.from(String(s), 'utf8').toString('base64');
const CRLF = '\r\n';

// RFC 2047 编码非 ASCII 头部（超长时拆成多个 encoded-word）。
function encodeHeader(value) {
  const s = String(value || '');
  if (/^[\x20-\x7E]*$/.test(s)) return s;
  const b64 = B64(s);
  const parts = b64.match(/.{1,60}/g) || [''];
  return parts.map((p) => `=?UTF-8?B?${p}?=`).join(`${CRLF} `);
}

// RFC 2231：附件文件名用 UTF-8 百分号编码。
function encodeParam(value) {
  return encodeURIComponent(String(value)).replace(/['()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);
}

function base64Lines(buf) {
  return (Buffer.isBuffer(buf) ? buf.toString('base64') : Buffer.from(String(buf), 'utf8').toString('base64'))
    .replace(/(.{76})/g, `$1${CRLF}`);
}

/**
 * 组装 MIME 邮件。
 * @param {object} m
 * @param {string} m.from 发件人地址
 * @param {string|string[]} m.to
 * @param {string} m.subject
 * @param {string} m.text 正文（UTF-8 纯文本）
 * @param {Array<{filename:string, content:Buffer|string, contentType?:string, inline?:boolean}>} [m.attachments]
 */
export function buildMime({ from, to, subject, text, attachments = [], date = new Date() }) {
  const toList = Array.isArray(to) ? to : [to];
  const boundary = `----planner_${Math.random().toString(36).slice(2)}${Date.now().toString(36)}`;
  const head = [
    `Date: ${date.toUTCString()}`,
    `From: ${encodeHeader(from)}`,
    `To: ${toList.map((t) => encodeHeader(t)).join(', ')}`,
    `Subject: ${encodeHeader(subject)}`,
    'MIME-Version: 1.0',
    `Content-Type: multipart/mixed; boundary="${boundary}"`,
    'X-Mailer: Codex Planner (no-deps SMTP)',
  ];
  const body = [
    `--${boundary}`,
    'Content-Type: text/plain; charset=UTF-8',
    'Content-Transfer-Encoding: base64',
    '',
    base64Lines(text),
  ];
  for (const a of attachments) {
    const filename = a.filename || 'file.txt';
    const type = a.contentType || 'application/octet-stream';
    body.push(`--${boundary}`);
    body.push(`Content-Type: ${type}; name*=UTF-8''${encodeParam(filename)}`);
    body.push('Content-Transfer-Encoding: base64');
    body.push(`Content-Disposition: attachment; filename*=UTF-8''${encodeParam(filename)}`);
    body.push('');
    body.push(base64Lines(a.content));
  }
  body.push(`--${boundary}--`, '');
  return Buffer.concat([
    Buffer.from(head.join(CRLF) + CRLF + CRLF, 'utf8'),
    Buffer.from(body.join(CRLF), 'utf8'),
  ]);
}

function createClient({ host, port = 465, timeout = 25000, log = () => {}, plain = false, secure = true }) {
  // plain 模式只用于本机自检（mock SMTP 服务器）或极少数无加密的内网中继。
  const useTls = !plain && secure;
  const socket = useTls
    ? tls.connect({ host, port, rejectUnauthorized: false })
    : net.connect({ host, port });
  socket.setEncoding('utf8');
  let buf = '';
  const queue = [];
  socket.on('data', (chunk) => {
    buf += chunk;
    let idx;
    while ((idx = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, idx + 1);
      buf = buf.slice(idx + 1);
      const pending = queue[0];
      if (!pending) continue;
      pending.lines.push(line.replace(/\r?\n$/, ''));
      // 多行响应：以 "250-" 继续，末行是 "250 xxx"
      if (/^\d{3} /.test(line)) {
        queue.shift();
        pending.resolve(pending.lines);
      }
    }
  });
  const fail = (e) => {
    while (queue.length) queue.shift().reject(e);
  };
  socket.on('error', fail);
  socket.on('timeout', () => fail(new Error('SMTP 连接超时')));
  socket.setTimeout(timeout);

  const readResponse = () => new Promise((resolve, reject) => queue.push({ resolve, reject, lines: [] }));
  const write = (line) => { socket.write(line + CRLF); log(`> ${line.replace(/^AUTH LOGIN.*/, 'AUTH LOGIN')}`); };

  const expect = async (okCodes, what) => {
    const lines = await readResponse();
    const last = lines[lines.length - 1] || '';
    const code = Number(last.slice(0, 3));
    log(`< ${last}`);
    if (!okCodes.includes(code)) throw new Error(`${what}失败：${last}`);
    return lines;
  };

  return {
    socket,
    open: () => new Promise((resolve, reject) => {
      socket.once(useTls ? 'secureConnect' : 'connect', resolve);
      socket.once('error', reject);
    }),
    write,
    expect,
    close: () => { try { socket.end(); } catch { /* ignore */ } },
  };
}

/**
 * 发一封邮件（隐式 SSL，465）。返回 { ok, error }。
 */
export async function sendMail({ host, port = 465, user, pass, from, to, subject, text, attachments = [], timeout = 25000, log, plain = false }) {
  const toList = (Array.isArray(to) ? to : String(to || '').split(/[,;，；\s]+/)).map((t) => String(t).trim()).filter(Boolean);
  if (!host || !user || !pass) return { ok: false, error: '发信配置不完整（缺少 SMTP 服务器或邮箱密码）' };
  if (!toList.length) return { ok: false, error: '没有收件人地址' };

  const client = createClient({ host, port, timeout, log, plain });
  try {
    await client.open();
    await client.expect([220], '连接');
    client.write(`EHLO planner.local`);
    await client.expect([250], 'EHLO');
    client.write('AUTH LOGIN');
    await client.expect([334], 'AUTH LOGIN');
    client.write(B64(user));
    await client.expect([334], '用户名');
    client.write(B64(pass));
    await client.expect([235], '登录');
    client.write(`MAIL FROM:<${from || user}>`);
    await client.expect([250], 'MAIL FROM');
    for (const rcpt of toList) {
      client.write(`RCPT TO:<${rcpt}>`);
      await client.expect([250, 251], 'RCPT TO');
    }
    client.write('DATA');
    await client.expect([354], 'DATA');
    const mime = buildMime({ from: from || user, to: toList, subject, text, attachments });
    // 正文里以 "." 开头的行需要转义
    const dotted = mime.toString('binary').replace(/\r\n\./g, '\r\n..');
    client.socket.write(Buffer.from(dotted, 'binary'));
    client.write(`${CRLF}.`);
    await client.expect([250], '发送');
    client.write('QUIT');
    try { await client.expect([221], 'QUIT'); } catch { /* 有些服务器直接断开 */ }
    client.close();
    return { ok: true, to: toList, bytes: mime.length };
  } catch (e) {
    client.close();
    return { ok: false, error: e.message };
  }
}
