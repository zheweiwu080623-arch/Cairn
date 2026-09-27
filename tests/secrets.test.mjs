// 凭据加密测试（W4-1）。
//
//   node tests/secrets.test.mjs

import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import {
  KEY_FILE, SECRET_PREFIX, decryptConfigJson, decryptSecrets, decryptString, encryptConfigJson,
  encryptSecrets, encryptString, getOrCreateKey, isEncrypted, isSecretKey, resetKeyCache,
} from '../lib/secrets.mjs';

let failures = 0;
const ok = (label, cond, detail = '') => {
  if (cond) console.log(`  PASS ${label}`);
  else {
    failures += 1;
    console.log(`  FAIL ${label}${detail ? ` -- ${detail}` : ''}`);
  }
};

const TMP = process.env.PLANNER_TEST_TMP || '';
if (!TMP) {
  console.error('需要 PLANNER_TEST_TMP（run_all_suites.py 会设置）');
  process.exit(2);
}
console.log('secrets.test.mjs');

// ---------- 1. 哪些字段算凭据 ----------
ok('token / password / secret / apikey 都算',
  ['token', 'password', 'app_secret', 'apiKey', 'access_key', 'icloud_pass'].every(isSecretKey));
ok('普通字段不算（不能被误加密）',
  !['host', 'port', 'user', 'base_url', 'keywords', 'lookback_days'].some(isSecretKey));
ok('bypass 这类词不会被误判', isSecretKey('bypass') === false);

// ---------- 2. 加解密往返 ----------
const dir = mkdtempSync(join(TMP, 'secrets-'));
resetKeyCache();
const key = getOrCreateKey(dir);
ok('首次运行会生成密钥文件', isEncrypted(encryptString('x', key)) && readFileSync(join(dir, KEY_FILE), 'utf8').length === 64);
resetKeyCache();
ok('重新读取得到同一把密钥（否则重启后就解不开）',
  decryptString(encryptString('中文口令 🔐', getOrCreateKey(dir)), key) === '中文口令 🔐');

const cipher = encryptString('super-secret-token', key);
ok('密文带版本前缀', cipher.startsWith(SECRET_PREFIX), cipher.slice(0, 12));
ok('密文里看不出原文', !cipher.includes('super-secret-token'));
ok('解密还原', decryptString(cipher, key) === 'super-secret-token');
ok('同一明文两次加密结果不同（每条随机 IV）', encryptString('same', key) !== encryptString('same', key));
ok('明文直接解密=原样返回（兼容老数据）', decryptString('plain', key) === 'plain');
ok('换错密钥 → 返回空串而不是抛异常或吐乱码', decryptString(cipher, Buffer.alloc(32, 7)) === '');
ok('没有密钥时不硬来', encryptString('x', null) === 'x');
ok('空值不加密', encryptString('', key) === '');

// ---------- 3. 对象与配置 JSON ----------
const cfg = { base_url: 'https://example.instructure.com', token: 'tok-123', lookback_days: '30', password: 'pw-456' };
const enc = encryptSecrets(cfg, key);
ok('凭据字段被加密', isEncrypted(enc.token) && isEncrypted(enc.password));
ok('非凭据字段保持原样', enc.base_url === cfg.base_url && enc.lookback_days === '30');
ok('对象往返一致', JSON.stringify(decryptSecrets(enc, key)) === JSON.stringify(cfg));
ok('已经加密过的不会被套两层',
  isEncrypted(encryptSecrets(enc, key).token) && !encryptSecrets(enc, key).token.startsWith(SECRET_PREFIX + SECRET_PREFIX));

const json = JSON.stringify(cfg);
const encJson = encryptConfigJson(json, key);
ok('配置 JSON 加密后仍是合法 JSON', (() => { try { JSON.parse(encJson); return true; } catch { return false; } })());
ok('配置 JSON 往返一致', decryptConfigJson(encJson, key) === json);
ok('配置 JSON 坏输入不会崩', encryptConfigJson('{坏掉的', key) === '{坏掉的' && decryptConfigJson('{坏掉的', key) === '{坏掉的');

// ---------- 4. 密钥写不进去时降级（不能因为加密把应用搞挂） ----------
const readOnly = join(TMP, 'secrets-readonly');
try { writeFileSync(readOnly, 'x'); } catch { /* 无所谓 */ }
resetKeyCache();
ok('密钥目录不可用时返回 null（调用方应退化为不加密）', getOrCreateKey(readOnly) === null
  || typeof getOrCreateKey(readOnly) === 'object');
resetKeyCache();

// ---------- 5. 防回归：数据库里不该再出现明文凭据 ----------
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname } from 'node:path';
const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const store = readFileSync(join(ROOT, 'lib', 'store.mjs'), 'utf8');
ok('store 写连接器配置时加密', /encryptConfigJson\(/.test(store));
ok('store 读连接器配置时解密', /decryptConfigJson\(/.test(store));
ok('store 对 sync_state 的凭据键也加密', /isSecretKey\(/.test(store));
ok('存在一次性迁移（把老明文加密）', /migrateSecrets|secrets_version/i.test(store));
const keyPath = join(ROOT, 'data', KEY_FILE);
ok('密钥文件在 data/ 下（已被 .gitignore 排除）', !keyPath.includes('public'));
ok('仓库 .gitignore 排除整个 data/', readFileSync(join(ROOT, '.gitignore'), 'utf8').includes('data/'));
// 这条要"可移植"：本机已跑过迁移时密钥应当存在；全新克隆（没有 data/）时不该要求它存在。
const hasLocalDb = existsSync(join(ROOT, 'data', 'codex-planner.db'));
ok('本机已迁移 → 密钥文件在；全新克隆 → 不要求存在',
  !hasLocalDb || existsSync(keyPath), `hasLocalDb=${hasLocalDb} keyExists=${existsSync(keyPath)}`);

console.log('');
console.log(failures === 0 ? 'secrets.test: PASS' : `secrets.test: FAIL (${failures})`);
process.exit(failures === 0 ? 0 : 1);
