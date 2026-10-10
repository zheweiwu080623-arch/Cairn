// 「给平板开热点」按钮的验证（2026-10-08）。
//
// 背景：校园网会把同一 Wi-Fi 里的设备互相隔离 —— 平板连校园网时**根本到不了这台电脑**
// （实测 3211 访问日志里一条请求都没有）。手机热点能用，但要一直开着、IP 还每次都变。
// 所以加一个按钮：让**电脑自己发热点**，平板连它；电脑那边照样连着校园网并共享出去。
//
// 这里验三块：① 状态解析（PowerShell 只回一行 JSON，前面可能有权衡噪音）；
//            ② 平板地址（固定走热点 IP，不能拼错）；③ 接线（接口存在、界面有按钮、没用废弃的 netsh 写法）。

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  HOTSPOT_FALLBACK_IP, buildScript, humanizePsError, parseStatus, runPowerShell, stateLabel, tabletUrl,
} from '../lib/hotspot.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const read = (p) => readFileSync(join(ROOT, p), 'utf8');
let failures = 0;
const ok = (label, cond, detail = '') => {
  if (cond) console.log(`  PASS ${label}`);
  else { failures += 1; console.log(`  FAIL ${label}${detail ? ` -- ${detail}` : ''}`); }
};

console.log('hotspot.test.mjs');

// ---------------- ① 状态解析 ----------------
console.log('\n① 状态解析');
ok('on → 已开 / off → 关着',
  stateLabel('on') === '已开' && stateLabel('off') === '关着', stateLabel('on'));
ok('其它状态不装懂（InTransition / 没联网 / 未知）',
  stateLabel('intransition') === '正在切换' && stateLabel('no-internet') === '没联网'
  && stateLabel('whatever') === '未知');

const good = '{"supported":true,"state":"On","ssid":"LAPTOP-ABC 1234","pass":"p@ss","ip":"192.168.137.1","error":""}';
const st = parseStatus(good);
ok('正常 JSON 解析成对象', st.state === 'on' && st.ssid === 'LAPTOP-ABC 1234' && st.ip === '192.168.137.1', JSON.stringify(st));
ok('大小写不敏感（On → on）', parseStatus('{"state":"On"}').state === 'on');
ok('前面有噪音也能挑出 JSON', parseStatus('警告：\n随便什么\n{"state":"Off"}').state === 'off');
ok('多行 JSON 时取最后一行（后写的赢）', parseStatus('{"state":"On"}\n{"state":"Off"}').state === 'off');
ok('全是垃圾 → 不抛错，给"读不出"', parseStatus('完全不是 json').state === 'unknown');
ok('空输入也不炸', parseStatus('').error === '读不出热点状态');
ok('PS 只回错误码，人话在 JS 这一侧（脚本保持 ASCII）',
  parseStatus('{"state":"no-internet","code":"no-internet"}').error.includes('先让电脑连上 Wi-Fi'));
ok('PowerShell 的失败码翻成人话（不再甩英文/CLIXML）',
  humanizePsError('', 'tethering op failed (status=3)').includes('系统拒绝了这次切换'),
  humanizePsError('', 'tethering op failed (status=3)'));

// ---------------- ② 平板地址 ----------------
console.log('\n② 平板要打开的地址');
ok('拼出固定地址', tabletUrl({ ip: '192.168.137.1', port: 3211, token: 'abc123' })
  === 'http://192.168.137.1:3211/p/abc123/', tabletUrl({ ip: '192.168.137.1', token: 'abc123' }));
ok('读不到 IP 时用 ICS 兜底网段', tabletUrl({ token: 'x' }).includes(HOTSPOT_FALLBACK_IP));
ok('端口可换', tabletUrl({ ip: '10.0.0.1', port: 9999, token: 't' }).includes(':9999/'));
ok('密钥做 URL 转义（不会拼出坏链接）', tabletUrl({ ip: '1.2.3.4', token: 'a/b' }).includes('/p/a%2Fb/'));

// ---------------- ③ 传给 PowerShell 的脚本 ----------------
console.log('\n③ 开关脚本');
ok('on/off 替换进脚本', buildScript('on').includes("'on'") && buildScript('off').includes("'off'"));
ok('模板里的 __ACTION__ **全部**被替换（不然开关会变成"什么都不做"）',
  !buildScript('on').includes('__ACTION__') && !buildScript('off').includes('__ACTION__'),
  buildScript('on').includes('__ACTION__') ? '还残留 __ACTION__' : '');
ok('不认识的 action 一律当查询（不会误关/误开）',
  buildScript('destroy').includes("'status'") && !buildScript('destroy').includes("'off' -eq"));
ok('脚本纯 ASCII（base64 传过去也不会乱码）', /^[\x00-\x7F]*$/.test(buildScript('on')));
ok('用的是 WinRT 的 TetheringManager（不是废弃的 netsh）',
  buildScript('status').includes('NetworkOperatorTetheringManager') && !/netsh/.test(buildScript('status')));

// ---------------- ④ 调用层（假 runner） ----------------
console.log('\n④ 调用层');
{
  const fake = (cmd, args, opts, cb) => cb(null, '{"state":"On","ssid":"S","pass":"P","ip":"192.168.137.1"}', '');
  const r = await runPowerShell('status', { runner: fake, platform: 'win32' });
  ok('win32：把 stdout 解析成状态', r.state === 'on' && r.ssid === 'S', JSON.stringify(r));
  const bad = await runPowerShell('status', { runner: (c, a, o, cb) => cb(new Error('boom'), '', ''), platform: 'win32' });
  ok('PowerShell 失败 → 如实带 error，不抛', bad.state === 'unknown' && bad.error.includes('boom'), JSON.stringify(bad));
  const mac = await runPowerShell('status', { platform: 'darwin' });
  ok('非 Windows：明说没做，不假装成功', mac.supported === false && /只做了 Windows/.test(mac.error));
}

// ---------------- ⑤ 接线 ----------------
console.log('\n⑤ 接线');
const routes = read('lib/routes/mobile.mjs');
ok('挂了 GET/POST /api/mobile/hotspot', /'\/api\/mobile\/hotspot'/.test(routes));
ok('接口层直接复用 lib/hotspot.mjs（不再写一份判断）', /from '\.\.\/hotspot\.mjs'/.test(routes));
ok('返回里带上"平板要打开的地址"', /tabletUrl/.test(routes) && /url:/.test(routes));
const app = read('public/app.js');
ok('「手机与办公本」卡片上有开/关按钮', /mb-hot-toggle/.test(app) && /mb-hot-refresh/.test(app));
ok('打开时把 Wi-Fi 名与密码显示出来（不然平板连不上）', /Wi-Fi 名/.test(app) && /密码/.test(app));
ok('状态缓存（不每分钟去问一次 PowerShell）', /hotCacheAt/.test(app) && /60000/.test(app));
ok('主程序行数闸门仍然守得住', read('server.mjs').split('\n').length < 2100);

console.log(`\nhotspot.test: ${failures === 0 ? 'PASS' : `FAIL (${failures})`}`);
process.exit(failures ? 1 : 0);
