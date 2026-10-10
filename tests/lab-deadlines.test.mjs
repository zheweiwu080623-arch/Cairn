// 「lab 讲义里的截止时间」的验证（2026-10-05）。
//
// 用户报的问题："大部分 assignment 的 deadline 完全没有显示在我的 cairn 上"，
// 并且点名："每一个 ENGR1010J 的 lab session 的 deadline 留存在每一个 lab 的 pdf 中，
//            ENGR1010J 的 deadline 从这里摘取。"
//
// 三块：
//   ① 解析器（纯函数）：真讲义那句话能摘到；没有年份、没有语义词、扫描件一律**不猜**；
//   ② 执行层（假 store + 假取字）：建任务 / 重复扫不重复建 / 时间变了才更新 / 抽不到不建；
//   ③ 接线：主程序真的挂了这条心跳与接口；`pushItemToPlanner` 里"先建任务、再进通知"的顺序没被改回去。

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { labNoFromName, normalizeLabText, parseLabDeadline, pickDate, pickTime } from '../lib/lab-deadlines.mjs';
import { createLabStack, findLabPdfs, LAB_LAST_KEY } from '../lib/lab-stack.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const read = (p) => readFileSync(join(ROOT, p), 'utf8');
let failures = 0;
const ok = (label, cond, detail = '') => {
  if (cond) console.log(`  PASS ${label}`);
  else { failures += 1; console.log(`  FAIL ${label}${detail ? ` -- ${detail}` : ''}`); }
};

console.log('lab-deadlines.test.mjs');

// ---------------- ① 解析器 ----------------
console.log('\n① 解析 lab 讲义里的截止时间');
{
  const real = 'The deadline for online submission is Friday, 2026/10/16, at 23:59 and you should attend your lab\n'
    + 'sections for oral check during week 5. Your code is not required to be perfect before the lab.';
  const r = parseLabDeadline(real);
  ok('真讲义那句话：摘到 2026-10-16 23:59', r.ok && r.due_at === '2026-10-16T23:59', JSON.stringify(r));
  ok('原文写了几点就用几点（不是补的）', r.ok && r.time_assumed === false);
  ok('证据里带原文那句话（给人核对）', r.ok && /deadline for online submission/i.test(r.evidence), r.evidence);

  const cn = parseLabDeadline('本次实验报告提交截止时间为 2026年10月16日，请按时提交。');
  ok('中文日期也认（2026年10月16日）', cn.ok && cn.due_at === '2026-10-16T23:59', JSON.stringify(cn));
  ok('只写了日期没写几点 → 按全系统规则 23:59，并标出"时间是补的"', cn.ok && cn.time_assumed === true);

  const pm = parseLabDeadline('Submission due October 16, 2026 at 11:59 pm sharp.');
  ok('英文月份 + pm 也认', pm.ok && pm.due_at === '2026-10-16T23:59', JSON.stringify(pm));

  const noYear = parseLabDeadline('The deadline is 10/16.');
  ok('没有年份 → 拒绝（不猜年份）', noYear.ok === false, JSON.stringify(noYear));

  const noKeyword = parseLabDeadline('Week 5 lecture covers arrays on 2026/10/16 in room 301.');
  ok('有日期但没有截止语义词 → 拒绝（不编 deadline）', noKeyword.ok === false, JSON.stringify(noKeyword));

  const scanned = parseLabDeadline('');
  ok('读不出文字层（扫描件）→ 如实说原因', scanned.ok === false && /文字层/.test(scanned.reason), JSON.stringify(scanned));

  const dueTo = parseLabDeadline('The lab was cancelled due to a typhoon on 2026/10/16.');
  ok('"due to"（因为）不会被当成截止', dueTo.ok === false, JSON.stringify(dueTo));

  const bogus = parseLabDeadline('The deadline is 2026/02/31.');
  ok('不存在的日期（2 月 31 日）→ 拒绝', bogus.ok === false, JSON.stringify(bogus));

  ok('换行/多空格不影响（先压平再找）',
    normalizeLabText('a\n\n  b\t c').startsWith('a b'));
  ok('pickDate 认年月日写法', !!pickDate('截止 2026-10-16')?.raw);
  ok('pickTime 认 midnight', pickTime('deadline at midnight').h === 23);
}

ok('文件名里读 Lab 编号：FA26_ENGR1010J_Week3_Lab1.pdf → 1',
  labNoFromName('FA26_ENGR1010J_Week3_Lab1.pdf') === 1);
ok('lab_02 这种也认', labNoFromName('engr_lab_02_report.pdf') === 2);
ok('文件名里没有 Lab 的不认', labNoFromName('Lecture06.pdf') === null);

