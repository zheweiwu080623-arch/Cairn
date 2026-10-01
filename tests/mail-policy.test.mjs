// 发信降载策略（2026-10-01 用户口径）：一天早上汇总一封 + Canvas 检查有新增时一封。
//
//   node tests/mail-policy.test.mjs
//
// 判据：
//   * 「早上汇总」一天最多 1 封、默认只在 05:00–11:59 发；
//   * 「Canvas 有新增」**必须真有新增**才放行，且一天有上限；
//   * 晚报 / 自动化简报默认**不发邮件**（内容照旧进应用通知）；
//   * 手动发送不受策略管（人明确的动作）；
//   * 账本跨重启有效、按本地日期自动翻篇；**发失败了不记账**（否则风控那天白吃配额）；
//   * 接线：course-sync / 邮件摘要 / 自动化转发三处都过这道闸；
//     早上那封汇总里带上自动化简报的标题索引（办公本仍看得到"跑了什么"）。

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  MAIL_KINDS, decideMail, localDateKey, mailPolicyState, noteMailSent, policyLimits, readLedger,
} from '../lib/mail-policy.mjs';
import { buildDigestText } from '../lib/mobile.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const read = (p) => readFileSync(join(ROOT, p), 'utf8');

let failures = 0;
const ok = (label, cond, detail = '') => {
  if (cond) console.log(`  PASS ${label}`);
  else { failures += 1; console.log(`  FAIL ${label}${detail ? ` -- ${detail}` : ''}`); }
};

console.log('mail-policy.test.mjs');

const makeStore = () => {
  const kv = new Map();
  return { kv, getSync: (k) => (kv.has(k) ? kv.get(k) : null), setSync: (k, v) => kv.set(k, v) };
};
const at = (h, m = 0) => new Date(2026, 9, 1, h, m, 0);      // 2026-10-01（本地时间，跟时区无关）

// ---------------- ① 早上汇总：一天一封、在时段内 ----------------
{
  const store = makeStore();
  const first = decideMail('morning', { store, now: at(7, 30) });
  ok('早上 07:30 第一次 → 允许', first.allow === true, JSON.stringify(first));
  noteMailSent('morning', { store, now: at(7, 30), ref: 'morning-1' });
  const second = decideMail('morning', { store, now: at(9, 0) });
  ok('同一天再想发 → 拒绝（一天只留一封）', second.allow === false && second.reason.includes('已经发了'), second.reason);

  const fresh = makeStore();
  const early = decideMail('morning', { store: fresh, now: at(4, 30) });
  ok('凌晨 04:30 → 拒绝（不在 05:00–11:59 时段）', early.allow === false && early.reason.includes('时段'), early.reason);
  const late = decideMail('morning', { store: fresh, now: at(14, 0) });
  ok('下午 14:00 → 拒绝（同上）', late.allow === false && late.reason.includes('时段'), late.reason);
  ok('11:30 仍在时段内', decideMail('morning', { store: fresh, now: at(11, 30) }).allow === true);
}

// ---------------- ② Canvas：必须有新增 + 有上限 ----------------
{
  const store = makeStore();
  const noNew = decideMail('canvas', { store, now: at(9), hasNew: false });
  ok('Canvas 这一轮没有新增 → 拒绝（用户口径："有新增的时候再来一封"）',
    noNew.allow === false && noNew.reason.includes('没有新增'), noNew.reason);
  ok('Canvas 有新增 → 允许', decideMail('canvas', { store, now: at(9), hasNew: true }).allow === true);

  const cap = policyLimits(store).canvas.perDay;
  for (let i = 0; i < cap; i++) noteMailSent('canvas', { store, now: at(9 + i % 3) });
  const over = decideMail('canvas', { store, now: at(20), hasNew: true });
  ok(`发满 ${cap} 封后 → 拒绝（上限保护）`, over.allow === false && over.reason.includes('上限'), over.reason);
  ok('Canvas 不受"时段"限制（半夜有新增也能发）',
    decideMail('canvas', { store: makeStore(), now: at(2), hasNew: true }).allow === true);
}

// ---------------- ③ 晚报 / 自动化简报：默认不发；手动不受管 ----------------
{
  const store = makeStore();
  ok('晚报 → 默认不发邮件', decideMail('evening', { store, now: at(21) }).allow === false);
  ok('自动化简报转发 → 默认不发邮件', decideMail('report', { store, now: at(10) }).allow === false);
  ok('手动发送 → 永远允许（人明确的动作）', decideMail('manual', { store, now: at(3) }).allow === true);
  ok('不认识的类别 → 拒绝并说清', decideMail('乱写', { store }).allow === false);
  ok('默认规则表就是用户要的两类 + 三类默认关',
    MAIL_KINDS.morning.perDay === 1 && MAIL_KINDS.canvas.needsNew === true
    && MAIL_KINDS.evening.perDay === 0 && MAIL_KINDS.report.perDay === 0);
}

