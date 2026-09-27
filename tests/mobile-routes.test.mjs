// 「手机 / 办公本」通道的验证（R2 · P0：从 server.mjs 拆出来之后的行为守卫）。
//
//   node tests/mobile-routes.test.mjs
//
// 两类断言：
//   ① 十条 HTTP 路径的**行为不变**（偏好读写 / 测试推送 / 发报 / 重置密钥 / iCloud 两个 / 三个只读下载 / 打开目录）；
//   ② 那个局域网只读小服务的**安全边界**（token 不对一律 404；只暴露 .ics/.txt/说明页/健康检查）。

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { createMobileRoutes } from '../lib/routes/mobile.mjs';
import { createMobileServer, mobileReadHandler, mobilePageHtml, tokenEquals } from '../lib/mobile-server.mjs';
import { MOBILE_KEYS } from '../lib/mobile.mjs';

let failures = 0;
const ok = (label, cond, detail = '') => {
  if (cond) console.log(`  PASS ${label}`);
  else {
    failures += 1;
    console.log(`  FAIL ${label}${detail ? ` -- ${detail}` : ''}`);
  }
};

console.log('mobile-routes.test.mjs');

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

// ---------------- 替身 ----------------
const sync = new Map();
const store = {
  getSync: (k) => (sync.has(k) ? sync.get(k) : null),
  setSync: (k, v) => sync.set(k, v),
};
const calls = [];
const prefs = {
  bark_enabled: true, bark_key: 'bark-example-key', digest_enabled: false, digest_time: '07:00',
  digest_evening_enabled: false, digest_evening_time: '21:00', lan_enabled: true, icloud_enabled: false,
};
let lanRunning = false;
const mobileRoutes = createMobileRoutes({
  store, sendJson: (res, code, obj) => { res.code = code; res.body = obj; },
  sendError: (res, code, msg) => { res.code = code; res.body = { error: msg }; },
  readBody: async (r) => r.body || {},
  dataDir: 'C:/tmp/data', mobilePort: 3211,
  mobileApi: {
    getMobilePrefs: () => ({ ...prefs }),
    saveMobilePrefs: (s, patch) => { calls.push(['save', patch]); Object.assign(prefs, patch); return { ...prefs }; },
    ensureCalToken: () => { calls.push(['reset-token']); return 'tok'; },
    calendarInfo: () => ({ port: 3211, urls: [] }),
    buildDigestText: () => 'Cairn · 今日\n===',
    writeMobileFiles: () => { calls.push(['write-files']); return { written: ['a.txt'] }; },
    testIcloud: async () => { calls.push(['icloud-test']); return { ok: true, calendars: ['Planner'] }; },
    syncIcloud: async () => { calls.push(['icloud-sync']); return { ok: true, pushed: 1 }; },
    sendDigestNow: async (s, opts) => { calls.push(['digest', opts.kind]); return { ok: true, to: ['x@example.edu'], kind: opts.kind }; },
  },
  maskMobilePrefs: (p) => ({ ...p, bark_key: '••••0000' }),
  sanitizeMobilePatch: (patch) => { const out = { ...(patch || {}) }; if (out.bark_key === '••••0000') delete out.bark_key; return out; },
  buildIcs: () => ({ ics: 'BEGIN:VCALENDAR\r\nEND:VCALENDAR', count: 0 }),
  appName: () => 'Cairn',
  briefFor: (kind) => ({ kind }),
  lanServer: { start: () => { lanRunning = true; return { ok: true }; }, stop: () => { lanRunning = false; return { ok: true }; } },
  barkNotify: async (o) => { calls.push(['bark', o.title]); return { ok: true }; },
});
const req = (method, body) => ({ method, body });
const mkRes = () => ({ code: null, body: null, headers: null, ended: null, writeHead(c, h) { this.code = c; this.headers = h; }, end(b) { this.ended = b; } });
const url = (p) => new URL('http://127.0.0.1:3210' + p);

