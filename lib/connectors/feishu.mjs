import { feishuSample } from './samples.mjs';

const BASE = 'https://open.feishu.cn/open-apis';

export const meta = {
  id: 'feishu',
  name: '飞书 / Lark',
  icon: '💬',
  description: '通过飞书开放平台 API 导入日历日程（需企业自建应用凭据）。',
  fields: [
    { key: 'app_id', label: 'App ID', type: 'text', required: true, placeholder: 'cli_xxxxxxxx' },
    { key: 'app_secret', label: 'App Secret', type: 'password', required: true, placeholder: '••••••••' },
  ],
};

async function post(url, body) {
  const res = await fetch(url, {
    method: 'POST', headers: { 'Content-Type': 'application/json; charset=utf-8' }, body: JSON.stringify(body),
  });
  const data = await res.json().catch(() => ({}));
  return data;
}

async function get(url, token) {
  const res = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
  return res.json().catch(() => ({}));
}

export async function fetchAll(config) {
  if (!config?.app_id || !config?.app_secret) throw new Error('缺少 App ID/App Secret');
  // 1. tenant_access_token
  const tokenRes = await post(`${BASE}/auth/v3/tenant_access_token/internal`, {
    app_id: config.app_id, app_secret: config.app_secret,
  });
  if (tokenRes.code !== 0) throw new Error('获取 token 失败：' + (tokenRes.msg || tokenRes.code));
  const token = tokenRes.tenant_access_token;

  // 2. list calendars
  const calRes = await get(`${BASE}/calendar/v4/calendars?page_size=100`, token);
  const calendars = calRes.data?.calendar_list || [];

  // 3. list events in each calendar
  const now = Date.now();
  const windowStart = now - 7 * 86400000;
  const windowEnd = now + 60 * 86400000;
  const events = [];
  for (const cal of calendars) {
    const url = `${BASE}/calendar/v4/calendars/${cal.calendar_id}/events`
      + `?start_time=${Math.floor(windowStart / 1000)}&end_time=${Math.floor(windowEnd / 1000)}&page_size=200`;
    const evRes = await get(url, token);
    const list = evRes.data?.items || [];
    for (const e of list) {
      events.push({
        external_id: e.event_id,
        title: e.summary || '（无标题日程）',
        start_at: e.start_time?.timestamp ? secsToISO(e.start_time.timestamp) : null,
        end_at: e.end_time?.timestamp ? secsToISO(e.end_time.timestamp) : null,
        notes: e.description || '',
        url: e.url || null,
        calendar: cal.summary || cal.calendar_id,
      });
    }
  }
  return { items: events.map((e) => ({ kind: 'event', ...e })), raw: { calendars: calendars.length, events: events.length } };
}

function secsToISO(sec) { return new Date(sec * 1000).toISOString(); }

// offline demo path
export function fromSample() {
  const events = [];
  for (const cal of Object.keys(feishuSample.events)) {
    for (const e of feishuSample.events[cal]) {
      events.push({
        kind: 'event',
        external_id: e.event_id,
        title: e.summary,
        start_at: secsToISO(e.start_time.timestamp),
        end_at: secsToISO(e.end_time.timestamp),
        notes: e.description || '',
        url: e.url || null,
        calendar: cal.replace('cal_', ''),
      });
    }
  }
  return { items: events, raw: { calendars: feishuSample.calendars.length, events: events.length } };
}
