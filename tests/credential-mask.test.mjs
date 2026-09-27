// 凭据脱敏的验证（R2 第三组之一）。这是**安全边界**，所以测得细一点。
//
//   node tests/credential-mask.test.mjs

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import {
  MASK_PREFIX, MOBILE_SECRET_KEYS, SECRET_KEY_RE, connectorSecretKeys,
  maskConfigJson, maskConnectorConfig, maskMobilePrefs, maskSecretValue,
  sanitizeMobilePatch, shouldKeepStoredSecret, unmaskConnectorConfig,
} from '../lib/credential-mask.mjs';

let failures = 0;
const ok = (label, cond, detail = '') => {
  if (cond) console.log(`  PASS ${label}`);
  else {
    failures += 1;
    console.log(`  FAIL ${label}${detail ? ` -- ${detail}` : ''}`);
  }
};

console.log('credential-mask.test.mjs');

// ---------------- 1. 单个值的掩码 ----------------
ok('长值保留末四位', maskSecretValue('abcdef1234') === `${MASK_PREFIX}1234`, maskSecretValue('abcdef1234'));
// 四个字符以内**全部藏起来**（连末四位都不露，因为太短了，露出来等于没藏）
ok('四个字符以内全藏', maskSecretValue('1234') === MASK_PREFIX, maskSecretValue('1234'));
ok('五个字符才留末四位', maskSecretValue('12345') === `${MASK_PREFIX}2345`, maskSecretValue('12345'));
ok('短值只留前缀（不泄露任何字符）', maskSecretValue('12') === MASK_PREFIX, maskSecretValue('12'));
ok('空值还是空', maskSecretValue('') === '' && maskSecretValue(null) === '' && maskSecretValue(undefined) === '');
ok('数字也会被当字符串处理', maskSecretValue(12345678) === `${MASK_PREFIX}5678`);
ok('掩码前缀是多字节圆点', MASK_PREFIX === '••••');

// ---------------- 2. 哪些字段算凭据 ----------------
for (const k of ['token', 'api_token', 'secret', 'app_secret', 'password', 'passwd', 'pass', 'apikey', 'appKey']) {
  ok(`字段名 ${k} 会被当成凭据`, SECRET_KEY_RE.test(k));
}
for (const k of ['url', 'label', 'max_results', 'path', 'kind']) {
  ok(`字段名 ${k} 不算凭据`, !SECRET_KEY_RE.test(k));
}
{
  const metaOf = () => ({ meta: { fields: [{ key: 'token', type: 'text' }, { key: 'url' }, { key: 'pin', type: 'password' }] } });
  const keys = connectorSecretKeys('任何', { metaOf });
  ok('type=password 的字段算凭据（哪怕名字不像）', keys.has('pin'));
  ok('名字像凭据的也算', keys.has('token'));
  ok('普通字段不算', !keys.has('url'));
  const bad = connectorSecretKeys('坏的', { metaOf: () => { throw new Error('拿不到元信息'); } });
  ok('拿不到元信息时不炸（只按字段名判断）', bad.size === 0);
}
{
  // 真实连接器：Canvas 的 token 字段应当被认出来
  const keys = connectorSecretKeys('canvas');
  ok('真实连接器 canvas 的 token 被认作凭据', keys.has('token'), JSON.stringify([...keys]));
}

// ---------------- 3. 配置 → 掩码（读接口用） ----------------
{
  const cfg = { base_url: 'https://canvas.example.edu', token: 'demo_token_0000', label: '学校' };
  const masked = maskConnectorConfig('canvas', cfg);
  ok('token 变成掩码', masked.token === `${MASK_PREFIX}0000`, masked.token);
  ok('非凭据字段原样保留', masked.base_url === cfg.base_url && masked.label === '学校');
  ok('原对象没被改动（不是原地改）', cfg.token === 'demo_token_0000');
  ok('JSON 字符串版本也不含明文', !maskConfigJson('canvas', JSON.stringify(cfg)).includes('demo_token'));
}
ok('maskConfigJson 遇到坏 JSON 就原样返回', maskConfigJson('canvas', '{坏掉的') === '{坏掉的');
ok('null / 非对象原样返回', maskConnectorConfig('canvas', null) === null && maskConnectorConfig('canvas', 'x') === 'x');

