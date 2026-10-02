// 本机备用投递口（2026-10-01）：邮件发不出去时，外部邮件桥把内容投到本机 Cairn。
//
//   node tests/local-drop.test.mjs
//
// 判据：
//   * **只认本机**：非 loopback 的请求一律拒绝（这是本机互投，不是对外接口）；
//   * 空正文拒绝；正文按 20000 字截断；
//   * 写进「通知」页（source=mail-bridge）并如实标注"走的是备用通道 + 为什么"；
//   * 带 ref 时按 external_id 去重（对侧重试不会刷屏）；
//   * 手机推送：**绕过"重点来源"过滤**（故障兜底必须看得见），但仍然尊重免打扰；
//     urgent:true 才连免打扰一起绕过；
//   * 接线：server.mjs 用的是这个路由模块，对侧邮件桥打的就是这个地址。

import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  LOCAL_DROP_MAX_CHARS, LOCAL_DROP_SOURCE, createLocalDropRoutes, ingestLocalDrop, isLoopbackRequest,
} from '../lib/routes/local-drop.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const read = (p) => readFileSync(join(ROOT, p), 'utf8');

let failures = 0;
const ok = (label, cond, detail = '') => {
  if (cond) console.log(`  PASS ${label}`);
  else { failures += 1; console.log(`  FAIL ${label}${detail ? ` -- ${detail}` : ''}`); }
};

console.log('local-drop.test.mjs');

// ---------------- 假的 store / barkNotify ----------------
function makeStore() {
  const rows = [];
  return {
    rows,
    listNotifications: () => rows,
    createNotification: (n) => { const row = { id: `id-${rows.length + 1}`, ...n }; rows.push(row); return row; },
  };
}
const loopback = { socket: { remoteAddress: '127.0.0.1' } };
const remote = { socket: { remoteAddress: '192.168.1.44' } };

// ---------------- ① 只认本机 ----------------
{
  ok('127.0.0.1 算本机', isLoopbackRequest(loopback) === true);
  ok('::1 / ::ffff:127.0.0.1 也算本机',
    isLoopbackRequest({ socket: { remoteAddress: '::1' } }) === true
    && isLoopbackRequest({ socket: { remoteAddress: '::ffff:127.0.0.1' } }) === true);
  ok('局域网地址不算本机', isLoopbackRequest(remote) === false);
  const store = makeStore();
  const r = await ingestLocalDrop(remote, { title: 'x', body: 'y' }, { store });
  ok('非本机投递 → 拒绝，且不写库', r.ok === false && r.error.includes('本机') && store.rows.length === 0, JSON.stringify(r));
}

// ---------------- ② 校验与截断 ----------------
{
  const store = makeStore();
  const empty = await ingestLocalDrop(loopback, { title: 'x', body: '   ' }, { store });
  ok('空正文 → 拒绝', empty.ok === false && empty.error.includes('正文') && store.rows.length === 0);

  const long = await ingestLocalDrop(loopback, { title: 't', body: '字'.repeat(LOCAL_DROP_MAX_CHARS + 500) }, { store });
  ok('超长正文按上限截断（并写明已截断）',
    long.ok === true && store.rows[0].message.includes('已截断')
    && store.rows[0].message.length < LOCAL_DROP_MAX_CHARS + 400, String(store.rows[0].message.length));
}

// ---------------- ③ 写进通知页 + 如实标注 ----------------
{
  const store = makeStore();
  const pushes = [];
  const r = await ingestLocalDrop(loopback,
    { title: '📮 回信（备用通道）｜测试', body: '正文内容', kind: 'reply', ref: 'reply-1.eml', reason: '邮件发不出去：535' },
    { store, barkNotify: async (a) => { pushes.push(a); return { ok: true }; }, log: () => {} });
  const row = store.rows[0];
  ok('投递成功 → 返回 notification_id', r.ok === true && !!r.notification_id);
  ok('写进通知页的来源是中性的 mail-bridge（对外材料里不出现另一个项目的名字）',
    row.source === LOCAL_DROP_SOURCE && LOCAL_DROP_SOURCE === 'mail-bridge', row.source);
  ok('external_id 用 ref 去重（重试不会刷屏）', row.external_id === 'mail-bridge-reply-1.eml', row.external_id);
  ok('正文里如实写明"备用通道 + 为什么"',
    row.message.includes('备用通道') && row.message.includes('535') && row.message.includes('照常补发'));
  ok('优先级提到 1（要看得见）', row.priority === 1);
  ok('手机推送：绕过"重点来源"过滤，但没绕过免打扰',
    pushes.length === 1 && pushes[0].ignoreSource === true && pushes[0].force === false, JSON.stringify(pushes));

  // 同 ref 再来一次 → duplicate
  const again = await ingestLocalDrop(loopback, { title: 'x', body: 'y', ref: 'reply-1.eml' }, { store, barkNotify: async () => ({ ok: true }) });
  ok('同 ref 再投 → skipped=duplicate，且不新增通知',
    again.ok === true && again.skipped === 'duplicate' && store.rows.length === 1);
}

// ---------------- ③b silent：只记不弹（给"任务完成"这类只为推手机的短消息） ----------------
{
  const store = makeStore();
  // 标题里不要出现另一条产品线的名字：对外发的体验包会做"整包 0 处提到那个名字"的体检。
  await ingestLocalDrop(loopback, { title: '📮 邮件桥：任务完成', body: '回信已发出', silent: true },
    { store, barkNotify: async () => ({ ok: true }) });
  ok('silent:true → 通知记下来，但标成"已触发"（不弹系统通知）',
    store.rows[0].last_fired_at !== undefined && store.rows[0].source === LOCAL_DROP_SOURCE,
    JSON.stringify(store.rows[0].last_fired_at));
  const store2 = makeStore();
  await ingestLocalDrop(loopback, { title: 't', body: 'b' }, { store: store2, barkNotify: async () => ({ ok: true }) });
  ok('不带 silent → 照旧会弹（真正"内容丢了"那种要让你立刻看见）',
    store2.rows[0].last_fired_at === undefined);
}

