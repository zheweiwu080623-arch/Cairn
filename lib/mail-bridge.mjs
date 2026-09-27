// 外部邮件桥 —— Cairn 发信的**唯一边界**（P1-7）。
//
// Cairn 自己不实现 SMTP、也不持有任何邮箱凭据：需要发信时，把一张 `mail-job.v1`
// 契约（收件人 / 主题 / 正文 / 附件 / dry_run）用 stdin 递给本机的一个**外部邮件桥
// 程序**，由它去发；它回一行 `mail-job-result.v1`。Cairn 只认这条命令行协议，
// 不关心对方怎么实现、配置放在哪 —— 两个程序不同仓库、不共享数据库、不共享凭据。
//
//   唯一接口（任何满足它的程序都能当这个桥）：
//     <桥命令> send-mail --json-stdin [--outbox <目录>]
//         ← stdin: mail-job.v1（见 contracts/mail-job.v1.schema.json）
//         → stdout 最后一行: mail-job-result.v1
//     <桥命令> status --json --root <桥目录>
//         → stdout: 机器可读状态（只用来在界面上显示"通道通不通"）
//
// 桥**在哪、怎么起**（都在 data/ 里，data/ 被 .gitignore 排除，所以仓库里不含
// 任何一台机器的路径或程序名）：
//   目录：环境变量 MAIL_BRIDGE_DIR  >  data/paths.json 的 mail_bridge_dir  >  空
//   命令：环境变量 MAIL_BRIDGE_CMD  >  data/paths.json 的 mail_bridge_cmd
//         >  默认 `python -X utf8 -m mail_bridge`
//   契约名：环境变量 MAIL_BRIDGE_SCHEMA > data/paths.json 的 mail_bridge_schema
//         >  默认 `mail-job.v1`（有的桥认自己的版本名，就配在这儿 —— 属于"对方怎么实现"，
//            不属于 Cairn 的代码；请求体的其它字段两边一致）
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { localPath } from './local-config.mjs';

export const MAIL_JOB_SCHEMA = 'mail-job.v1';
export const MAIL_JOB_RESULT_SCHEMA = 'mail-job-result.v1';

/** 桥的安装目录（默认空 = 没配置；所有调用都会如实返回"没配好"）。 */
export const MAIL_BRIDGE_DEFAULT_DIR = localPath({ envKey: 'MAIL_BRIDGE_DIR', configKey: 'mail_bridge_dir' });

/** 怎么启动桥：整条命令前缀，按空白切开（所以路径里有空格要自己引号那层处理）。 */
export function mailBridgeCommand(env = process.env) {
  const fromEnv = String(env.MAIL_BRIDGE_CMD || '').trim();
  if (fromEnv) return fromEnv;
  const fromCfg = localPath({ envKey: 'MAIL_BRIDGE_CMD', configKey: 'mail_bridge_cmd' });
  return String(fromCfg || '').trim() || 'python -X utf8 -m mail_bridge';
}

/** 递给桥的契约名（请求体里的 schema 字段）。 */
export function mailBridgeSchema(env = process.env) {
  const fromEnv = String(env.MAIL_BRIDGE_SCHEMA || '').trim();
  if (fromEnv) return fromEnv;
  const fromCfg = localPath({ envKey: 'MAIL_BRIDGE_SCHEMA', configKey: 'mail_bridge_schema' });
  return String(fromCfg || '').trim() || MAIL_JOB_SCHEMA;
}

