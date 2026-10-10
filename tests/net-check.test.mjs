// 「平板换网络后连不上」的自检与修复：纯函数判定 + 修复脚本 + 接线（2026-10-08）。
//
// 真实故障（2026-10-08 实测）：电脑在 SJTU WLAN 上，Windows 把这个网络判成 **Public**，
// 而放行规则「Cairn Mobile LAN (TCP 3211)」只覆盖 **Private** —— 服务在跑、端口在听，
// 但包被防火墙丢了，界面上没有任何提示。所以这里的核心断言是：
//   「当前是公用网络 + 规则只覆盖专用」必须被判成"要修"，并且说清原因。

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { FIREWALL_RULE, buildFixScript, coversProfile, judge, parseJson, toArray } from '../lib/net-check.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const read = (p) => readFileSync(join(ROOT, p), 'utf8');
let failures = 0;
const ok = (label, cond, detail = '') => {
  if (cond) console.log(`  PASS ${label}`);
  else { failures += 1; console.log(`  FAIL ${label}${detail ? ` -- ${detail}` : ''}`); }
};

console.log('net-check.test.mjs');

// ---------------- ① 解析小工具 ----------------
console.log('\n① 读 PowerShell 的返回');
ok('空 → []', toArray(null).length === 0 && toArray('').length === 0);
ok('单个对象 → 一个元素的数组', toArray({ Name: 'SJTU' }).length === 1);
ok('数组原样（丢掉空值）', toArray([{ a: 1 }, null]).length === 1);
ok('坏 JSON 不抛错，返回 null', parseJson('{不是 json') === null);
ok('空串 → null', parseJson('   ') === null);
ok('正常 JSON 能解析', parseJson('{"Name":"SJTU","Category":"Public"}').Name === 'SJTU');

// ---------------- ② 规则覆盖判断 ----------------
console.log('\n② 规则覆盖了哪种网络');
ok('Any 覆盖公用与专用', coversProfile('Any', 'Public') && coversProfile('Any', 'Private'));
ok('Private 不覆盖公用 ← 这次故障的根', coversProfile('Private', 'Public') === false);
ok('Private 覆盖专用', coversProfile('Private', 'Private'));
ok('"Domain, Private" 能认出 Private、但覆盖不了 Public',
  coversProfile('Domain, Private', 'Private') && !coversProfile('Domain, Private', 'Public'));
ok('空规则 = 什么都不覆盖', coversProfile('', 'Private') === false);

// ---------------- ③ 判定（核心） ----------------
console.log('\n③ 判定：现在能不能连');
const sjtu = [{ name: 'SJTU', alias: 'WLAN', category: 'Public' }];
const home = [{ name: 'H3C_1C23D8', alias: 'WLAN', category: 'Private' }];

const v1 = judge({ profiles: sjtu, rule: { name: FIREWALL_RULE, enabled: 'True', profile: 'Private' }, platform: 'win32' });
ok('公用网络 + 只覆盖专用的规则 → 判定为"要修"', v1.level === 'bad' && v1.needs_fix === true, v1.level);
ok('说清了原因（公用网络 / 规则只覆盖 Private）',
  /公用网络/.test(v1.headline) && /Private/.test(v1.headline), v1.headline);
ok('给了"下一步做什么"', v1.steps.length >= 2 && /让平板能连/.test(v1.steps[0]), JSON.stringify(v1.steps.slice(0, 2)));

const v2 = judge({ profiles: home, rule: { name: FIREWALL_RULE, enabled: 'True', profile: 'Private' }, platform: 'win32' });
ok('专用网络 + 专用规则 → 没问题', v2.level === 'ok' && v2.needs_fix === false, v2.headline);

const v3 = judge({ profiles: sjtu, rule: { name: FIREWALL_RULE, enabled: 'True', profile: 'Any' }, platform: 'win32' });
ok('规则放宽到 Any 之后，公用网络也判定为没问题', v3.level === 'ok' && v3.needs_fix === false, v3.headline);

const v4 = judge({ profiles: sjtu, rule: null, platform: 'win32' });
ok('规则不存在 → 要修，并说明默认会被挡', v4.level === 'bad' && v4.needs_fix === true && /还没放行过/.test(v4.headline), v4.headline);

const v5 = judge({ profiles: home, rule: { name: FIREWALL_RULE, enabled: 'False', profile: 'Any' }, platform: 'win32' });
ok('规则被禁用 → 要修', v5.level === 'bad' && v5.needs_fix === true && /禁用/.test(v5.headline), v5.headline);

const v6 = judge({ profiles: [], rule: null, platform: 'win32' });
ok('电脑没连网络 → 提醒先连 Wi-Fi（不是防火墙问题）', v6.level === 'warn' && v6.needs_fix === false, v6.headline);

const v7 = judge({ profiles: sjtu, rule: { name: FIREWALL_RULE, enabled: 'True', profile: 'Any' }, portOk: false, platform: 'win32' });
ok('规则没问题但 3211 没在听 → 提示先看应用是否在跑', v7.level === 'warn' && /监听/.test(v7.headline), v7.headline);

const v8 = judge({ profiles: home, rule: { name: FIREWALL_RULE, enabled: 'True', profile: 'Private' }, platform: 'darwin' });
ok('非 Windows：如实说没做，不假装成功', v8.level === 'info' && /只做了 Windows/.test(v8.headline));

ok('每种判定都给了"还是连不上怎么办"这条退路',
  [v1, v2, v3, v4, v5, v7].every((v) => v.steps.some((s) => /热点|隔离设备/.test(s))));

// ---------------- ④ 修复脚本 ----------------
console.log('\n④ 一键修复脚本');
const script = buildFixScript();
ok('只动这一条规则（名字写死）', script.includes(FIREWALL_RULE));
ok('覆盖所有网络类型', /-Profile Any/.test(script));
ok('只开 3211 且限本子网', /-LocalPort \$port/.test(script) && /-RemoteAddress LocalSubnet/.test(script));
ok('规则不存在时会新建（不只是改）', /New-NetFirewallRule/.test(script));
ok('**纯 ASCII**（PowerShell 5.1 读非 ASCII 脚本会乱码）', /^[\x00-\x7F]*$/.test(script));

// ---------------- ⑤ 接线 ----------------
console.log('\n⑤ 接线');
const routes = read('lib/routes/mobile.mjs');
ok('挂了 GET /api/mobile/network（自检）', /'\/api\/mobile\/network'/.test(routes));
ok('挂了 POST /api/mobile/network/fix（一键修复）', /\/api\/mobile\/network\/fix/.test(routes));
ok('接口层直接复用自检模块（不是又写一份判断）', /from '\.\.\/net-check\.mjs'/.test(routes));
const app = read('public/app.js');
ok('「手机与办公本」卡片上有自检按钮', /mb-net-check/.test(app));
ok('需要修的时候才显示"让平板能连"按钮', /mb-net-fix/.test(app) && /needs_fix/.test(app));
ok('修复前先确认（会弹 UAC，不能偷偷改）', /会弹一次 Windows 管理员确认|管理员确认/.test(app));

console.log(`\nnet-check.test: ${failures === 0 ? 'PASS' : `FAIL (${failures})`}`);
process.exit(failures ? 1 : 0);
