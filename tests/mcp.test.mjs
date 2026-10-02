// 给外部 AI agent 的只读入口（2026-09-24）：MCP 协议层 + 只读数据接口。
//
//   node tests/mcp.test.mjs
//
// 不起服务、不联网：协议层用假 fetch，数据层用假 store。

import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { MCP_PROTOCOL_VERSION, MCP_TOOLS, SERVER_INFO, formatToolText, handleMessage, serveStdio } from '../lib/mcp-server.mjs';
import { buildAgentFiles, writeAgentFiles } from '../lib/agent-export.mjs';
import { createMcpRoutes } from '../lib/routes/mcp.mjs';
import { createMcpStack } from '../lib/mcp-stack.mjs';

let failures = 0;
const ok = (label, cond, detail = '') => {
  if (cond) console.log(`  PASS ${label}`);
  else { failures += 1; console.log(`  FAIL ${label}${detail ? ` -- ${detail}` : ''}`); }
};

console.log('mcp.test.mjs');
const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const H = 3600000;
const NOW = new Date(2026, 8, 24, 14, 0).getTime();
const iso = (ms) => new Date(ms).toISOString();

// ---------------- 1. 协议层（MCP 最小子集） ----------------
{
  const init = await handleMessage({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: MCP_PROTOCOL_VERSION, clientInfo: { name: 'qoder', version: '1' } } });
  ok('initialize：回协议版本 + 工具能力 + 服务名',
    init && init.result && init.result.protocolVersion === MCP_PROTOCOL_VERSION
    && init.result.capabilities.tools && init.result.serverInfo.name === SERVER_INFO.name);
  ok('initialize：带一句给模型的边界说明（只读、不提交作业）',
    typeof init.result.instructions === 'string' && init.result.instructions.includes('只读') && init.result.instructions.includes('提交作业'));
  ok('客户端报别的版本时跟着它走（最小实现，够用）',
    (await handleMessage({ jsonrpc: '2.0', id: 2, method: 'initialize', params: { protocolVersion: '2025-06-18' } })).result.protocolVersion === '2025-06-18');
  ok('ping → 空结果', JSON.stringify((await handleMessage({ jsonrpc: '2.0', id: 3, method: 'ping' })).result) === '{}');
  ok('initialized 通知不回复', (await handleMessage({ jsonrpc: '2.0', method: 'notifications/initialized' })) === null);
  // 这一句必须喂假 fetch：本文件的地基是"不起服务、不联网"。以前漏了 fetchImpl，
  // 于是**本机 Cairn 恰好在跑**时，tools/list 会顺带取到运行时能力表（工具数变多）→ 时红时绿。
  const offline = async () => { throw new Error('不联网'); };
  const list = await handleMessage({ jsonrpc: '2.0', id: 4, method: 'tools/list' }, { fetchImpl: offline });
  ok('tools/list 给 5 个固定只读工具，都带 name/description/inputSchema（不联网时只有这 5 个）',
    list.result.tools.length === 5 && list.result.tools.every((t) => t.name && t.description && t.inputSchema && t.inputSchema.type === 'object'),
    `实际 ${list.result.tools.length} 个`);
  ok('tools/list：服务开着时会额外带上运行时能力表（假 fetch 给一份就认得出来）',
    (await handleMessage({ jsonrpc: '2.0', id: 41, method: 'tools/list' },
      { fetchImpl: async () => ({ ok: true, status: 200, text: async () => JSON.stringify({ tools: [{ name: 'csv.parse', description: 'x', inputSchema: { type: 'object' } }] }) }) })
    ).result.tools.length === 6);
  ok('工具名都带 cairn_ 前缀（免得和别的服务器撞名）',
    list.result.tools.every((t) => t.name.startsWith('cairn_')),
    JSON.stringify(list.result.tools.map((t) => t.name)));
  ok('不支持的方法 → JSON-RPC 错误码 -32601',
    (await handleMessage({ jsonrpc: '2.0', id: 5, method: 'resources/list' })).error.code === -32601);
  ok('未知工具 → 内容里如实报错（不是协议错误）',
    (await handleMessage({ jsonrpc: '2.0', id: 6, method: 'tools/call', params: { name: 'nope' } })).result.isError === true);
}