/** 跑一条桥命令，返回 { code, stdout, stderr, ok }。 */
export async function runMailBridgeCli(args, { dir = MAIL_BRIDGE_DEFAULT_DIR,
  cmd = mailBridgeCommand(), input = null, timeoutMs = 120000 } = {}) {
  const parts = String(cmd || '').trim().split(/\s+/).filter(Boolean);
  return new Promise((resolve) => {
    let child;
    try {
      child = spawn(parts[0], [...parts.slice(1), ...args], {
        cwd: String(dir || MAIL_BRIDGE_DEFAULT_DIR || process.cwd()),
        windowsHide: true,
      });
    } catch (e) {
      return resolve({ code: -1, ok: false, stdout: '', stderr: `${e.name}: ${e.message}` });
    }
    let stdout = '';
    let stderr = '';
    const timer = setTimeout(() => {
      try { child.kill(); } catch { /* ignore */ }
      stderr += `\n[timeout ${timeoutMs}ms]`;
    }, timeoutMs);
    child.stdout.on('data', (b) => { stdout += b.toString('utf8'); });
    child.stderr.on('data', (b) => { stderr += b.toString('utf8'); });
    child.on('error', (e) => {
      clearTimeout(timer);
      resolve({ code: -1, ok: false, stdout, stderr: `${stderr}\n${e.name}: ${e.message}` });
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      resolve({ code, ok: code === 0, stdout, stderr });
    });
    if (input != null) {
      try { child.stdin.end(input); } catch { /* ignore */ }
    } else {
      try { child.stdin.end(); } catch { /* ignore */ }
    }
  });
}

