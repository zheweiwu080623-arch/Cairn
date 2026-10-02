// Anthropic Messages API。
// 与 OpenAI 的两处差别：图片放在**前面**、鉴权用 x-api-key + anthropic-version。
export default {
  id: 'anthropic',
  label: 'Anthropic',
  needs_key: true,
  defaults: { base_url: 'https://api.anthropic.com/v1', model: 'claude-3-5-haiku-latest' },

  build({ cfg, base, text, images, system }) {
    const anthropicContent = images.length
      ? [
        ...images.map((im) => ({ type: 'image', source: { type: 'base64', media_type: im.mime || 'image/png', data: im.base64 } })),
        { type: 'text', text },
      ]
      : text;
    return {
      url: `${base}/messages`,
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': cfg.api_key,
        'anthropic-version': '2023-06-01',
      },
      body: {
        model: cfg.model, max_tokens: 1024, temperature: 0,
        ...(system ? { system } : {}),
        messages: [{ role: 'user', content: anthropicContent }],
      },
      images_ok: true,
    };
  },

  parse(json) {
    const parts = Array.isArray(json?.content) ? json.content : [];
    return parts.map((p) => (typeof p?.text === 'string' ? p.text : '')).join('').trim();
  },
};
