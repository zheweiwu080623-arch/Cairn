// OpenAI 兼容通道：OpenAI / DeepSeek / Moonshot / vLLM / LM Studio …都走这一家。
// 约定见 ./README.md（新增一个供应商 = 复制一个文件 + 在 index.mjs 注册一行）。
export default {
  id: 'openai',
  label: 'OpenAI 兼容接口',
  needs_key: true,
  defaults: { base_url: 'https://api.openai.com/v1', model: 'gpt-4o-mini' },

  /** 拼 HTTP 请求（纯函数）。ctx 由 lib/llm.mjs 统一准备好。 */
  build({ cfg, base, system, openAiContent }) {
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
    const c = json?.choices?.[0];
    return String(c?.message?.content ?? c?.text ?? '').trim();
  },
};
