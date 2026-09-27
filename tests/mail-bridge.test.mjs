// 邮件桥（`lib/mail-bridge.mjs`）：契约形状 + 凭据隔离 + 干跑。
//
//   node tests/mail-bridge.test.mjs
//
// 需要本机**配了一个邮件桥**（data/paths.json 的 mail_bridge_dir / mail_bridge_cmd，或同名环境变量）；
// 没配就整体 SKIP（不算失败）—— 别的系统上跑不动正是它不进 tests/run-portable.mjs 的原因。
// 全程 dry_run：桥只把 .eml 落盘，不连 SMTP、不发真信。

import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, rmSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  MAIL_JOB_SCHEMA, MAIL_JOB_RESULT_SCHEMA, MAIL_BRIDGE_DEFAULT_DIR,
  mailBridgeCommand, mailBridgeSchema, runMailBridgeCli, sendViaMailBridge, mailBridgeStatus, readEmlSummary,
} from '../lib/mail-bridge.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..');
const TMP = process.env.PLANNER_TEST_TMP || join(ROOT, 'data', 'test-tmp');

let failures = 0;
const ok = (label, condition, detail = '') => {
  if (condition) console.log(`  PASS ${label}`);
  else { failures += 1; console.log(`  FAIL ${label}${detail ? ` -- ${detail}` : ''}`); }
};

/** 解 RFC2047 编码的头部（只处理 base64/q，够测试用） */
function decodeHeader(value) {
  if (!value) return value;
  return value
    // RFC2047：相邻的两个编码字之间的空白要丢掉（否则解码后会多一个空格）
    .replace(/\?=\s+=\?/g, '?==?')
    .replace(/=\?([^?]+)\?([BbQq])\?([^?]*)\?=/g, (_, charset, enc, data) => {
      if (enc.toUpperCase() === 'B') return Buffer.from(data, 'base64').toString(charset === 'utf-8' ? 'utf8' : 'latin1');
      return data.replace(/_/g, ' ').replace(/=([0-9A-F]{2})/gi, (m, h) => String.fromCharCode(parseInt(h, 16)));
    });
}

const sha256 = (buf) => createHash('sha256').update(buf).digest('hex');

console.log('mail-bridge.test.mjs');

// ---- 1. 源码级护栏：Cairn 侧不碰凭据、只认 CLI 协议
{
  const src = readFileSync(join(ROOT, 'lib', 'mail-bridge.mjs'), 'utf8');
  const codeOnly = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
  ok('不读任何配置文件里的账号/口令', !/readFileSync\([^)]*config/i.test(codeOnly)
    && !/\bpassword\b/i.test(codeOnly) && !/\bapp_password\b/i.test(codeOnly));
  ok('只通过两条子命令对接（send-mail / status）',
    codeOnly.includes("'send-mail', '--json-stdin'") && codeOnly.includes("['status', '--json', '--root'"));
  ok('契约名是版本化的 mail-job.v1', MAIL_JOB_SCHEMA === 'mail-job.v1' && MAIL_JOB_RESULT_SCHEMA === 'mail-job-result.v1');
  ok('没有旧的分发器/旧实现残留（只有一条发信路径）',
    !codeOnly.includes('MailBridgeLegacy') && !codeOnly.includes('mailMode'));
  const legacySrc = existsSync(join(ROOT, 'lib', 'mail-port.mjs'));
  ok('旧的 mail-port.mjs 已经不在了（合并进 mail-bridge.mjs）', !legacySrc);
  ok('契约名可以按桥的配置覆盖（代码里只留中性缺省）',
    mailBridgeSchema({ MAIL_BRIDGE_SCHEMA: ' x-mail.v9 ' }) === 'x-mail.v9'
    && mailBridgeSchema({}).length > 0);
}

// ---- 2. 桥怎么启动：环境变量优先，缺省是中文档写明的那条
{
  ok('MAIL_BRIDGE_CMD 环境变量优先', mailBridgeCommand({ MAIL_BRIDGE_CMD: '  python -m x  ' }) === 'python -m x',
    mailBridgeCommand({ MAIL_BRIDGE_CMD: '  python -m x  ' }));
  const fallback = mailBridgeCommand({});
  ok('没配置时给一个能解释的缺省值', /^python\b/.test(fallback), fallback);
}

const bridgeReady = Boolean(MAIL_BRIDGE_DEFAULT_DIR) && existsSync(MAIL_BRIDGE_DEFAULT_DIR);
if (!bridgeReady) {
  console.log('  SKIP 本机没配邮件桥（data/paths.json 里没有 mail_bridge_dir）—— 只做了上面的静态检查');
  console.log('');
  console.log(failures === 0 ? 'mail-bridge.test: PASS（部分跳过）' : `mail-bridge.test: FAIL (${failures})`);
  process.exit(failures === 0 ? 0 : 1);
}

