// 交大邮箱（Zimbra）：复用通用 IMAP 实现，但作为独立的「重点数据源」单独配置与展示。
import * as email from './email.mjs';

export const meta = {
  ...email.meta,
  id: 'email_sjtu',
  name: '交大邮箱 (Zimbra)',
  icon: '🏫',
  description: '读取 SJTU 交大邮箱（mail.sjtu.edu.cn）收件箱，同步到「通知」（重点来源）。',
  fields: email.meta.fields.map((f) => {
    if (f.key === 'host') return { ...f, placeholder: 'mail.sjtu.edu.cn' };
    if (f.key === 'user') return { ...f, placeholder: '你的学号@sjtu.edu.cn' };
    return f;
  }),
};

export const fetchAll = email.fetchAll;
export const fromSample = email.fromSample;
