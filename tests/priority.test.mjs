// 重要性引擎的验证（"按未来规划给信息排优先级"）。
//
//   node tests/priority.test.mjs

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import {
  BANDS, EMPTY_GOALS, HORIZON_DAYS, SOURCE_IMPORTANCE, bandOf, buildAdvice, buildPlanContext,
  normalizeGoals, rankByImportance, scoreImportance, termsFromText,
} from '../lib/priority.mjs';

let failures = 0;
const ok = (label, cond, detail = '') => {
  if (cond) console.log(`  PASS ${label}`);
  else {
    failures += 1;
    console.log(`  FAIL ${label}${detail ? ` -- ${detail}` : ''}`);
  }
};

console.log('priority.test.mjs');

const DAY = 86400000;
const NOW = Date.parse('2026-09-22T10:00:00+08:00');   // 固定"现在"，测试不受当天日期影响
const dayStr = (offset) => {
  const d = new Date(NOW + offset * DAY);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
};
const iso = (offset, hour = 23) => {
  const d = new Date(NOW + offset * DAY);
  d.setHours(hour, 0, 0, 0);
  return d.toISOString();
};

// ---------------- 1. 词抽取 ----------------
{
  const t = termsFromText('这学期拿到 GPA 3.8，11 月要考托福 TOEFL');
  ok('英文词被抽出', t.includes('gpa') && t.includes('toefl'), JSON.stringify(t));
  ok('中文块被抽出', t.includes('这学期拿到') || t.some((x) => x.includes('托福')), JSON.stringify(t));
  ok('课程代码被抽出', termsFromText('ENGR1010J 的实验').includes('ENGR1010J'));
  ok('结果不超过上限', termsFromText('a b c d e f g h i j k l m n o p q r s t u v w x y z', { max: 5 }).length <= 5);
  ok('两个字母的英文词不进关键词表（to / ai 这种噪音）',
    !termsFromText('send it to my AI friend').includes('to') && !termsFromText('send it to my AI friend').includes('ai'),
    JSON.stringify(termsFromText('send it to my AI friend')));
  ok('空输入不炸', termsFromText('').length === 0 && termsFromText(null).length === 0);
  const long = termsFromText('准备在十二月底之前完成整个项目的第一个正式版本');
  ok('长中文句拆成两字组合（保证召回）', long.some((x) => x.length === 2), JSON.stringify(long));
}

// ---------------- 2. 规划整理 ----------------
ok('默认规划是空的', EMPTY_GOALS.goals.length === 0);
{
  const g = normalizeGoals({ goals: [' 考托福 ', '', '考托福', '项目 v1'], updated_at: 123 });
  ok('去空行去重复', g.goals.length === 2, JSON.stringify(g.goals));
  ok('保留时间戳', g.updated_at === 123);
  ok('脏数据不炸', normalizeGoals(null).goals.length === 0 && normalizeGoals('字符串').goals.length === 0);
  ok('条数有上限（40）', normalizeGoals({ goals: Array.from({ length: 60 }, (_, i) => `目标${i}`) }).goals.length === 40);
}