// ---------------- 2. 工具取数（假 fetch） ----------------
{
  const sample = { schema: 'mcp.today.v1', date: '2026-09-24', semester_week: 2, events: [{ title: '高等数学', start_at: iso(NOW + H) }], due_today: [{ title: '作业1', countdown: '还有 9 小时' }], overdue: [], notifications: [{ title: '提醒一件事' }] };
  const fake = async (url) => ({ ok: true, status: 200, text: async () => JSON.stringify(sample) });
  const r = await handleMessage({ jsonrpc: '2.0', id: 7, method: 'tools/call', params: { name: 'cairn_today', arguments: {} } }, { fetchImpl: fake });
  ok('cairn_today：调的是 /api/mcp/today', r.result && r.result.content[0].type === 'text');
  ok('cairn_today：把数据说成人话（日期/日程/逾期/今天到期）',
    r.result.content[0].text.includes('2026-09-24') && r.result.content[0].text.includes('高等数学')
    && r.result.content[0].text.includes('作业1'), r.result.content[0].text.slice(0, 120));
}
{
  const seen = [];
  const fake = async (url) => { seen.push(url); return { ok: true, status: 200, text: async () => '{"tasks":[],"count":0}' }; };
  await handleMessage({ jsonrpc: '2.0', id: 8, method: 'tools/call', params: { name: 'cairn_tasks', arguments: { status: 'open', q: '数学', limit: 5 } } }, { fetchImpl: fake });
  ok('cairn_tasks：把参数带进查询串（URL 编码过）',
    seen[0].includes('/api/mcp/tasks?') && seen[0].includes(encodeURIComponent('数学')) && seen[0].includes('limit=5'), seen[0]);
  const fake2 = async (url) => { seen.push(url); return { ok: true, status: 200, text: async () => '{"hits":[]}' }; };
  await handleMessage({ jsonrpc: '2.0', id: 9, method: 'tools/call', params: { name: 'cairn_course_search', arguments: { q: 'Taylor' } } }, { fetchImpl: fake2 });
  ok('cairn_course_search：走课件检索那条只读接口', String(seen[1]).includes('/api/mcp/course/search?q=Taylor'), String(seen[1]));
}
{
  const down = async () => { throw new Error('fetch failed'); };
  const r = await handleMessage({ jsonrpc: '2.0', id: 10, method: 'tools/call', params: { name: 'cairn_today', arguments: {} } }, { fetchImpl: down });
  ok('服务没开 → 如实说连不上，并告诉人怎么办',
    r.result.isError === true && r.result.content[0].text.includes('连不上') && r.result.content[0].text.includes('先把 Cairn 打开'),
    r.result.content[0].text.slice(0, 120));
}
{
  const bad = async () => ({ ok: false, status: 500, text: async () => JSON.stringify({ error: '这台机器上没有可用的课件搜索' }) });
  const r = await handleMessage({ jsonrpc: '2.0', id: 11, method: 'tools/call', params: { name: 'cairn_course_search', arguments: { q: 'x' } } }, { fetchImpl: bad });
  ok('接口报错 → 把它的原话带出来（不吞错）', r.result.isError === true && r.result.content[0].text.includes('没有可用的课件搜索'));
}

