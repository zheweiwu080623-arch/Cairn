#!/usr/bin/env node
// cairn-mcp —— 把 Cairn 作为 **MCP 服务器**跑起来（stdio），给 Qoder CN 这类支持 MCP 的工具用。
//
// 用法（在 Qoder 的 MCP 配置里填这三行就够；详见 docs/CONNECT_AGENTS.md）：
//   { "mcpServers": { "cairn": { "command": "node", "args": ["<仓库路径>/bin/cairn-mcp.mjs"] } } }
//
// 只读：它只会去问本机 `http://127.0.0.1:3210` 的只读接口，不会写库、不会发通知、不会提交作业。
// 所以 **用之前请先把 Cairn 打开**（服务在跑，MCP 才有东西可答）。

import { MCP_PROTOCOL_VERSION, SERVER_INFO, serveStdio } from '../lib/mcp-server.mjs';

const args = process.argv.slice(2);
if (args.includes('--help') || args.includes('-h')) {
  process.stdout.write([
    'cairn-mcp —— 让外部 AI agent（Qoder CN 等）通过 MCP 读 Cairn 的数据',
    '',
    '用法：node bin/cairn-mcp.mjs [--base http://127.0.0.1:3210] [--selftest]',
    '',
    '它按 MCP 的 stdio 传输工作（一行一条 JSON-RPC 2.0 消息），由支持 MCP 的工具启动，',
    '不用手动运行。工具清单：今日 / 任务与 DDL / 重要信息 / 课件检索 / 已生成的学习产物。',
    `协议版本：${MCP_PROTOCOL_VERSION} · 服务名：${SERVER_INFO.name}`,
    '',
  ].join('\n'));
  process.exit(0);
}

const baseArg = args.indexOf('--base');
const baseUrl = baseArg >= 0 && args[baseArg + 1] ? String(args[baseArg + 1]) : 'http://127.0.0.1:3210';

if (args.includes('--selftest')) {
  // 离线自检：只验证"协议层说得通"，不去连服务（换台机器也能跑）
  const { handleMessage } = await import('../lib/mcp-server.mjs');
  const init = await handleMessage({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: MCP_PROTOCOL_VERSION } });
  const list = await handleMessage({ jsonrpc: '2.0', id: 2, method: 'tools/list' });
  const missing = await handleMessage({ jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: '不存在', arguments: {} } });
  const lines = [
    `协议握手：${init && init.result ? `OK（${init.result.protocolVersion}）` : '失败'}`,
    `工具清单：${list && list.result ? `OK（${list.result.tools.map((t) => t.name).join(' / ')}）` : '失败'}`,
    `未知工具：${missing && missing.result && missing.result.isError ? 'OK（如实报错）' : '失败'}`,
    `目标服务：${baseUrl}`,
    '（自检不联网、不读写任何数据）',
  ];
  process.stdout.write(`${lines.join('\n')}\n`);
  process.exit(init && init.result && list && list.result ? 0 : 1);
}

serveStdio({ baseUrl, log: (m) => process.stderr.write(`${m}\n`) });