// ---------------- ④ 账本：跨天翻篇 / 发失败不记账 / 可覆盖 ----------------
{
  const store = makeStore();
  noteMailSent('canvas', { store, now: at(9) });
  ok('记账后剩余额度减一', mailPolicyState(store, at(9)).kinds.canvas.used === 1);
  ok('第二天自动翻篇（新的一天又是满额）',
    mailPolicyState(store, new Date(2026, 9, 2, 9)).kinds.canvas.used === 0);
  ok('翻篇后「早上汇总」也能再发',
    decideMail('morning', { store, now: new Date(2026, 9, 2, 7) }).allow === true);
  ok('日期键就是本地日期（不带时区）', localDateKey(new Date(2026, 9, 1, 23, 59)) === '2026-10-01');

  // 手动改配置：把 Canvas 上限调成 1、把晚报放行（说明"默认关"不等于"写死"）
  const store2 = makeStore();
  store2.setSync('mail_policy', JSON.stringify({ canvas: { per_day: 1 }, evening: { per_day: 1 } }));
  noteMailSent('canvas', { store: store2, now: at(9) });
  ok('配置能改上限（canvas 调到 1 之后第 2 封就被拒）',
    decideMail('canvas', { store: store2, now: at(10), hasNew: true }).allow === false);
  ok('配置能改"晚报默认不发"（填 per_day:1 就放行）',
    decideMail('evening', { store: store2, now: at(21) }).allow === true);
  const broken = makeStore();
  broken.setSync('mail_policy', '{坏掉的 JSON');
  ok('配置坏了 → 退回默认规则，不影响发信判断', decideMail('morning', { store: broken, now: at(7) }).allow === true);
  ok('账本读不出来也不炸', readLedger({ getSync: () => '{坏', setSync: () => {} }).counts
    && Object.keys(readLedger({ getSync: () => null, setSync: () => {} }).counts).length === 0);
}

// ---------------- ⑤ 早上那封汇总里带上自动化简报的标题 ----------------
{
  const now = Date.now();
  const store = {
    listTasks: () => [], listEvents: () => [], listCourses: () => [],
    listAcademic: () => [], listMilestones: () => [], listPending: () => [],
    listNotifications: () => ([
      { source: 'codex', title: '🤖 每日简报｜晨间简报', created_at: now - 3600 * 1000 },
      { source: 'codex', title: '🤖 跟进监控｜最近重要变化', created_at: now - 2 * 3600 * 1000 },
      { source: 'canvas', title: '不该出现的 Canvas 条目', created_at: now },
      { source: 'codex', title: '🤖 上周的旧简报（36 小时以外）', created_at: now - 48 * 3600 * 1000 },
    ]),
  };
  const text = buildDigestText(store, { kind: 'morning' });
  ok('早上汇总里有「自动化简报」标题索引',
    text.includes('【自动化简报') && text.includes('🤖 每日简报｜晨间简报'), text.slice(0, 120));
  ok('只列 codex 来源、且只列最近 36 小时的（旧的不带、别的来源不混进来）',
    text.includes('跟进监控') && !text.includes('不该出现的 Canvas 条目') && !text.includes('上周的旧简报'));
  ok('晚报不列这个索引（晚报默认也不发邮件）',
    !buildDigestText(store, { kind: 'evening' }).includes('【自动化简报'));
}

// ---------------- ⑥ 接线守卫 ----------------
{
  const courseSync = read('lib/course-sync.mjs');
  ok('course-sync 的发信过了这道闸，且"没有新增就不发"',
    courseSync.includes("decideMail('canvas', { store, hasNew: !alreadyEmailed })")
    && courseSync.includes('mail-policy'));
  ok('course-sync 只有发成功才记账（失败不占配额）',
    courseSync.includes("if (r.ok) noteMailSent('canvas'"));

  const mobile = read('lib/mobile.mjs');
  ok('邮件摘要过了这道闸，force（手动发送）不受管',
    mobile.includes('if (!force) {') && mobile.includes("decideMail(kind, { store })"));
  ok('摘要发成功后记账', mobile.includes("if (sendRes.ok) noteMailSent(kind"));
  ok('被策略拦下时不算失败、也不刷日志（一小时最多一行）',
    mobile.includes("r.skipped === 'mail-policy'") && mobile.includes('digestPolicyLogged'));

  const srv = read('server.mjs');
  ok('自动化简报的转发也被拦（不再单独发邮件）',
    srv.includes("decideMail('report', { store })") && srv.includes("skipped: 'mail-policy'"));
  ok('通知里会说清"按发信策略没有单独发邮件"', srv.includes('按发信策略没有单独发邮件'));
  ok('有接口能看到今天的配额用了多少（/api/mail-policy）',
    srv.includes("'/api/mail-policy'") && srv.includes('mailPolicyState(store)'));
  ok('手动发送 / 发文件那条路没被策略拦（人明确的动作照做）',
    !/sendLocalFileViaMailBridge[\s\S]{0,400}decideMail/.test(srv));
}

console.log('');
console.log(failures === 0 ? 'mail-policy.test: PASS' : `mail-policy.test: FAIL (${failures})`);
process.exit(failures === 0 ? 0 : 1);