// ---------------- 3. "说人话"的格式化 ----------------
{
  const t = formatToolText('cairn_tasks', { count: 2, tasks: [
    { title: '数学作业', status: 'todo', due_at: iso(NOW + 24 * H), countdown: '还有 1 天 10 小时', next_reminder: { label: '还剩 1 天' } },
    { title: '没有截止的', status: 'todo', due_at: null },
  ] });
  ok('任务格式化：带倒计时与下一次提醒', t.includes('数学作业') && t.includes('还有 1 天 10 小时') && t.includes('还剩 1 天'));
  ok('任务格式化：没有截止时间也不显示 NaN/undefined', !t.includes('undefined') && !t.includes('NaN'));
  ok('重要性格式化：带分数、档位与第一条理由',
    formatToolText('cairn_priority', { items: [{ title: 'X', score: 88, band: 'high', reasons: ['和你写的规划直接相关'] }] })
      .includes('[88 · high]') );
  ok('课件搜索格式化：说明命中在哪份材料、第几段',
    formatToolText('cairn_course_search', { query: 'Taylor', scanned: 64, hits: [{ course: 'MATH1860J', name: 'rc1.pdf', segment: 2, context: 'Taylor expansion' }] })
      .includes('rc1.pdf') && formatToolText('cairn_course_search', { scanned: 64, hits: [{ course: 'A', name: 'b.pdf', where: '文件名', context: 'x' }] }).includes('命中的是文件名'));
  ok('搜不到就说搜不到（不编）',
    formatToolText('cairn_course_search', { query: '量子', scanned: 64, hits: [] }).includes('没在课件里找到'));
  ok('产物清单格式化：没有就说"还没有生成"',
    formatToolText('cairn_packs', { files: [] }).includes('还没有生成'));
}

// ---------------- 4. stdio 循环（假流） ----------------
{
  const out = [];
  const listeners = {};
  const input = {
    setEncoding() {},
    on(ev, fn) { listeners[ev] = fn; },
  };
  const output = { write: (s) => out.push(String(s)) };
  serveStdio({ input, output, baseUrl: 'http://x', fetchImpl: async () => ({ ok: true, status: 200, text: async () => '{}' }), log: () => {} });
  listeners.data(`${JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'ping' })}\n不是 JSON\n${JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/list' })}\n`);
  await new Promise((r) => setTimeout(r, 30));
  const parsed = out.join('').trim().split('\n').map((l) => JSON.parse(l));
  ok('stdio：三条消息对应三条回复（含一条"不是合法 JSON"的如实报错）', parsed.length === 3, JSON.stringify(parsed.map((p) => p.id)));
  ok('stdio：坏行回 -32700，好行正常回', parsed.some((p) => p.error && p.error.code === -32700) && parsed.some((p) => p.id === 2 && p.result));
}

// ---------------- 5. 只读数据接口（假 store） ----------------
const store = {
  getSync: () => null,
  listEvents: () => [{ id: 'e1', title: '高等数学', start_at: iso(NOW + H), end_at: iso(NOW + 3 * H), all_day: 0 }],
  listTasks: () => ([
    { id: 't1', title: '明天交的作业', status: 'todo', due_at: iso(NOW + 24 * H), priority: 1 },
    { id: 't2', title: '昨天的作业', status: 'todo', due_at: iso(NOW - H), priority: 0 },
    { id: 't3', title: '今天到期', status: 'todo', due_at: iso(NOW + 5 * H), priority: 2 },
    { id: 't4', title: '做完了', status: 'done', due_at: iso(NOW - 2 * H), priority: 2 },
  ]),
  listNotifications: () => [{ id: 'n1', title: '提醒', message: '内容', trigger_at: iso(NOW), enabled: 1, source: 'app' }],
  listAcademic: () => [{ id: 'a1', kind: 'term', start_at: iso(NOW - 8 * 86400000) }],
};
const routes = createMcpRoutes({
  store, now: () => NOW,                       // 固定时钟：否则"今天到期"会随真实时间漂移（2026-09-24 实测踩到）
  sendJson: (res, code, obj) => { res.code = code; res.body = obj; },
  sendError: (res, code, message) => { res.code = code; res.body = { error: message }; },
  dataDir: 'C:\\数据',
  priority: { computePriority: () => ({ result: { ranked: [{ item: { title: '重要的事', source: 'canvas' }, score: 88, band: 'high', reasons: [{ note: '和你的规划相关' }] }] }, advice: '先做这个' }) },
  course: { search: (q) => ({ ok: true, query: q, scanned: 3, hits: [{ course: 'MATH1860J', name: 'rc1.pdf', segment: 1, context: 'x' }] }) },
  listStudyFiles: () => [{ name: 'week-2-巩固.md', size: 4000, mtime: iso(NOW) }],
  readStudyFile: (n) => (n === 'week-2-巩固.md' ? { ok: true, name: n, content: '# 第 2 周巩固包' } : { ok: false, name: n, error: '没有这个文件' }),
});
const req = (method) => ({ method });
const urlOf = (p) => new URL('http://127.0.0.1:3210' + p);
const call = async (p, method = 'GET') => { const res = {}; await routes.handleMcp(req(method), res, urlOf(p)); return res; };