// ---------------- 3. 未来规划上下文 ----------------
const STATE = {
  tasks: [
    { id: 't1', title: '交线性代数作业', status: 'todo', due_at: iso(1) },        // 明天
    { id: 't2', title: '已经做完的', status: 'done', due_at: iso(2) },
    { id: 't3', title: '很远的任务', status: 'todo', due_at: dayStr(40) },
  ],
  events: [{ id: 'e1', title: '小组会议', start_at: iso(2, 14) }],
  milestones: [
    { id: 'm1', title: '托福考试', target_at: dayStr(20), done: 0 },
    { id: 'm2', title: '完成的项目', target_at: dayStr(5), done: 1 },
  ],
  academic: [
    { id: 'a1', kind: 'exam', title: '线性代数期中', start_at: dayStr(3), end_at: dayStr(3) },
    { id: 'a2', kind: 'term', title: '秋季学期', start_at: dayStr(-30), end_at: dayStr(60) },
  ],
  courses: [{ id: 'c1', course: '线性代数', course_code: 'MATH1860J' }, { id: 'c2', course: '大学英语' }],
  profile: { keywords: ['讲座'], courseCodes: ['MATH1860J'] },
  goals: { goals: ['11 月要考托福', '这学期 GPA 上 3.8'], updated_at: 1 },
};
const ctx = buildPlanContext(STATE, { now: NOW });
{
  ok('上下文里只有"未来 14 天"的事（本次 3 件）', ctx.upcoming.length === 3, JSON.stringify(ctx.upcoming.map((u) => u.title)));
  ok('20 天后的里程碑不在 14 天窗口内', !ctx.upcoming.some((u) => u.id === 'm1'));
  ok('已完成的任务不进来', !ctx.upcoming.some((u) => u.id === 't2'));
  ok('远处的任务（40 天）不进来', !ctx.upcoming.some((u) => u.id === 't3'));
  ok('已完成里程碑不进来', !ctx.upcoming.some((u) => u.id === 'm2'));
  ok('最紧的排在最前', ctx.upcoming[0].daysLeft <= ctx.upcoming[1].daysLeft, JSON.stringify(ctx.upcoming.map((u) => u.daysLeft)));
  ok('考试被识别（3 天后）', ctx.examSoon && ctx.examSoon.title === '线性代数期中', JSON.stringify(ctx.examSoon));
  ok('课程代码进了关键词表', ctx.terms.some((t) => t.lower === 'math1860j'));
  ok('自己写的规划也进了关键词表', ctx.terms.some((t) => t.kind === 'goal'), JSON.stringify(ctx.terms.filter((t) => t.kind === 'goal')));
  ok('有规划时 hasPlan=true', ctx.hasPlan === true);
  ok('没有规划时也能建上下文（只是没有规划词）',
    buildPlanContext({}, { now: NOW }).hasPlan === false && buildPlanContext({}, { now: NOW }).terms.length === 0);
}
{
  const empty = buildPlanContext({}, { now: NOW });
  ok('空状态下 upcoming 为空数组', Array.isArray(empty.upcoming) && empty.upcoming.length === 0);
  ok('空状态下 crowdedDays 为空', empty.crowdedDays.length === 0);
}

// ---------------- 4. 打分：时间越近越高 ----------------
{
  const base = { source: 'rss', title: '一条普通消息' };
  const s0 = scoreImportance(base, ctx, { now: NOW }).score;
  const s1 = scoreImportance({ ...base, due_at: iso(1) }, ctx, { now: NOW }).score;
  const s7 = scoreImportance({ ...base, due_at: iso(7) }, ctx, { now: NOW }).score;
  ok('明天到期 > 一周后到期 > 无时间', s1 > s7 && s7 > s0, `${s1}/${s7}/${s0}`);
  ok('刚过期的普通信息轻微降分', scoreImportance({ ...base, due_at: iso(-2) }, ctx, { now: NOW }).score < s0);
  ok('过期好几天的旧提醒降得更多',
    scoreImportance({ ...base, due_at: iso(-9) }, ctx, { now: NOW }).score
    < scoreImportance({ ...base, due_at: iso(-2) }, ctx, { now: NOW }).score);
  ok('逾期但**没做完的任务**反而更重要',
    scoreImportance({ source: 'canvas', kind: 'task', title: '线性代数作业', due_at: iso(-2) }, ctx, { now: NOW }).score
    > scoreImportance({ source: 'canvas', kind: 'task', title: '线性代数作业' }, ctx, { now: NOW }).score);
  ok('还没处理过的外部条目会加一点分（先让你过一眼）',
    scoreImportance({ ...base, origin: 'pending' }, ctx, { now: NOW }).score > s0);
}

