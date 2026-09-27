// credential-mask.mjs —— 凭据脱敏（R2：从 server.mjs 拆出来的第三组之一）
//
// 起因（2026-09-16）：`/api/connectors` 与 `/api/state` 曾经把已保存的凭据
// （Canvas Token / 邮箱密码 / 飞书 App Secret / Bark 密钥 / iCloud App 专用密码）**明文回显**，
// 本机任何脚本读一次接口就能拿到。
//
// 现在的规则（三条，缺一不可）：
//   1. **读的一律给掩码** `••••1234`（保留末四位，方便你确认"填的是哪一个"）；
//   2. **写的时候带掩码回来 → 沿用已存的真值**（否则掩码会被当成新密码存进去）；
//   3. **密码框留空也算"没改"** —— 浏览器会把 `type=password` 的预填值清空，
//      "空"并不代表用户想删掉凭据。只认"用户真的敲了新值"才覆盖。
//
// 这个文件被单独拿出来的原因：它是**安全边界**，应该有一个能单独审阅的地方。

import { getConnector } from './connectors/index.mjs';

export const MASK_PREFIX = '••••';
/** 字段名像不像凭据（token / secret / password / apikey…）。 */
export const SECRET_KEY_RE = /(token|secret|password|passwd|pass|apikey|appkey)$/i;
/** 手机通道里需要脱敏的键（Bark 推送密钥 / iCloud App 专用密码）。 */
export const MOBILE_SECRET_KEYS = ['bark_key', 'icloud_pass'];

/** 某个数据源里哪些字段属于凭据（看它自己的字段定义 + 字段名）。 */
export function connectorSecretKeys(source, { metaOf = (s) => getConnector(s) } = {}) {
  const keys = new Set();
  try {
    for (const f of metaOf(source)?.meta?.fields || []) {
      if (f && f.key && (String(f.type).toLowerCase() === 'password' || SECRET_KEY_RE.test(f.key))) keys.add(f.key);
    }
  } catch { /* 元信息拿不到就只按字段名判断 */ }
  return keys;
}

/** 单个值 → 掩码。 */
export function maskSecretValue(v) {
  const s = v == null ? '' : String(v);
  return s ? `${MASK_PREFIX}${s.length > 4 ? s.slice(-4) : ''}` : s;
}

/** 写入时要不要沿用已存的真值？（见文件头规则 2、3） */
export function shouldKeepStoredSecret(incoming, stored) {
  if (stored == null || String(stored) === '') return false;
  const s = incoming == null ? '' : String(incoming);
  return s === '' || s.startsWith(MASK_PREFIX) || s === maskSecretValue(stored);
}

/** 一份数据源配置 → 可以安全回给界面的版本。 */
export function maskConnectorConfig(source, config, opts = {}) {
  if (!config || typeof config !== 'object') return config;
  const keys = connectorSecretKeys(source, opts);
  const out = { ...config };
  for (const k of Object.keys(out)) {
    if (keys.has(k) || SECRET_KEY_RE.test(k)) out[k] = maskSecretValue(out[k]);
  }
  return out;
}

/** 同上，但输入输出都是 JSON 字符串（数据库里存的就是字符串）。 */
export function maskConfigJson(source, configJson, opts = {}) {
  try { return JSON.stringify(maskConnectorConfig(source, JSON.parse(configJson || '{}'), opts)); } catch { return configJson; }
}

/** 界面提交的配置（可能带掩码）+ 已存的真值 → 真正要保存的配置。 */
export function unmaskConnectorConfig(source, incoming, stored, opts = {}) {
  const out = { ...(incoming || {}) };
  const keys = connectorSecretKeys(source, opts);
  for (const k of Object.keys(out)) {
    if (!(keys.has(k) || SECRET_KEY_RE.test(k))) continue;
    if (shouldKeepStoredSecret(out[k], stored?.[k])) out[k] = stored[k];
  }
  return out;
}

/** 手机通道的偏好设置 → 脱敏版。 */
export function maskMobilePrefs(prefs) {
  if (!prefs || typeof prefs !== 'object') return prefs;
  const out = { ...prefs };
  for (const k of MOBILE_SECRET_KEYS) if (out[k]) out[k] = maskSecretValue(out[k]);
  return out;
}

/** 把「原样带回来的掩码」从待保存的 patch 里删掉，只保留用户真正改动过的值。 */
export function sanitizeMobilePatch(patch, before) {
  const out = { ...(patch || {}) };
  for (const k of MOBILE_SECRET_KEYS) {
    if (out[k] === undefined) continue;
    if (shouldKeepStoredSecret(out[k], before?.[k])) delete out[k];
  }
  return out;
}