{
  const r = await call('/api/mcp/today');
  ok('today：日程 / 今天到期 / 逾期 / 提醒都分好了类',
    r.code === 200 && r.body.events.length === 1 && r.body.due_today.length === 1
    && r.body.overdue.length === 1 && r.body.notifications.length === 1 && r.body.semester_week === 2);
  ok('today：带 schema 与时间戳（外部 agent 好解析）', r.body.schema === 'mcp.today.v1' && !!r.body.at);
}
{
  const r = await call('/api/mcp/tasks?status=open&q=作业');
  ok('tasks：默认只给未完成、能按关键词筛、带倒计时',
    r.code === 200 && r.body.tasks.length === 2
    && r.body.tasks.every((t) => t.countdown && t.status !== 'done'),
    JSON.stringify(r.body.tasks.map((t) => t.title)));
  ok('tasks：还没到期的带"下一次提醒"；已逾期的没有（它已经没有下一次了）',
    r.body.tasks[0].level === 'overdue' && r.body.tasks[0].next_reminder === null
    && r.body.tasks[1].next_reminder && /还剩/.test(r.body.tasks[1].next_reminder.label),
    JSON.stringify(r.body.tasks.map((t) => [t.level, t.next_reminder && t.next_reminder.label])));
  ok('tasks：按截止时间从近到远（逾期在最前）', r.body.tasks[0].title === '昨天的作业', r.body.tasks[0].title);
  const done = await call('/api/mcp/tasks?status=done');
  ok('tasks：可以只看做完的', done.body.tasks.length === 1 && done.body.tasks[0].title === '做完了');
}
{
  const r = await call('/api/mcp/priority?top=3');
  ok('priority：带分数 / 档位 / 理由 / 建议',
    r.code === 200 && r.body.items[0].score === 88 && r.body.items[0].reasons[0] === '和你的规划相关' && r.body.advice === '先做这个');
}
{
  const r = await call('/api/mcp/packs');
  ok('packs：列出已生成的学习产物', r.code === 200 && r.body.count === 1 && r.body.files[0].name === 'week-2-巩固.md');
  const one = await call('/api/mcp/pack?name=week-2-%E5%B7%A9%E5%9B%BA.md');
  ok('pack：能读一份的正文', one.code === 200 && String(one.body.content).includes('第 2 周巩固包'));
  const bad = await call('/api/mcp/pack?name=..%2F..%2Fsecret.txt');
  ok('pack：文件名不合法就拒绝（挡目录穿越）', bad.body.ok === false && String(bad.body.error).includes('不合法'));
}
{
  const r = await call('/api/mcp/course/search?q=Taylor');
  ok('course/search：透传课件检索结果', r.code === 200 && r.body.hits.length === 1);
  const empty = await call('/api/mcp/course/search');
  ok('course/search：不给关键词 → 400 且说清要什么', empty.code === 400 && empty.body.error.includes('q='));
}
ok('这些接口**只读**：用 POST 会被挡回去（405）', (await call('/api/mcp/today', 'POST')).code === 405);
ok('不认识的路径 → 404', (await call('/api/mcp/别的')).code === 404);