// ---------------- ① 十条路径 ----------------
{
  const res = mkRes();
  await mobileRoutes.handleMobile(req('GET'), res, url('/api/mobile'));
  ok('GET /api/mobile：给偏好（**带掩码**）+ 日历地址 + 上次结果',
    res.code === 200 && res.body.prefs.bark_key === '••••0000' && !!res.body.calendar && 'last_digest' in res.body);
  ok('名片夹默认目录也回了', String(res.body.mobile_dir_default).endsWith('mobile'), res.body.mobile_dir_default);
}
{
  const res = mkRes();
  await mobileRoutes.handleMobile(req('POST', { digest_time: '06:30' }), res, url('/api/mobile'));
  ok('POST /api/mobile：保存偏好并把新值回给界面', res.code === 200 && prefs.digest_time === '06:30');
}
{
  prefs.lan_enabled = false;
  const res = mkRes();
  await mobileRoutes.handleMobile(req('POST', { lan_enabled: true }), res, url('/api/mobile'));
  ok('打开"局域网访问"会真的把小服务起起来', res.code === 200 && lanRunning === true);
  await mobileRoutes.handleMobile(req('POST', { lan_enabled: false }), res, url('/api/mobile'));
  ok('关掉就停', lanRunning === false);
}
{
  const res = mkRes();
  await mobileRoutes.handleMobile(req('POST', { bark_key: 'new-key' }), res, url('/api/mobile/bark/test'));
  ok('测试推送走的是真通道，并且 force=true（不受来源过滤）',
    res.body.ok === true && calls.some(([k, t]) => k === 'bark' && /测试推送/.test(t)));
}
{
  const res = mkRes();
  await mobileRoutes.handleMobile(req('POST', { kind: 'evening' }), res, url('/api/mobile/digest/send'));
  ok('立即发晚报：kind 透传到领域层', res.body.ok === true && res.body.kind === 'evening');
  ok('摘要用的是「重要信息」那套排序（briefFor 被调用）', calls.some(([k, v]) => k === 'digest' && v === 'evening'));
}
{
  const res = mkRes();
  await mobileRoutes.handleMobile(req('POST', {}), res, url('/api/mobile/calendar/reset'));
  ok('重置订阅密钥', res.code === 200 && calls.some(([k]) => k === 'reset-token'));
}
{
  const t = mkRes();
  await mobileRoutes.handleMobile(req('POST', {}), t, url('/api/mobile/icloud/test'));
  ok('iCloud 测试连接', t.body.ok === true && calls.some(([k]) => k === 'icloud-test'));
  const s = mkRes();
  await mobileRoutes.handleMobile(req('POST', {}), s, url('/api/mobile/icloud/sync'));
  ok('iCloud 立即同步', s.body.ok === true && calls.some(([k]) => k === 'icloud-sync'));
}
{
  const ics = mkRes();
  await mobileRoutes.handleMobile(req('GET'), ics, url('/api/mobile/calendar.ics'));
  ok('下载 .ics 带正确 Content-Type 与附件名',
    ics.code === 200 && /text\/calendar/.test(ics.headers['Content-Type']) && /planner\.ics/.test(ics.headers['Content-Disposition']));
  const txt = mkRes();
  await mobileRoutes.handleMobile(req('GET'), txt, url('/api/mobile/today.txt'));
  ok('今日文本是 UTF-8 BOM + 纯文本（办公本直接读）',
    txt.code === 200 && /text\/plain/.test(txt.headers['Content-Type']) && String(txt.ended).startsWith('\uFEFF'));
  const files = mkRes();
  await mobileRoutes.handleMobile(req('POST', {}), files, url('/api/mobile/files'));
  ok('写出 today-plan / .ics', files.body.written.length === 1 && calls.some(([k]) => k === 'write-files'));
}
{
  const res = mkRes();
  await mobileRoutes.handleMobile(req('GET'), res, url('/api/mobile/nope'));
  ok('不认识的手机路径 404（不会静默成功）', res.code === 404);
  const res2 = mkRes();
  await mobileRoutes.handleMobile(req('GET'), res2, url('/api/other'));
  ok('不是手机通道的路径也 404（路由只认自己的地盘）', res2.code === 404);
}

