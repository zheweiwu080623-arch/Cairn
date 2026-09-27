// routes/digest.mjs —— 「日报 / 晚报」的接口
//
//   GET  /api/digest            → 现在该看的那一份（?kind=auto|morning|evening|both）
//   POST /api/digest/push       → 把这份摘要推到你手机（Bark）；没配就说人话
//   POST /api/digest/advice     → 让 agent 写 2~3 条建议（非高峰才跑；高峰/失败回落规则版）
//
// 为什么单独一个文件：跟 priority 一样——逻辑在 lib/digest.mjs（纯函数），这里只做
// "取料 → 算 → 回话"。**排序不在这里**：直接复用 lib/routes/priority.mjs 的 computePriority()，
// 保证"哪条重要"全项目只有一个定义。
//
// 三条设计约束（和 priority 那套一致）：
//   1) **不改现有推送**：定时邮件（buildDigestText）、日常通知、Canvas 巡检都不受影响；
//      日报/晚报要么是你点开看，要么是你按「推到手机」——不会自己发。
//   2) **不联网也能用**：规则版建议离线可用，只有点「让 agent 写建议」才联网，且只在非高峰。
//   3) **失败说人话**：agent/推送失败都翻成"下一步该干什么"，不丢英文报错。

import { buildBrief, buildBriefPrompt, normalizeKind } from '../digest.mjs';
import { explainAgentFailure, extractAdviceText } from './priority.mjs';

export function createDigestRoutes(ctx) {
  const {
    store, sendJson, sendError, readBody,
    priority,                 // lib/routes/priority.mjs 的返回值（复用排序与规则版建议）
    getPlan,                  // () => buildPlan(store, { days: 2 })
    appName = () => 'Cairn',
    pushBark,                 // (o) => Promise<{ok, skipped?, error?}>
    isPeak = () => false,
    askAgent,
  } = ctx;

  /** 算一份摘要。kind 只认 morning / evening（auto 由调用方先收好）。 */
  function makeBrief(kind) {
    const k = normalizeKind(kind);
    const { result, advice } = priority.computePriority({ top: 12 });
    return buildBrief({
      kind: k,
      appName: appName(),
      plan: getPlan(),
      ranked: result.ranked,
      advice,
    });
  }

  async function handleDigest(req, res, url) {
    const p = url.pathname;
    const method = req.method;

    // ---- 看摘要（默认：16:00 前早报、之后晚报）----
    if (p === '/api/digest' && method === 'GET') {
      const asked = String(url.searchParams.get('kind') || 'auto').toLowerCase();
      const kinds = asked === 'both'
        ? ['morning', 'evening']
        : [normalizeKind(asked)];
      const briefs = {};
      for (const k of kinds) briefs[k] = makeBrief(k);
      const primary = kinds[0];
      return sendJson(res, 200, {
        ok: true,
        schema: 'digest.v1',
        kind: primary,
        brief: briefs[primary],
        briefs,
        text: briefs[primary].text,
      });
    }

    // ---- 推到手机（显式动作；不会自己发）----
    if (p === '/api/digest/push' && method === 'POST') {
      const body = await readBody(req);
      const brief = makeBrief(body && body.kind ? body.kind : 'auto');
      let r;
      try {
        r = await pushBark({ title: brief.push.title, body: brief.push.body, level: 'active', source: 'digest' });
      } catch (e) {
        r = { ok: false, error: e.message };
      }
      if (r && r.ok) {
        return sendJson(res, 200, { ok: true, kind: brief.kind, sent: brief.push, result: r });
      }
      return sendJson(res, 200, { ok: false, kind: brief.kind, error: explainPushFailure(r), result: r || null });
    }

    // ---- 让 agent 写建议（非高峰才跑）----
    if (p === '/api/digest/advice' && method === 'POST') {
      const body = await readBody(req);
      const brief = makeBrief(body && body.kind ? body.kind : 'auto');
      const peak = isPeak(new Date());
      if (peak) {
        return sendJson(res, 200, {
          ok: false, skipped: 'peak', kind: brief.kind,
          advice: brief.advice, advice_source: 'rules',
          message: '现在是高峰时段，先给你规则版建议（等非高峰再让 agent 做更细的分析）。',
        });
      }
      let r;
      try {
        r = await askAgent(buildBriefPrompt(brief));
      } catch (e) {
        r = { ok: false, error: e.message };
      }
      if (!r || r.ok !== true) {
        return sendJson(res, 200, {
          ok: false, kind: brief.kind,
          error: (r && r.error) || 'agent 没有返回内容',
          advice: brief.advice, advice_source: 'rules',
          message: explainAgentFailure(r && r.error),
        });
      }
      const text = extractAdviceText(r.text, { maxChars: 400 });
      if (!text) {
        return sendJson(res, 200, {
          ok: false, kind: brief.kind, via: r.via || null,
          advice: brief.advice, advice_source: 'rules',
          message: '模型这次只返回了思考过程、没有给出结论（这类推理模型偶尔会这样）。先给你规则版建议。',
        });
      }
      return sendJson(res, 200, { ok: true, kind: brief.kind, text, via: r.via || null, advice_source: 'agent' });
    }

    return sendError(res, 404, '没有这个接口');
  }

  return { handleDigest, makeBrief };
}

/** 推送失败时给一句"照着做"的话（而不是丢一个 skipped 代号）。 */
export function explainPushFailure(r) {
  if (!r) return '推送没有成功，也没拿到原因；可以到「数据源 → 手机通道」看一眼配置。';
  if (r.skipped === 'no-key' || /密钥/.test(String(r.error || ''))) {
    return '还没有配手机推送（Bark 密钥）：到「数据源 → 手机通道」填一下就能推；不想配也可以直接看这份摘要。';
  }
  if (r.skipped === 'source-filtered') {
    return '这条推送被来源过滤挡掉了；到「数据源 → 手机通道」把来源放开，或直接用摘要。';
  }
  if (r.skipped === 'rate-limited') {
    return '短时间内推得太多了，先按住不发（避免刷屏）；过几分钟再试。';
  }
  if (r.error) return `推送失败：${String(r.error).slice(0, 120)}`;
  return '推送没有成功，可以先看这份摘要，稍后再试一次。';
}