// ---------------- 5.5 给办公 AI 的导出目录（千问办公那条路） ----------------
{
  const files = buildAgentFiles({
    generatedAt: '2026-09-24T05:30:00.000Z',
    today: {
      date: '2026-09-24', semester_week: 2,
      events: [{ title: '高等数学', start_at: iso(NOW), end_at: iso(NOW + 2 * H), location: 'LBL326C' }],
      overdue: [{ title: '昨天的作业', countdown: '已逾期 3 小时' }],
      due_today: [{ title: '今天的作业', countdown: '还有 5 小时' }],
      notifications: [{ title: '提醒一件事', message: '内容' }],
    },
    tasks: { count: 1, tasks: [{ title: '明天的作业', status: 'todo', due_at: iso(NOW + 24 * H), countdown: '还有 1 天', next_reminder: { label: '还剩 1 天' } }] },
    priority: { items: [{ title: '重要条目', score: 88, band: 'high', reasons: ['和规划相关'] }], advice: '先做它' },
    packs: { dir: 'C:\\数据\\study', files: [{ name: 'week-2-巩固.md', size: 4096, mtime: iso(NOW) }] },
  });
  ok('导出目录含六份文件（含 README 与机器可读 manifest）',
    Object.keys(files).length === 6 && !!files['README-给办公AI看.md'] && !!files['manifest.json'], JSON.stringify(Object.keys(files)));
  ok('README 第一句就说清"只读、别改"', files['README-给办公AI看.md'].includes('请只读，不要修改或删除'));
  ok('今日.md 把日程/逾期/今天到期/提醒都写清了',
    files['今日.md'].includes('高等数学') && files['今日.md'].includes('已逾期 3 小时') && files['今日.md'].includes('还有 5 小时'));
  ok('任务与DDL.md 是表格，带倒计时与下一次提醒',
    files['任务与DDL.md'].includes('| 任务 |') && files['任务与DDL.md'].includes('还剩 1 天'));
  ok('重要信息.md 带分数、档位与理由', files['重要信息.md'].includes('| 88 | high |') && files['重要信息.md'].includes('和规划相关'));
  ok('manifest.json 可解析，且写明只读 + 字段说明',
    (() => { const m = JSON.parse(files['manifest.json']); return m.read_only === true && !!m.fields.countdown && m.counts.events === 1; })());
  ok('导出内容是结论不是原始数据（没有凭据字段）',
    !/password|token|secret|api[_-]?key/i.test(files['manifest.json'] + files['任务与DDL.md']));
  ok('没有数据时也给人话（不是空表）',
    buildAgentFiles({})['任务与DDL.md'].includes('没有未完成的任务')
    && buildAgentFiles({})['学习产物索引.md'].includes('还没有生成学习产物'));
}
{
  // 临时目录必须落在临时目录里：以前退到 '.'（= 仓库根），每跑一次就在仓库里留下一个
  // agent-export-<时间戳>/ 目录 —— 本地跑几次就攒几个，CI 也会把检出目录弄脏。
  const dir = mkdtempSync(join(process.env.PLANNER_TEST_TMP || tmpdir(), 'cairn-agent-export-'));
  const w = writeAgentFiles(dir, { 'a.md': '# A\n', 'b.json': '{}\n' });
  ok('落盘：返回写了哪几个、各多少字节', w.ok === true && w.written.length === 2 && w.written[0].bytes > 0);
  ok('落盘：文件真的在那儿（能读回来）', readFileSync(join(dir, 'a.md'), 'utf8') === '# A\n');
}
{
  const stack = createMcpStack({
    store, dataDir: 'C:\\数据', priority: null, course: null, log: () => {},
    sendJson: (res, code, obj) => { res.code = code; res.body = obj; },
    sendError: (res, code, message) => { res.code = code; res.body = { error: message }; },
    readBody: async (r) => r.body || {},
  });
  const urlOf2 = (p) => new URL('http://127.0.0.1:3210' + p);
  const res1 = {};
  await stack.handleAgentExport({ method: 'GET' }, res1, urlOf2('/api/agent-export'));
  ok('GET /api/agent-export 给目录与文件清单',
    res1.code === 200 && res1.body.dir.includes('for-agents') && res1.body.files.includes('今日.md'));
  const res2 = {};
  await stack.handleAgentExport({ method: 'POST', body: {} }, res2, urlOf2('/api/agent-export'));
  ok('POST 默认演练：只说会写什么，不落盘', res2.code === 200 && res2.body.dry_run === true && res2.body.would_write.length === 6);
  const res3 = {};
  await stack.handleAgentExport({ method: 'GET' }, res3, urlOf2('/api/agent-export/别的'));
  ok('不认识的路径 → 404', res3.code === 404);
}

