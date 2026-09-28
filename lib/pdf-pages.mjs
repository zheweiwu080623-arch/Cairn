// pdf-pages.mjs —— 把 PDF 的某几页**渲染成图片**（2026-09-27）
//
// 为什么需要它：数学课件的 PDF 有两种，"文字层"的质量天差地别 ——
//   * 习题解 / Word 导出的：抽出来的文字虽然丢了空格，但还能认出 `A,B:(:A^B)` 这种；
//   * LaTeX / PPT 导出的：文字层是**字形编号**（实测 `IIII IIIIII II II`、`(:)(:)(^)(_)()`），
//     文本层面**救不回来**。
// 后一种只有一个出路：把页面**渲染成图**，交给**视觉模型**看着图转（用户本机配的就是视觉模型）。
//
// 渲染用 Poppler 的 `pdftoppm`。这台机器上它跟着 Codex 的运行时装着（实测路径见 CANDIDATES），
// 所以不需要用户再装东西；**找不到就如实说找不到**，并给出退路（把截图发给 Codex）。
import { execFile } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/** 找 pdftoppm：PATH → Codex 运行时缓存 → 常见安装位置。找不到返回 ''。 */
export const RASTERIZER_CANDIDATES = [
  '',                                                                   // 交给 PATH
  join(process.env.USERPROFILE || '', '.cache', 'codex-runtimes', 'codex-primary-runtime',
    'dependencies', 'native', 'poppler', 'Library', 'bin', 'pdftoppm.exe'),
  'C:\\Program Files\\poppler\\Library\\bin\\pdftoppm.exe',
  'C:\\poppler\\Library\\bin\\pdftoppm.exe',
];

/**
 * 界面上配的 pdftoppm 路径（`设置 → 本机 → PDF 转图工具`，存在 `paths.json` 的
 * `pdftoppm_path`）。宿主注入 —— 同 coursetext 的 pdftotext，改完立刻生效、不用重启。
 */
let configuredRasterizer = '';

/** 宿主注入/更新"界面上配的 pdftoppm 路径"（传空 = 回到自动找）。 */
export function setRasterizerPath(p) {
  configuredRasterizer = String(p == null ? '' : p).trim();
  return configuredRasterizer;
}

/** 现在生效的"界面上配的"路径（没配就是空串）。 */
export function getConfiguredRasterizer() { return configuredRasterizer; }

/** 找 pdftoppm：界面上配的路径 → 候选（PATH → Codex 运行时缓存 → 常见安装位置）。找不到返回 ''。 */
export function findRasterizer({
  candidates = RASTERIZER_CANDIDATES, exists = existsSync, configured = configuredRasterizer,
} = {}) {
  // 界面上配的（设置 → 本机）最优先：用户明说的，别再自作聪明去猜
  const fromUi = String(configured || '').trim();
  if (fromUi) {
    try { if (exists(fromUi)) return fromUi; } catch { /* 继续找 */ }
  }
  // 先按顺序看"明确给出的绝对路径"
  for (const c of candidates) {
    if (!c) continue;                                // 空串 = 等会儿扫 PATH（见下）
    try { if (exists(c)) return c; } catch { /* 继续找 */ }
  }
  // 再扫 PATH 里的 pdftoppm（**必须真去扫**：空串候选直接返回 'pdftoppm' 的话，
  // 服务进程的 PATH 里没有它，就会 spawn ENOENT —— 2026-09-27 真机踩到的）
  const sep = process.platform === 'win32' ? ';' : ':';
  const names = process.platform === 'win32' ? ['pdftoppm.exe'] : ['pdftoppm'];
  for (const dir of String(process.env.PATH || '').split(sep)) {
    if (!dir) continue;
    for (const n of names) {
      const p = `${dir.replace(/[\\/]+$/, '')}${process.platform === 'win32' ? '\\' : '/'}${n}`;
      try { if (exists(p)) return p; } catch { /* 继续 */ }
    }
  }
  return '';
}

/**
 * 把 PDF 的第 first~last 页渲染成 PNG。
 * @returns {Promise<{ok:boolean, pages:{index:number, png:Buffer}[], bin:string, error?:string, howToInstall?:string}>}
 */
export async function renderPdfPages(filePath, {
  first = 1, last = 3, dpi = 130, timeoutMs = 120000,
  bin = '', runner = execFile, tmpBase = '',
} = {}) {
  const exe = bin || findRasterizer();
  if (!exe) {
    return {
      ok: false, pages: [], bin: '',
      error: '这台机器上没有找到 PDF 渲染工具（pdftoppm）—— 视觉路线走不了',
      howToInstall: '退路：把这几页截图发到 Codex 里，让它看着图转（效果一样）。',
    };
  }
  // 临时目录：优先调用方给的（一般是 <数据目录>/tmp，服务进程一定写得进去），
  // 再退到 PLANNER_TEST_TMP（沙箱里 %TEMP% 常常不可写），最后才是系统临时目录。
  // 2026-09-27 实测：服务从受限环境里跑时 %TEMP% 不可写，渲染会直接失败 —— 所以必须能指定。
  let work = '';
  for (const base of [tmpBase, process.env.PLANNER_TEST_TMP, tmpdir()].filter(Boolean)) {
    try {
      if (!existsSync(base)) mkdirSync(base, { recursive: true });
      work = mkdtempSync(join(base, 'cairn-pdf-'));
      break;
    } catch { /* 换下一个 */ }
  }
  if (!work) return { ok: false, pages: [], bin: exe, error: '建不了临时目录（%TEMP% 不可写？）' };
  const prefix = join(work, 'page');
  const args = ['-png', '-r', String(Math.max(72, Math.min(200, Number(dpi) || 130))),
    '-f', String(Math.max(1, Number(first) || 1)), '-l', String(Math.max(1, Number(last) || 1)), String(filePath), prefix];
  const run = await new Promise((resolve) => {
    try {
      runner(exe, args, { timeout: timeoutMs, windowsHide: true, maxBuffer: 8 * 1024 * 1024 },
        (err, stdout, stderr) => resolve({ err, stdout: String(stdout || ''), stderr: String(stderr || '') }));
    } catch (e) { resolve({ err: e, stdout: '', stderr: '' }); }
  });
  if (run.err) {
    try { rmSync(work, { recursive: true, force: true }); } catch { /* ignore */ }
    return { ok: false, pages: [], bin: exe, error: `渲染失败：${run.err.message || run.err}` };
  }
  const pages = [];
  try {
    const files = readdirSync(work).filter((n) => /\.png$/i.test(n)).sort();
    for (const n of files) pages.push({ index: pages.length + first, png: readFileSync(join(work, n)) });
  } catch (e) {
    return { ok: false, pages: [], bin: exe, error: `读渲染结果失败：${e.message}` };
  } finally {
    try { rmSync(work, { recursive: true, force: true }); } catch { /* ignore */ }
  }
  if (!pages.length) {
    return { ok: false, pages: [], bin: exe, error: `这 ${first}~${last} 页没有渲染出图（PDF 可能页数没那么多么）` };
  }
  return { ok: true, pages, bin: exe };
}
