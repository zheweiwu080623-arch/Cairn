// mcp-server.mjs —— 让外部 AI agent（Qoder CN 等支持 MCP 的工具）能"问 Cairn 事情"。
//
// 2026-09-24 用户点名："针对这两个办公 agent 做特化兼容"。查证结果：
//   * **Qoder CN**：CLI 支持 **MCP**（Model Context Protocol）接入外部工具；
//   * **千问办公**：按"文件夹授权"读文件（另有单独的导出目录，见 lib/agent-export.mjs）。
// 所以这里把 Cairn 包成一个 **MCP 服务器**（stdio，一行一条 JSON-RPC 2.0 消息，**零依赖**）。
//
// 三条刻意的决定：
//   1) **只读**：所有工具只查不改 —— 不写库、不发通知、不推手机、绝不碰 Canvas 提交；
//   2) **不直接开数据库**：走本机 `http://127.0.0.1:3210` 的只读接口，
//      这样"永远只有一个进程写库"，也不会和正在运行的服务抢 SQLite；
//   3) **服务没起就说清楚**：报错信息里直接写"先把 Cairn 打开"，别丢一串英文。
//
// 2026-10-02（台阶 A/C）：除了下面这五个固定工具，**能力登记表本身也当工具表用** ——
// 工具清单从运行中的 Cairn 现取（`GET /api/capabilities/model-tools`），
// 调一条能力走 `POST /api/capabilities/invoke`。
//   4) **写类能力只回计划**：expose=tool_with_confirm 的能力（发通知 / 推手机 / 写文件 / 出巩固包）
//      调用**只会返回"本来会做什么"**，真正执行要用户在应用里确认 —— 这条由服务端保证，
//      不靠调用方自觉，也不靠提示词里写一句"请先确认"。

export const MCP_PROTOCOL_VERSION = '2024-11-05';
export const SERVER_INFO = { name: 'cairn', title: 'Cairn（空庭Coterie 的 Planner）', version: '0.1.0' };

/** 能力工具名的前缀（避免和上面五个固定工具撞名）。 */
export const CAP_PREFIX = 'cairn_cap_';

/** 把一个工具名还原成"要调的能力 id"（点分与下划线两种写法都认）。 */
export function capabilityIdFromMcpName(name) {
  const n = String(name || '');
  if (!n.startsWith(CAP_PREFIX)) return null;
  return n.slice(CAP_PREFIX.length);
}

/** 能力 id → MCP 工具名：点分换成下划线，加前缀（能力 id 里不许有下划线，所以不会撞）。 */
export function mcpNameForCapability(id) {
  return CAP_PREFIX + String(id || '').replace(/\./g, '_');
}

/** 五个只读工具：名字 / 说明 / 入参 schema。 */
export const MCP_TOOLS = [
  {
    name: 'cairn_today',
    description: '今天有什么：日程、今天到期与逾期的任务、待看的提醒（只读）。',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    path: () => '/api/mcp/today',
  },
  {
    name: 'cairn_tasks',
    description: '任务清单（默认只给未完成的），每条带倒计时与"下一次提醒"。可按关键词筛。',
    inputSchema: {
      type: 'object',
      properties: {
        status: { type: 'string', enum: ['open', 'done', 'all'], description: '默认 open' },
        q: { type: 'string', description: '关键词（匹配标题与备注）' },
        limit: { type: 'number', description: '最多几条，默认 30' },
      },
      additionalProperties: false,
    },
    path: (a = {}) => `/api/mcp/tasks?status=${encodeURIComponent(a.status || 'open')}&q=${encodeURIComponent(a.q || '')}&limit=${Number(a.limit) || 30}`,
  },
  {
    name: 'cairn_priority',
    description: '按"未来规划"排出的重要信息，每条带分数、档位与理由（只读）。',
    inputSchema: { type: 'object', properties: { top: { type: 'number', description: '默认 10' } }, additionalProperties: false },
    path: (a = {}) => `/api/mcp/priority?top=${Number(a.top) || 10}`,
  },
  {
    name: 'cairn_course_search',
    description: '在课程课件里找一段话（告诉你命中在哪份材料、第几段附近）。只读课件，不改任何文件。',
    inputSchema: {
      type: 'object',
      properties: { q: { type: 'string' }, course: { type: 'string', description: '只看某一门课，例如 MATH1860J' } },
      required: ['q'], additionalProperties: false,
    },
    path: (a = {}) => `/api/mcp/course/search?q=${encodeURIComponent(a.q || '')}&course=${encodeURIComponent(a.course || '')}`,
  },
  {
    name: 'cairn_packs',
    description: '列出 Cairn 已经生成的学习产物（资料索引 / 每周巩固包 …），或读其中一份的正文。',
    inputSchema: {
      type: 'object',
      properties: { name: { type: 'string', description: '不带就是列清单；带文件名就是读正文' } },
      additionalProperties: false,
    },
    path: (a = {}) => (a.name ? `/api/mcp/pack?name=${encodeURIComponent(a.name)}` : '/api/mcp/packs'),
  },
];

