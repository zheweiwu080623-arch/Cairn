// 「日报 / 晚报」摘要引擎的验证（纯函数）。
//
//   node tests/digest-brief.test.mjs

import {
  KIND_META, TOP_N, buildBrief, buildBriefPrompt, buildPushBody, kindForDate, kindForHour,
  normalizeKind, pickTop, scheduleLines, todayProgress, whenText, ymd,
} from '../lib/digest.mjs';

let failures = 0;
const ok = (label, cond, detail = '') => {
  if (cond) console.log(`  PASS ${label}`);
  else {
    failures += 1;
    console.log(`  FAIL ${label}${detail ? ` -- ${detail}` : ''}`);
  }
};

console.log('digest-brief.test.mjs');

// 2026-09-28：按**本地时间**构造（不带 +08:00）—— 报文抬头写的是用户本地时间，
// 写成固定时区的绝对时刻后，CI（UTC）上会算成"01:00 的早报"而假失败。
const NOW = Date.parse('2026-09-22T09:00:00');   // 周二上午（本地）
const EVE = Date.parse('2026-09-22T21:00:00');   // 周二晚上（本地）

// ---------------- 1. 早报还是晚报 ----------------
ok('15:59 还算早上（早报）', kindForHour(15) === 'morning');
ok('16:00 之后算晚报', kindForHour(16) === 'evening' && kindForHour(23) === 'evening');
ok('kindForDate 按时间点给', kindForDate(new Date(NOW)) === 'morning' && kindForDate(new Date(EVE)) === 'evening');
ok('auto / 空 / 拼错都收成两种之一',
  normalizeKind('auto', { now: NOW }) === 'morning'
  && normalizeKind('', { now: EVE }) === 'evening'
  && normalizeKind('EVENING') === 'evening'
  && normalizeKind('乱写', { now: NOW }) === 'morning');
ok('时间的人话说法（含过期）',
  whenText(0) === '今天' && whenText(1) === '明天' && whenText(4) === '4 天后'
  && whenText(-2) === '已过期 2 天' && whenText(null) === '无时间');

// ---------------- 2. 挑条目 ----------------
const ranked = [
  { id: 'n1', band: 'high', importance: 92, title: '实验报告明天截止，务必提交', daysLeft: 1, source: 'canvas', why: '明天内到期（+35）' },
  { id: 'n2', band: 'normal', importance: 60, title: '选课通知', daysLeft: 3, source: 'email_sjtu', why: '命中你写的规划（+16）' },
  { id: 'n3', band: 'normal', importance: 52, title: '讲座', daysLeft: null, source: 'rss', why: '命中你的关注点（+6）' },
  { id: 'n4', band: 'low', importance: 20, title: '很久以前的旧公告', daysLeft: -5, source: 'rss', why: '已经过去 5 天（-12）' },
  { id: 'n5', band: 'low', importance: 10, title: '排在很后面的第四条', daysLeft: 2, source: 'rss', why: '' },
];
{
  const top = pickTop(ranked);
  ok(`最多只挑 ${TOP_N} 条`, top.length === TOP_N, String(top.length));
  ok('过期的旧公告不参与"最值得先看"', !top.some((x) => x.id === 'n4'));
  ok('按重要性原顺序（第一条还是它）', top[0].id === 'n1');
  ok('缺字段不崩、字段被规整',
    pickTop([{ title: 'x' }])[0].daysLeft === null && pickTop([{ title: 'x' }])[0].source === '');
  ok('空输入 → 空数组', pickTop([]).length === 0 && pickTop(null).length === 0);
  ok('全是过期的就诚实返回空', pickTop([{ title: '旧', daysLeft: -3 }]).length === 0);
  // 真库实测出来的规则：低分又不急的不能上榜，否则"验证码邮件"会排第 2
  ok('低分且不急的（>1 天）不进榜',
    pickTop([{ title: 'GitHub 验证码', band: 'low', daysLeft: 5 }]).length === 0);
  ok('低分但今明到期的仍然进榜（急事优先）',
    pickTop([{ title: '明天到期的小事', band: 'low', daysLeft: 1 }]).length === 1
    && pickTop([{ title: '今天到期的小事', band: 'low', daysLeft: 0 }]).length === 1);
  ok('重要 / 一般档不受这条限制',
    pickTop([{ title: '重要但无时间', band: 'high', daysLeft: null }]).length === 1
    && pickTop([{ title: '一般但无时间', band: 'normal', daysLeft: null }]).length === 1);
  ok('没给分档的条目不会被误伤', pickTop([{ title: '不知道档位', daysLeft: 5 }]).length === 1);
}

