// 语义兜底测试（P2）：时段规则 + 提示词 + 回复解析 + 结果套用。
//
//   node tests/semantic.test.mjs

// 2026-09-27：高峰时段改成**可配**（lib/peak.mjs 用"当天分钟数"表示时段，并支持时区），
// 所以这里跟着改成新 API；缺省值仍然是原来那两条窗口。
import { PEAK_DEFAULTS, bandLabel, isPeak, localParts } from '../lib/peak.mjs';
import {
  MAX_ITEMS_PER_RUN, applySemanticResults, buildSemanticPrompt, parseSemanticReply,
} from '../lib/semantic.mjs';

let failures = 0;
const ok = (label, cond, detail = '') => {
  if (cond) console.log(`  PASS ${label}`);
  else {
    failures += 1;
    console.log(`  FAIL ${label}${detail ? ` -- ${detail}` : ''}`);
  }
};

console.log('semantic.test.mjs');

// ---------- 1. 高峰/非高峰（与计价口径一致） ----------
// 北京时间：周一 10:00 高峰 / 周一 13:00 非高峰 / 周一 15:00 高峰 / 周六 10:00 非高峰
const at = (iso) => new Date(iso);
ok('缺省窗口还是 09:00–12:00 与 14:00–18:00（分钟数表示）',
  JSON.stringify(PEAK_DEFAULTS.windows) === JSON.stringify([[540, 720], [840, 1080]]));
ok('周一 10:00 → 高峰', isPeak(at('2026-09-21T02:00:00Z')) === true, bandLabel(at('2026-09-21T02:00:00Z')));
ok('周一 13:00 → 非高峰', isPeak(at('2026-09-21T05:00:00Z')) === false);
ok('周一 15:00 → 高峰', isPeak(at('2026-09-21T07:00:00Z')) === true);
ok('周一 19:00 → 非高峰', isPeak(at('2026-09-21T11:00:00Z')) === false);
ok('周六 10:00 → 非高峰（周末全天）', isPeak(at('2026-09-26T02:00:00Z')) === false);
ok('边界：09:00 算高峰、12:00 不算',
  isPeak(at('2026-09-21T01:00:00Z')) === true && isPeak(at('2026-09-21T04:00:00Z')) === false);
ok('北京时间换算不依赖本机时区', localParts(at('2026-09-21T02:00:00Z'), 8).hour === 10,
  String(localParts(at('2026-09-21T02:00:00Z'), 8).hour));
ok('换个时区就按那个时区算（同一瞬间 UTC+0 是 2 点）',
  localParts(at('2026-09-21T02:00:00Z'), 0).hour === 2
  && isPeak(at('2026-09-21T02:00:00Z'), { tz_offset: 0 }) === false);

// ---------- 2. 提示词 ----------
const profile = {
  keywords: ['TOEFL', '科研'], courseCodes: ['MATH1860J'],
  allowSenders: ['advisor@example.edu'], denyKeywords: ['促销'],
};
const items = [
  { source: 'email', title: '限时优惠：全场促销', notes: '买一送一' },
  { source: 'canvas', title: 'MATH1860J 作业 3', due_at: '2026-09-25' },
];
const prompt = buildSemanticPrompt(profile, items);
ok('提示词带上画像（关键词/课程/屏蔽词）',
  prompt.includes('TOEFL') && prompt.includes('MATH1860J') && prompt.includes('促销'));
ok('提示词逐条列出候选（带来源与时间）',
  prompt.includes('限时优惠') && prompt.includes('MATH1860J 作业 3') && prompt.includes('canvas'));
ok('提示词明确要求只输出 JSON 数组', prompt.includes('只输出一个 JSON 数组') && prompt.includes('"relevant"'));
ok('明确禁止执行操作（安全边界）', prompt.includes('不要执行任何操作') && prompt.includes('不要读写文件'));
ok('空画像也能拼出提示词', buildSemanticPrompt({}, []).includes('（未填）'));

// ---------- 3. 回复解析（容错） ----------
const okJson = '[{"n":1,"relevant":false,"reason":"促销广告"},{"n":2,"relevant":true,"reason":"你的课程作业"}]';
ok('标准 JSON 能解析', parseSemanticReply(okJson).length === 2);
ok('被 ``` 包住的 JSON 也能解析',
  parseSemanticReply('好的，结果如下：\n```json\n' + okJson + '\n```\n以上。').length === 2);
ok('带前缀废话的 JSON 也能解析', parseSemanticReply('我认为：' + okJson).length === 2);
const liney = parseSemanticReply('1. 不相关：促销广告\n2. 相关：你的课程作业');
ok('行式输出兜底可用', liney.length === 2 && liney[0].relevant === false && liney[1].relevant === true,
  JSON.stringify(liney));
ok('英文行式也能认', parseSemanticReply('1 yes - relevant\n2 no - irrelevant')[0].relevant === true);
ok('完全看不懂就返回空数组（不瞎猜）', parseSemanticReply('我不知道该怎么判').length === 0);
ok('空回复不崩', parseSemanticReply('').length === 0 && parseSemanticReply(null).length === 0);
ok('缺 relevant 字段的行被丢掉',
  parseSemanticReply('[{"n":1,"reason":"没说相关不相关"}]').length === 0);

// ---------- 4. 套用结果 ----------
const applied = applySemanticResults(items, [
  { n: 1, relevant: false, reason: '促销广告' },
  { n: 2, relevant: true, reason: '你的课程作业' },
]);
ok('相关 → 建议放行', applied[1].verdict === 'push' && applied[1].score > 0);
ok('不相关 → 建议忽略', applied[0].verdict === 'drop' && applied[0].score < 0);
ok('理由写回来了（可解释）',
  applied[0].reasons[0].rule === 'semantic' && applied[0].reasons[0].note.includes('促销广告'));
ok('没被判到的条目不硬套结果', applySemanticResults(items, [{ n: 1, relevant: true, reason: 'x' }]).length === 1);
ok('单次处理上限是 10 条（省调用）', MAX_ITEMS_PER_RUN === 10);

console.log('');
console.log(failures === 0 ? 'semantic.test: PASS' : `semantic.test: FAIL (${failures})`);
process.exit(failures === 0 ? 0 : 1);
