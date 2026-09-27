// 本地文件导入连接器（适配器④）：CSV / JSON / ICS。
//
// 场景：别人从别的应用搬过来时，手里就是一个文件。选文件 → 选类型 → 导入。
import { detectFormat, importLocalFile, parseCsv } from '../localfile.mjs';

export const meta = {
  id: 'localfile',
  name: '本地文件导入（CSV / JSON / ICS）',
  icon: '📄',
  description: '把本机的一个文件导进来：Excel 导出的 CSV、别的应用导出的 JSON、日历导出的 .ics 都行。',
  fields: [
    { key: 'path', label: '文件完整路径', type: 'text', required: true, placeholder: '例如 C:\\Users\\<你的用户名>\\Desktop\\tasks.csv' },
    { key: 'format', label: '格式（留空按扩展名判断：csv / json / ics）', type: 'text', required: false, placeholder: 'csv' },
    { key: 'label', label: '给这批数据的短名字（可选）', type: 'text', required: false, placeholder: '如：旧应用迁移' },
    { key: 'kind', label: '当成什么：event / task / reminder（默认 task）', type: 'text', required: false, placeholder: 'task' },
    { key: 'map_title', label: '标题字段/列名（留空自动猜）', type: 'text', required: false, placeholder: '标题' },
    { key: 'map_due', label: '截止字段/列名', type: 'text', required: false, placeholder: '截止时间' },
    { key: 'map_start', label: '开始时间字段/列名', type: 'text', required: false, placeholder: '开始时间' },
    { key: 'map_url', label: '链接字段/列名', type: 'text', required: false, placeholder: '链接' },
    { key: 'map_body', label: '备注字段/列名', type: 'text', required: false, placeholder: '备注' },
    { key: 'max_results', label: '最多导入几条（默认 200）', type: 'text', required: false, placeholder: '200' },
  ],
};

export async function fetchAll(config = {}) {
  const mapping = {
    title: config.map_title, due: config.map_due, start: config.map_start,
    url: config.map_url, body: config.map_body,
  };
  return importLocalFile(config.path, {
    format: config.format,
    mapping: Object.fromEntries(Object.entries(mapping).filter(([, v]) => v)),
    kind: ['event', 'task', 'reminder'].includes(String(config.kind || '').trim()) ? String(config.kind).trim() : 'task',
    label: String(config.label || '').trim(),
    maxResults: Number(config.max_results) || 200,
  });
}

/** 离线示例：一段 CSV（带中文表头、引号里的逗号），用来验证「示例演示」。 */
export function fromSample() {
  const csv = [
    '标题,截止时间,链接,备注',
    '（示例）交实验报告,2026-09-30,https://example.edu/a,"包含,逗号的备注"',
    '（示例）预习第五章,2026-10-02,https://example.edu/b,',
    '（示例）小组讨论准备,2026-10-05,https://example.edu/c,每人一页提纲',
  ].join('\n');
  const { rows } = parseCsv(csv);
  const items = [];
  for (const row of rows) {
    items.push({
      kind: 'task',
      external_id: null,
      title: row['标题'],
      start_at: null,
      end_at: null,
      due_at: row['截止时间'] || null,
      url: row['链接'] || null,
      notes: row['备注'] || '',
      payload: { from: 'localfile' },
    });
  }
  return { items, raw: { format: 'csv', kept: items.length, demo: true } };
}
