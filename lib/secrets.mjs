// 凭据加密（W4-1）：让数据库文件里不再出现明文口令。
//
// 背景：连接器配置（Canvas Token / 邮箱授权码 / 飞书 App Secret）与手机推送密钥
// 原先都**明文**存在 SQLite 里。任何能读到 data/ 的人（备份、误传、别人拷走文件）
// 都能直接拿到。界面上的"掩码"只挡了接口，不挡文件。
//
// 做法（刻意保持简单、跨平台、零依赖）：
//   * AES-256-GCM；每条值一个随机 IV；存成 `enc:v1:<base64(iv|tag|ciphertext)>`
//   * 密钥放 `<数据目录>/.secret.key`（首次运行自动生成，尽量设为仅本人可读）
//   * **密钥提供者可替换**：将来接系统钥匙串（Windows 凭据管理器 / macOS Keychain）
//     只需要换 getOrCreateKey 的实现，密文格式不变。
//
// 安全边界（诚实说明）：
//   这是"防止明文躺在文件里"，不是"防住已经控制你电脑的人" —— 后者需要系统钥匙串或口令加密。
//   另外：密钥丢了 = 密文解不开（会在界面上表现为"字段需要重新填写"，不会崩）。
import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

export const SECRET_PREFIX = 'enc:v1:';
export const KEY_FILE = '.secret.key';

/** 哪些字段算凭据：键名以这些词结尾（与界面掩码用的是同一套规则）。 */
// 必须是"开头或下划线"之后才接这些词：否则 `bypass` 这种会被误判成凭据
export const SECRET_KEY_RE = /(^|_)(token|secret|password|passwd|pass|apikey|appkey|credential)$/i;

/** 明文密码也常写在 `password`/`passwd` 里；这里给一个明确清单，避免误伤 `bypass` 之类。 */
export const SECRET_KEY_EXACT = ['token', 'secret', 'password', 'passwd', 'pass', 'apikey', 'appkey', 'app_secret', 'access_key'];

export function isSecretKey(key) {
  const k = String(key || '').toLowerCase();
  if (SECRET_KEY_EXACT.includes(k)) return true;
  if (SECRET_KEY_RE.test(k)) return true;
  // 复合键名：mobile_bark_key / xxx_api_key / xxx_icloud_pass 这类也要算凭据
  return /(_key|_secret|_token|_pass(word)?|_credential)$/.test(k)
    && /(bark|api|app|access|secret|token|pass|auth|credential|icloud|smtp|imap|mail)/.test(k);
}

export function isEncrypted(value) {
  return typeof value === 'string' && value.startsWith(SECRET_PREFIX);
}

let cachedKey = null;
let cachedKeyPath = '';

/** 取（或首次生成）数据目录下的密钥。 */
export function getOrCreateKey(dataDir) {
  const path = join(String(dataDir || '.'), KEY_FILE);
  if (cachedKey && cachedKeyPath === path) return cachedKey;
  try {
    if (existsSync(path)) {
      const raw = readFileSync(path, 'utf8').trim();
      if (/^[0-9a-f]{64}$/i.test(raw)) {
        cachedKey = Buffer.from(raw, 'hex');
        cachedKeyPath = path;
        return cachedKey;
      }
    }
    mkdirSync(dataDir, { recursive: true });
    const key = randomBytes(32);
    writeFileSync(path, key.toString('hex'), { encoding: 'utf8', mode: 0o600 });
    try { chmodSync(path, 0o600); } catch { /* Windows 上不一定支持，忽略 */ }
    cachedKey = key;
    cachedKeyPath = path;
    return key;
  } catch {
    // 写不进去（只读目录等）就别硬来：退化为"不加密"，功能照常
    cachedKey = null;
    cachedKeyPath = path;
    return null;
  }
}

/** 重置内存里的密钥缓存（测试用）。 */
export function resetKeyCache() {
  cachedKey = null;
  cachedKeyPath = '';
}

export function encryptString(plain, key) {
  const text = String(plain ?? '');
  if (!key || !text) return text;
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  const data = Buffer.concat([cipher.update(text, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return SECRET_PREFIX + Buffer.concat([iv, tag, data]).toString('base64');
}

export function decryptString(payload, key) {
  if (!isEncrypted(payload)) return payload;               // 明文原样返回（兼容老数据）
  if (!key) return '';
  try {
    const buf = Buffer.from(String(payload).slice(SECRET_PREFIX.length), 'base64');
    const iv = buf.subarray(0, 12);
    const tag = buf.subarray(12, 28);
    const data = buf.subarray(28);
    const decipher = createDecipheriv('aes-256-gcm', key, iv);
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(data), decipher.final()]).toString('utf8');
  } catch {
    // 换过密钥 / 数据被改过 → 当作"空值"，界面上会提示重新填写，但不崩
    return '';
  }
}

/** 把对象里所有凭据字段加密（只处理字符串值）。 */
export function encryptSecrets(obj, key, extraKeys = []) {
  if (!obj || typeof obj !== 'object' || !key) return obj;
  const out = { ...obj };
  for (const [k, v] of Object.entries(out)) {
    if (typeof v !== 'string' || !v) continue;
    if (!isSecretKey(k) && !extraKeys.includes(k)) continue;
    if (isEncrypted(v)) continue;                          // 已经加密过就别再套一层
    out[k] = encryptString(v, key);
  }
  return out;
}

/** 反向：把凭据字段解密（非凭据字段不动）。 */
export function decryptSecrets(obj, key, extraKeys = []) {
  if (!obj || typeof obj !== 'object') return obj;
  const out = { ...obj };
  for (const [k, v] of Object.entries(out)) {
    if (typeof v !== 'string' || !v) continue;
    if (!isEncrypted(v)) continue;                         // 明文（老数据）不用管
    if (!isSecretKey(k) && !extraKeys.includes(k)) { out[k] = decryptString(v, key); continue; }
    out[k] = decryptString(v, key);
  }
  return out;
}

/** JSON 版：加密整段配置 JSON 串里的凭据字段。 */
export function encryptConfigJson(configJson, key, extraKeys = []) {
  try {
    const obj = JSON.parse(configJson || '{}');
    return JSON.stringify(encryptSecrets(obj, key, extraKeys));
  } catch {
    return configJson;
  }
}

export function decryptConfigJson(configJson, key, extraKeys = []) {
  try {
    const obj = JSON.parse(configJson || '{}');
    return JSON.stringify(decryptSecrets(obj, key, extraKeys));
  } catch {
    return configJson;
  }
}
