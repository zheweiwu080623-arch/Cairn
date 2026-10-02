// 模型供应商注册表。
//
// **新增一家供应商只需要两步**：在 providers/ 里加一个文件（照 openai.mjs 抄），
// 然后在下面 REGISTRY 里加一行。`lib/llm.mjs` 里的拼请求、解析响应、
// 默认地址、可用性判断、下拉框选项全部由这张表驱动 —— 业务代码一行不用改。
//
// 每家的文件导出同一个形状：
//   { id, label, needs_key, defaults:{base_url,model},
//     build(ctx) -> {url,method,headers,body,images_ok} | null,   // null = 不走 HTTP
//     parse(json) -> string,
//     ready?(cfg) -> {ready,why},        // 可选：这家有特殊要求时才写
//     describe?(cfg) -> string }         // 可选：这家要特殊文案时才写

import anthropic from './anthropic.mjs';
import codexCli from './codex-cli.mjs';
import codexConfig from './codex-config.mjs';
import ollama from './ollama.mjs';
import openai from './openai.mjs';

/** 顺序 = 界面上下拉框的顺序（与原 LLM_PROVIDERS 保持一致，避免沿用他人配置时行为变化）。 */
export const REGISTRY = [codexCli, codexConfig, openai, anthropic, ollama];

const BY_ID = new Map(REGISTRY.map((p) => [p.id, p]));

export function getProvider(id) {
  return BY_ID.get(String(id)) || null;
}

export function providerIds() {
  return REGISTRY.map((p) => p.id);
}

/** 老接口 PROVIDER_DEFAULTS 的形状：{ [id]: { base_url, model, needs_key, label } }。 */
export function providerDefaults() {
  const out = {};
  for (const p of REGISTRY) {
    out[p.id] = { base_url: p.defaults.base_url, model: p.defaults.model, needs_key: p.needs_key, label: p.label };
  }
  return out;
}
