// 「沿用本机 Codex 配置」通道（2026-09-22 新增）。
//
// 很多人的"agent"其实是别的模型跑在 Codex 壳子里（例如 DeepSeek + 本机中转），
// 这条通道直接读 ~/.codex/config.toml 的 provider 信息，不用再粘一次 Key。
// 地址与令牌在**调用那一刻**才由 server.mjs 取，所以这里只检查"这份配置读到了没"。
export default {
  id: 'codex-config',
  label: '沿用本机 Codex 配置',
  needs_key: false,
  defaults: { base_url: '', model: '' },

  build({ cfg, base, text, images, system, openAiContent }) {
    // Codex 壳子通常用 Responses 接口（wire_api = "responses"）；
    // 也有中转只支持 chat/completions，所以按配置里写的来。
    const wantResponses = /responses/i.test(cfg.wire_api || '');
    if (wantResponses) {
      // Responses 接口的图：content 里放 input_text + input_image（data URL）。
      // 2026-09-27 实测：不给图它会回"本轮消息未包含可读取的截图" —— 那是图根本没送出去。
      return {
        url: `${base}/responses`,
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${cfg.api_key}` },
        body: {
          model: cfg.model,
          input: images.length
            ? [{
              role: 'user',
              content: [
                { type: 'input_text', text },
                ...images.map((im) => ({ type: 'input_image', image_url: `data:${im.mime || 'image/png'};base64,${im.base64}` })),
              ],
            }]
            : text,
          ...(system ? { instructions: system } : {}),
          stream: false,
        },
        images_ok: true,
      };
    }
    const messages = [];
    if (system) messages.push({ role: 'system', content: system });
    messages.push({ role: 'user', content: openAiContent });
    return {
      url: `${base}/chat/completions`,
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${cfg.api_key}` },
      body: { model: cfg.model, messages, temperature: 0, stream: false },
      images_ok: true,
    };
  },

  parse(json) {
    try {
      // Responses 接口（2026-09-22 实测修正）：
      // 推理模型的返回里，`output` 是**两个并列项** —— 先 reasoning（思考过程）、后 message（真正的回答）。
      // 早先的写法把所有 content.text 拼在一起，于是用户看到一堵"思考墙"。
      // 正确做法：**只取 message 项里的 output_text**，跳过 reasoning。
      const parts = [];
      for (const item of Array.isArray(json?.output) ? json.output : []) {
        if (item?.type && item.type !== 'message') continue;         // 跳过 reasoning 等非回答项
        for (const c of Array.isArray(item?.content) ? item.content : []) {
          if (c?.type === 'reasoning_text' || c?.type === 'reasoning') continue;
          if (typeof c?.text === 'string') parts.push(c.text);
        }
      }
      if (parts.length) return parts.join('').trim();
      // 有些中转会额外给一个 output_text 便利字段（没有 output 时才用它）
      if (typeof json?.output_text === 'string' && json.output_text.trim()) return json.output_text.trim();
      // 兼容中转实际返回 chat/completions 形状的情况
      const c0 = json?.choices?.[0];
      return String(c0?.message?.content ?? c0?.text ?? '').trim();
    } catch {
      return '';
    }
  },

  ready(cfg) {
    if (!cfg.base_url) return { ready: false, why: '没读到本机 Codex 配置（~/.codex/config.toml）' };
    if (!cfg.model) return { ready: false, why: '本机 Codex 配置里没有 model' };
    return { ready: true, why: '' };
  },

  describe(cfg) {
    return `沿用本机 Codex 配置 · ${cfg.model}${/responses/i.test(cfg.wire_api || '') ? '（Responses 接口）' : ''}`;
  },
};
