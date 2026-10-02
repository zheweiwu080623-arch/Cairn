# 加一家模型供应商，要改哪些地方？

**两个地方，别处都不用动：**

1. 在 `providers/` 下照着 `openai.mjs` 复制一个新文件（比如 `moonshot.mjs`）；
2. 在 `index.mjs` 的 `REGISTRY` 数组里加一行 import 与一个元素。

改完之后自动获得：拼请求、解析响应、默认地址与默认模型、可用性判断（`llmReady`）、
下拉框选项（`LLM_PROVIDERS` / `PROVIDER_DEFAULTS`）——**`lib/llm.mjs` 与所有调用方一行都不用改**。

## 一个 provider 文件长什么样

```js
export default {
  id: 'moonshot',                 // 唯一 id，会出现在配置与界面上
  label: 'Moonshot',              // 界面上的中文名
  needs_key: true,                // 远程接口需要 Key（本机地址会被自动豁免）
  defaults: { base_url: 'https://api.moonshot.cn/v1', model: 'moonshot-v1-8k' },

  // 拼 HTTP 请求。返回 null 表示"这家不走 HTTP"（例如本机 CLI 通道）。
  // ctx = { cfg, base, text, images, system, openAiContent }
  build(ctx) { return { url, method, headers, body, images_ok }; },

  // 从响应 JSON 里取正文（纯函数，取不到就返回空串）。
  parse(json) { return ''; },

  // 可选：这家有特殊要求时才写（不写就走通用规则：有地址、远程地址要有 Key）
  ready(cfg) { return { ready: true, why: '' }; },

  // 可选：这家要特殊文案时才写（不写就是「<label> · <model>（无 Key）」）
  describe(cfg) { return ''; },
};
```

## 注意

- **`build` 与 `parse` 必须是纯函数**（不碰文件、不发请求）——`tests/llm.test.mjs` 直接比对 URL/头/体，
  真调用在 `askLlm` 那一层。
- **图片支持**：OpenAI 风格用 `openAiContent`（已备好），Anthropic 把图放前面并用自己的字段，
  Respons-es 接口用 `input_image`。不支持的通道请在 `build` 里忽略 `images`。
- 加完记得 `node tests/llm-providers.test.mjs`（会检查每家都实现了同一套契约）。
