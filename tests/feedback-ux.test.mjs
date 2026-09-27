// 「测试反馈」第二组（iv / iii / v）的回归守卫（2026-09-25 晚档）。
//
//   node tests/feedback-ux.test.mjs
//
//   iv  任务表的列错位（真 bug）：表头与每一行必须用**同一套列宽**，且每行固定 6 格 —— 少一格就左移错位；
//   iii 通知逐条开关：界面上真有开关、真的走 PATCH /api/notifications/:id、store 真的认 enabled；
//   v   任务排序两档：「智能（默认，原来的行为）」与「时间优先」，且界面只给这两档。

import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { tasksSelection } from '../public/viewmodel.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const app = readFileSync(join(ROOT, 'public', 'app.js'), 'utf8');
const css = readFileSync(join(ROOT, 'public', 'styles.css'), 'utf8');
const server = readFileSync(join(ROOT, 'server.mjs'), 'utf8');
const storeSrc = readFileSync(join(ROOT, 'lib', 'store.mjs'), 'utf8');

let failures = 0;
const ok = (label, cond, detail = '') => {
  if (cond) console.log(`  PASS ${label}`);
  else { failures += 1; console.log(`  FAIL ${label}${detail ? ` -- ${detail}` : ''}`); }
};

console.log('feedback-ux.test.mjs');

