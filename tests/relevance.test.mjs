// 相关度裁决测试（信息筛选 P0）。
//
//   node tests/relevance.test.mjs
//
// 三块：①画像整理 ②打分与三档 verdict（含"画像没启用 = 保持原行为"）
// ③两条画像入口 —— 自动派生 / 从长期记忆文本解析

import {
  DEFAULT_PROFILE, deriveProfileFromState, normalizeProfile, parseProfileFromText,
  scoreItem, summarizeVerdicts,
} from '../lib/relevance.mjs';

let failures = 0;
const ok = (label, cond, detail = '') => {
  if (cond) console.log(`  PASS ${label}`);
  else {
    failures += 1;
    console.log(`  FAIL ${label}${detail ? ` -- ${detail}` : ''}`);
  }
};

console.log('relevance.test.mjs');

// ---------- 1. 画像整理 ----------
const dirty = normalizeProfile({
  enabled: true,
  keywords: ['TOEFL', '', ' TOEFL ', 123],
  courseCodes: ['math1860j', 'stat1000J'],
  allowSenders: ['Professor@EXAMPLE.EDU'],
  denyKeywords: ['促销', '优惠'],
  denySenders: ['noreply@example.net'],
});
ok('关键词去重去空', JSON.stringify(dirty.keywords) === JSON.stringify(['TOEFL']), JSON.stringify(dirty.keywords));
ok('课程代码统一大写去重', JSON.stringify(dirty.courseCodes) === JSON.stringify(['MATH1860J', 'STAT1000J']),
  JSON.stringify(dirty.courseCodes));
ok('发件人统一小写', dirty.allowSenders[0] === 'professor@example.edu', dirty.allowSenders[0]);
ok('阈值有默认值', dirty.pushAt === 3 && dirty.dropAt === -3);
ok('脏输入不会崩', normalizeProfile(null).enabled === false && normalizeProfile('x').schema === 'profile.v1');

// ---------- 2. 打分与 verdict ----------
const off = scoreItem({ source: 'canvas', title: '任何东西' }, DEFAULT_PROFILE);
ok('画像未启用时 verdict 恒为 push（保持今天的行为）', off.verdict === 'push' && off.score === 0,
  JSON.stringify(off));

const profile = normalizeProfile({
  enabled: true,
  keywords: ['TOEFL', '科研'],
  courseCodes: ['MATH1860J'],
  allowSenders: ['advisor@example.edu'],
  denySenders: ['noreply@example.net'],
  denyKeywords: ['促销', '优惠'],
  sourceWeights: { canvas: 1, arxiv: -1 },
});

const strong = scoreItem({ source: 'canvas', title: 'MATH1860J 作业 3 已发布', sender: 'advisor@example.edu' }, profile);
ok('课程代码 + 关注发件人 → push', strong.verdict === 'push', JSON.stringify(strong));
ok('判决带可解释的理由', strong.reasons.some((r) => r.rule === 'course-code') && strong.reasons.some((r) => r.rule === 'allow-sender'),
  JSON.stringify(strong.reasons));

const junk = scoreItem({ source: 'email', title: '双十一促销：全场优惠', sender: 'noreply@example.net' }, profile);
ok('屏蔽发件人 → drop（一票否决）', junk.verdict === 'drop' && junk.score <= -100, JSON.stringify(junk));

const promo = scoreItem({ source: 'email', title: '限时优惠：订阅我们的课程', sender: 'news@example.net' }, profile);
ok('推广语气 + 自动发件人 → 不会被当成重点', promo.verdict !== 'push', JSON.stringify(promo));

const mid = scoreItem({ source: 'arxiv', title: 'A new paper about planning', sender: 'rss@example.org' }, profile);
ok('拿不准的条目落在 review 中间带', mid.verdict === 'review', JSON.stringify(mid));

const urgent = scoreItem({ source: 'canvas', title: 'MATH1860J 期中考试', due_at: new Date(Date.now() + 2 * 86400000).toISOString() }, profile);
ok('命中课程 + 7 天内到期 → 分数更高', urgent.score >= 4, JSON.stringify(urgent));

const summary = summarizeVerdicts([strong, junk, promo, mid]);
ok('汇总能报出三档数量与主要理由',
  summary.push >= 1 && summary.drop >= 1 && Object.keys(summary.topReasons).length > 0,
  JSON.stringify(summary));

// ---------- 3. 两条画像入口 ----------
const derived = deriveProfileFromState({
  courses: [{ course: 'MATH1860J 高等数学', weekday: 1 }, { course: 'STAT1000J 概率统计' }],
  tasks: [{ title: '[英语] TOEFL 备考节奏' }, { title: '[ACM] 补选三件事' }],
  notifications: Array.from({ length: 30 }, () => ({ source: 'connector:canvas' }))
    .concat(Array.from({ length: 3 }, () => ({ source: 'connector:email' }))),
});
ok('自动派生：从课表抓到课程代码',
  derived.courseCodes.includes('MATH1860J') && derived.courseCodes.includes('STAT1000J'),
  JSON.stringify(derived.courseCodes));
ok('自动派生：从任务抓到关注词（TOEFL / ACM）',
  derived.keywords.includes('TOEFL') && derived.keywords.includes('ACM'), JSON.stringify(derived.keywords));
ok('自动派生：来源权重只在出现较多时才给分',
  derived.sourceWeights.canvas === 1 && derived.sourceWeights.email === 0, JSON.stringify(derived.sourceWeights));
ok('自动派生结果默认不启用（要你点一下才生效）', derived.enabled === false);
ok('自动派生会标注来源', derived.origin === 'derived', derived.origin);

const imported = parseProfileFromText(`
# 长期记忆
## 兴趣
- 科研：agent 记忆与工具调用
- 方向：计算机系统 / 编译器
## 目标
- 密西根 DD 申请
- TOEFL 二月考位
## 不想看
- 社团招新
- 电商促销
课程：FA26 有 MATH1860J 与 ECE2150J
`);
ok('长期记忆导入：抓到课程代码（含正文里出现的）',
  imported.courseCodes.includes('MATH1860J') && imported.courseCodes.includes('ECE2150J'),
  JSON.stringify(imported.courseCodes));
ok('长期记忆导入：抓到关注关键词', imported.keywords.includes('科研') || imported.keywords.includes('agent 记忆与工具调用'),
  JSON.stringify(imported.keywords));
ok('长期记忆导入：抓到屏蔽词', imported.denyKeywords.includes('电商促销'), JSON.stringify(imported.denyKeywords));
ok('长期记忆导入结果也默认不启用', imported.enabled === false && imported.origin === 'longterm-memory');
ok('两条入口产出同一个形状（可互相覆盖）',
  JSON.stringify(Object.keys(imported).sort()) === JSON.stringify(Object.keys(derived).sort()));
ok('导入文本为空时不会崩', parseProfileFromText('').keywords.length === 0);

console.log('');
console.log(failures === 0 ? 'relevance.test: PASS' : `relevance.test: FAIL (${failures})`);
process.exit(failures === 0 ? 0 : 1);
