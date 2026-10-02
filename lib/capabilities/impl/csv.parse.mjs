// 能力模块：csv.parse —— 把 CSV / TSV 文字变成一行行数据（纯计算）。
//
// Cairn 本来就能读桌面上的表格文件（localfile 数据源），但它给的是整段文字；
// 这条能力负责把它变成"能逐条处理"的结构，再交给 json.pick / text.template。
export const meta = {
  id: 'csv.parse',
  name: '解析 CSV 表格',
  version: '1.0.0',
  kind: 'compute',
  input: {
    type: 'object',
    properties: {
      text: { type: 'string' },
      delimiter: { type: 'string' },
      header: { type: 'boolean' },
      limit: { type: 'number' },
    },
    required: ['text'],
  },
  output: { type: 'object', properties: { headers: { type: 'array' }, rows: { type: 'array' }, count: { type: 'number' } } },
  permissions: [],
  idempotent: true,
  cost: 'none',
  ui: { label: '解析 CSV', group: '通用', icon: '📊' },
  model: { description: '当手上是 CSV / TSV 文本、要变成一行行能处理的数据时用它。' },
  notes: '支持双引号包裹的字段（引号里的分隔符不算分隔符）。header=true（默认）时第一行当表头，rows 里每行是对象。',
};

export const bind = { from: 'none' };

/** 一行 → 若干字段（认得双引号）。 */
export function splitCsvLine(line, delimiter) {
  const out = [];
  let cur = '';
  let quoted = false;
  for (let i = 0; i < line.length; i += 1) {
    const ch = line[i];
    if (quoted) {
      if (ch === '"') {
        if (line[i + 1] === '"') { cur += '"'; i += 1; } else quoted = false;
      } else cur += ch;
    } else if (ch === '"') quoted = true;
    else if (ch === delimiter) { out.push(cur); cur = ''; }
    else cur += ch;
  }
  out.push(cur);
  return out.map((s) => s.trim());
}

export async function run(input = {}) {
  const text = String(input.text == null ? '' : input.text).replace(/^\uFEFF/, '');
  const delimiter = input.delimiter === undefined || input.delimiter === '' ? ',' : String(input.delimiter);
  const useHeader = input.header !== false;
  const limit = Number.isFinite(Number(input.limit)) && Number(input.limit) > 0 ? Number(input.limit) : 0;
  let lines = text.split(/\r?\n/).filter((l) => l.trim() !== '');
  if (limit) lines = lines.slice(0, useHeader ? limit + 1 : limit);
  if (!lines.length) return { headers: [], rows: [], count: 0 };
  const first = splitCsvLine(lines[0], delimiter);
  const headers = useHeader ? first : first.map((_v, i) => `col${i + 1}`);
  const body = useHeader ? lines.slice(1) : lines;
  const rows = body.map((line) => {
    const cells = splitCsvLine(line, delimiter);
    if (!useHeader) return cells;
    const row = {};
    headers.forEach((h, i) => { row[h || `col${i + 1}`] = cells[i] === undefined ? '' : cells[i]; });
    return row;
  });
  return { headers, rows, count: rows.length };
}
