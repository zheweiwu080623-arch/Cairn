// 行为学习测试（P1）。
//
//   node tests/learning.test.mjs
//
// 要点：删 3 次 → 自动忽略；批 2 次 → 自动放行；正反计数互斥；
// 学习结果**追加**进画像而不是覆盖；随时可清空；每条都能解释。

import {
  ACCEPT_AT, REJECT_AT, clearLearning, learnedRules, mergeLearned, normalizeLearning, recordFeedback,
} from '../lib/learning.mjs';

let failures = 0;
const ok = (label, cond, detail = '') => {
  if (cond) console.log(`  PASS ${label}`);
  else {
    failures += 1;
    console.log(`  FAIL ${label}${detail ? ` -- ${detail}` : ''}`);
  }
};

console.log('learning.test.mjs');
console.log(`  阈值：删 ${REJECT_AT} 次 → 忽略；批 ${ACCEPT_AT} 次 → 放行`);

ok('初始状态干净', normalizeLearning().schema === 'learning.v1'
  && Object.keys(normalizeLearning().applied).length === 0);
ok('脏输入不会崩', normalizeLearning('x').enabled === true && normalizeLearning(null).reject !== undefined);
ok('计数只收正整数', JSON.stringify(normalizeLearning({ reject: { a: 2, b: -1, c: 'x' } }).reject) === JSON.stringify({ a: 2 }));

// ---- 删除 → 学成"忽略" ----
let l = normalizeLearning();
const key = 'promo@example.net';
for (let i = 1; i <= REJECT_AT; i += 1) {
  const r = recordFeedback(l, { action: 'delete', key, label: '商店促销' });
  l = r.learning;
  if (i < REJECT_AT) ok(`删第 ${i} 次还不下结论`, r.changed === null, JSON.stringify(r.changed));
  else ok(`删第 ${i} 次 → 学成"以后忽略"`,
    r.changed && r.changed.verdict === 'deny' && r.changed.count === REJECT_AT, JSON.stringify(r.changed));
}
const rules = learnedRules(l);
ok('学到的规则进入 denySenders', rules.denySenders.includes(key), JSON.stringify(rules));
ok('说明是人话（含次数）', rules.notes.some((n) => n.includes('商店促销') && n.includes(String(REJECT_AT))),
  JSON.stringify(rules.notes));

// ---- 批准 → 学成"放行"；并与删除互斥 ----
let l2 = normalizeLearning();
for (let i = 1; i <= ACCEPT_AT; i += 1) l2 = recordFeedback(l2, { action: 'approve', key: 'advisor@example.edu', label: '导师' }).learning;
ok('批 2 次 → 学成"以后优先"', learnedRules(l2).allowSenders.includes('advisor@example.edu'));

let l3 = normalizeLearning({ reject: { 'x@example.net': 5 }, accept: { 'x@example.net': 5 } });
l3 = recordFeedback(l3, { action: 'approve', key: 'x@example.net' }).learning;
ok('批准会把删除计数清零（避免又爱又恨）', l3.reject['x@example.net'] === undefined && l3.accept['x@example.net'] === 6,
  JSON.stringify({ reject: l3.reject, accept: l3.accept }));

// ---- 合并进画像：只追加，不覆盖手填 ----
const profile = {
  enabled: true,
  allowSenders: ['boss@example.com'],
  denySenders: ['already-blocked@example.net'],
  keywords: ['TOEFL'],
};
const merged = mergeLearned(profile, l);
ok('学到的不想看重进了画像的屏蔽清单', merged.profile.denySenders.includes(key), JSON.stringify(merged.profile.denySenders));
ok('手填的规则没被动', merged.profile.allowSenders.includes('boss@example.com')
  && merged.profile.denySenders.includes('already-blocked@example.net')
  && merged.profile.keywords.includes('TOEFL'));
ok('合并是可解释的（返回 applied 条数与说明）',
  merged.applied >= 1 && merged.learned.notes.length >= 1, JSON.stringify(merged.learned.notes));
ok('原画像对象没有被改动', profile.denySenders.length === 1 && profile.allowSenders.length === 1);

// ---- 开关与清空 ----
ok('关闭学习后不再记录',
  recordFeedback(normalizeLearning({ enabled: false }), { action: 'delete', key: 'a@example.net' }).changed === null);
const cleared = clearLearning(l);
ok('清空后没有学到的规则',
  Object.keys(cleared.applied).length === 0 && learnedRules(cleared).denySenders.length === 0);
ok('清空不影响手填画像（merge 后仍保留手填）',
  mergeLearned(profile, cleared).profile.allowSenders.includes('boss@example.com'));
ok('空 key 不记', recordFeedback(normalizeLearning(), { action: 'delete', key: '' }).changed === null);

console.log('');
console.log(failures === 0 ? 'learning.test: PASS' : `learning.test: FAIL (${failures})`);
process.exit(failures === 0 ? 0 : 1);