// ---------------- 6. 接线与文档守卫 ----------------
{
  const srv = readFileSync(join(ROOT, 'server.mjs'), 'utf8');
  const mcpSrc = readFileSync(join(ROOT, 'lib', 'mcp-server.mjs'), 'utf8');
  const binSrc = readFileSync(join(ROOT, 'bin', 'cairn-mcp.mjs'), 'utf8');
  const routeSrc = readFileSync(join(ROOT, 'lib', 'routes', 'mcp.mjs'), 'utf8');
  ok('主程序接上了 /api/mcp/*（一行接线）', srv.includes('createMcpStack') && srv.includes("p.startsWith('/api/mcp/')"));
  ok('MCP 服务器是零依赖的（只用内置能力）', !/from '(?!node:|\.\.?\/)/.test(mcpSrc));
  ok('MCP 服务器**不直接开数据库**（走本机只读接口，避免两个进程写库）',
    !mcpSrc.includes('store.mjs') && mcpSrc.includes('127.0.0.1'));
  // 2026-10-02（台阶 A/C）：MCP 现在也把"能力表"当工具表 —— 写类能力会出现，
  // 但**调用只会得到计划**。所以守卫改成守"它自己不写"：不开库、不写文件、不直接建通知，
  // 而且只允许一个 POST 出口（那条口正是"只给计划"的 /api/capabilities/invoke）。
  ok('MCP 层自己不写任何东西（不开库 / 不写文件 / 不建通知）',
    !mcpSrc.includes('store.mjs') && !/createNotification|barkNotify|writeFileSync/.test(mcpSrc)
    && !/method:\s*'POST'|createNotification/.test(routeSrc));
  ok('写类能力只走"要计划"那一个口（POST 只允许打到 /api/capabilities/invoke）',
    (mcpSrc.match(/method: 'POST'/g) || []).length === 1 && mcpSrc.includes("'/api/capabilities/invoke'"));
  ok('CLI 有 --selftest（换台机器也能自检）与 --help', binSrc.includes('--selftest') && binSrc.includes('--help'));
  ok('文档里给了 Qoder 的 MCP 配置写法', readFileSync(join(ROOT, 'docs', 'CONNECT_AGENTS.md'), 'utf8').includes('mcpServers'));
  ok('主程序行数护栏内', srv.split('\n').length < 2200, String(srv.split('\n').length));
  ok('工具定义与实现一一对应（不会列出用不了的工具）',
    MCP_TOOLS.every((t) => t.name && typeof t.path === 'function'));
}

console.log('');
console.log(failures === 0 ? 'mcp.test: PASS' : `mcp.test: FAIL (${failures})`);
process.exit(failures === 0 ? 0 : 1);
