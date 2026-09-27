// routes/preclass.mjs —— 「上课前 Canvas 检查」的设置与状态
//
//   GET  /api/preclass  → 当前设置 + 接下来 N 分钟内的课（含"这节课查过没有"）+ 上次运行
//   POST /api/preclass  → 改设置（提前几分钟 / 是否应用内通知 / 是否推手机 / 只看最近多少小时）
//
// 只读写"设置"和"状态"，**不触发检查**（检查由心跳里的调度器按时间自动做）——
// 想手动试一次就走 `POST /api/modules/preclass-check/run`（默认演练，不会打扰你）。

import { PRECLASS_DEFAULT, normalizePreclass } from '../preclass.mjs';
import { PRECLASS_PREFS_KEY } from '../preclass-run.mjs';

export function createPreclassRoutes({ store, sendJson, sendError, readBody, runner, runsOf = () => null }) {
  const readPrefs = () => {
    try { return normalizePreclass(JSON.parse(store.getSync(PRECLASS_PREFS_KEY) || 'null') || {}); } catch { return normalizePreclass({}); }
  };

  const snapshot = () => ({
    ok: true,
    schema: 'preclass.v1',
    prefs: readPrefs(),
    defaults: { ...PRECLASS_DEFAULT },
    upcoming: (() => { try { return runner.upcoming(); } catch { return []; } })(),
    last: runsOf() || null,
  });

  async function handlePreclass(req, res, _url) {
    if (req.method === 'GET') return sendJson(res, 200, snapshot());
    if (req.method !== 'POST') return sendError(res, 405, '只支持 GET / POST');
    const body = (await readBody(req)) || {};
    const patch = body.prefs && typeof body.prefs === 'object' ? body.prefs : body;
    const next = normalizePreclass({ ...readPrefs(), ...patch, updated_at: Date.now() });
    store.setSync(PRECLASS_PREFS_KEY, JSON.stringify(next));
    return sendJson(res, 200, snapshot());
  }

  return { handlePreclass, snapshot, readPrefs };
}