// ---------------- 5. 打分：规划相关会加分，并能说清理由 ----------------
{
  const unrelated = scoreImportance({ source: 'rss', title: '校园网维护公告' }, ctx, { now: NOW });
  const related = scoreImportance({ source: 'rss', title: '托福考试报名开始' }, ctx, { now: NOW });
  ok('命中自己写的规划 → 分数更高', related.score > unrelated.score, `${related.score}/${unrelated.score}`);
  ok('理由里点名了那条规划', related.reasons.some((r) => r.rule === 'plan-hit' && /托福/.test(r.label)), JSON.stringify(related.reasons));
  ok('无关信息的理由里没有 plan-hit', !unrelated.reasons.some((r) => r.rule === 'plan-hit'));

  const course = scoreImportance({ source: 'canvas', title: 'MATH1860J 作业已发布' }, ctx, { now: NOW });
  ok('命中课程代码 → 加分且理由说明是课程', course.reasons.some((r) => r.rule === 'plan-hit' && /课/.test(r.label)), JSON.stringify(course.reasons));
  ok('来源是 Canvas → 也有来源加分', course.reasons.some((r) => r.rule === 'source'));
  // 标题命中比正文命中更有意义（否则"每日简报"那种长正文会把关键词刷爆）
  const inTitle = scoreImportance({ source: 'rss', title: '托福考试报名开始', notes: '' }, ctx, { now: NOW }).score;
  const inBody = scoreImportance({ source: 'rss', title: '一条消息', notes: '正文里提到托福考试报名' }, ctx, { now: NOW }).score;
  ok('标题命中 > 正文命中', inTitle > inBody, `${inTitle}/${inBody}`);
  const longBody = scoreImportance({ source: 'codex', title: '每日简报', notes: '托福 线性代数 MATH1860J 讲座 小组会议 '.repeat(20) }, ctx, { now: NOW });
  ok('再长的正文也不会把加分刷到上限以上', longBody.score <= inTitle + 22, `${longBody.score}`);
  ok('理由里报出的是命中的词（而不是"命中 181 个词"）',
    longBody.reasons.some((r) => r.rule === 'plan-hit' && r.label.length < 80) && !/命中 \d+ 个相关词/.test(longBody.why),
    longBody.why);
}

// ---------------- 6. 打分：行动词 / 紧急词 / 纯告知 ----------------
{
  const act = scoreImportance({ source: 'email', title: '请于本周五前提交报名表' }, ctx, { now: NOW });
  ok('"提交/报名"会被识别成需要行动', act.reasons.some((r) => r.rule === 'action'), JSON.stringify(act.reasons));
  const actInBody = scoreImportance({ source: 'email', title: '一条普通消息', notes: '正文里说请提交报名表' }, ctx, { now: NOW });
  ok('只有正文提到"提交"不算（避免长正文误判）', !actInBody.reasons.some((r) => r.rule === 'action'), JSON.stringify(actInBody.reasons));
  const urgent = scoreImportance({ source: 'email', title: '务必今天内确认' }, ctx, { now: NOW });
  ok('"务必/今天内"会被识别成紧急', urgent.reasons.some((r) => r.rule === 'urgent'));
  const notUrgent = scoreImportance({ source: 'codex', title: '🤖 跟进监控｜最近重要变化' }, ctx, { now: NOW });
  ok('只有"重要变化"这种标题不会被当成紧急', !notUrgent.reasons.some((r) => r.rule === 'urgent'), JSON.stringify(notUrgent.reasons));
  const ambient = scoreImportance({ source: 'rss', title: '本站已更新公告' }, ctx, { now: NOW });
  ok('纯告知类会被降权', ambient.reasons.some((r) => r.rule === 'ambient' && r.delta < 0), JSON.stringify(ambient.reasons));
}

