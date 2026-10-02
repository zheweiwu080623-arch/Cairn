// 能力模块：file.write —— 写产物文件（只准写 <数据目录>/study）。
export const meta = {
  id: 'file.write',
  name: '写产物文件（只准写 <数据目录>/study）',
  version: '1.0.0',
  kind: 'write',
  input: { type: 'object', properties: { path: { type: 'string' }, text: { type: 'string' } }, required: ['path', 'text'] },
  output: { type: 'object', properties: { ok: { type: 'boolean' }, detail: { type: 'string' }, error: { type: 'string' } } },
  permissions: ['fs:write:data'],
  idempotent: true,
  cost: 'none',
  ui: { label: '写产物文件', group: '产物', icon: '💾' },
  model: { description: '当要把生成的内容落成一个文件（Markdown、文本）交给用户时用它；只能写在数据目录的 study 下。' },
  used_by: ['course-assist'],
  notes: '真正落盘的闸门在 lib/course-stack.mjs 的 writeStudyFile（越界返回 ok:false，不抛）。同路径同内容写两次结果一致 ⇒ 幂等。',
};
export const bind = { from: 'executors', executor: 'file' };
export async function run(input = {}) {
  return { actions: [{
    type: 'file',
    summary: input.summary || `写出 ${input.path || ''}`,
    idempotency_key: `file.write:${input.idempotency_key || input.path || ''}`,
    target: { kind: 'file', path: input.path },
    payload: { text: input.text },
    permissions: meta.permissions,
  }] };
}
