// 本地模型（Ollama）：默认 http://127.0.0.1:11434，不需要 Key。
export default {
  id: 'ollama',
  label: '本地模型（Ollama）',
  needs_key: false,
  defaults: { base_url: 'http://127.0.0.1:11434', model: 'qwen2.5:7b' },

  build({ cfg, base, text, images, system }) {
    const messages = [];
    if (system) messages.push({ role: 'system', content: system });
    // Ollama 的 chat 接口认 images:[base64]（不带 data: 前缀）
    messages.push({ role: 'user', content: text, ...(images.length ? { images: images.map((im) => im.base64) } : {}) });
    return {
      url: `${base}/api/chat`,
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: { model: cfg.model, messages, stream: false },
      images_ok: true,
    };
  },

  parse(json) {
    return String(json?.message?.content ?? json?.response ?? '').trim();
  },
};
