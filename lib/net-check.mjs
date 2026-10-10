// net-check.mjs —— 「平板 / 手机连不上 Cairn」的网络自检与一键修复（2026-10-08）
//
// 为什么要它：Windows 会把每个 Wi-Fi 判成「专用 / 公用」，而**防火墙规则只在它覆盖到的
// 网络类型上生效**。家里与手机热点通常被判成专用，校园网（实测 SJTU WLAN）被判成**公用**——
// 于是出现最讨厌的一种故障：服务在跑、端口也在听，但包被防火墙丢了，**界面上一点提示都没有**，
// 表现就是"昨天还好好的，换个网络就连不上"。
//
// 这个模块只做三件事：
//   ① 读出"当前网络是什么类型"与"那条放行规则覆盖哪些类型"；
//   ② 用一句人话说明现在能不能连、为什么不能，以及下一步做什么；
//   ③ 需要时用**一次管理员确认（UAC）**把规则扩到所有网络类型（只动这一条规则、只开 3211）。
//
// 边界（刻意不做的）：不改别的防火墙规则、不开别的端口、不碰系统其它设置；
// 非 Windows 平台如实说"这个自检目前只做了 Windows"，不假装成功。

import { execFile } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/** 放行规则的名字（和 2026-10-03 建的那条一致；改名会导致重复建规则）。 */
export const FIREWALL_RULE = 'Cairn Mobile LAN (TCP 3211)';
export const MOBILE_PORT = 3211;

const CATEGORY_LABEL = {
  Public: '公用网络',
  Private: '专用网络',
  DomainAuthenticated: '域网络',
};

/** `ConvertTo-Json` 出来的可能是对象、数组、或空串 —— 统一成数组。 */
export function toArray(value) {
  if (!value) return [];
  return Array.isArray(value) ? value.filter(Boolean) : [value];
}

export function parseJson(text) {
  const raw = String(text == null ? '' : text).trim();
  if (!raw) return null;
  try { return JSON.parse(raw); } catch { return null; }
}

export function categoryLabel(name) {
  return CATEGORY_LABEL[name] || String(name || '未知网络');
}

/** 规则覆盖了某个网络类型吗？（Profile 可能是 "Private"、"Any"、"Domain, Private"） */
export function coversProfile(ruleProfile, category) {
  const text = String(ruleProfile || '');
  if (!text) return false;
  if (/Any/i.test(text)) return true;
  return text.split(/[,\s]+/).filter(Boolean).some((x) => x.toLowerCase() === String(category || '').toLowerCase());
}

/**
 * 纯函数：给出"现在能不能连"的判定（不碰系统，好测）。
 *
 * @param {{profiles?:Array, rule?:object|null, portOk?:boolean, platform?:string}} input
 * @returns {{level:'ok'|'warn'|'bad'|'info', headline:string, why:string[], steps:string[], needs_fix:boolean}}
 */
export function judge({ profiles, rule, portOk = true, platform = process.platform } = {}) {
  const steps = [];
  const fallbackSteps = [
    '确认平板和电脑连的是**同一个** Wi-Fi',
    '如果这个网络会"隔离设备"（校园网、酒店网基本都会：同一个 Wi-Fi 里两台设备也互相不通），开手机热点，让电脑和平板都连热点',
    '不想管局域网时，用不依赖它的通道：iCloud 日历订阅 / Bark 推送 / 早报邮件（这三样在校园网下也能用）',
  ];
  if (platform !== 'win32') {
    return { level: 'info', headline: '这个自检目前只做了 Windows（这台机器不是 Windows，跳过）', why: [], steps: [], needs_fix: false };
  }
  const list = toArray(profiles);
  if (!list.length) {
    return { level: 'warn', headline: '现在没有连任何网络 —— 先让电脑连上 Wi-Fi', why: [], steps: fallbackSteps, needs_fix: false };
  }
  const names = list.map((p) => `${p.name || '（未命名网络）'}（${categoryLabel(p.category)}）`).join('、');
  const uncovered = list.filter((p) => p.category && !coversProfile(rule && rule.profile, p.category));
  if (!rule) {
    return {
      level: 'bad', needs_fix: true,
      headline: `还没放行过 3211：${names} — 平板连不上（服务其实在跑）`,
      why: [`没有找到名为「${FIREWALL_RULE}」的入站规则，Windows 防火墙默认会挡掉外面的连接。`],
      steps: ['点下面的「让平板能连」（只会弹一次管理员确认）', ...fallbackSteps],
    };
  }
  if (String(rule.enabled).toLowerCase() !== 'true') {
    return {
      level: 'bad', needs_fix: true,
      headline: `放行规则被禁用了：${names} — 平板连不上`,
      why: [`「${FIREWALL_RULE}」存在，但 Enabled=${rule.enabled}。`],
      steps: ['点下面的「让平板能连」重新启用它', ...fallbackSteps],
    };
  }
  if (uncovered.length) {
    const bad = uncovered.map((p) => `${p.name || '（未命名）'}（${categoryLabel(p.category)}）`).join('、');
    return {
      level: 'bad', needs_fix: true,
      headline: `现在这个网络是${uncovered[0].category === 'Public' ? '「公用网络」' : '「' + categoryLabel(uncovered[0].category) + '」'}，而放行规则只覆盖「${rule.profile}」—— 平板连不上`,
      why: [
        `Windows 把网络分成专用 / 公用 / 域；防火墙规则只在它覆盖的类型上生效。`,
        `当前：${bad}；规则「${FIREWALL_RULE}」覆盖：${rule.profile}。`,
        '所以服务在跑、端口也在听，但数据包被防火墙丢了 —— 这就是"换个网络就连不上"的原因。',
      ],
      steps: ['点下面的「让平板能连」把规则扩到所有网络类型（一次性，需管理员确认）', ...fallbackSteps],
    };
  }
  steps.push(...fallbackSteps);
  if (!portOk) steps.unshift('电脑上的 Cairn 好像没在监听 3211 —— 先确认应用在运行（托盘图标）');
  return {
    level: portOk ? 'ok' : 'warn',
    needs_fix: false,
    headline: portOk
      ? `放行规则覆盖到位：${names} → 平板应该能连（打不开就按下面三步查）`
      : `规则没问题，但没检测到 3211 在监听：${names}`,
    why: [`规则「${FIREWALL_RULE}」覆盖：${rule.profile}，已启用。`],
    steps,
  };
}

