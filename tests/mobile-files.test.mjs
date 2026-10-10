// 手机端「文件」页（/f/<token>/，lib/mobile-files.mjs）的验证。
//
//   node tests/mobile-files.test.mjs
//
// 断言四件事：
//   ① token 不对一律 404（跟其它路径同一把锁）；没接线 → 503；
//   ② 上传/下载/列表能真跑通（在临时目录里，不碰真数据）；
//   ③ **出不去的边界**：带路径、以点开头、反斜杠的名字全拒，且目标目录外不留痕；
//   ④ 大小上限：超了回 413 而不是先写一半。

import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { mobileReadHandler } from '../lib/mobile-server.mjs';
import { MOBILE_KEYS } from '../lib/mobile.mjs';

let failures = 0;
const ok = (label, cond, detail = '') => {
  if (cond) console.log(`  PASS ${label}`);
  else { failures += 1; console.log(`  FAIL ${label}${detail ? ` -- ${detail}` : ''}`); }
};

console.log('mobile-files.test.mjs');

const TOKEN = 'files-token-9876';
const sync = new Map([[MOBILE_KEYS.cal_token, TOKEN]]);
const store = { getSync: (k) => (sync.has(k) ? sync.get(k) : null), setSync: (k, v) => sync.set(k, v) };

const work = mkdtempSync(join(tmpdir(), 'cairn-files-'));
const share = join(work, 'share');
mkdirSync(share, { recursive: true });

const mkRes = () => ({
  code: null, headers: null, ended: null,
  writeHead(c, h) { this.code = c; this.headers = h; },
  end(b) { this.ended = b; },
  on() {},
});

const handler = mobileReadHandler({
  store,
  buildIcs: () => ({ ics: 'BEGIN:VCALENDAR' }),
  buildDigestText: () => 'Cairn · 今日',
  appName: () => 'Cairn',
  fileDir: share,
  fileMaxMb: 1,                     // 测试里把上限压到 1 MB，方便验 413
});

const call = async (path, { method = 'GET', body } = {}) => {
  const res = mkRes();
  await handler({ url: path, method, headers: { host: '10.0.0.5:3211' }, body }, res);
  return res;
};
const json = (res) => { try { return JSON.parse(String(res.ended)); } catch { return null; } };