// ---------------- iv · 任务表列对齐 ----------------
{
  ok('表头用 .task-grid（列宽只定义一次）', /<div class="task-head task-grid">/.test(app));
  ok('每一行也用 .task-grid（与表头共用同一套列宽）', /class="list-item task-grid"/.test(app));
  ok('CSS 里那套列宽就是 6 列',
    /\.task-grid \{ display: grid; grid-template-columns: 20px 1fr 150px 90px 70px 80px;/.test(css));
  ok('第一列是固定宽度（20px）而不是 auto —— 表头那格是空的、行里是勾选框，'
    + 'auto 在各自独立的 grid 里会算出不同宽度（实测差 18px）',
    /grid-template-columns: 20px /.test(css) && !/grid-template-columns: auto /.test(css));
  ok('表头与行的左右内边距一致（差 2px 也会整列错开）',
    /\.task-head \{[^}]*padding: 4px 4px 10px;/.test(css) && /\.list-item\.task-grid \{ display: grid; padding-left: 4px;/.test(css));
  ok('.list-item.task-grid 覆盖了 .list-item 的 flex 排版（否则表头是格、行是流，必然错位）',
    /\.list-item\.task-grid \{ display: grid;/.test(css));
  ok('悬停不再改 padding-left（一动整行就跟着错位）',
    /#view-tasks \.list-item\.task-grid:hover \{ padding-left: 4px; \}/.test(css));
  ok('旧的"表头自己再写一份 inline grid"已删（两份定义迟早漂移）',
    !app.includes('grid-template-columns:auto 1fr 150px'));

  const row = /function taskRow\(t\) \{[\s\S]*?\n\}/.exec(app);
  const body = row ? row[0] : '';
  ok('找得到 taskRow', !!row);
  const cells = (body.match(/class="checkbox/g) || []).length
    + (body.match(/class="title task-cell/g) || []).length
    + (body.match(/class="task-cell"/g) || []).length
    + (body.match(/class="icon-btn"/g) || []).length;
  ok('每行固定 6 格：勾选 + 任务 + 截止 + 优先级 + 状态 + 删除', cells === 6, String(cells));
  ok('没填截止时间用「—」占位，绝不少一格', body.includes('<span class="dim">—</span>'));
  ok('状态栏不再是空的（以前表头有"状态"、行里却没有这一格）', /'已完成'/.test(body) && /'进行中'/.test(body) && /'待办'/.test(body));
}

// ---------------- iii · 通知逐条开关 ----------------
{
  ok('每一条通知都有开关', /<input type="checkbox" data-toggle-notif="\$\{n\.id\}" \$\{n\.enabled \? 'checked' : ''\}/.test(app));
  ok('开关旁边写着「提醒：开 / 关」', app.includes("'提醒：开'") && app.includes("'提醒：关'"));
  ok('开关带 title（说清关掉会怎样、还能再打开）', /data-toggle-notif[\s\S]{0,120}title="[^"]*不会再响[^"]*"/.test(app)
    || /class="notif-switch" title="[^"]*不会再响/.test(app));
  ok('点开关不会顺手打开编辑弹窗（stopPropagation）',
    /data-toggle-notif[\s\S]{0,400}e\.stopPropagation\(\)/.test(app));
  ok('走既有接口 PATCH /api/notifications/:id（没有新造接口）',
    app.includes("api('PATCH', `/api/notifications/${id}`, { enabled: next })"));
  ok('改失败会把开关拨回去（不骗人）', app.includes('c.checked = !next;'));
  ok('后端 PATCH 真的落到 updateNotification', /store\.updateNotification\(id, body\)/.test(server));
  ok('store 认 enabled 这个字段', /enabled: p\.enabled === undefined \? cur\.enabled/.test(storeSrc));

  // 真行为：在临时库里建一条 → 关掉 → 读回来（需要一个可写的临时目录：
  // run_all_suites.py 会设 PLANNER_TEST_TMP；直接手跑又没设且 %TEMP% 不可写时，这一段跳过）
  let tmp = '';
  try { tmp = mkdtempSync(join(process.env.PLANNER_TEST_TMP || tmpdir(), 'notif-toggle-')); } catch { tmp = ''; }
  if (!tmp) {
    console.log('  SKIP 临时目录不可写（没设 PLANNER_TEST_TMP）—— 逐条开关的"落库"那三条跳过');
  } else {
    process.env.PLANNER_DATA_DIR = tmp;                   // 必须在 import store 之前设
    const { store: st } = await import(pathToFileURL(join(ROOT, 'lib', 'store.mjs')).href);
    const n = st.createNotification({ title: '测试：逐条开关', trigger_at: new Date().toISOString() });
    // 注意：store 回出来的 enabled 是 SQLite 的 1/0（不是 true/false），界面按真假用；这里也按真假断言。
    ok('新建的提醒默认是开着的', !!(n && n.enabled), JSON.stringify(n && n.enabled));
    ok('关掉之后再读回来是关着的', !st.updateNotification(n.id, { enabled: false }).enabled);
    ok('再打开就恢复（随时能反悔）', !!st.updateNotification(n.id, { enabled: true }).enabled);
  }
}

// ---------------- v · 任务排序两档 ----------------
{
  const mk = (id, status, due) => ({ id, title: id, status, priority: 2, due_at: due });
  const tasks = [
    mk('a', 'done', '2026-09-21T10:00:00Z'),   // 做完的，但时间不算晚
    mk('b', 'todo', '2026-09-26T10:00:00Z'),
    mk('c', 'todo', null),                     // 没填截止时间
    mk('d', 'doing', '2026-09-20T10:00:00Z'),
  ];
  const ids = (sel) => sel.list.map((t) => t.id).join(',');
  const smart = tasksSelection({ tasks }, { filter: 'all', sort: 'smart' });
  const due = tasksSelection({ tasks }, { filter: 'all', sort: 'due' });

  ok('智能：没做完的在前、做完的沉底（组内按截止时间）', ids(smart) === 'd,b,c,a', ids(smart));
  ok('时间优先：严格按截止时间排，做完的留在原位', ids(due) === 'd,a,b,c', ids(due));
  ok('没填截止时间的排在（同一组里的）最后：智能组内 d,b,c、时间优先则整列最后',
    ids(smart) === 'd,b,c,a' && ids(due).endsWith('c'), `${ids(smart)} | ${ids(due)}`);
  ok('不传 sort 时就是原来的行为（默认智能）',
    ids(tasksSelection({ tasks }, { filter: 'all' })) === ids(smart));
  const noDone = { tasks: tasks.filter((t) => t.status !== 'done') };
  ok('没有已完成任务时，两档结果一样（差别只在"做完的沉不沉底"）',
    ids(tasksSelection(noDone, { filter: 'all', sort: 'smart' })) === ids(tasksSelection(noDone, { filter: 'all', sort: 'due' })));
  ok('返回体里带着 sort，方便上层回显', smart.sort === 'smart' && due.sort === 'due');

  ok('界面有三档：智能排序 / 轻重缓急 / 时间优先',
    app.includes('>智能排序<') && app.includes('>轻重缓急<') && app.includes('>时间优先<'));
  ok('下拉框带 title，说清两档的区别',
    /id="task-sort"[\s\S]{0,240}title="[^"]*智能排序[^"]*时间优先[^"]*"/.test(app));
  ok('这一次的选择记在浏览器里（下次打开还是这档）',
    app.includes("localStorage.setItem('planner-task-sort', state.taskSort)"));
  ok('脏值一律回落到智能（只认 due / balanced 两档）',
    /\['due', 'balanced'\]\.includes\(state\.taskSort\)/.test(app));
  ok('两条取数路径都支持 sort（app.js 与 viewmodel.js 各一份，等价性由 tasks-wiring 比对）',
    /function legacyTasksSelection\(filter, sort/.test(app)
    && readFileSync(join(ROOT, 'public', 'viewmodel.js'), 'utf8').includes('sort = \'smart\''));
}

console.log('');
console.log(failures === 0 ? 'feedback-ux.test: PASS' : `feedback-ux.test: FAIL (${failures})`);
process.exit(failures === 0 ? 0 : 1);
