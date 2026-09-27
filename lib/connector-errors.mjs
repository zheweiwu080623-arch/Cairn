// 把连接器的原始报错翻译成"人话 + 下一步怎么做"（W4-2 连接向导）。
//
// 为什么值得单独做一个文件：用户填 Token / 邮箱密码失败时，原始报错是
// `401 Unauthorized` / `LOGIN failed` / `getaddrinfo ENOTFOUND` 这种，
// 新手完全不知道哪里错了。这里做纯字符串映射，**可测试、可复用、无副作用**。

const RULES = [
  // ---- Canvas / HTTP API ----
  [/\b401\b|unauthorized|invalid token|invalid access token/i,
    '令牌无效或已过期。请到 Canvas →「账号 → 设置 → 新建访问令牌」重新生成一个，粘过来时注意别带空格。'],
  [/\b403\b|forbidden/i,
    '令牌有效但没有权限。请确认这个账号能看到你要导入的课程，或重新生成一个有完整权限的令牌。'],
  [/\b404\b|not found/i,
    '地址不对：域名要形如 `https://school.instructure.com`（不要带 /courses 之类的路径），也不要漏掉 https://'],
  [/证书|certificate|self.?signed|SSL|TLS/i,
    '证书校验失败。可能是学校自签名证书或中间网络拦截 —— 先确认浏览器能正常打开该域名。'],

  // ---- IMAP / 邮箱 ----
  [/LOGIN failed|authentication failed|AUTHENTICATIONFAILED|Invalid credentials|auth failed/i,
    '邮箱拒绝登录。国内邮箱/学校邮箱通常**不能用网页密码**，要用「IMAP 授权码 / 应用专用密码」（Gmail 需要两步验证后生成的应用专用密码）。'],
  [/application-specific password|app password|需要应用专用密码/i,
    '这家邮箱要求「应用专用密码」，请到邮箱设置的「安全 / 应用密码」里生成一个再填。'],
  [/IMAP.*(disabled|not enabled|未开启)|imap_disabled/i,
    '邮箱的 IMAP 服务没开。请到邮箱设置里开启 IMAP/SMTP（QQ/163/交大邮箱都有这个开关）。'],
  [/ECONNREFUSED/i,
    '连不上服务器：服务器地址或端口不对。IMAP 一般是 `imap.xxx.com` + 993（SSL）。'],

  // ---- 网络层 ----
  [/ENOTFOUND|EAI_AGAIN/i,
    '域名解析不了：请检查服务器地址是否拼错，或本机网络/DNS 是否正常。'],
  [/\bfetch failed\b/i,
    '连不上这个地址（DNS 查不到或网络不通）。请确认网址能在这台电脑的浏览器里打开；如果浏览器也打不开，多半是网络/代理限制。'],
  [/ETIMEDOUT|timeout|timed out/i,
    '连接超时（等满 60 秒）。也可能是数据源本身很慢（例如 Canvas 课程多）—— 可以稍后重试；若一直超时再检查网络/防火墙（校园网、公司网常见）与服务器地址。'],
  // fetch 的 AbortController 超时会抛 "This operation was aborted"，也要认
  [/abort|aborted|The operation was aborted/i,
    '这个地址响应太慢，等超时了。可以稍后重试；如果一直很慢，多半是网络到该站点不稳（校园网/公司网常见），或者对方站点本身在限速。'],
  [/ECONNRESET|socket hang up/i,
    '连接被中途断开：常见于网络不稳或需要走代理。'],

  // ---- 配置本身 ----
  [/缺少|required|missing/i,
    '有必填项没填。请把带 * 的字段补齐（通常是账号、密码/令牌、服务器地址）。'],
];

/** 人话化一条连接器报错。第二个返回值是"要不要提示重试"。 */
export function humanizeConnectorError(source, error) {
  const raw = String(error?.message || error || '').trim();
  if (!raw) return { text: '未知错误（没有报错信息）', raw };
  // 连接器自己抛的中文提示通常已经说清楚了（例如"请至少填一个关键词"），原样透传
  if (/[\u4e00-\u9fff]/.test(raw) && !/[\u4e00-\u9fff].*<\/?[a-z]/.test(raw)) {
    return { text: raw.slice(0, 160), raw };
  }
  for (const [re, text] of RULES) {
    if (re.test(raw)) return { text, raw };
  }
  return { text: `连接失败：${raw.slice(0, 160)}`, raw };
}

/** 测试连接的结果 → 一句人话（成功也说话）。 */
export function describeTestResult(source, { ok, count, detail } = {}) {
  if (ok) {
    if (Number.isFinite(count) && count > 0) return `连接成功，已经能看到 ${count} 条数据（可以放心导入了）`;
    return '连接成功（暂时没读到新数据，也会是正常的 —— 比如这几天没有新邮件）';
  }
  return humanizeConnectorError(source, detail).text;
}
