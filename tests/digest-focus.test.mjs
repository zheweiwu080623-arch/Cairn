// 投递三档的"摘要档"+ 专注时段不打扰（P1-b）。
//
//   node tests/digest-focus.test.mjs

import { activeFocus, coversNow, isFocusRunning } from '../lib/focus.mjs';
import { buildDigestText } from '../lib/mobile.mjs';

let failures = 0;
const ok = (label, cond, detail = '') => {
  if (cond) console.log(`  PASS ${label}`);
  else {
    failures += 1;
    console.log(`  FAIL ${label}${detail ? ` -- ${detail}` : ''}`);
  }
};

console.log('digest-focus.test.mjs');

// ---------- 1. 专注时段判断（纯函数） ----------
const now = Date.parse('2026-09-21T19:00:00+08:00');
const h = 3600000;
const running = { label: '番茄 45', started_at: new Date(now - h / 2).toISOString(), ended_at: new Date(now + h / 2).toISOString() };
const past = { started_at: new Date(now - 3 * h).toISOString(), ended_at: new Date(now - 2 * h).toISOString() };
const future = { started_at: new Date(now + h).toISOString(), ended_at: new Date(now + 2 * h).toISOString() };

ok('正在专注 → 期间为真', coversNow(running, now) === true);
ok('已结束的专注不算', coversNow(past, now) === false);
ok('还没开始的专注不算', coversNow(future, now) === false);
ok('边界：刚好开始算、刚好结束算',
  coversNow({ started_at: new Date(now).toISOString(), ended_at: new Date(now + h).toISOString() }, now) === true
  && coversNow({ started_at: new Date(now - h).toISOString(), ended_at: new Date(now).toISOString() }, now) === true);
ok('坏数据不崩、也不算专注',
  coversNow({ started_at: '不是时间', ended_at: null }, now) === false
  && isFocusRunning([{ started_at: null, ended_at: undefined }], now) === false);
ok('空列表 → 不在专注', isFocusRunning([], now) === false && isFocusRunning(null, now) === false);
ok('混在多条里也能认出正在专注的那条', isFocusRunning([past, running, future], now) === true);
ok('activeFocus 返回正在专注的那条', activeFocus([past, running], now)?.label === '番茄 45');
ok('没有正在专注时 activeFocus 返回 null', activeFocus([past, future], now) === null);

// ---------- 2. 摘要里带出"被筛选拦下"的条目 ----------
const emptyStore = {
  listTasks: () => [], listEvents: () => [], listNotifications: () => [],
  listCourses: () => [], listAcademic: () => [], listMilestones: () => [],
  listPending: () => [],
};
const plain = buildDigestText(emptyStore, { days: 1 });
ok('没有待批准时，摘要里不出现"被筛选拦下"一节', !plain.includes('被筛选拦下'));
ok('摘要标题用传入的品牌名（默认 Cairn）', plain.startsWith('Cairn ·'), plain.split('\n')[0]);
ok('可以换成作者自己的名字', buildDigestText(emptyStore, { days: 1, appName: '空庭Coterie的Planner' })
  .startsWith('空庭Coterie的Planner ·'));

const withPending = {
  ...emptyStore,
  listPending: () => [
    { id: '1', verdict: 'review', title: '选课通知', reasons: JSON.stringify([]) },
    { id: '2', verdict: 'drop', title: '双十一促销', reasons: JSON.stringify([{ rule: 'promo-tone', delta: -2, note: '标题像推广/订阅类内容' }]) },
    { id: '3', verdict: 'push', title: '已经放行的不该出现在这里' },
    { id: '4', title: '没有裁决的老数据不出现' },
  ],
};
const text = buildDigestText(withPending, { days: 1 });
ok('出现"被筛选拦下，等你确认"一节', text.includes('【被筛选拦下，等你确认】'));
ok('待确认条目带标签', text.includes('[待确认] 选课通知'));
ok('建议忽略条目带标签 + 理由（人话）',
  text.includes('[建议忽略] 双十一促销') && text.includes('标题像推广/订阅类内容'), text.slice(0, 60));
ok('已放行 / 无裁决的条目不会混进来',
  !text.includes('已经放行的不该出现') && !text.includes('没有裁决的老数据'));
ok('给出下一步指引', text.includes('待批准') && text.includes('自动处理'));

const many = buildDigestText({ ...emptyStore, listPending: () => Array.from({ length: 25 }, (_, i) => ({ id: `p${i}`, verdict: 'review', title: `条目 ${i}`, reasons: '[]' })) }, { days: 1 });
ok('最多列 10 条，不刷屏', (many.match(/\[待确认\]/g) || []).length === 10,
  String((many.match(/\[待确认\]/g) || []).length));

console.log('');
console.log(failures === 0 ? 'digest-focus.test: PASS' : `digest-focus.test: FAIL (${failures})`);
process.exit(failures === 0 ? 0 : 1);
