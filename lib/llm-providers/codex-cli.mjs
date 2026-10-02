// 本机 Codex CLI 通道：**不走 HTTP** —— 由 server.mjs 直接 spawn（原路径，未改动）。
export default {
  id: 'codex-cli',
  label: '本机 Codex CLI',
  needs_key: false,
  defaults: { base_url: '', model: '' },

  build() { return null; },          // 不走 HTTP 的通道显式返回 null
  parse() { return ''; },
  ready() { return { ready: true, why: '' }; },
  describe() { return '本机 Codex CLI'; },
};
