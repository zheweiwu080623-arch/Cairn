// module-package.mjs —— 「模块包清单」：把"这个包是什么、要什么、由哪些文件组成"写进包里（2026-10-02 · 台阶 E）。
//
// 为什么要它：`cairn mod install` 以前只打印一份权限清单，装完就没据可查了 ——
// 包里的文件和作者打的那份是不是同一份，谁也说不清。现在：
//   * `mod pack` 会往包里塞一份 `MANIFEST.json`（每个文件的 sha256 + 能力 + 权限 + 一句人话）；
//   * `mod install` 有清单就**逐文件核对**，对不上就拒绝安装（除非显式 `--force`）；
//   * 老包没有清单也照装，只是会如实说一句"没有逐文件校验和"。
//
// 纯函数（读文件、算 sha256），不打印、不安装 —— 好测。

import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { describePrivacy } from './permissions.mjs';

export const MANIFEST_NAME = 'MANIFEST.json';
export const MANIFEST_SCHEMA = 'module-package.v1';

export const sha256 = (buf) => createHash('sha256').update(buf).digest('hex');

/**
 * 生成清单。
 * @param {string} modDir 模块目录
 * @param {object} descriptor module.json 的内容
 * @param {string[]} files 目录内的相对路径（不含清单自己）
 * @param {object[]} caps 这个功能声明的能力（用来生成 privacy 那句）
 */
export function buildManifest(modDir, descriptor, files, caps = [], now = () => new Date().toISOString()) {
  const entries = files.map((f) => {
    const data = readFileSync(join(modDir, f));
    return { name: f, bytes: data.length, sha256: sha256(data) };
  }).sort((a, b) => (a.name < b.name ? -1 : 1));
  const d = descriptor && typeof descriptor === 'object' ? descriptor : {};
  return {
    schema: MANIFEST_SCHEMA,
    id: d.id,
    name: d.name || '',
    version: d.version || '0.0.0',
    kind: d.kind || '',
    created_at: now(),
    author: d.author || null,
    license: d.license || null,
    // 三样"装之前该看见的"：能力、权限、一句人话
    capabilities: (Array.isArray(d.requires && d.requires.capabilities) ? d.requires.capabilities : []).map(String),
    permissions: (Array.isArray(d.permissions) ? d.permissions : []).map(String),
    privacy: describePrivacy(d, caps),
    file_count: entries.length,
    files: entries,
  };
}

/**
 * 核对清单：逐文件比 sha256。
 * @param {object} manifest 包里的 MANIFEST.json
 * @param {Record<string, Buffer>} files 包内全部文件（键是包内路径）
 * @param {string} prefix 包内可能有一层子目录（"'my-mod/"）
 */
export function verifyManifest(manifest, files = {}, prefix = '') {
  const list = Array.isArray(manifest && manifest.files) ? manifest.files : [];
  const bad = [];
  const missing = [];
  for (const f of list) {
    if (!f || !f.name) continue;
    const buf = files[`${prefix}${f.name}`];
    if (!buf) { missing.push(f.name); continue; }
    if (sha256(buf) !== f.sha256) bad.push(f.name);
  }
  return { checked: list.filter((f) => f && f.name).length, ok: bad.length === 0 && missing.length === 0, bad, missing };
}
