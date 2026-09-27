// routes/function-settings.mjs —— 「每个功能自己的设置」的接口（2026-09-27 新增）
//
//   GET  /api/fn-settings          → 已登记功能的当前值 + 默认值 + 字段声明（界面照着画抽屉）
//   POST /api/fn-settings          → { fn, patch } 改一个功能的值（只认声明过的字段，其余忽略）
//   POST /api/fn-settings/preview  → { fn, template } 拿真实台账算"改完名字会变成什么"（只算不写）
//
// 为什么要有它：设置页不该收所有功能的细项。谁的东西放谁的页面上 ——
// 功能页右上角那颗「⚙ 功能设置」从这里取值；值的存法见 lib/function-settings.mjs（`fn_<id>` 一个键）。

import {
  FUNCTION_SETTINGS, courseAssistNamePreview, getFunctionSettings, listFunctionSettings, setFunctionSettings,
} from '../function-settings.mjs';

export function createFunctionSettingsRoutes({ sendJson, sendError, readBody, store = null, log = () => {} } = {}) {
  const opts = store ? { store } : {};
  const known = () => Object.keys(FUNCTION_SETTINGS).join(' / ');

  async function handleFnSettings(req, res, url) {
    const p = url.pathname;
    const method = req.method;

    if (p === '/api/fn-settings' && method === 'GET') return sendJson(res, 200, listFunctionSettings(opts));

    if (p === '/api/fn-settings' && method === 'POST') {
      const b = (await readBody(req)) || {};
      const fn = String(b.fn || '');
      const r = setFunctionSettings(fn, b.patch || {}, opts);
      if (!r.ok) return sendError(res, 400, `${r.error}（现在登记过的功能：${known()}）`);
      log(`[fn-settings] ${fn} 已更新`);
      return sendJson(res, 200, r);
    }

    if (p === '/api/fn-settings/preview' && method === 'POST') {
      const b = (await readBody(req)) || {};
      const fn = String(b.fn || '');
      if (fn !== 'course_assist') {
        return sendError(res, 400, `这个功能还没做预览：${fn || '（空）'}（现在只有 course_assist）`);
      }
      // 只预览、不保存：用户还在改模板的输入框里打字，不该每一敲就落一次盘
      return sendJson(res, 200, courseAssistNamePreview({ template: b.template, ...opts }));
    }

    if (p.startsWith('/api/fn-settings/') && method === 'GET') {
      const fn = p.slice('/api/fn-settings/'.length).replace(/\/+$/, '');
      const one = getFunctionSettings(fn, opts);
      if (!one.ok) return sendError(res, 404, `${one.error}（现在登记过的功能：${known()}）`);
      return sendJson(res, 200, one);
    }

    return sendError(res, 404, '没有这个接口');
  }

  return { handleFnSettings };
}