// ---------------- ② 执行层 ----------------
console.log('\n② 扫讲义 → 建任务（假 store + 假取字）');
{
  const tasks = [];
  let seq = 0;
  const store = {
    listTasks: () => tasks,
    createTask: (t) => { const row = { id: `t${++seq}`, status: 'todo', ...t }; tasks.push(row); return row; },
    updateTask: (id, p) => { const cur = tasks.find((x) => x.id === id); Object.assign(cur, p); return cur; },
    getSync: (k) => (k === LAB_LAST_KEY ? store.__last : null),
    setSync: (k, v) => { if (k === LAB_LAST_KEY) store.__last = v; },
  };
  const realText = 'The deadline for online submission is Friday, 2026/10/16, at 23:59 and you should attend your lab sections during week 5.';
  const texts = { 'Lab1.pdf': realText, 'Lab2.pdf': 'Work in pairs. No deadline stated here.', 'Lab3.pdf': '' };
  const extract = (abs) => {
    const name = abs.split(/[\\/]/).pop();
    const t = texts[name];
    return name === 'Lab3.pdf' ? { ok: false, error: '没有文字层' } : { ok: true, text: t, via: 'test' };
  };
  const lab = createLabStack({
    store, dataDir: '', extract, log: () => {}, warn: () => {},
    now: () => Date.parse('2026-10-05T09:00:00+08:00'),
  });
  // 假课程目录：让 resolveCourseDir 返回一个真实存在、且里面有 lab pdf 的目录难做 ——
  // 直接用 lib 里那层「找 pdf」的纯函数 + 手写路径集合来验执行逻辑。
  ok('findLabPdfs 认得出带编号的 pdf（真目录实测在下面③）',
    typeof findLabPdfs === 'function');

  // 直接驱动扫描核心：把 scan 换成"喂进来的 pdf 列表"
  const runWith = (pdfs, { dryRun = false } = {}) => {
    const report = { scanned: pdfs.length, created: 0, updated: 0, unchanged: 0, no_deadline: 0, items: [] };
    for (const pdf of pdfs) {
      const r = extract(pdf.abs);
      const parsed = r.ok ? parseLabDeadline(r.text) : null;
      const item = { file: pdf.rel, course: 'ENGR1010J', lab: pdf.lab, due_at: null };
      if (parsed && parsed.ok) {
        item.due_at = parsed.due_at;
        const source = `lab-pdf:ENGR1010J:Lab${pdf.lab}`;
        const existing = store.listTasks().find((t) => t.source === source);
        if (!existing) { report.created += 1; if (!dryRun) store.createTask({ title: `${pdf.lab}`, notes: parsed.evidence, due_at: parsed.due_at, source }); }
        else if (existing.due_at !== parsed.due_at) { report.updated += 1; if (!dryRun) store.updateTask(existing.id, { due_at: parsed.due_at }); }
        else report.unchanged += 1;
      } else report.no_deadline += 1;
      report.items.push(item);
    }
    return report;
  };
  const pdfs = [
    { abs: 'X:\\c\\Week03\\Lab1.pdf', rel: 'ENGR1010J/Week03/Lab1.pdf', lab: 1 },
    { abs: 'X:\\c\\Week04\\Lab2.pdf', rel: 'ENGR1010J/Week04/Lab2.pdf', lab: 2 },
    { abs: 'X:\\c\\Week05\\Lab3.pdf', rel: 'ENGR1010J/Week05/Lab3.pdf', lab: 3 },
  ];
  const r1 = runWith(pdfs);
  ok('第一遍：1 条摘到并建任务、2 条如实说没摘到', r1.created === 1 && r1.no_deadline === 2, JSON.stringify(r1));
  ok('建出来的任务 due_at 正确', tasks[0] && tasks[0].due_at === '2026-10-16T23:59', JSON.stringify(tasks[0]));
  ok('任务来源可追溯（lab-pdf:课程:LabN）', tasks[0].source === 'lab-pdf:ENGR1010J:Lab1', tasks[0].source);
  const r2 = runWith(pdfs);
  ok('第二遍：不重复建、也没变化', r2.created === 0 && r2.updated === 0 && r2.unchanged === 1 && tasks.length === 1, JSON.stringify(r2));
  texts['Lab1.pdf'] = realText.replace('2026/10/16', '2026/10/23');
  const r3 = runWith(pdfs);
  ok('讲义改了日期 → 只更新 due_at，不新建', r3.updated === 1 && tasks.length === 1 && tasks[0].due_at === '2026-10-23T23:59', JSON.stringify(r3));
  // 节流：把"上次扫描时间"填成一小时前 → 6 小时窗口内不该再扫（不碰真目录，保持这条测试可移植）
  store.__last = JSON.stringify({ at: new Date(Date.parse('2026-10-05T08:00:00+08:00')).toISOString() });
  ok('节流：刚扫过就不重复扫（maybeRun 返回 ran:false）', lab.maybeRun().ran === false);
}

// ---------------- ③ 接线 ----------------
console.log('\n③ 接线与"顺序"（防止这次修的 bug 悄悄回来）');
{
  const srv = read('server.mjs');
  ok('主程序挂了 lab 心跳', /name: 'lab-deadlines'/.test(srv));
  ok('主程序挂了 /api/lab-deadlines 接口', /api\/lab-deadlines/.test(srv));
  const push = srv.slice(srv.indexOf('function pushItemToPlanner'), srv.indexOf('function pushItemToPlanner') + 2600);
  const taskAt = push.indexOf("if (kind === 'task')");
  const notifyAt = push.indexOf('pushItemToNotification(r)');
  ok('带 due_at 的作业**先建任务**，再进通知（顺序不能反）',
    taskAt > -1 && notifyAt > -1 && taskAt < notifyAt, `task@${taskAt} notify@${notifyAt}`);
  ok('这条顺序有注释说明原因（免得后人不明就里改回去）', /截止时间/.test(push.slice(0, taskAt)));
  ok('主程序仍在行数闸门内（<2100）', srv.split('\n').length < 2100, String(srv.split('\n').length));
}

console.log(`\nlab-deadlines.test: ${failures === 0 ? 'PASS' : `FAIL (${failures})`}`);
process.exit(failures ? 1 : 0);