// ---------------- 4. 写入时沿用已存真值 ----------------
ok('界面带掩码回来 → 沿用真值', shouldKeepStoredSecret(`${MASK_PREFIX}0000`, 'demo_token_0000'));
ok('界面留空 → 沿用真值（浏览器会清空密码框）', shouldKeepStoredSecret('', 'stored-value'));
// 界面把真值原样传回来 → 不走"沿用"分支，但结果一样（存进去的还是这个值）
ok('界面传了真值本身 → 按新值处理（结果相同）', !shouldKeepStoredSecret('stored-value', 'stored-value'));
ok('用户真的敲了新密码 → 覆盖', !shouldKeepStoredSecret('brand-new-password', 'stored-value'));
ok('库里本来就是空 → 不沿用（允许保存空）', !shouldKeepStoredSecret('', ''));
{
  const stored = { base_url: 'https://old.example', token: 'example_token_0000' };
  const incomingMask = { base_url: 'https://new.example', token: `${MASK_PREFIX}0000` };
  const merged = unmaskConnectorConfig('canvas', incomingMask, stored);
  ok('带掩码提交：token 用库里的真值', merged.token === 'example_token_0000', merged.token);
  ok('带掩码提交：非凭据字段用界面上的新值', merged.base_url === 'https://new.example');

  const incomingNew = { token: 'example_user_token' };
  ok('用户敲了新值：用新值', unmaskConnectorConfig('canvas', incomingNew, stored).token === 'example_user_token');

  const incomingBlank = { token: '' };
  ok('留空：仍然是库里的真值（不会被清成空）',
    unmaskConnectorConfig('canvas', incomingBlank, stored).token === 'example_token_0000');

  ok('没有已存值时不硬套', unmaskConnectorConfig('canvas', { token: 'abc' }, {}).token === 'abc');
  ok('传入空对象不炸', JSON.stringify(unmaskConnectorConfig('canvas', null, null)) === '{}');
}

// ---------------- 5. 手机通道的凭据 ----------------
ok('手机通道的两个键在多处保持一致', MOBILE_SECRET_KEYS.join(',') === 'bark_key,icloud_pass');
{
  const prefs = { bark_key: 'bark-example-key', icloud_pass: 'demo_app_pass_0000', digest: true };
  const masked = maskMobilePrefs(prefs);
  ok('Bark 密钥被掩码', masked.bark_key.startsWith(MASK_PREFIX) && !masked.bark_key.includes('example-key'), masked.bark_key);
  ok('iCloud 密码被掩码', masked.icloud_pass === `${MASK_PREFIX}0000`, masked.icloud_pass);
  ok('其他偏好不动', masked.digest === true);
  ok('空对象 / null 不炸', JSON.stringify(maskMobilePrefs({})) === '{}' && maskMobilePrefs(null) === null);
}
{
  const before = { bark_key: 'bark-example-key', icloud_pass: 'example_pass' };
  const patch = { bark_key: `${MASK_PREFIX}-key`, digest: false };
  const clean = sanitizeMobilePatch(patch, before);
  ok('带掩码的字段被从 patch 里删掉（不会把掩码存进去）', !('bark_key' in clean));
  ok('其他字段保留', clean.digest === false);
  ok('用户改的新值会保留', sanitizeMobilePatch({ bark_key: 'brand-new' }, before).bark_key === 'brand-new');
  ok('patch 里没有的键不动', JSON.stringify(sanitizeMobilePatch({}, before)) === '{}');
}

// ---------------- 6. 搬家之后 server.mjs 里不再有这些实现 ----------------
{
  const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
  const srv = readFileSync(join(ROOT, 'server.mjs'), 'utf8');
  ok('server.mjs 不再自己实现 maskSecretValue', !srv.includes('function maskSecretValue'));
  ok('server.mjs 不再自己实现 handleConnectors', !srv.includes('async function handleConnectors'));
  ok('server.mjs 从 lib 引入脱敏函数',
    srv.includes("from './lib/credential-mask.mjs'") && srv.includes('maskConfigJson'));
  ok('server.mjs 保留接线', srv.includes('createConnectorRoutes({') && srv.includes('handleConnectors(req, res, url)'));
  // 这个上限是"别再长回去"的护栏：R2 拆完后 2224 行；此后新增的功能各只加十几行接线
  // （数据源 / 文档 / 重要性 / 日报·晚报），所以把余量放到 2320 —— 目的是挡住"大块逻辑搬回来"，
  // 而不是禁止加新功能的接线。改这个数字时请顺手说明这次加了什么。
  ok('server.mjs 保持在 2320 行以内（拆出来的三组没被搬回去）',
    srv.split('\n').length < 2320, String(srv.split('\n').length));
}

console.log('');
console.log(failures === 0 ? 'credential-mask.test: PASS' : `credential-mask.test: FAIL (${failures})`);
process.exit(failures === 0 ? 0 : 1);
