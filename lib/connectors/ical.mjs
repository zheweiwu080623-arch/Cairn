// 通用 ICS 日历订阅连接器（通用数据源适配器 ②）。
//
// 用途：把**任何**日历并进来 —— Google / Outlook / 学校教务 / 课程表工具导出的 .ics 链接都可以。
// 这是"不需要账号、不需要 OAuth"就能拿到日程的最通用方式。
import { icsEventToPlanner, icsEventsInWindow, parseIcs } from '../ical.mjs';
import { icsSample } from './samples.mjs';

export const meta = {
  id: 'ical',
  name: '通用日历订阅（ICS / iCal）',
  icon: '📅',
  description: '贴一个 .ics 日历链接就能把日程并进来：Google 日历、Outlook、学校教务、课程表导出的都行。',
  fields: [
    { key: 'url', label: '日历 .ics 链接', type: 'text', required: true, placeholder: 'https://example.com/calendar.ics' },
    { key: 'label', label: '给这个日历的短名字（可选）', type: 'text', required: false, placeholder: '如：学校校历' },
    { key: 'days_ahead', label: '往后导入多少天（默认 60）', type: 'text', required: false, placeholder: '60' },
    { key: 'days_back', label: '往前导入多少天（默认 7）', type: 'text', required: false, placeholder: '7' },
    { key: 'max_results', label: '每次最多收几条（默认 200）', type: 'text', required: false, placeholder: '200' },
  ],
};

async function fetchText(url, timeoutMs = 30000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      signal: controller.signal,
      headers: { 'User-Agent': 'Cairn/0.1 (+local planner; ics subscriber)', Accept: 'text/calendar, text/plain, */*' },
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return await res.text();
  } catch (e) {
    if (e?.name === 'AbortError') throw new Error('aborted（等满 30 秒还没响应）');
    const code = e?.cause?.code || e?.code || '';
    if (code) throw new Error(`${code}: 无法连接 ${url}`);
    throw e;
  } finally {
    clearTimeout(timer);
  }
}

/** 抓一个 .ics 并转成平台日程。 */
export async function fetchAll(config = {}) {
  const url = String(config.url || '').trim();
  if (!url) throw new Error('缺少日历 .ics 链接');
  if (!/^https?:\/\//i.test(url)) throw new Error('链接要以 http:// 或 https:// 开头');

  const text = await fetchText(url);
  const parsed = parseIcs(text);
  if (!parsed.events.length) {
    throw new Error('这个链接里没有解析出日程。请确认它导出的是 .ics（日历）而不是普通网页。');
  }
  const now = Date.now();
  const fromMs = now - Math.max(0, Number(config.days_back) || 7) * 86400000;
  const toMs = now + Math.max(1, Number(config.days_ahead) || 60) * 86400000;
  const picked = icsEventsInWindow(parsed, { fromMs, toMs, max: Number(config.max_results) || 200 });
  const label = String(config.label || parsed.calendarName || '').trim();
  return {
    items: picked.map((ev) => {
      const item = icsEventToPlanner(ev, { source: 'ical' });
      if (label) item.title = `${label}: ${item.title}`;
      return item;
    }),
    raw: { calendar: parsed.calendarName, total: parsed.events.length, kept: picked.length, url },
  };
}

/** 离线示例。 */
export function fromSample() {
  const parsed = parseIcs(icsSample());
  const now = Date.now();
  const picked = icsEventsInWindow(parsed, { fromMs: now - 7 * 86400000, toMs: now + 60 * 86400000, max: 50 });
  return {
    items: picked.map((ev) => icsEventToPlanner(ev, { source: 'ical' })),
    raw: { calendar: parsed.calendarName, total: parsed.events.length, kept: picked.length, demo: true },
  };
}