const textResult = (text) => ({ content: [{ type: 'text', text: String(text) }] });
const errorResult = (text) => ({ content: [{ type: 'text', text: String(text) }], isError: true });

/** 取数据（可注入 fetch，测试时不用起服务）。 */
async function fetchJson(baseUrl, path, { fetchImpl = globalThis.fetch, timeoutMs = 60000 } = {}) {
  const ctl = typeof AbortController === 'function' ? new AbortController() : null;
  const timer = ctl ? setTimeout(() => ctl.abort(), timeoutMs) : null;
  try {
    const r = await fetchImpl(`${baseUrl}${path}`, { signal: ctl ? ctl.signal : undefined });
    const body = await r.text();
    if (!r.ok) {
      let msg = body;
      try { msg = JSON.parse(body).error || body; } catch { /* 原文就是文本 */ }
      return { ok: false, status: r.status, error: String(msg).slice(0, 400) };
    }
    try { return { ok: true, data: JSON.parse(body) }; } catch { return { ok: false, error: '返回的不是 JSON' }; }
  } catch (e) {
    const m = (e && e.message) || String(e);
    if (/abort/i.test(m)) return { ok: false, error: `取数超时（${Math.round(timeoutMs / 1000)} 秒）` };
    return { ok: false, error: `连不上 Cairn 服务：${m}` };
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/** POST 一条 JSON（同样可注入 fetch）。写类能力的"要计划"也走这里 —— 服务端不会真执行。 */
async function postJson(baseUrl, path, body, { fetchImpl = globalThis.fetch, timeoutMs = 60000 } = {}) {
  const ctl = typeof AbortController === 'function' ? new AbortController() : null;
  const timer = ctl ? setTimeout(() => ctl.abort(), timeoutMs) : null;
  try {
    const r = await fetchImpl(`${baseUrl}${path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body || {}),
      signal: ctl ? ctl.signal : undefined,
    });
    const text = await r.text();
    let data = {};
    try { data = JSON.parse(text); } catch { data = { error: text }; }
    if (!r.ok) return { ok: false, status: r.status, error: data.error || text };
    return { ok: true, data };
  } catch (e) {
    const m = (e && e.message) || String(e);
    if (/abort/i.test(m)) return { ok: false, error: `调用超时（${Math.round(timeoutMs / 1000)} 秒）` };
    return { ok: false, error: `连不上 Cairn 服务：${m}` };
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/**
 * 从运行中的 Cairn 现取"能给模型用的能力表"，转成 MCP 工具。
 * 取不到就**只给固定工具**（如实降级，不编造一份能力表出来）。
 */
export async function capabilityTools(baseUrl, { fetchImpl = globalThis.fetch, timeoutMs = 4000 } = {}) {
  const r = await fetchJson(baseUrl, '/api/capabilities/model-tools', { fetchImpl, timeoutMs });
  if (!r.ok || !r.data || !Array.isArray(r.data.tools)) return { ok: false, tools: [], error: r.error || '能力表读不出来' };
  const tools = r.data.tools.map((t) => {
    const schema = t.inputSchema && typeof t.inputSchema === 'object' ? { ...t.inputSchema } : { type: 'object', properties: {} };
    if (!schema.type) schema.type = 'object';
    if (schema.additionalProperties === undefined) schema.additionalProperties = true;
    return {
      name: mcpNameForCapability(t.name),
      description: `${t.title}：${t.description}`,
      inputSchema: schema,
    };
  });
  return { ok: true, tools, count: r.data.count };
}

/** 把一次能力调用的结果写成人话（写类要**说清"这只是计划"**）。 */
export function formatCapabilityResult(body) {
  const b = body && typeof body === 'object' ? body : {};
  if (b.ok === false) return `调用失败：${b.error || '未知原因'}`;
  const id = b.id || '';
  if (b.requires_confirmation) {
    const L = [`［${id}］这一步是**写操作**，现在只产出计划、**还没有执行**：`];
    for (const a of b.planned || []) L.push(`- ${a.type}：${a.summary}${a.path ? ` → ${a.path}` : ''}`);
    if (!(b.planned || []).length) L.push('- （没有产生任何动作）');
    L.push('', '要真的执行，请在 Cairn 应用里确认（或让用户运行对应的功能）。');
    return L.join('\n');
  }
  const out = b.output;
  if (out === undefined || out === null) return `［${id}］执行完成（这条能力没有返回内容）。`;
  if (typeof out === 'string') return out;
  try { return JSON.stringify(out, null, 2).slice(0, 8000); } catch { return String(out); }
}

/** 人类可读的"给模型看"的文本（比丢一坨 JSON 更好用）。 */
export function formatToolText(name, data) {
  if (!data || typeof data !== 'object') return String(data || '（没有数据）');
  if (data.error) return `取数失败：${data.error}`;
  if (name === 'cairn_today') {
    const L = [`【${data.date}】${data.semester_week ? `学期第 ${data.semester_week} 周` : '（未设校历）'}`];
    L.push('', '日程：');
    L.push(...(data.events.length ? data.events.map((e) => `- ${String(e.start_at).slice(11, 16)} ${e.title}${e.location ? ` @${e.location}` : ''}`) : ['- （今天没有日程）']));
    if (data.overdue.length) { L.push('', '已逾期：'); L.push(...data.overdue.map((t) => `- ${t.title}（${t.countdown}）`)); }
    L.push('', '今天到期：');
    L.push(...(data.due_today.length ? data.due_today.map((t) => `- ${t.title}（${t.countdown}）`) : ['- （没有今天到期的）']));
    if (data.notifications.length) {
      L.push('', '待看的提醒：');
      L.push(...data.notifications.map((n) => `- ${n.title}${n.message ? `：${String(n.message).slice(0, 60)}` : ''}`));
    }
    return L.join('\n');
  }
  if (name === 'cairn_tasks') {
    if (!data.tasks.length) return '没有符合条件的任务。';
    return [`共 ${data.count} 条（最多显示 ${data.tasks.length} 条）：`]
      .concat(data.tasks.map((t) => `- [${t.status}] ${t.title}${t.due_at ? ` —— ${t.countdown}（截止 ${String(t.due_at).slice(0, 16).replace('T', ' ')}）` : ''}${t.next_reminder ? `，下一次提醒 ${t.next_reminder.label}` : ''}`))
      .join('\n');
  }
  if (name === 'cairn_priority') {
    if (!data.items || !data.items.length) return '现在没有排得上号的重要信息。';
    return data.items.map((x) => `- [${x.score} · ${x.band}] ${x.title}${x.reasons && x.reasons.length ? ` —— ${x.reasons[0]}` : ''}`).join('\n');
  }
  if (name === 'cairn_course_search') {
    if (!data.hits || !data.hits.length) return `没在课件里找到「${data.query || ''}」（它是逐字找的，不猜同义词）。`;
    return [`找到 ${data.hits.length} 处（翻了 ${data.scanned} 份材料）：`]
      .concat(data.hits.map((h) => `- ${h.course} / ${h.name}${h.where === '文件名' ? '（命中的是文件名）' : (h.segment ? `（第 ${h.segment} 段附近）` : '')}\n  ${String(h.context || '').slice(0, 160)}`))
      .join('\n');
  }
  if (name === 'cairn_packs') {
    if (data.content) return `# ${data.name}\n\n${String(data.content).slice(0, 8000)}`;
    if (data.ok === false) return `读不到：${data.error}`;
    if (!data.files || !data.files.length) return '还没有生成任何学习产物（在 Cairn 的「课程辅助」页生成资料索引或每周巩固包）。';
    return [`已有 ${data.count} 份（目录：${data.dir}）：`]
      .concat(data.files.map((f) => `- ${f.name}（${Math.round((f.size || 0) / 1024)} KB · ${String(f.mtime || '').slice(0, 16).replace('T', ' ')}）`))
      .join('\n');
  }
  return JSON.stringify(data, null, 2).slice(0, 8000);
}

/**
 * 处理一条 JSON-RPC 消息 → 返回要写回去的响应对象（通知类消息返回 null）。
 * 纯函数 + 注入 fetch，离线可测。
 */
export async function handleMessage(msg, { baseUrl = 'http://127.0.0.1:3210', fetchImpl = globalThis.fetch, clientProtocol = MCP_PROTOCOL_VERSION } = {}) {
  if (!msg || typeof msg !== 'object') return null;
  const { id, method, params } = msg;
  const isNotification = id === undefined || id === null;
  if (method === 'notifications/initialized' || method === 'initialized') return null;
  const ok = (result) => ({ jsonrpc: '2.0', id, result });
  const fail = (code, message) => ({ jsonrpc: '2.0', id, error: { code, message } });

  if (method === 'initialize') {
    const want = (params && params.protocolVersion) || clientProtocol;
    return ok({
      protocolVersion: want,                       // 跟着客户端说的版本来（最小实现，够用）
      capabilities: { tools: { listChanged: false } },
      serverInfo: SERVER_INFO,
      instructions: 'Cairn 的只读数据入口：今日 / 任务与 DDL / 重要信息 / 课件检索 / 已生成的学习产物。'
        + '另外还能调用 Cairn 的「能力」（cairn_cap_ 开头的工具）：读类能力直接返回结果；'
        + '带⚠️的写类能力**调用只会得到"计划"**，真正执行要用户在 Cairn 应用里确认。'
        + '它不会替你提交作业、不会写你的文件。要动数据请让用户在 Cairn 应用里操作。',
    });
  }
  if (method === 'ping') return ok({});
  if (method === 'tools/list') {
    const caps = await capabilityTools(baseUrl, { fetchImpl });
    return ok({ tools: MCP_TOOLS.map(({ name, description, inputSchema }) => ({ name, description, inputSchema })).concat(caps.tools) });
  }
  if (method === 'tools/call') {
    const name = (params && params.name) || '';
    const args = (params && params.arguments) || {};
    // 能力工具：走"调一条能力"的接口（写类在服务端就会被拦成"只给计划"）
    const capId = capabilityIdFromMcpName(name);
    if (capId) {
      const r = await postJson(baseUrl, '/api/capabilities/invoke', { id: capId, input: args }, { fetchImpl });
      if (!r.ok) {
        const hint = /连不上/.test(r.error || '') ? '（先把 Cairn 打开：托盘图标里启动，或者双击「启动桌面应用.cmd」）' : '';
        return ok(errorResult(`${r.error || '调用失败'}${hint}`));
      }
      return ok(textResult(formatCapabilityResult(r.data)));
    }
    const tool = MCP_TOOLS.find((t) => t.name === name);
    if (!tool) return ok(errorResult(`没有这个工具：${name}`));
    const r = await fetchJson(baseUrl, tool.path(args), { fetchImpl });
    if (!r.ok) {
      const hint = /连不上/.test(r.error || '') ? '（先把 Cairn 打开：托盘图标里启动，或者双击「启动桌面应用.cmd」）' : '';
      return ok(errorResult(`${r.error || '取数失败'}${hint}`));
    }
    return ok(textResult(formatToolText(name, r.data)));
  }
  if (isNotification) return null;
  return fail(-32601, `不支持的方法：${method}`);
}

/**
 * stdio 主循环：一行一条消息（MCP 的 stdio 传输就是这个形状）。
 * `input`/`output` 可注入，测试时用假流。
 */
export function serveStdio({ input = process.stdin, output = process.stdout, baseUrl = 'http://127.0.0.1:3210', fetchImpl = globalThis.fetch, log = () => {} } = {}) {
  let buf = '';
  const write = (obj) => output.write(`${JSON.stringify(obj)}\n`);
  input.setEncoding?.('utf8');
  input.on('data', (chunk) => {
    buf += chunk;
    let idx;
    while ((idx = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, idx).trim();
      buf = buf.slice(idx + 1);
      if (!line) continue;
      let msg = null;
      try { msg = JSON.parse(line); } catch (e) {
        write({ jsonrpc: '2.0', id: null, error: { code: -32700, message: `这一行不是合法 JSON：${(e && e.message) || e}` } });
        continue;
      }
      Promise.resolve(handleMessage(msg, { baseUrl, fetchImpl }))
        .then((resp) => { if (resp) write(resp); })
        .catch((e) => { if (msg && msg.id !== undefined) write({ jsonrpc: '2.0', id: msg.id, error: { code: -32603, message: String((e && e.message) || e) } }); });
    }
  });
  input.on?.('end', () => log('[mcp] 输入结束，退出'));
  return { write };
}
