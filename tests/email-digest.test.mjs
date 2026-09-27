// 早报 / 晚报邮件（定时摘要）的验证：内容里带"最值得先看的 3 条"、两档各自开关。
//
//   node tests/email-digest.test.mjs

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { MOBILE_KEYS, buildDigestText, digestDue, getMobilePrefs, saveMobilePrefs } from '../lib/mobile.mjs';

let failures = 0;
const ok = (label, cond, detail = '') => {
  if (cond) console.log(`  PASS ${label}`);
  else {
    failures += 1;
    console.log(`  FAIL ${label}${detail ? ` -- ${detail}` : ''}`);
  }
};

console.log('email-digest.test.mjs');

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const DAY = 86400000;
const NOW = Date.parse('2026-09-22T10:00:00+08:00');
const iso = (off, hour = 23) => { const d = new Date(NOW + off * DAY); d.setHours(hour, 0, 0, 0); return d.toISOString(); };
// 「今天」要用**真实今天**：buildPlan 读系统日期，写死某一天跨零点就失效
const todayAt = (hour = 23) => { const d = new Date(); d.setHours(hour, 0, 0, 0); return d.toISOString(); };
const ymd = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;

// ---------------- 替身：一个空的 Planner ----------------
const sync = new Map();
const emptyStore = {
  getSync: (k) => (sync.has(k) ? sync.get(k) : null),
  setSync: (k, v) => sync.set(k, v),
  listTasks: () => [{ id: 't1', title: 'MATH1860J 作业', status: 'todo', due_at: todayAt(23) }],
  listEvents: () => [],
  listNotifications: () => [],
  listCourses: () => [],
  listAcademic: () => [],
  listMilestones: () => [],
  listPending: () => [],
};

// ---------------- 1. 摘要里带"最值得先看的 3 条 + 建议" ----------------
const brief = {
  kind: 'morning', label: '早报', date: '2026-09-22', weekday: '周二',
  top: [
    { title: '实验报告明天截止，务必提交', band: 'high', importance: 92, daysLeft: 1, source: 'canvas', why: '明天内到期（+35）' },
    { title: '选课通知', band: 'normal', importance: 60, daysLeft: 3, source: 'email_sjtu', why: '命中你写的规划（+16）' },
  ],
  advice: [{ id: 'urgent', text: '「实验报告」明天到期，建议今晚先写引言。' }],
  stats: { today_due: 2, today_done: 1, today_open: 1 },
};
{
  const plain = buildDigestText(emptyStore, { days: 1 });
  ok('不传 brief 时保持原样（老行为不变）', !plain.includes('最值得先看的') && plain.startsWith('Cairn ·'));
  ok('原来那些段落还在', plain.includes('未完成') && plain.includes('【今天】'));

  const withBrief = buildDigestText(emptyStore, { days: 1, brief, kind: 'morning' });
  ok('带 brief 时多一段"今天最值得先看"', withBrief.includes('【今天最值得先看的 2 条】'));
  ok('每一条都带分数和为什么',
    withBrief.includes('[重要 92] 实验报告明天截止，务必提交（明天 · canvas）') && withBrief.includes('为什么：明天内到期（+35）'));
  ok('建议也进邮件', withBrief.includes('【建议】') && withBrief.includes('今晚先写引言'));
  ok('原来的日程清单还在（只是多了前面一段）',
    withBrief.includes('【今天】') && withBrief.includes('[截止] MATH1860J 作业'));
  ok('顺序是"先看什么"在最前面', withBrief.indexOf('最值得先看的') < withBrief.indexOf('【今天】'));

  const evening = buildDigestText(emptyStore, { days: 2, brief: { ...brief, kind: 'evening' }, kind: 'evening' });
  ok('晚报那段写成"明天最值得先看"', evening.includes('【明天最值得先看的 2 条】'));
  ok('晚报会报今天的完成情况', evening.includes('今天到期 2 项：完成 1 · 还没做完 1'));

  const noTop = buildDigestText(emptyStore, { days: 1, brief: { top: [], advice: [] } });
  ok('没有值得先看的就不硬编（也不加空标题）', !noTop.includes('最值得先看的'));
  const onlyAdvice = buildDigestText(emptyStore, { days: 1, brief: { top: [], advice: [{ text: '先睡够。' }] } });
  ok('只有建议时也会带上', onlyAdvice.includes('【建议】') && onlyAdvice.includes('先睡够。'));
}