// ---------------- 7. 打分：历史行为与相关度裁决 ----------------
{
  const item = { source: 'rss', title: '某条消息' };
  const plain = scoreImportance(item, ctx, { now: NOW }).score;
  const liked = scoreImportance(item, ctx, { now: NOW, learning: { accept: 3 } }).score;
  const hated = scoreImportance(item, ctx, { now: NOW, learning: { reject: 5 } }).score;
  ok('你保留过的类型 → 加分', liked > plain);
  ok('你反复忽略的类型 → 减分', hated < plain);
  ok('相关度判"建议忽略" → 重要性也下调',
    scoreImportance(item, ctx, { now: NOW, relevance: { verdict: 'drop' } }).score < plain);
  ok('相关度判"待确认" → 轻微下调',
    scoreImportance(item, ctx, { now: NOW, relevance: { verdict: 'review' } }).score < plain);
  // 接口里是按条目各自取学习计数（learningFor），这条路也要能用
  ok('learningFor(item) 也能取到计数',
    scoreImportance(item, ctx, { now: NOW, learningFor: () => ({ reject: 3 }) }).score < plain
    && scoreImportance(item, ctx, { now: NOW, learningFor: () => ({ accept: 2 }) }).score > plain);
}

// ---------------- 8. 分档与边界 ----------------
ok('70 分是"重要"的起点', bandOf(70) === 'high' && bandOf(69) === 'normal');
ok('45 分是"一般"的起点', bandOf(45) === 'normal' && bandOf(44) === 'low');
ok('阈值写在常量里，不是散在代码里', BANDS.high === 70 && BANDS.normal === 45);
{
  const hi = scoreImportance({ source: 'canvas', title: 'MATH1860J 作业明天 23:59 截止，务必提交', due_at: iso(1) }, ctx, { now: NOW });
  ok('特别重要的条目能到 high 档', hi.band === 'high', `${hi.score} ${JSON.stringify(hi.reasons)}`);
  ok('分数永远落在 0~100', hi.score >= 0 && hi.score <= 100);
  const lo = scoreImportance({ source: 'rss', title: '本站已更新公告' }, ctx, { now: NOW, learning: { reject: 9 } });
  ok('再差也不会变成负数', lo.score >= 0 && lo.score <= 100);
}

// ---------------- 9. 排序 ----------------
{
  const items = [
    { id: 'x1', source: 'rss', title: '普通订阅内容' },
    { id: 'x2', source: 'canvas', title: 'MATH1860J 实验报告明天截止，务必提交', due_at: iso(1) },
    { id: 'x3', source: 'email', title: '讲座通知：本周五' },
    { id: 'x4', source: 'email_sjtu', title: '期末考试安排（线性代数期中）', due_at: iso(3) },
  ];
  const r = rankByImportance(items, ctx, { now: NOW });
  ok('排在最前的是最急最相关的', r.ranked[0].id === 'x2', JSON.stringify(r.ranked.map((x) => `${x.id}:${x.importance}`)));
  ok('与你无关的"公告类"排最后', r.ranked[r.ranked.length - 1].id === 'x1', JSON.stringify(r.ranked.map((x) => `${x.id}:${x.importance}`)));
  ok('命中你关注点的信息不会被当噪音压下去',
    r.ranked.find((x) => x.id === 'x3').importance > r.ranked.find((x) => x.id === 'x1').importance,
    JSON.stringify(r.ranked.map((x) => `${x.id}:${x.importance}`)));
  ok('每条都带 band / why / reasons',
    r.ranked.every((x) => x.band && x.why && Array.isArray(x.reasons)));
  ok('分档计数对得上', r.counts.high + r.counts.normal + r.counts.low === items.length);
  ok('结果里带上下文摘要（界面要显示"我在参考什么"）',
    Array.isArray(r.context.upcoming) && r.context.goals.length === 2);
  ok('空列表不炸', rankByImportance([], ctx, { now: NOW }).ranked.length === 0);
}

