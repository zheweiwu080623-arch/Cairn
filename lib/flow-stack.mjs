// flow-stack.mjs —— 「能力搭建 / 功能 = 能力图」的接线层（M2 + M3）。
//
// 为什么单列一个文件：主程序有行数护栏（<2100 行），而这一套要接的东西有三样
// （能力宿主、模块目录、四个接口）。装在这里，主程序只留三行 —— 与 preclass / course /
// ddl / mcp 那几个 stack 同一个套路。

import { createFlowRoutes } from './routes/flows.mjs';

export function createFlowStack({
  sendJson, sendError, readBody, modulesDir,
  capabilities = null, log = () => {},
} = {}) {
  const routes = createFlowRoutes({
    sendJson, sendError, readBody, modulesDir, capabilities, log,
  });
  return { routes, listFlows: routes.listFlows };
}