// ---------------- 3. 日程压缩 ----------------
const day = {
  date: '2026-09-22', weekday: '二', is_today: true,
  academic: [{ title: '秋季学期', kind: 'term' }],
  courses: [{ course: '线性代数', start: '08:00', end: '09:40', location: '东中院' }],
  events: [{ title: '班会', start: '2026-09-22 18:00', all_day: false }],   // 和 buildPlan 的输出格式一致
  due_tasks: [{ title: 'MATH1860J 作业', status: 'todo' }, { title: '已完成的实验', status: 'done' }],
  reminders: [{ title: '吃药', at: '2026-09-22 21:00' }],
  milestones: [],
};
{
  const lines = scheduleLines(day);
  ok('课程 / 日程 / 截止 / 提醒 / 校历都在',
    lines.some((l) => l.includes('08:00') && l.includes('线性代数') && l.includes('东中院'))
    && lines.some((l) => l.includes('18:00') && l.includes('班会'))
    && lines.some((l) => l.startsWith('[截止] MATH1860J'))
    && lines.some((l) => l.startsWith('[提醒] 21:00'))
    && lines.some((l) => l.startsWith('校历：')));
  ok('已完成的任务不再列成"截止"', !lines.some((l) => l.includes('已完成的实验')));
  ok('没安排就说没安排', scheduleLines({ courses: [] })[0].includes('没有固定安排'));
  ok('没有那天的数据也不崩', scheduleLines(null)[0].includes('没有这一天的数据'));
  const many = scheduleLines({ courses: Array.from({ length: 9 }, (_, i) => ({ course: `课${i}`, start: '08:00' })) }, { max: 4 });
  ok('超过上限会折叠（不刷屏）', many.length === 5 && many[4].includes('还有 5 条'), JSON.stringify(many));
  const prog = todayProgress(day);
  ok('今天到期：完成 1 / 未完成 1 / 共 2',
    prog.done.length === 1 && prog.open.length === 1 && prog.total === 2);
}

// ---------------- 4. 早报 ----------------
const plan = {
  days: [
    day,
    {
      date: '2026-09-23', weekday: '三', is_today: false, academic: [], courses: [],
      events: [{ title: '组会', start: '2026-09-23 14:00', all_day: false }],
      due_tasks: [{ title: '实验报告', status: 'todo' }],
      reminders: [], milestones: [{ title: '托福报名', kind: 'goal' }],
    },
  ],
  backlog: { overdue: [{ title: '旧作业', due: '9月20日' }], no_due: [] },
  stats: { open_tasks: 5, done_tasks: 10, events: 2 },
};
const advice = [{ id: 'urgent', level: 'high', text: '「实验报告明天截止」明天到期，建议今晚先写引言。' }];

const morning = buildBrief({ kind: 'morning', now: NOW, appName: 'Cairn', plan, ranked, advice });
{
  const t = morning.text;
  ok('抬头是「Cairn · 早报 · 日期 周X 时间」',
    t.startsWith('Cairn · 早报 · 2026-09-22 周二 09:00'), t.split('\n')[0]);
  ok('schema / label / focus 齐备',
    morning.schema === 'digest.v1' && morning.label === '早报' && morning.focus === '今天');
  ok('列了最值得先看的 3 条', t.includes('【最值得先看的 3 条】'));
  ok('每条都带"为什么"（可解释）', t.includes('为什么：') && t.includes('明天内到期'));
  ok('过期的旧公告没混进榜单', !t.includes('很久以前的旧公告'));
  ok('第四条也没上榜', !t.includes('排在很后面的第四条'));
  ok('今天安排里有课与截止', t.includes('【今天的安排】 2026-09-22 周二')
    && t.includes('08:00  线性代数 @东中院') && t.includes('[截止] MATH1860J 作业'));
  ok('建议在', t.includes('【建议】') && t.includes('今晚先写引言'));
  ok('分档统计正确', morning.counts.high === 1 && morning.counts.normal === 2 && morning.counts.low === 2);
  ok('今日进度被记下（完成 1 / 未完成 1）',
    morning.stats.today_done === 1 && morning.stats.today_open === 1 && morning.stats.today_due === 2);
  ok('有推送用的短正文', morning.push.title.includes('早报') && morning.push.body.length <= 200);
  ok('正文里没有 undefined', !t.includes('undefined'));
}