// ---------------- ① 锁与接线 ----------------
{
  ok('token 不对 → 404（列表 / 页面 / 下载 / 上传都一样）',
    (await call('/f/wrong/list.json')).code === 404
    && (await call('/f/wrong/')).code === 404
    && (await call('/f/wrong/dl/a.txt')).code === 404
    && (await call('/f/wrong/up/a.txt', { method: 'POST', body: 'x' })).code === 404);
  ok('没有 token → 404', (await call('/f//list.json')).code === 404);

  const bare = mobileReadHandler({ store, buildIcs: () => ({ ics: '' }), buildDigestText: () => '', appName: () => 'Cairn' });
  const r = mkRes();
  bare({ url: `/f/${TOKEN}/list.json`, method: 'GET', headers: { host: 'h' } }, r);
  ok('没接线的文件页 → 503（不是 500）', r.code === 503, String(r.code));

  const page = await call(`/f/${TOKEN}/`);
  ok('页面能出来（用相对地址请求，页面里没有 file:// 这种浏览器打不开的东西）',
    page.code === 200 && /up\//.test(String(page.ended)) && /list\.json/.test(String(page.ended))
    && !/file:\/\//.test(String(page.ended)));
}

// ---------------- ② 列表 / 上传 / 下载 ----------------
{
  const empty = await call(`/f/${TOKEN}/list.json`);
  ok('初始列表为空', empty.code === 200 && json(empty).files.length === 0, String(empty.ended));

  const up = await call(`/f/${TOKEN}/up/hello.txt`, { method: 'POST', body: '你好，平板' });
  ok('上传成功', up.code === 200 && json(up).ok === true, String(up.ended));
  ok('内容真的落盘了', readFileSync(join(share, 'hello.txt'), 'utf8') === '你好，平板');

  const listed = json(await call(`/f/${TOKEN}/list.json`)).files;
  ok('列表里有它（名字 + 字节数）',
    listed.length === 1 && listed[0].name === 'hello.txt' && listed[0].size === Buffer.byteLength('你好，平板'),
    JSON.stringify(listed));

  const again = await call(`/f/${TOKEN}/up/hello.txt`, { method: 'POST', body: 'overwritten' });
  ok('同名再传 = 覆盖（不是生成 -1）',
    again.code === 200 && readFileSync(join(share, 'hello.txt'), 'utf8') === 'overwritten'
    && json(await call(`/f/${TOKEN}/list.json`)).files.length === 1);

  const dl = await call(`/f/${TOKEN}/dl/hello.txt`);
  ok('下载：200 + 内容 + attachment 头',
    dl.code === 200 && String(dl.ended) === 'overwritten'
    && /attachment/.test(String(dl.headers['Content-Disposition'])));
  ok('下载不存在的 → 404', (await call(`/f/${TOKEN}/dl/nope.txt`)).code === 404);
  const cnUp = await call(`/f/${TOKEN}/up/${encodeURIComponent('第 3 周 作业.pdf')}`, { method: 'POST', body: 'pdf' });
  ok('中文/空格文件名也能传（名字用 URL 编码）',
    cnUp.code === 200 && existsSync(join(share, '第 3 周 作业.pdf')), String(cnUp.ended));
}

// ---------------- ③ 出不去的边界 ----------------
{
  const outside = join(work, 'evil.txt');
  const cases = [
    ['带路径（编码的斜杠）', `/f/${TOKEN}/up/..%2Fevil.txt`],
    ['裸 ..', `/f/${TOKEN}/up/..`],
    ['反斜杠', `/f/${TOKEN}/up/${encodeURIComponent('..\\evil.txt')}`],
    ['隐藏文件', `/f/${TOKEN}/up/.secret`],
    ['子目录形式', `/f/${TOKEN}/up/${encodeURIComponent('sub/evil.txt')}`],
  ];
  let allRejected = true;
  for (const [label, path] of cases) {
    const r = await call(path, { method: 'POST', body: 'x' });
    // 裸 `..` 会被 URL 解析器先规范化（变成上层的目录），到不了处理器 —— 404 也算拒了。
    if (r.code !== 400 && r.code !== 404) { allRejected = false; console.log(`    · ${label} 没被拒：${r.code}`); }
  }
  ok('五种越界名字全被拒（不写盘）', allRejected);
  ok('目标目录外没有留下任何东西', !existsSync(outside));
  ok('隐藏文件下载也拒', (await call(`/f/${TOKEN}/dl/.secret`)).code === 400);

  writeFileSync(join(share, '.hidden'), 'x');
  mkdirSync(join(share, 'subdir'), { recursive: true });
  writeFileSync(join(share, 'subdir', 'inner.txt'), 'x');
  const names = json(await call(`/f/${TOKEN}/list.json`)).files.map((f) => f.name);
  ok('列表不列隐藏文件、也不递归子目录', !names.includes('.hidden') && !names.includes('inner.txt'), JSON.stringify(names));
}

// ---------------- ④ 大小上限 ----------------
{
  const big = Buffer.alloc(1024 * 1024 + 10, 0x41);      // 1 MB 上限 + 10 B
  const r = await call(`/f/${TOKEN}/up/big.bin`, { method: 'POST', body: big });
  ok('超限 → 413', r.code === 413, String(r.code));
  ok('超限的文件一个字节都没写', !existsSync(join(share, 'big.bin')));
  const okSize = await call(`/f/${TOKEN}/up/small.bin`, { method: 'POST', body: Buffer.alloc(1000, 1) });
  ok('没超限的正常写入', okSize.code === 200 && existsSync(join(share, 'small.bin')));
}

// ---------------- ⑤ 未知动作 ----------------
{
  ok('未知子路径 → 404', (await call(`/f/${TOKEN}/whatever`)).code === 404);
}

console.log(failures === 0 ? '\n全部通过 ✓' : `\n${failures} 项失败 ✗`);
process.exit(failures === 0 ? 0 : 1);
