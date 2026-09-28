// ci-annotate.mjs —— 把 `run-portable.mjs --json` 的失败明细变成 GitHub 的 ::error:: 注解。
//
//   node tests/run-portable.mjs --json > portable.json; node tests/ci-annotate.mjs portable.json
//
// 为什么需要它：GitHub 的 **job log 要登录才能下载**（未登录读 API 会被 403），
// 但 check-run 的 **annotation 是公开可读的**。失败时把「哪个测试挂了 + 它最后几行输出」
// 打成注解，任何人（包括自动化）不登录也能从
//   https://api.github.com/repos/<owner>/<repo>/check-runs/<job_id>/annotations
// 读到失败原因 —— 不然 CI 一红，能拿到的只有一句 "Process completed with exit code 1"。
import { readFileSync } from 'node:fs';

const file = process.argv[2] || 'portable.json';
let data = {};
try {
  const raw = readFileSync(file, 'utf8');
  data = JSON.parse(raw.slice(raw.indexOf('{')));
} catch (e) {
  console.log(`::error::读不出 ${file}：${e.message}`);
  process.exit(0);
}

const detail = data.failedDetail || [];
const named = data.failed || [];

if (!detail.length && !named.length) {
  console.log('::notice::portable 全部通过');
  process.exit(0);
}

console.log(`::error::可移植子集失败 ${named.length || detail.length} 个：${named.join(', ')}`);
for (const item of detail) {
  const text = String(item.log || item.tail || '')
    .split('\n')
    .map((s) => s.trim())
    .filter(Boolean)
    .join(' ⏎ ');
  console.log(`::error file=tests/${item.file}::${item.file} 失败 :: ${text.slice(0, 1500)}`);
}
