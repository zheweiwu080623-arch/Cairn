// 学期周次（学生特化第一刀，2026-09-26 晚）。
//
//   node tests/semester.test.mjs
//
// 这玩意儿全是日期算术，最容易出"差一天/差一周"的错，所以边界逐个钉：
// 开学当天=第 1 周、跨月跨年、最后两周算考试周、没设学期就什么都不显示。

import { daysBetween, mondayOf, parseDay, semesterInfo } from '../lib/semester.mjs';

let failures = 0;
const ok = (label, cond, detail = '') => {
  if (cond) console.log(`  PASS ${label}`);
  else { failures += 1; console.log(`  FAIL ${label}${detail ? ` -- ${detail}` : ''}`); }
};

console.log('semester.test.mjs');

// ---------------- 1. 日期解析与对齐 ----------------
{
  const d = parseDay('2026-09-07');
  ok('能解析 YYYY-MM-DD', d && d.getFullYear() === 2026 && d.getMonth() === 8 && d.getDate() === 7);
  ok('坏值一律给 null（不炸）', parseDay('2026/09/07') === null && parseDay('') === null && parseDay(null) === null);
  ok('对齐到周一：9/07 是周一 → 它自己', mondayOf(parseDay('2026-09-07')).getDate() === 7);
  ok('对齐到周一：9/13 是周日 → 回到 9/07', mondayOf(parseDay('2026-09-13')).getDate() === 7);
  ok('对齐到周一：9/14 是周一 → 它自己', mondayOf(parseDay('2026-09-14')).getDate() === 14);
  ok('差几天按日历天算（跨月也对）', daysBetween(parseDay('2026-09-07'), parseDay('2026-10-07')) === 30);
}

// ---------------- 2. 第几周 ----------------
{
  const sem = { start: '2026-09-07', weeks: 18 };   // 9/07 开课，周一
  const at = (s) => semesterInfo(sem, parseDay(s));
  ok('没设学期：configured=false 且给出人话', semesterInfo({}, parseDay('2026-09-07')).configured === false);
  ok('开学当天 = 第 1 周', at('2026-09-07').week === 1 && at('2026-09-07').phase === 'classes');
  ok('开学那一周的周日还是第 1 周', at('2026-09-13').week === 1);
  ok('第二周周一 = 第 2 周', at('2026-09-14').week === 2);
  ok('第 4 周（跨月）', at('2026-09-28').week === 4, JSON.stringify(at('2026-09-28')));
  ok('开学前：还没开学，并且说还有几天', at('2026-09-01').phase === 'not-yet' && at('2026-09-01').week === 0);
  ok('开学前那句话里有天数', /还有\s*6\s*天/.test(at('2026-09-01').label), at('2026-09-01').label);
  ok('最后两周算考试周（18 周 → 第 17、18 周）',
    at('2026-12-28').phase === 'finals' && at('2026-12-28').week === 17
    && at('2027-01-04').week === 18 && at('2027-01-04').phase === 'finals');
  ok('第 16 周还不是考试周', at('2026-12-21').week === 16 && at('2026-12-21').phase === 'classes');
  ok('学期结束后：over，不再报周次', at('2027-02-01').phase === 'over' && at('2027-02-01').week === 0);
  ok('一天之差不影响周次（同周内每天都一样）',
    at('2026-09-08').week === 1 && at('2026-09-09').week === 1 && at('2026-09-10').week === 1);
  ok('周数会被夹在合理区间（1~60）',
    semesterInfo({ start: '2026-09-07', weeks: 999 }, parseDay('2026-09-07')).total === 60
    && semesterInfo({ start: '2026-09-07', weeks: 0 }, parseDay('2026-09-07')).total === 18);
  ok('labels 是人话：带"第 N 周 / 共 M 周"', /第 1 周 \/ 共 18 周/.test(at('2026-09-07').label), at('2026-09-07').label);
  ok('考试周那句话里写着"考试周"', /考试周/.test(at('2027-01-04').label), at('2027-01-04').label);
}

// ---------------- 3. 跨年 / 不同开学日 ----------------
{
  const spring = { start: '2027-02-22', weeks: 16 };   // 春季学期
  const at = (s) => semesterInfo(spring, parseDay(s));
  ok('春季学期也认（2/22 开学 → 第 1 周）', at('2027-02-22').week === 1);
  ok('跨到 3 月仍是连续计数（3/01 是第 2 周）', at('2027-03-01').week === 2, JSON.stringify(at('2027-03-01')));
  ok('16 周的学期：第 15 周就是考试周', at('2027-05-31').week === 15 && at('2027-05-31').phase === 'finals');
}

console.log('');
console.log(failures === 0 ? 'semester.test: PASS' : `semester.test: FAIL (${failures})`);
process.exit(failures === 0 ? 0 : 1);