// ---------------- 10. 建议（规则版，离线可用） ----------------
{
  const r = rankByImportance([
    { id: 'x2', source: 'canvas', title: 'MATH1860J 实验报告明天截止，务必提交', due_at: iso(1) },
    { id: 'x4', source: 'email_sjtu', title: '线性代数期中考试安排', due_at: iso(3) },
    { id: 'x5', source: 'rss', title: '托福考试报名开始' },
  ], ctx, { now: NOW });
  const adv = buildAdvice(r, ctx);
  ok('给出了建议', adv.length > 0, JSON.stringify(adv));
  ok('最急的一条被点名', adv.some((a) => a.id === 'urgent' && /只剩/.test(a.text)), JSON.stringify(adv.map((a) => a.id)));
  ok('提到了临近的考试', adv.some((a) => a.id === 'exam-soon'), JSON.stringify(adv.map((a) => a.id)));
  ok('每条建议都有 level 与 text', adv.every((a) => a.level && a.text));
  ok('建议条数有上限', buildAdvice(r, ctx, { max: 2 }).length <= 2);
}
{
  // 撞车日：同一天 3 件到期
  const crowded = buildPlanContext({
    tasks: [
      { id: 'a', title: '一', status: 'todo', due_at: dayStr(2) },
      { id: 'b', title: '二', status: 'todo', due_at: dayStr(2) },
      { id: 'c', title: '三', status: 'todo', due_at: dayStr(2) },
    ],
  }, { now: NOW });
  ok('同一天 3 件事到期会被发现', crowded.crowdedDays.length === 1 && crowded.crowdedDays[0].count === 3, JSON.stringify(crowded.crowdedDays));
  const adv = buildAdvice(rankByImportance([], crowded, { now: NOW }), crowded);
  ok('撞车日会进建议', adv.some((a) => a.id === 'crowded' && /同一天/.test(a.text)), JSON.stringify(adv));
}
{
  // 已经过期、还没处理的外部条目：不能说成"只剩不到一天"
  const r = rankByImportance([
    { id: 'p:1', origin: 'pending', source: 'email', kind: 'reminder', title: '某个放了几天的通知', due_at: iso(-4) },
  ], ctx, { now: NOW });
  const adv = buildAdvice(r, ctx);
  // 4 天前 23:00 到期、现在是 10:00 → 按"整天天数"算就是 3 天，用"放了 N 天"的说法
  ok('过期未处理 → 用"放了 N 天"的说法', adv.some((a) => a.id === 'unhandled-stale' && /放了 3 天/.test(a.text)), JSON.stringify(adv));
  ok('不会说成"只剩"', !adv.some((a) => /只剩/.test(a.text)), JSON.stringify(adv));
}
{
  const empty = buildAdvice(rankByImportance([], buildPlanContext({}, { now: NOW }), { now: NOW }), buildPlanContext({}, { now: NOW }));
  ok('什么都没配置时不硬编建议', empty.length === 0, JSON.stringify(empty));
}

// ---------------- 11. 与免费额度/离线无关：引擎不联网、不读库 ----------------
{
  const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
  const src = readFileSync(join(ROOT, 'lib', 'priority.mjs'), 'utf8');
  ok('引擎不引入网络/数据库/文件模块',
    !/from 'node:fs'|from 'node:http'|from 'node:net'|from 'node:sqlite'|fetch\(/.test(src));
  ok('只说从 duedate 复用日期规则（纯日期 = 当天 23:59）', src.includes("from './duedate.mjs'"));
  ok('导出被测试用到的主要 API',
    ['buildPlanContext', 'scoreImportance', 'rankByImportance', 'buildAdvice', 'normalizeGoals', 'termsFromText']
      .every((k) => src.includes(`export function ${k}`) || src.includes(`export const ${k}`)));
  ok('每条加分都带理由（可解释）', src.includes('reasons.push'));
  ok('HORIZON_DAYS 是常量', HORIZON_DAYS === 14);
  ok('来源权重表在导出的常量里', SOURCE_IMPORTANCE.canvas === 10 && SOURCE_IMPORTANCE.email_sjtu === 10);
}

console.log('');
console.log(failures === 0 ? 'priority.test: PASS' : `priority.test: FAIL (${failures})`);
process.exit(failures === 0 ? 0 : 1);