// ---------------- ④ urgent 才连免打扰一起绕过；push:false 就不推 ----------------
{
  const store = makeStore();
  const pushes = [];
  await ingestLocalDrop(loopback, { title: 'a', body: 'b', urgent: true },
    { store, barkNotify: async (a) => { pushes.push(a); return { ok: true }; } });
  ok('urgent:true → force=true（连免打扰一起绕过）', pushes[0].force === true);

  const pushes2 = [];
  await ingestLocalDrop(loopback, { title: 'a', body: 'b', push: false },
    { store, barkNotify: async (a) => { pushes2.push(a); return { ok: true }; } });
  ok('push:false → 不推手机（但仍然进通知页）', pushes2.length === 0 && store.rows.length === 2,
    `pushes2=${pushes2.length} rows=${store.rows.length} rowsDetail=${JSON.stringify(store.rows.map((r) => r.title))}`);
}

// ---------------- ⑤ 路由：GET 探测 / POST 投递 / 其它 404 ----------------
{
  const store = makeStore();
  const routes = createLocalDropRoutes({
    store,
    sendJson: (res, code, obj) => { res.code = code; res.body = obj; },
    sendError: (res, code, msg) => { res.code = code; res.body = { error: msg }; },
    readBody: async (req) => req.body || {},
    barkNotify: async () => ({ ok: false, skipped: 'no-key' }),
    log: () => {},
  });
  const url = new URL('http://127.0.0.1:3210/api/local-drop');
  const res1 = {};
  await routes.handleLocalDrop({ method: 'GET', socket: { remoteAddress: '127.0.0.1' } }, res1, url);
  ok('GET 是就绪探测（给对侧邮件桥的 --doctor 用）',
    res1.code === 200 && res1.body.ok === true && res1.body.schema === 'local-drop.v1');

  const res2 = {};
  await routes.handleLocalDrop(
    { method: 'POST', body: { title: 't', body: 'b' }, socket: { remoteAddress: '127.0.0.1' } }, res2, url);
  ok('POST 投递成功', res2.code === 200 && res2.body.ok === true && !!res2.body.notification_id);
  ok('推送失败（没配 Bark）不影响投递成功', res2.body.pushed && res2.body.pushed.skipped === 'no-key');

  const res3 = {};
  await routes.handleLocalDrop({ method: 'POST', body: {}, socket: { remoteAddress: '127.0.0.1' } }, res3,
    new URL('http://127.0.0.1:3210/api/别的地方'));
  ok('别的路径 → 404', res3.code === 404);

  const res4 = {};
  await routes.handleLocalDrop({ method: 'DELETE', socket: { remoteAddress: '127.0.0.1' } }, res4, url);
  ok('只支持 GET / POST', res4.code === 405);
}

// ---------------- ⑥ 接线守卫（Cairn 这侧 + 对侧邮件桥那侧） ----------------
{
  const srv = read('server.mjs');
  ok('server.mjs 用上了这个路由模块（不在主程序里手写一遍）',
    srv.includes("import { createLocalDropRoutes } from './lib/routes/local-drop.mjs'")
    && srv.includes('localDrop.handleLocalDrop(req, res, url)'));
  ok('barkNotify 支持 ignoreSource（备用通道要绕过"重点来源"过滤）',
    srv.includes('ignoreSource = false') && srv.includes('!ignoreSource && !barkSourceAllowed'));
  // 对侧邮件桥的源码在**本仓库之外**（每台机器上位置不同），所以：
  //   * 位置由环境变量给（CAIRN_MAIL_BRIDGE_DIR），没给就如实跳过；
  //   * 这里刻意**不写死那边的路径与项目名** —— 对外发的体验包里不许出现它
  //     （2026-10-02：这一条以前写死了路径，重打体验包时被隐私体检抓了出来）。
  const bridgeDir = process.env.CAIRN_MAIL_BRIDGE_DIR || '';
  const pyFiles = [];
  if (bridgeDir && existsSync(bridgeDir)) {
    const walk = (d, depth = 0) => {
      if (depth > 4) return;
      let items = [];
      try { items = readdirSync(d, { withFileTypes: true }); } catch { return; }
      for (const it of items) {
        const full = join(d, it.name);
        if (it.isDirectory()) walk(full, depth + 1);
        else if (it.name.endsWith('.py')) pyFiles.push(full);
      }
    };
    walk(bridgeDir);
  }
  if (!pyFiles.length) {
    console.log('  SKIP 对侧邮件桥的接线守卫（设 CAIRN_MAIL_BRIDGE_DIR 指向它的源码目录才会跑）');
  } else {
    const all = pyFiles.map((f) => readFileSync(f, 'utf8')).join('\n');
    ok('对侧适配器打的就是这个地址', all.includes('/api/local-drop') && all.includes('DEFAULT_URL'));
    ok('对侧发信失败后会走备用通道', all.includes('local_drop.deliver'));
    ok('对侧回信失败后也会走备用通道（且不改邮件状态）',
      all.includes('local_drop.deliver') && all.includes('retry_outbox 会在邮件恢复后照常补发'));
  }
}

console.log('');
console.log(failures === 0 ? 'local-drop.test: PASS' : `local-drop.test: FAIL (${failures})`);
process.exit(failures === 0 ? 0 : 1);