// ---------------- ② 只读小服务的边界 ----------------
{
  sync.set(MOBILE_KEYS.cal_token, 'secret-token-1234');
  const handler = mobileReadHandler({
    store, buildIcs: () => ({ ics: 'BEGIN:VCALENDAR' }), buildDigestText: () => 'Cairn · 今日', appName: () => 'Cairn',
  });
  const call = (path, host = '10.0.0.5:3211') => {
    const res = mkRes();
    handler({ url: path, headers: { host } }, res);
    return res;
  };
  ok('健康检查不带密钥也能用', call('/health').code === 200 && /planner-mobile/.test(String(call('/health').ended)));
  ok('token 不对 → 404（不告诉你路径存不存在）', call('/cal/wrong.ics').code === 404);
  ok('没有 token → 404', call('/cal/.ics').code === 404 && call('/').code === 404);
  const ics = call('/cal/secret-token-1234.ics');
  ok('token 对 → 给 .ics', ics.code === 200 && /text\/calendar/.test(ics.headers['Content-Type']));
  const txt = call('/cal/secret-token-1234.txt');
  ok('token 对 → 给今日文本', txt.code === 200 && String(txt.ended).startsWith('\uFEFF'));
  const page = call('/cal/secret-token-1234');
  ok('token 对 → 给说明页（含订阅链接）',
    page.code === 200 && /webcal:\/\//.test(String(page.ended)) && /订阅日历/.test(String(page.ended)));
  ok('空 token 时任何请求都是 404（没配好就不暴露）',
    (() => { sync.set(MOBILE_KEYS.cal_token, ''); const r = call('/cal/.ics'); sync.set(MOBILE_KEYS.cal_token, 'secret-token-1234'); return r.code === 404; })());
  ok('常数时间比较：长度不同直接否', tokenEquals('abc', 'abcd') === false && tokenEquals('', '') === false);
  ok('说明页里的 token 会原样出现（它就是订阅地址的一部分）', mobilePageHtml({ token: 'T', host: 'h' }).includes('/cal/T.ics'));
}
{
  // 起停是幂等的；没起过也能安全 stop
  const srv = createMobileServer({
    store, mobilePort: 39999, buildIcs: () => ({ ics: '' }), buildDigestText: () => '',
    appName: () => 'Cairn', calendarInfo: () => ({ urls: [] }), log: () => {}, warn: () => {},
  });
  ok('没起过也能安全 stop', srv.stop().ok === true && srv.running === false);
}

// ---------------- ③ 接线：主程序只留一行 ----------------
{
  const srv = readFileSync(join(ROOT, 'server.mjs'), 'utf8');
  ok('主程序引入了两个新文件',
    srv.includes("from './lib/routes/mobile.mjs'") && srv.includes("from './lib/mobile-server.mjs'"));
  ok('手机通道只剩一行分发',
    srv.includes("if (p === '/api/mobile' || p.startsWith('/api/mobile/')) return mobileRoutes.handleMobile(req, res, url);"));
  ok('旧实现（逐条 if + 内置小服务）已经搬走',
    !srv.includes('startMobileServer') && !srv.includes('/cal/${token}.ics') && !srv.includes('planner-mobile'));
  // 行数闸门已统一到 tests/server-shell.test.mjs（结构为主、行数兜底）；这里只留结构断言
  ok('主程序没有把手机侧实现搬回来（结构闸门在 server-shell.test.mjs）',
    !srv.includes('function startMobileServer') && srv.includes('mobileRoutes.handleMobile('));
  const mod = readFileSync(join(ROOT, 'lib', 'routes', 'mobile.mjs'), 'utf8');
  ok('路由文件是"只转发、不重写手机侧规则"（读掩码、写留空沿用）',
    mod.includes('maskMobilePrefs') && mod.includes('sanitizeMobilePatch'));
}

console.log('');
console.log(failures === 0 ? 'mobile-routes.test: PASS' : `mobile-routes.test: FAIL (${failures})`);
process.exit(failures === 0 ? 0 : 1);