/** 只在出错时跑一次 PowerShell，拿文本结果。不抛错（失败就是 ok:false）。 */
export function runPs(command, { timeoutMs = 12000, runner = execFile } = {}) {
  return new Promise((resolve) => {
    try {
      runner('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', command],
        { timeout: timeoutMs, windowsHide: true, encoding: 'utf8' },
        (err, stdout) => resolve({ ok: !err, text: String(stdout || ''), error: err ? String(err.message || err) : '' }));
    } catch (e) {
      resolve({ ok: false, text: '', error: String(e.message || e) });
    }
  });
}

const PS_PROFILES = 'Get-NetConnectionProfile | Select-Object Name,InterfaceAlias,@{n="Category";e={$_.NetworkCategory.ToString()}} | ConvertTo-Json -Compress';
const PS_RULE = `Get-NetFirewallRule -DisplayName "${FIREWALL_RULE}" -ErrorAction SilentlyContinue | Select-Object DisplayName,@{n="Enabled";e={$_.Enabled.ToString()}},@{n="Profile";e={$_.Profile.ToString()}},@{n="Action";e={$_.Action.ToString()}} | ConvertTo-Json -Compress`;
const psListen = (port) => `try { $c = New-Object Net.Sockets.TcpClient; $c.Connect('127.0.0.1',${port}); 'ok' } catch { 'fail' }`;

/** 读当前网络 + 规则 + 端口监听，给出判定。 */
export async function check({ run = runPs, platform = process.platform, port = MOBILE_PORT } = {}) {
  const base = judge({ profiles: [], platform });
  if (platform !== 'win32') return { supported: false, verdict: base };
  const [pRes, rRes, lRes] = await Promise.all([run(PS_PROFILES), run(PS_RULE), run(psListen(port))]);
  const profiles = toArray(parseJson(pRes.text)).map((p) => ({ name: p.Name, alias: p.InterfaceAlias, category: p.Category }));
  const ruleRaw = toArray(parseJson(rRes.text))[0] || null;
  const rule = ruleRaw ? { name: ruleRaw.DisplayName, enabled: ruleRaw.Enabled, profile: ruleRaw.Profile, action: ruleRaw.Action } : null;
  const portOk = /ok/i.test(lRes.text || '');
  const verdict = judge({ profiles, rule, portOk, platform });
  return {
    supported: true, port, port_ok: portOk, rule, profiles, verdict,
    needs_fix: !!verdict.needs_fix,
    error: [pRes, rRes].filter((r) => !r.ok).map((r) => r.error).join('；') || '',
  };
}

/**
 * 修复脚本（**纯 ASCII**：PowerShell 5.1 在非 UTF-8 代码页下读中文会乱）。
 * 只做一件事：把那条规则覆盖的网络类型放宽到所有类型；规则不存在就按同样的名字与端口建一条。
 */
export function buildFixScript({ rule = FIREWALL_RULE, port = MOBILE_PORT } = {}) {
  return [
    `$name = '${rule}'`,
    `$port = ${port}`,
    '$r = Get-NetFirewallRule -DisplayName $name -ErrorAction SilentlyContinue',
    'if ($r) {',
    '  Set-NetFirewallRule -DisplayName $name -Enabled True -Action Allow -Profile Any -RemoteAddress LocalSubnet -ErrorAction Stop',
    '  Write-Output "CAIRN_FIREWALL_UPDATED"',
    '} else {',
    '  New-NetFirewallRule -DisplayName $name -Direction Inbound -Action Allow -Protocol TCP -LocalPort $port -Profile Any -RemoteAddress LocalSubnet -ErrorAction Stop | Out-Null',
    '  Write-Output "CAIRN_FIREWALL_CREATED"',
    '}',
    '',
  ].join('\n');
}

/**
 * 弹一次 UAC 去执行上面的脚本（用户在弹窗里点「是」才真的改）。
 * 刻意不做静默提权：改防火墙必须有人点那一下。
 */
export async function requestFix({ run = runPs, platform = process.platform, tempDir = tmpdir() } = {}) {
  const script = buildFixScript();
  if (platform !== 'win32') return { ok: false, error: '这个修复目前只做了 Windows', script };
  let file = '';
  try {
    const dir = mkdtempSync(join(tempDir, 'cairn-firewall-'));
    file = join(dir, 'fix-cairn-mobile-firewall.ps1');
    writeFileSync(file, '\ufeff' + script, 'utf8');       // 带 BOM，PowerShell 5.1 才认 UTF-8
  } catch (e) {
    return { ok: false, error: `写临时脚本失败：${e.message}`, script };
  }
  const cmd = `Start-Process -FilePath powershell.exe -Verb RunAs -ArgumentList @('-NoProfile','-ExecutionPolicy','Bypass','-File','${file}')`;
  const r = await run(cmd);
  return r.ok
    ? { ok: true, launched: true, script_path: file, script, note: '已请求管理员权限；请在弹窗里点「是」，然后重新自检' }
    : { ok: false, launched: false, script_path: file, script, error: r.error || '发起提权失败（可能被组策略挡住）' };
}