// ---------------- 2. 两个档位各自开关 / 时间 / 记录 ----------------
{
  const fresh = getMobilePrefs(emptyStore);
  ok('早报默认关（用户没开过就不发）', fresh.digest_enabled === false);
  ok('晚报默认关、默认 21:00', fresh.digest_evening_enabled === false && fresh.digest_evening_time === '21:00');
  ok('四个晚报键和早报的完全分开',
    MOBILE_KEYS.digest_evening_enabled !== MOBILE_KEYS.digest_enabled
    && MOBILE_KEYS.digest_evening_time !== MOBILE_KEYS.digest_time
    && MOBILE_KEYS.digest_evening_last !== MOBILE_KEYS.digest_last
    && MOBILE_KEYS.digest_evening_result !== MOBILE_KEYS.digest_result);
  ok('所有键名都带 mobile_ 前缀（和别处的键不会撞）',
    ['digest_evening_enabled', 'digest_evening_time', 'digest_evening_last', 'digest_evening_result']
      .every((k) => String(MOBILE_KEYS[k]).startsWith('mobile_')));

  const saved = saveMobilePrefs(emptyStore, { digest_evening_enabled: true, digest_evening_time: '21:30' });
  ok('存得下晚报设置', saved.digest_evening_enabled === true && saved.digest_evening_time === '21:30');
  ok('存晚报不会顺手动早报', saved.digest_enabled === false && saved.digest_time === '07:00');
  const back = getMobilePrefs(emptyStore);
  ok('再读能读回来', back.digest_evening_time === '21:30');
}
{
  const s = { getSync: () => null, setSync: () => {} };
  ok('两个都关着 → 都不发', digestDue(s, { kind: 'morning' }) === false && digestDue(s, { kind: 'evening' }) === false);
}
{
  sync.clear();
  const s = { getSync: (k) => (sync.has(k) ? sync.get(k) : null), setSync: (k, v) => sync.set(k, v) };
  saveMobilePrefs(s, { digest_enabled: true, digest_time: '00:00', digest_evening_enabled: true, digest_evening_time: '00:00' });
  ok('到点就发（早报）', digestDue(s, { kind: 'morning' }) === true);
  ok('到点就发（晚报）', digestDue(s, { kind: 'evening' }) === true);
  // 「今天已经发过」是发送成功时写进去的（saveMobilePrefs 不管这个键），这里直接写存储
  sync.set(MOBILE_KEYS.digest_last, ymd(new Date()));
  ok('早报今天发过了就不再发', digestDue(s, { kind: 'morning' }) === false);
  ok('早报发过不影响晚报', digestDue(s, { kind: 'evening' }) === true);
  sync.set(MOBILE_KEYS.digest_evening_last, ymd(new Date()));
  ok('晚报也发过就都不发', digestDue(s, { kind: 'evening' }) === false);
}
{
  // 时间写坏了要有兜底（早报 07:00 / 晚报 21:00），不能因此不发或乱发
  sync.clear();
  const s = { getSync: (k) => (sync.has(k) ? sync.get(k) : null), setSync: (k, v) => sync.set(k, v) };
  saveMobilePrefs(s, { digest_evening_enabled: true, digest_evening_time: '乱写', digest_evening_last: '' });
  const now = new Date();
  const expected = now.getHours() * 60 + now.getMinutes() >= 21 * 60;
  ok('时间写坏了按 21:00 兜底', digestDue(s, { kind: 'evening' }) === expected);
}

// ---------------- 3. 接线：早报/晚报都走同一套发送 ----------------
{
  const srv = readFileSync(join(ROOT, 'server.mjs'), 'utf8');
  const mob = readFileSync(join(ROOT, 'lib', 'mobile.mjs'), 'utf8');
  ok('定时器里早报晚报各看一次（发送循环独立成函数）',
    mob.includes("for (const kind of kinds)") && mob.includes('digestDue(store, { kind })')
    && srv.includes('await sendDueDigests(store, {'));
  ok('发信时把算好的摘要一起带上', srv.includes('briefFor: (kind) => digestRoutes.makeBrief(kind)'));
  ok('原有那封"今日安排"的正文函数没被换掉', mob.includes("export async function sendDigest(store"));
  ok('手动发送支持指定早报/晚报', mob.includes("kind === 'both' ? ['morning', 'evening']"));
  ok('界面能一次拿到晚报的上次结果', srv.includes('last_digest_evening'));

  const app = readFileSync(join(ROOT, 'public', 'app.js'), 'utf8');
  ok('界面有晚报的时间/开关/保存/立即发', ['mb-digest-eve-time', 'mb-digest-eve-enabled', 'mb-digest-eve-save', 'mb-digest-eve-send']
    .every((id) => app.includes(`id="${id}"`)));
  ok('界面上"立即发一封晚报"带 kind=evening',
    /mb-digest-eve-send[\s\S]{0,400}kind: 'evening'/.test(app));
  ok('界面上"立即发送一封"（早报）带 kind=morning',
    /mb-digest-send[\s\S]{0,400}kind: 'morning'/.test(app));
  ok('界面说明了邮件里会带"最值得先看的 3 条"', app.includes('最值得先看的 3 条'));
}

console.log('');
console.log(failures === 0 ? 'email-digest.test: PASS' : `email-digest.test: FAIL (${failures})`);
process.exit(failures === 0 ? 0 : 1);
