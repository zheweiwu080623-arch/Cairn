// agent-export.mjs —— 把 Cairn 的结论导出成"给办公 AI 看的目录"（2026-09-24）。
//
// 为什么：千问办公那类办公 Agent 是**按文件夹授权读取**的（文章里写得很清楚：
// "权限严格遵循文件夹授权范围"）。所以最自然的兼容不是让它调接口，而是
// **把该给它看的东西，写成几份规整的纯文本**，你把目录授权给它就行。
//
// 三条边界：
//   1) **导出的是结论，不是原始数据**：没有凭据、没有课程原文件、没有数据库；
//   2) **只读语义**：README 第一句就写"这些文件是 Cairn 生成的，请只读别改"；
//   3) **可复核**：`manifest.json` 里写清每份文件的 schema、字段与生成时间 —— 出问题能对得上。

import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

export const AGENT_DIRNAME = 'for-agents';

export function agentDirOf(dataDir) {
  return join(dataDir, AGENT_DIRNAME);
}

const line = (s) => String(s == null ? '' : s);
const hhmm = (iso) => String(iso || '').slice(11, 16);

/** 六份文件的正文（纯函数：给数据 → 给文本，好测）。 */
export function buildAgentFiles({ today = {}, tasks = {}, priority = {}, packs = {}, generatedAt = '' } = {}) {
  const README = [
    '# 这个文件夹是给「办公 AI」看的',
    '',
    `> 由 **Cairn**（空庭Coterie 的 Planner）在 ${generatedAt || '（未知时间）'} 生成。`,
    '> **请只读，不要修改或删除这里的文件** —— 它们下次会被重新生成。',
    '',
    '里面是**结论**，不是原始数据：没有账号凭据、没有课程原文件、没有数据库。',
    '你可以直接把这些内容拿去：整理表格、提炼待办、排优先级、写汇报。',
    '',
    '| 文件 | 是什么 |',
    '| --- | --- |',
    '| `今日.md` | 今天的日程 + 今天到期 + 已逾期 + 待看的提醒 |',
    '| `任务与DDL.md` | 未完成任务，每条带倒计时与"下一次提醒" |',
    '| `重要信息.md` | 按用户未来规划排序的条目，每条带分数与理由 |',
    '| `学习产物索引.md` | 已生成的学习产物（资料索引 / 每周巩固包）在哪、多大 |',
    '| `manifest.json` | 机器可读的元信息（schema / 生成时间 / 字段说明） |',
    '',
    '如果你要做的是"改数据"（加任务、改日程、提交作业）：**不要在这里改**，让用户在 Cairn 应用里操作。',
  ].join('\n');

  const T = [];
  T.push(`# 今日（${line(today.date) || '—'}）`);
  T.push('');
  T.push(`学期：${today.semester_week ? `第 ${today.semester_week} 周` : '（未设校历）'}`);
  T.push('');
  T.push('## 日程');
  T.push(...((today.events || []).length
    ? today.events.map((e) => `- ${hhmm(e.start_at)}–${e.end_at ? hhmm(e.end_at) : '?'}　${line(e.title)}${e.location ? `　@${e.location}` : ''}`)
    : ['- （今天没有日程）']));
  T.push('');
  T.push('## 已逾期');
  T.push(...((today.overdue || []).length ? today.overdue.map((t) => `- ${line(t.title)}　（${line(t.countdown)}）`) : ['- （没有逾期的）']));
  T.push('');
  T.push('## 今天到期');
  T.push(...((today.due_today || []).length ? today.due_today.map((t) => `- ${line(t.title)}　（${line(t.countdown)}）`) : ['- （今天没有到期的）']));
  T.push('');
  T.push('## 待看的提醒');
  T.push(...((today.notifications || []).length
    ? today.notifications.map((n) => `- ${line(n.title)}${n.message ? `：${String(n.message).slice(0, 80)}` : ''}`)
    : ['- （没有）']));

  const K = [];
  K.push('# 任务与 DDL');
  K.push('');
  K.push(`共 ${line(tasks.count) || 0} 条未完成（按截止时间从近到远）。`);
  K.push('');
  K.push('| 任务 | 状态 | 倒计时 | 截止 | 下一次提醒 |');
  K.push('| --- | --- | --- | --- | --- |');
  for (const t of (tasks.tasks || [])) {
    K.push(`| ${line(t.title)} | ${line(t.status)} | ${line(t.countdown) || '—'} | ${t.due_at ? String(t.due_at).slice(0, 16).replace('T', ' ') : '—'} | ${t.next_reminder ? line(t.next_reminder.label) : '—'} |`);
  }
  if (!(tasks.tasks || []).length) K.push('| （没有未完成的任务） | — | — | — | — |');

  const P = [];
  P.push('# 重要信息（按你的未来规划排序）');
  P.push('');
  if ((priority.items || []).length) {
    P.push('| 分数 | 档位 | 条目 | 为什么重要 |');
    P.push('| --- | --- | --- | --- |');
    for (const x of priority.items) P.push(`| ${line(x.score)} | ${line(x.band)} | ${line(x.title)} | ${line((x.reasons || [])[0])} |`);
    if (priority.advice) {
      P.push('');
      P.push(`> 建议：${line(priority.advice)}`);
    }
  } else P.push('（现在没有排得上号的条目）');

  const S = [];
  S.push('# 学习产物索引');
  S.push('');
  S.push(`目录：\`${line(packs.dir)}\``);
  S.push('');
  if ((packs.files || []).length) {
    S.push('| 文件 | 大小 | 生成时间 |');
    S.push('| --- | --- | --- |');
    for (const f of packs.files) S.push(`| ${line(f.name)} | ${Math.round((f.size || 0) / 1024)} KB | ${String(f.mtime || '').slice(0, 16).replace('T', ' ')} |`);
  } else S.push('（还没有生成学习产物：在 Cairn 的「课程辅助」页点一次"生成资料索引"）');

  const manifest = {
    schema: 'agent-export.v1',
    generated_at: generatedAt,
    generated_by: 'Cairn（空庭Coterie 的 Planner）',
    read_only: true,
    files: [
      { name: 'README-给办公AI看.md', what: '先读这个：说明与边界' },
      { name: '今日.md', what: '日程 / 今天到期 / 逾期 / 提醒', schema: 'mcp.today.v1' },
      { name: '任务与DDL.md', what: '未完成任务与倒计时', schema: 'mcp.tasks.v1' },
      { name: '重要信息.md', what: '按规划排序的条目 + 理由', schema: 'mcp.priority.v1' },
      { name: '学习产物索引.md', what: '已生成的学习产物', schema: 'mcp.packs.v1' },
    ],
    fields: {
      countdown: '人话倒计时，例如「还有 1 天 10 小时」/「已逾期 2 小时」',
      next_reminder: 'Cairn 下一次会提醒的时间与档位（7天/3天/1天/3小时/30分钟）',
      score: '重要性 0–100；越高越该先做',
      band: '重要度档位：high / normal / low',
    },
    counts: {
      events: (today.events || []).length,
      overdue: (today.overdue || []).length,
      due_today: (today.due_today || []).length,
      open_tasks: (tasks.tasks || []).length,
      priority_items: (priority.items || []).length,
      study_files: (packs.files || []).length,
    },
  };

  return {
    'README-给办公AI看.md': `${README}\n`,
    '今日.md': `${T.join('\n')}\n`,
    '任务与DDL.md': `${K.join('\n')}\n`,
    '重要信息.md': `${P.join('\n')}\n`,
    '学习产物索引.md': `${S.join('\n')}\n`,
    'manifest.json': `${JSON.stringify(manifest, null, 2)}\n`,
  };
}

/** 落盘（目录不存在就建；返回写了哪几个）。 */
export function writeAgentFiles(dir, files) {
  try {
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    const written = [];
    for (const [name, content] of Object.entries(files)) {
      writeFileSync(join(dir, name), content, 'utf8');
      written.push({ name, bytes: Buffer.byteLength(content, 'utf8') });
    }
    return { ok: true, dir, written };
  } catch (e) {
    return { ok: false, dir, error: `写不进去：${(e && e.message) || e}` };
  }
}