// ---- 3. 状态查询：能问出来，且不带任何口令字段
const status = await mailBridgeStatus({ dir: MAIL_BRIDGE_DEFAULT_DIR });
ok('能拿到通道状态', !!status && status.ok === true, JSON.stringify(status).slice(0, 160));
ok('状态里没有任何口令字段',
  !!status && !('pass' in status) && !('password' in status) && !JSON.stringify(status).includes('pass'),
  JSON.stringify(status).slice(0, 160));
ok('状态里有发件人（要含 @）', !!status && typeof status.from === 'string' && status.from.includes('@'),
  String(status && status.from));

// ---- 4. 干跑：真的落一封 .eml，逐项核对
const stamp = Date.now();
const workTmp = join(TMP, `mail-bridge-${stamp}`);
const outbox = join(workTmp, 'outbox');
mkdirSync(outbox, { recursive: true });
const attachment = Buffer.from('PDF-ish 内容 😀 attachment bytes\n', 'utf8');
const subject = '🧪 Planner 邮件桥干跑';
const text = '正文：如果你看到这封，说明链路通。\n';
const recipients = ['user@example.com'];

const result = await sendViaMailBridge({
  dir: MAIL_BRIDGE_DEFAULT_DIR, to: recipients, subject, text,
  attachments: [{ filename: 'sample-report.txt', content: attachment, contentType: 'text/plain' }],
  dryRun: true, outbox, tmpDir: workTmp, log: () => {},
});
ok('干跑成功', result.ok === true, String(result.error || ''));
ok('结果里带契约名（由桥自己决定叫什么）', typeof result.schema === 'string' && result.schema.length > 0, String(result.schema));
ok('返回收件人与附件数', (result.to || []).join(',') === recipients.join(',') && result.attachments === 1,
  `${JSON.stringify(result.to)} / ${result.attachments}`);
ok('真的写出 .eml', !!result.outbox && existsSync(result.outbox), String(result.outbox));

const eml = readEmlSummary(result.outbox);
ok('收件人对得上', decodeHeader(eml.to) === recipients.join(', '), String(eml.to));
ok('主题对得上（含 emoji 编码差异）', decodeHeader(eml.subject) === subject,
  `${decodeHeader(eml.subject)} vs ${subject}`);
ok('附件名对得上', eml.attachmentNames.includes('sample-report.txt'), JSON.stringify(eml.attachmentNames));
const emlText = readFileSync(result.outbox, 'utf8');
const b64 = emlText.split(/\r?\n\r?\n/).map((s) => s.replace(/\s+/g, '')).find((s) => {
  try { return Buffer.from(s, 'base64').equals(attachment); } catch { return false; }
});
ok('附件字节与源文件逐字节相同', !!b64, b64 ? '' : '未在 .eml 中找到附件的 base64');

// ---- 5. 收件人留空 = 用桥自己的白名单（不许失败成"没有收件人"）
const viaDefault = await sendViaMailBridge({
  dir: MAIL_BRIDGE_DEFAULT_DIR, subject: '白名单兜底', text: 'x', dryRun: true, outbox, tmpDir: workTmp, log: () => {},
});
ok('收件人留空时用桥的白名单', viaDefault.ok === true, String(viaDefault.error || ''));

// ---- 6. 协议细节：非法请求要有清晰错误、不吐栈
const bad = await runMailBridgeCli(['send-mail', '--json-stdin'], {
  dir: MAIL_BRIDGE_DEFAULT_DIR, input: JSON.stringify({ to: [], subject: '', dry_run: true }),
});
let badPayload = null;
try { badPayload = JSON.parse(bad.stdout.trim().split('\n').pop()); } catch { /* ignore */ }
ok('非法请求返回 ok=false 且有原因',
  bad.code === 1 && badPayload && badPayload.ok === false && !!badPayload.error,
  `exit=${bad.code} ${JSON.stringify(badPayload).slice(0, 160)}`);
ok('错误输出里没有异常栈', !bad.stdout.includes('Traceback') && !bad.stderr.includes('Traceback'));

// ---- 7. 桥不在时要如实报错（换一个不存在的目录）
const offline = await sendViaMailBridge({
  dir: join(workTmp, 'no-such-bridge'), cmd: 'python -X utf8 -m definitely_not_a_module',
  to: ['user@example.com'], subject: 'x', text: 'x', dryRun: true, tmpDir: workTmp, log: () => {},
});
ok('桥跑不起来时如实失败（不假装发过）', offline.ok === false && !!offline.error, JSON.stringify(offline).slice(0, 160));

rmSync(workTmp, { recursive: true, force: true });

console.log('');
console.log(failures === 0 ? 'mail-bridge.test: PASS' : `mail-bridge.test: FAIL (${failures})`);
process.exit(failures === 0 ? 0 : 1);
