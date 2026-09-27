// 能力模块：course.text —— 把课程材料读成文字并检索。

export const meta = {
  id: 'course.text',
  name: '把课程材料读成文字并检索',
  version: '1.0.0',
  kind: 'read',
  input: {
    type: 'object',
    properties: { courses: { type: 'array' }, maxChars: { type: 'number' }, only: { type: 'string' }, q: { type: 'string' } },
  },
  output: { type: 'object', properties: { materials: { type: 'array' }, hits: { type: 'array' } } },
  permissions: ['fs:read:course'],
  idempotent: true,
  cost: 'none',
  ui: { label: '读课件 / 找一段话', group: '课程', icon: '📄' },
  used_by: ['course-assist'],
  notes: '只读：不下载、不改原文件。扫描件与部分数学字体 PDF 抽不出文字时如实标「乱码·看原文」「需 OCR」。',
};

export const bind = { from: 'course', ctx: ['course.read', 'course.search'] };

export async function run(input = {}, ctx) {
  if (input.q) {
    const materials = input.materials || (ctx.course.read(input) || {}).materials || [];
    return { hits: ctx.course.search(materials, input.q) };
  }
  return ctx.course.read(input);
}