/** 把内存里的附件落成临时文件（mail-job.v1 的 attachments 只收路径）。 */
function materializeAttachments(attachments, tmpDir) {
  if (!attachments.length) return { files: [], cleanup: () => {} };
  const dir = mkdtempSync(join(tmpDir, 'planner-mail-'));
  const files = [];
  attachments.forEach((a, i) => {
    const name = String(a.filename || a.name || `attachment-${i + 1}`);
    const target = join(dir, name.replace(/[\\/:*?"<>|]/g, '_'));
    const content = Buffer.isBuffer(a.content) ? a.content : Buffer.from(String(a.content ?? ''), 'utf8');
    writeFileSync(target, content);
    files.push({ path: target, name, bytes: content.length });
  });
  return {
    files,
    cleanup: () => { try { rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ } },
  };
}

function splitRecipients(to) {
  return (Array.isArray(to) ? to : String(to || '').split(/[,;，；\s]+/))
    .map((t) => String(t).trim()).filter(Boolean);
}

/**
 * 通过外部邮件桥发信（契约见 contracts/mail-job*.schema.json）。
 * dryRun=true 时桥只把 .eml 落盘、不连 SMTP —— 这是本地验证的入口。
 */
export async function sendViaMailBridge({
  dir = MAIL_BRIDGE_DEFAULT_DIR, cmd = mailBridgeCommand(), to, subject, text,
  attachments = [], dryRun = false, outbox = null, tmpDir = null,
  timeoutMs = 120000, log = () => {},
} = {}) {
  const scratch = tmpDir || (dir && existsSync(dir) ? join(dir, 'tmp') : tmpdir());
  try { mkdirSync(scratch, { recursive: true }); } catch { /* 用系统临时目录兜底 */ }
  const usableTmp = (() => {
    try {
      const probe = join(scratch, '.write-probe');
      writeFileSync(probe, 'x');
      rmSync(probe, { force: true });
      return scratch;
    } catch {
      return tmpdir();
    }
  })();

  const { files, cleanup } = materializeAttachments(attachments, usableTmp);
  try {
    let finalRecipients = splitRecipients(to);
    // 与桥的约定保持一致：收件人留空 = 用桥自己那份白名单（课程资料邮件就是这么发的）
    if (!finalRecipients.length) {
      const status = await mailBridgeStatus({ dir, cmd });
      finalRecipients = (status && status.recipients) || [];
      log(`[mail-bridge] 收件人为空 → 用桥的白名单：${finalRecipients.join(', ') || '（空）'}`);
    }
    if (!finalRecipients.length) {
      return { ok: false, via: 'bridge-cli', error: '没有收件人（桥的白名单是空的）' };
    }
    const request = {
      schema: mailBridgeSchema(),
      to: finalRecipients,
      subject: String(subject ?? ''),
      text: String(text ?? ''),
      attachments: files.map((f) => ({ path: f.path, name: f.name })),
      dry_run: !!dryRun,
      source: 'planner:mail-bridge',
    };
    const args = ['send-mail', '--json-stdin'];
    if (outbox) args.push('--outbox', String(outbox));
      log(`[mail-bridge] ${finalRecipients.length} 位收件人，${files.length} 个附件，dry_run=${!!dryRun}，schema=${request.schema}`);
    const res = await runMailBridgeCli(args, { dir, cmd, input: JSON.stringify(request), timeoutMs });
    const lastLine = res.stdout.trim().split('\n').filter(Boolean).pop() || '';
    let payload = null;
    try { payload = JSON.parse(lastLine); } catch { payload = null; }
    if (!payload) {
      return {
        ok: false, via: 'bridge-cli',
        error: `邮件桥没有返回可解析的结果（exit=${res.code}）：${(res.stderr || res.stdout).trim().slice(0, 300)}`,
      };
    }
    return {
      ok: !!payload.ok,
      via: 'bridge-cli',
      error: payload.error || null,
      to: payload.recipients || finalRecipients,
      bytes: payload.bytes || 0,
      attachments: (payload.attachments || []).length,
      outbox: payload.outbox || null,
      duration_ms: payload.duration_ms ?? null,
      schema: payload.schema || null,
    };
  } finally {
    cleanup();
  }
}

/** 邮件通道现状（给界面显示用）。**不读凭据**，只问桥要一份状态。 */
export async function mailBridgeStatus({ dir = MAIL_BRIDGE_DEFAULT_DIR, cmd = mailBridgeCommand() } = {}) {
  const res = await runMailBridgeCli(['status', '--json', '--root', String(dir || '')], { dir, cmd, timeoutMs: 20000 });
  if (!res.ok) {
    return { ok: false, via: 'bridge-cli', error: (res.stderr || '桥上没问出状态').trim().slice(0, 200) };
  }
  try {
    const vm = JSON.parse(res.stdout);
    const extra = vm.extra || {};
    return {
      ok: true,
      via: 'bridge-cli',
      config_path: extra.config_path || null,
      from: extra.mailbox || null,
      recipients: extra.allow_senders || [],
      keep_session: extra.keep_session ?? null,
    };
  } catch (e) {
    return { ok: false, via: 'bridge-cli', error: `桥的状态输出无法解析：${e.message}` };
  }
}

/** 连通性自查：桥在不在 + 能不能收一张 dry-run 的活（可选真发一封给自己）。 */
export async function testMailBridge({
  dir = MAIL_BRIDGE_DEFAULT_DIR, cmd = mailBridgeCommand(), send = false,
  subject = '🧪 Planner 邮件通道测试',
  text = '如果你看到这封邮件，说明 Planner 已经能把信交给本机的邮件桥发出去了。',
} = {}) {
  const status = await mailBridgeStatus({ dir, cmd });
  const recipients = (status && status.recipients) || [];
  const result = await sendViaMailBridge({
    dir, cmd, to: recipients, subject, text, dryRun: !send,
  });
  return {
    ok: !!result.ok,
    via: 'bridge-cli',
    dry_run: !send,
    config_path: (status && status.config_path) || null,
    from: (status && status.from) || null,
    recipients,
    outbox: result.outbox || null,
    error: result.error || (status && status.error) || null,
  };
}

/** 便于测试：读一个 .eml 的关键头部（不引外部依赖）。 */
export function readEmlSummary(path) {
  const raw = readFileSync(path, 'utf8');
  const headerEnd = raw.indexOf('\n\n');
  // RFC5322 允许头部折行（续行以空格/Tab 开头），先拼回一行再解析
  const header = (headerEnd >= 0 ? raw.slice(0, headerEnd) : raw).replace(/\r?\n[ \t]+/g, ' ');
  const pick = (name) => (new RegExp(`^${name}:\\s*(.*)$`, 'mi').exec(header) || [])[1]?.trim() || null;
  // 附件名写在各分段的头部里（正文中），所以在全文里找
  const attachmentNames = [...raw.matchAll(/filename\*?=(?:"([^"]+)"|([^;\r\n]+))/gi)]
    .map((m) => (m[1] || m[2] || '').trim())
    .filter((n) => n && !n.startsWith('=?'))
    .map((n) => {
      const enc = /^utf-8''(.+)$/i.exec(n);
      return enc ? decodeURIComponent(enc[1]) : n;
    });
  return {
    to: pick('To'), from: pick('From'), subject: pick('Subject'),
    messageId: pick('Message-ID'), xBridge: pick('X-Mail-Bridge'),
    attachmentNames, bytes: Buffer.byteLength(raw, 'utf8'),
  };
}
