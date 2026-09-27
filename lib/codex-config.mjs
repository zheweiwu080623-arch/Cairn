// codex-config.mjs —— 读本机 Codex 的模型配置（2026-09-22 新增）
//
// 为什么需要它：很多人的"agent"其实是**别的模型跑在 Codex 壳子里**
// （典型例子：`model_provider = "deepseek"`，指向本机一个中转地址，`wire_api = "responses"`）。
// 这种情况下：
//   * 本机**没有** `codex` 命令行 → 原来的 codex-cli 通道直接 ENOENT；
//   * 但那份配置里的地址 / 模型 / 令牌是现成可用的。
// 所以这里把它读出来，让平台**沿用同一套配置**，用户不用再粘一次 Key。
//
// 安全约定：
//   1. 令牌**只在本机、只在调用那一刻**从 config.toml 读出来用，**不复制进平台数据库**；
//   2. 任何对外的地方（接口 / 界面 / 日志 / 报错）都只能出现掩码（见 `maskToken`）；
//   3. 解析器是纯函数（`parseCodexConfig`），可以拿样例文本测，不碰真实文件。

import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

export const CODEX_CONFIG_FILE = 'config.toml';

/** 令牌只留末尾 4 位给界面看。 */
export function maskToken(token) {
  const s = String(token || '');
  return s ? `••••${s.slice(-4)}` : '';
}

/** 去掉值里的引号（支持单/双引号），并处理简单的 `\n`、`\"` 转义。 */
function unquote(v) {
  const s = String(v ?? '').trim();
  const m = /^(["'])([\s\S]*)\1$/.exec(s);
  const body = m ? m[2] : s;
  return body.replace(/\\n/g, '\n').replace(/\\(["'\\])/g, '$1');
}

/**
 * 极简 TOML 解析 —— **只**认我们关心的部分：
 *   `[section.sub]` 段头 / `key = "value"` / `key = 'value'` / 数字 / 被忽略的数组与注释。
 * 不去实现完整 TOML（那需要几千行），够用就好；解析不了的行走 `unknown` 计数，方便排查。
 */
export function parseCodexConfig(text) {
  const out = { top: {}, sections: {}, unknown: 0 };
  let section = null;
  for (const rawLine of String(text || '').split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    const head = /^\[([^\]]+)\]$/.exec(line);
    if (head) {
      section = head[1].trim();
      if (!Object.prototype.hasOwnProperty.call(out.sections, section)) out.sections[section] = {};
      continue;
    }
    const kv = /^([A-Za-z0-9_.-]+)\s*=\s*([\s\S]+)$/.exec(line);
    if (!kv) { out.unknown += 1; continue; }
    const key = kv[1];
    const rawValue = kv[2].trim();
    let value;
    if (rawValue.startsWith('[') || rawValue.startsWith('{')) continue;   // 数组 / 内联表：跳过
    else if (/^-?\d+$/.test(rawValue)) value = Number(rawValue);
    else if (rawValue === 'true' || rawValue === 'false') value = rawValue === 'true';
    else value = unquote(rawValue);
    const target = section ? out.sections[section] : out.top;
    target[key] = value;
  }
  return out;
}

/**
 * 从解析结果里找出"当前用的那个 provider"。
 * @returns {{id:string, name:string, base_url:string, wire_api:string, token:string, model:string}|null}
 */
export function resolveCodexProvider(parsed, { env = {} } = {}) {
  const top = parsed?.top || {};
  const sections = parsed?.sections || {};
  const id = String(top.model_provider || 'openai');
  // Codex 的写法是 [model_providers.<id>]
  let block = sections[`model_providers.${id}`] || sections[`model_providers."${id}"`];
  if (!block) {
    // 容错：只有一个 provider 段时就用它
    const keys = Object.keys(sections).filter((k) => k.startsWith('model_providers.'));
    if (keys.length === 1) block = sections[keys[0]];
  }
  if (!block) return null;
  const token = block.experimental_bearer_token
    || (block.env_key ? env[String(block.env_key)] : '')
    || '';
  return {
    id,
    name: String(block.name || id),
    base_url: String(block.base_url || '').replace(/\/+$/, ''),
    wire_api: String(block.wire_api || 'chat'),
    token: String(token || ''),
    model: String(top.model || ''),
  };
}

/** 读本机 Codex 配置（读不到就返回 null，绝不抛）。 */
export function readCodexConfig({ home = process.env.USERPROFILE || process.env.HOME || '', env = process.env } = {}) {
  try {
    if (!home) return null;
    const file = join(home, '.codex', CODEX_CONFIG_FILE);
    if (!existsSync(file)) return null;
    return parseCodexConfig(readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
}

/** 一步到位：配置 → 当前 provider（给 server 调用时用）。 */
export function resolveLocalProvider({ home, env } = {}) {
  const parsed = readCodexConfig({ home, env });
  if (!parsed) return null;
  return resolveCodexProvider(parsed, { env: env || process.env });
}

/** 对外的简要描述（**不含令牌**，只说明发现了什么）。 */
export function describeLocalProvider(p) {
  if (!p) return { found: false };
  return {
    found: true,
    id: p.id,
    name: p.name,
    model: p.model,
    wire_api: p.wire_api,
    has_token: Boolean(p.token),
    token_masked: maskToken(p.token),
    local: /^https?:\/\/(127\.0\.0\.1|localhost|\[::1\])/i.test(p.base_url),
  };
}
