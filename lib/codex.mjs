// codex.mjs —— 读取**本机 Codex 的只读信息**（自动化任务）。
//
// 为什么要读它：Codex 的定时自动化（automations）是"用户既有工作流"的一部分，
// Cairn 想把它显示出来、必要时转发一封邮件；但**只读**，绝不改动 Codex 的任何文件。
//
// 五个导出各管一件事：
//   detectCodexHome()   找 <CODEX_HOME>（环境变量 → 默认位置），找不到就返回空
//   readAutomations()   读自动化任务清单（含 rrule 与下次触发时间）
//   nextOccurrences()   把 rrule 展开成未来 N 次触发时间（纯计算，便于测试）
//   describeRrule()     把 rrule 翻成人话（给界面显示"每天 09:00"这种）
//   codexHomeExists()   轻量存在性检查
//
// 解析失败一律"当成没有"，不让 Codex 目录里的脏数据把 Cairn 拖下水。
//
// 2026-09-27（用户要求"删掉记录 Codex 历史会话这个功能"）：已移除 readThreads()。
// 它原来会打开 <CODEX_HOME>/state_5.sqlite 的 threads 表，把**每个会话的标题、第一条用户消息、
// token 数、工作目录**读出来存进 Cairn 自己的库、并显示在界面上。现在 Cairn 一个字的会话内容都不碰。
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

// Detect the Codex home directory (where threads / automations live).
export function detectCodexHome() {
  if (process.env.CODEX_HOME) return process.env.CODEX_HOME;
  const user = process.env.USERPROFILE || process.env.HOME;
  if (user) {
    const p = join(user, '.codex');
    if (existsSync(p)) return p;
  }
  return null;
}

