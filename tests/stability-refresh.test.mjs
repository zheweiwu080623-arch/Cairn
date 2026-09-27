// 三个"用着用着就不对劲"的问题的设备闸门（2026-09-27）
//
//   node tests/stability-refresh.test.mjs
//
// 用户原话：「供我验证的『功能设置』完全没有，然后后台运行时好时坏，应用运行还变慢了」。
// 三件事各有根因，这个文件把修法钉住，免得下次再犯：
//   ① 界面更新看不见 → 前端自检 `/api/health.ui.version`，浮出「点这刷新」（不自动刷，怕丢正在填的东西）；
//   ② 后台时好时坏   → 托盘的「退出」**不再顺手停服务**（拆成"退托盘"/"退并停服务"两项），
//                      看门狗从"连续 2 次"放宽到"连续 3 次"（正常重启 20~25 秒不该被判掉线）；
//   ③ 变慢           → 问一次邮件桥状态每次都要起一个子进程（实测 ~300ms），
//                      而数据源页每渲染一次就问一次 ⇒ 加 30 秒短缓存（只影响显示用的读数，发信路径不变）。

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const read = (rel) => readFileSync(join(ROOT, rel), 'utf8');
let failures = 0;
const ok = (label, cond, detail = '') => {
  if (cond) console.log(`  PASS ${label}`);
  else { failures += 1; console.log(`  FAIL ${label}${detail ? ` -- ${detail}` : ''}`); }
};

console.log('stability-refresh.test.mjs');

// ---------------- ① 界面更新要被看见 ----------------
{
  const app = read('public/app.js');
  const css = read('public/styles.css');
  const srv = read('server.mjs');
  ok('服务端在 /api/health 里给出界面构建版本（按文件修改时间算）',
    srv.includes('ui: { version:') && srv.includes("'index.html', 'app.js', 'styles.css', 'vm-bridge.js'"));
  ok('页面每 30 秒拿它和自己加载时看到的版本比一次',
    app.includes('async function checkUiBuild()') && app.includes('setInterval(checkUiBuild, 30000)')
    && app.includes("fetch('/api/health?_t='"));
  ok('不一致就浮出「界面已更新 · 点这里刷新」',
    app.includes('function showUpdatePill()') && app.includes("'🔄 界面已更新 · 点这里刷新'") && app.includes('ui-update-pill'));
  ok('**不自动刷新**（怕丢掉正在填的东西，刷不刷由用户点）',
    app.includes('el.onclick = () => location.reload();') && !/if \(v !== UI_BUILD_SEEN\) location\.reload/.test(app));
  ok('启动时把它挂上', app.includes('startUiWatch();'));
  ok('样式里有这颗提示', css.includes('.ui-update-pill') && css.includes('.ui-update-pill.show'));
  ok('旧的写死构建标记退役（现在由服务端版本号来标）', !app.includes("dataset.build = '2026-09-25b'"));
  // 2026-09-27 追加：服务掉线时说清楚（用户看到的只是"壁纸又连不上了"）。
  ok('后台服务连不上 → 明确提示「后台服务没在跑」并给一键重试',
    app.includes('function showOfflinePill()') && app.includes('server-offline-pill')
    && app.includes('⚠ 后台服务没在跑') && app.includes('启动后台.cmd'));
  ok('服务回来就把提示收掉（不是一直挂着）',
    app.includes('function hideOfflinePill()') && app.includes('hideOfflinePill();                                  // 服务回来了就把提示收掉'));
  ok('掉线提示用告警色，和前端的"界面已更新"提示区分开',
    css.includes('.ui-update-pill.offline'));
}

// ---------------- ② 后台服务不该被顺手停掉 ----------------
{
  const tray = read('tray.ps1');
  const block = (name) => {
    const i = tray.indexOf(`$${name}.add_Click({`);
    if (i < 0) return '';
    const j = tray.indexOf('})', i);
    return tray.slice(i, j);
  };
  ok('菜单拆成两项：退出托盘 / 退出并停止服务',
    tray.includes("'退出托盘（后台服务继续跑）'") && tray.includes("'退出并停止后台服务'"));
  ok('**退出托盘不再停服务**（这就是"后台时好时坏"的直接原因）',
    !block('miExit').includes('Stop-Process') && block('miExit').includes("Write-Log '托盘退出（后台服务继续跑）'"),
    block('miExit').replace(/\s+/g, ' ').slice(0, 120));
  ok('想连服务一起停，得显式点第二项（那一项才会 Stop-Process）',
    block('miExitAll').includes('Stop-Process') && block('miExitAll').includes('已停止 server pid='));
  ok('看门狗放宽到连续 3 次无响应（60 秒）才重启，别把"正在重启"误判成掉线',
    tray.includes('if ($script:failCount -lt 3) { return }') && !tray.includes('if ($script:failCount -lt 2) { return }'));
  ok('看门狗与启停函数都还在（托盘的老本行没动）',
    tray.includes('function Start-Server') && tray.includes('function Test-Server') && tray.includes('$watchdog'));
}

// ---------------- ③ 显示用的邮件桥读数加短缓存 ----------------
{
  const cs = read('lib/course-sync.mjs');
  ok('加的是"只给界面看"的那一条读数（发信路径不动）',
    cs.includes('const MAIL_BRIDGE_STATUS_TTL_MS = 30000;') && cs.includes('async function mailBridgeStatusCached('));
  ok('courseSyncStatus 走缓存版', cs.includes('await mailBridgeStatusCached(cfg.mail_bridge_dir)'));
  ok('缓存键带上目录（换了邮件桥目录不会拿旧读数）',
    cs.includes("mailBridgeStatusCache.dir === key") && cs.includes('mailBridgeStatusCache = { at: now, dir: key, value }'));
  ok('发信本身仍然是现问的（缓存没有碰 sendViaMailBridge）',
    cs.includes('sendViaMailBridge({') && !/async function sendViaMailBridge[\s\S]{0,400}mailBridgeStatusCached/.test(cs));
}

// ---------------- 主程序行数闸门仍然守得住 ----------------
{
  const lines = read('server.mjs').split('\n').length;
  ok('server.mjs 仍在 <2100 行（这次为了加 ui 版本号，删了一句重复注释换的空间）', lines < 2100, String(lines));
}

console.log('');
console.log(failures === 0 ? 'stability-refresh.test: PASS' : `stability-refresh.test: FAIL (${failures})`);
process.exit(failures === 0 ? 0 : 1);