// ---------------- 5. 晚报 ----------------
const evening = buildBrief({ kind: 'evening', now: EVE, appName: 'Cairn', plan, ranked, advice });
{
  const t = evening.text;
  ok('晚报抬头与日期', t.startsWith('Cairn · 晚报 · 2026-09-22 周二 21:00'), t.split('\n')[0]);
  ok('晚报先讲今天做完 / 没做完', t.includes('【今天做完 / 没做完】') && t.includes('已完成 1 项') && t.includes('还没做完 1 项'));
  ok('晚报看的是明天', t.includes('【明天的安排】 2026-09-23 周三'));
  ok('明天的日程与截止都在', t.includes('14:00  组会') && t.includes('[截止] 实验报告') && t.includes('[里程碑] 托福报名'));
  ok('晚报也有"最值得先看的 3 条"与建议', t.includes('【最值得先看的 3 条】') && t.includes('【建议】'));
}

// ---------------- 6. 没数据时不说假话 ----------------
{
  const empty = buildBrief({ kind: 'morning', now: NOW, plan: { days: [], backlog: {}, stats: {} }, ranked: [], advice: [] });
  ok('没有值得先看的就明说', empty.text.includes('未来几天没有明确要优先处理的信息'));
  ok('没有建议也不硬编', empty.text.includes('没有需要特别提醒的'));
  ok('没有日程数据也诚实', empty.text.includes('（没有这一天的数据）'));
  ok('空数据不出现 undefined / NaN', !empty.text.includes('undefined') && !empty.text.includes('NaN'));
  ok('空数据仍给出 0 条统计', empty.counts.high === 0 && empty.stats.open_tasks === 0);
}

// ---------------- 7. 推送正文 ----------------
{
  const body = buildPushBody(morning.top, morning.advice);
  ok('推送正文带编号与时间', body.includes('1. ') && body.includes('（明天）'));
  ok('推送正文带一句建议', body.includes('建议：'));
  ok('推送正文有长度上限（手机不刷屏）', buildPushBody(
    Array.from({ length: 9 }, (_, i) => ({ title: '很长的标题'.repeat(12) + i, daysLeft: i })), advice).length <= 200);
  ok('没有任何内容时也给一句人话', buildPushBody([], []).includes('没有明确要优先处理的信息'));
}

// ---------------- 8. 给 agent 的提示词 ----------------
{
  const p = buildBriefPrompt(morning);
  ok('提示词写明是早报/今天', p.includes('早报') && p.includes('今天的安排'));
  ok('提示词带上了最值得先看的几条', p.includes('实验报告明天截止'));
  ok('提示词带上了规则版建议供参考', p.includes('今晚先写引言'));
  ok('硬约束"不要编造"在', p.includes('不要编造'));
  ok('要求了输出标记与字数上限', p.includes('【建议】') && p.includes('【结束】') && p.includes('40 字'));
  ok('明确禁止输出思考过程', p.includes('思考过程'));
  ok('空摘要也能拼出提示词', buildBriefPrompt({}).includes('【建议】'));
  ok('ymd 输出 YYYY-MM-DD', ymd(new Date(NOW)) === '2026-09-22');
  ok('两种档位的元信息都在', KIND_META.morning.focus === '今天' && KIND_META.evening.focus === '明天');
}

console.log('');
console.log(failures === 0 ? 'digest-brief.test: PASS' : `digest-brief.test: FAIL (${failures})`);
process.exit(failures === 0 ? 0 : 1);