// ---- Minimal TOML parser (scalars, strings, ints, floats, bools, inline tables, arrays, headers) ----
function parseToml(text) {
  const root = {};
  let current = root;
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.replace(/#.*$/, '').trim();
    if (!line) continue;
    if (line.startsWith('[') && line.endsWith(']')) {
      const name = line.slice(1, -1).trim();
      const parts = name.split('.').map((s) => s.replace(/"/g, ''));
      current = root;
      for (const part of parts) {
        current[part] = current[part] || {};
        current = current[part];
      }
      continue;
    }
    const eq = line.indexOf('=');
    if (eq < 0) continue;
    const key = line.slice(0, eq).trim().replace(/"/g, '');
    const raw = line.slice(eq + 1).trim();
    current[key] = parseValue(raw);
  }
  return root;
}

function parseValue(raw) {
  if (!raw) return '';
  if (raw.startsWith('{')) return parseInlineTable(raw);
  if (raw.startsWith('[')) return parseArray(raw);
  if ((raw.startsWith('"') && raw.endsWith('"')) || (raw.startsWith("'") && raw.endsWith("'"))) {
    return raw.slice(1, -1).replace(/\\\\/g, '\\').replace(/\\"/g, '"');
  }
  if (raw === 'true') return true;
  if (raw === 'false') return false;
  if (/^-?\d+$/.test(raw)) return parseInt(raw, 10);
  if (/^-?\d+\.\d+$/.test(raw)) return parseFloat(raw);
  return raw;
}

function parseInlineTable(raw) {
  const inner = raw.replace(/^\{\s*/, '').replace(/\s*\}$/, '');
  if (!inner.trim()) return {};
  const obj = {};
  for (const pair of inner.split(',')) {
    const eq = pair.indexOf('=');
    if (eq < 0) continue;
    const k = pair.slice(0, eq).trim().replace(/"/g, '');
    obj[k] = parseValue(pair.slice(eq + 1).trim());
  }
  return obj;
}

function parseArray(raw) {
  const inner = raw.replace(/^\[\s*/, '').replace(/\s*\]$/, '');
  if (!inner.trim()) return [];
  return inner.split(',').map((s) => parseValue(s.trim()));
}

// ---- Read the Codex automations (cron / heartbeat schedule definitions) ----
export function readAutomations(codexHome) {
  const dir = join(codexHome, 'automations');
  if (!existsSync(dir)) return [];
  const out = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const file = join(dir, entry.name, 'automation.toml');
    if (!existsSync(file)) continue;
    try {
      const parsed = parseToml(readFileSync(file, 'utf8'));
      out.push({
        id: parsed.id || entry.name,
        name: parsed.name || entry.name,
        kind: parsed.kind || 'cron',
        prompt: parsed.prompt || '',
        status: parsed.status || 'UNKNOWN',
        rrule: parsed.rrule || '',
        model: parsed.model || '',
        notification_policy: parsed.notification_policy || '',
        target_thread_id: parsed.target_thread_id || null,
        created_at: parsed.created_at || null,
        updated_at: parsed.updated_at || null,
        path: file,
      });
    } catch (e) {
      out.push({ id: entry.name, name: entry.name, kind: 'unknown', status: 'PARSE_ERROR', rrule: '', path: file, error: e.message });
    }
  }
  // Sort: active first, then created
  out.sort((a, b) => (a.status === 'ACTIVE' ? -1 : 1) - (b.status === 'ACTIVE' ? -1 : 1));
  return out;
}

// ---- Compute next occurrences from an RRULE (subset) ----
// Supports FREQ=DAILY|WEEKLY|MONTHLY|YEARLY, COUNT, UNTIL, BYDAY, BYMONTH, BYMONTHDAY, BYHOUR, BYMINUTE.
const WEEKDAYS = ['MO', 'TU', 'WE', 'TH', 'FR', 'SA', 'SU']; // index map (Jan 1 1970=Thu)

function parseRrule(rrule) {
  const parts = {};
  // Some stores prefix with "RRULE:" — strip it.
  const body = rrule.replace(/^\s*RRULE:\s*/i, '');
  for (const part of body.split(';')) {
    const i = part.indexOf('=');
    if (i < 0) continue;
    parts[part.slice(0, i).toUpperCase()] = part.slice(i + 1);
  }
  return parts;
}

export function nextOccurrences(rrule, from = new Date(), count = 10) {
  const res = [];
  if (!rrule) return res;
  const parts = parseRrule(rrule);
  const freq = parts.FREQ || 'DAILY';
  const interval = parseInt(parts.INTERVAL || '1', 10) || 1;
  const until = parts.UNTIL ? parseUntil(parts.UNTIL) : null;
  const rcount = parseInt(parts.COUNT || '0', 10);
  const byDay = parts.BYDAY ? parts.BYDAY.split(',') : null;
  const byMonth = parts.BYMONTH ? parts.BYMONTH.split(',').map(Number) : null;
  const byMonthDay = parts.BYMONTHDAY ? parts.BYMONTHDAY.split(',').map(Number) : null;
  const hour = parts.BYHOUR ? parseInt(parts.BYHOUR, 10) : 0;
  const minute = parts.BYMINUTE ? parseInt(parts.BYMINUTE, 10) : 0;

  const fromMs = from.getTime();
  const anchor = startOfDay(from);
  const horizon = new Date(anchor);
  horizon.setFullYear(horizon.getFullYear() + 3);

  const startDay = dayNumber(anchor);
  const d = new Date(anchor);
  let emitted = 0;
  let guard = 0;
  const maxGuard = 1600;
  while (emitted < count && d <= horizon && guard < maxGuard) {
    guard++;
    const dayDiff = dayNumber(d) - startDay;
    const freqOk = validInterval(freq, interval, d, anchor, dayDiff);
    const dayOk = dayLevelMatches(d, byDay, byMonth, byMonthDay);
    if (freqOk && dayOk) {
      const candidate = new Date(d);
      candidate.setHours(hour, minute, 0, 0);
      if (candidate.getTime() >= fromMs && (!until || candidate <= until) && (!rcount || emitted < rcount)) {
        res.push(candidate.toISOString());
        emitted++;
      }
    }
    d.setDate(d.getDate() + 1);
  }
  return res;
}

function startOfDay(t) {
  const r = new Date(t);
  r.setHours(0, 0, 0, 0);
  return r;
}

function dayNumber(t) {
  return Math.floor(Date.UTC(t.getFullYear(), t.getMonth(), t.getDate()) / 86400000);
}

function validInterval(freq, interval, d, anchor, dayDiff) {
  if (interval <= 1) return true;
  if (freq === 'DAILY') return dayDiff % interval === 0;
  if (freq === 'WEEKLY') return Math.floor(dayDiff / 7) % interval === 0;
  if (freq === 'MONTHLY') {
    const mdiff = (d.getFullYear() - anchor.getFullYear()) * 12 + (d.getMonth() - anchor.getMonth());
    return mdiff % interval === 0;
  }
  if (freq === 'YEARLY') return (d.getFullYear() - anchor.getFullYear()) % interval === 0;
  return true;
}

function dayLevelMatches(d, byDay, byMonth, byMonthDay) {
  if (byDay && byDay.length) {
    const wd = (d.getDay() + 6) % 7; // MO=0..SU=6
    if (!byDay.includes(WEEKDAYS[wd])) return false;
  }
  if (byMonth && byMonth.length && !byMonth.includes(d.getMonth() + 1)) return false;
  if (byMonthDay && byMonthDay.length && !byMonthDay.includes(d.getDate())) return false;
  return true;
}

function parseUntil(s) {
  // RRULE UNTIL is either YYYYMMDD or YYYYMMDDTHHMMSSZ
  const m = s.match(/^(\d{4})(\d{2})(\d{2})(?:T(\d{2})(\d{2})(\d{2})Z?)?$/);
  if (!m) return null;
  return new Date(Date.UTC(+m[1], +m[2] - 1, +m[3], m[4] ? +m[4] : 23, m[5] ? +m[5] : 59, m[6] ? +m[6] : 59));
}

export function describeRrule(rrule) {
  if (!rrule) return '一次性';
  const parts = parseRrule(rrule);
  const freqMap = { DAILY: '每天', WEEKLY: '每周', MONTHLY: '每月', YEARLY: '每年' };
  const byDay = parts.BYDAY ? parts.BYDAY.split(',').map((d) => WEEKDAYS.indexOf(d) + 1).join('、') : '';
  const dayName = parts.BYDAY ? parts.BYDAY.split(',').join('/') : '';
  const hour = parts.BYHOUR ? `${parts.BYHOUR}点` : '';
  const minute = parts.BYMINUTE ? `${String(parts.BYMINUTE).padStart(2, '0')}分` : '';
  const freq = freqMap[parts.FREQ] || parts.FREQ;
  return `${freq}${byDay ? ' ' + byDay : ''}${dayName ? '(' + dayName + ')' : ''} ${hour}${minute}`.trim();
}

export function codexHomeExists(home) {
  return !!(home && existsSync(home));
}
