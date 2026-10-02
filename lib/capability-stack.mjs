// capability-stack.mjs —— 「能力层 + 能力搭建」的接线层（M1 · S3/S6 + M2/M3）。
//
// 为什么单列一个文件：主程序有行数护栏（<2100 行），而这一套要接的东西有两组
// （能力登记表的出口、能力图的执行与保存）。装在这里，主程序只留一行 ——
// 与 preclass / course / ddl / mcp 那几个 stack 同一个套路。

import { createCapabilityRoutes } from './routes/capabilities.mjs';
import { createFlowStack } from './flow-stack.mjs';

export function createCapabilityStack({
  sendJson, sendError, readBody, dataDir = '', modulesDir = '',
  listModules = () => [], capabilities = null, log = () => {},
} = {}) {
  // 能力层（M1 · S3/S6）：命令行 `cairn cap list`、可视化搭建、安装预览读的都是它；
  // 另外还管"给外部 agent 的工具表"与"调一条能力"（写类只回计划）。
  const routes = createCapabilityRoutes({
    sendJson, sendError, readBody, dataDir, listModules, capabilities,
  });
  // 能力搭建（M2/M3）：图执行 + 试跑 + 存成新功能 / 新能力
  const flows = createFlowStack({ sendJson, sendError, readBody, modulesDir, dataDir, capabilities, log });
  return { routes, flows };
}
