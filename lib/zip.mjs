// zip.mjs —— 极简 ZIP 读写（零依赖，只用 node:zlib 的 deflateRaw/inflateRaw）
//
// 为什么要自己写：这个项目的硬规矩是**零第三方依赖**，而"功能的发布/安装"要用 zip，
// 后面的课程辅助（读 .pptx / .docx，它们本质也是 zip）也要用同一套。既然都用得上，就写一次。
//
// 支持的范围（够用就好，明文写清楚）：
//   * 只做 **store（0）/ deflate（8）** 两种压缩方式；不加密、不分卷、不写 ZIP64；
//   * 读的时候会按中央目录找条目（不是只扫 local header），所以常见工具打的包也能读；
//   * 时间戳固定写 1980-01-01（可复现构建：同样的内容打出来的包字节一致，方便比对）。

import { deflateRawSync, inflateRawSync } from 'node:zlib';

const SIG_LOCAL = 0x04034b50;
const SIG_CENTRAL = 0x02014b50;
const SIG_EOCD = 0x06054b50;

// ---------- CRC32（ZIP 要求）----------
const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let i = 0; i < 256; i++) {
    let c = i;
    for (let k = 0; k < 8; k++) c = c & 1 ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
    t[i] = c >>> 0;
  }
  return t;
})();

export function crc32(buf) {
  let c = 0xFFFFFFFF;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xFF] ^ (c >>> 8);
  return (c ^ 0xFFFFFFFF) >>> 0;
}

/** 把相对路径规整一下：去掉开头的斜杠、把反斜杠换成斜杠（zip 里的分隔符永远是 /）。 */
export function normalizeEntryName(name) {
  return String(name || '').replace(/\\/g, '/').replace(/^\/+/, '');
}

/**
 * 打包成 zip。
 * @param {Array<{name:string, data:Buffer|string}>} entries
 * @param {{compress?:boolean}} [opts]
 * @returns {Buffer}
 */
export function zipSync(entries = [], { compress = true } = {}) {
  const locals = [];
  const central = [];
  let offset = 0;
  for (const e of entries) {
    const name = Buffer.from(normalizeEntryName(e.name), 'utf8');
    const raw = Buffer.isBuffer(e.data) ? e.data : Buffer.from(String(e.data ?? ''), 'utf8');
    const crc = crc32(raw);
    const deflated = compress ? deflateRawSync(raw) : raw;
    const useDeflate = compress && deflated.length < raw.length;
    const body = useDeflate ? deflated : raw;
    const method = useDeflate ? 8 : 0;

    const local = Buffer.alloc(30);
    local.writeUInt32LE(SIG_LOCAL, 0);
    local.writeUInt16LE(20, 4);           // version needed
    local.writeUInt16LE(0, 6);            // flags
    local.writeUInt16LE(method, 8);
    local.writeUInt16LE(0, 10);           // time（固定）
    local.writeUInt16LE(0x0021, 12);      // date：1980-01-01
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(body.length, 18);
    local.writeUInt32LE(raw.length, 22);
    local.writeUInt16LE(name.length, 26);
    local.writeUInt16LE(0, 28);
    locals.push(local, name, body);

    const cen = Buffer.alloc(46);
    cen.writeUInt32LE(SIG_CENTRAL, 0);
    cen.writeUInt16LE(20, 4);             // version made by
    cen.writeUInt16LE(20, 6);             // version needed
    cen.writeUInt16LE(0, 8);
    cen.writeUInt16LE(method, 10);
    cen.writeUInt16LE(0, 12);
    cen.writeUInt16LE(0x0021, 14);
    cen.writeUInt32LE(crc, 16);
    cen.writeUInt32LE(body.length, 20);
    cen.writeUInt32LE(raw.length, 24);
    cen.writeUInt16LE(name.length, 28);
    cen.writeUInt16LE(0, 30);             // extra
    cen.writeUInt16LE(0, 32);             // comment
    cen.writeUInt16LE(0, 34);             // disk
    cen.writeUInt16LE(0, 36);             // internal attrs
    cen.writeUInt32LE(0, 38);             // external attrs
    cen.writeUInt32LE(offset, 42);
    central.push(cen, name);

    offset += local.length + name.length + body.length;
  }
  const centralBuf = Buffer.concat(central);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(SIG_EOCD, 0);
  eocd.writeUInt16LE(0, 4);
  eocd.writeUInt16LE(0, 6);
  eocd.writeUInt16LE(entries.length, 8);
  eocd.writeUInt16LE(entries.length, 10);
  eocd.writeUInt32LE(centralBuf.length, 12);
  eocd.writeUInt32LE(offset, 16);
  eocd.writeUInt16LE(0, 20);
  return Buffer.concat([...locals, centralBuf, eocd]);
}

/**
 * 解包。返回 `{ 'a/b.txt': Buffer, … }`（跳过目录项）。
 * 找不到中央目录就退回扫 local header（兼容少数不规范的工具）。
 * @param {Buffer} buf
 */
export function unzipSync(buf) {
  const out = {};
  if (!Buffer.isBuffer(buf) || buf.length < 22) return out;

  // 从尾部往前找 EOCD（注释最长 65535，所以最多回退这么多）
  let eocd = -1;
  const from = Math.max(0, buf.length - 22 - 65535);
  for (let i = buf.length - 22; i >= from; i--) {
    if (buf.readUInt32LE(i) === SIG_EOCD) { eocd = i; break; }
  }
  if (eocd < 0) return readLocalHeaders(buf);

  const count = buf.readUInt16LE(eocd + 10);
  let p = buf.readUInt32LE(eocd + 16);
  for (let n = 0; n < count; n++) {
    if (p + 46 > buf.length || buf.readUInt32LE(p) !== SIG_CENTRAL) break;
    const method = buf.readUInt16LE(p + 10);
    const compSize = buf.readUInt32LE(p + 20);
    const nameLen = buf.readUInt16LE(p + 28);
    const extraLen = buf.readUInt16LE(p + 30);
    const commentLen = buf.readUInt16LE(p + 32);
    const localOff = buf.readUInt32LE(p + 42);
    const name = buf.toString('utf8', p + 46, p + 46 + nameLen);
    p += 46 + nameLen + extraLen + commentLen;
    if (name.endsWith('/')) continue;                     // 目录项
    const data = extractLocal(buf, localOff, method, compSize);
    if (data) out[name] = data;
  }
  return out;
}

function extractLocal(buf, localOff, method, compSize) {
  if (localOff + 30 > buf.length || buf.readUInt32LE(localOff) !== SIG_LOCAL) return null;
  const nameLen = buf.readUInt16LE(localOff + 26);
  const extraLen = buf.readUInt16LE(localOff + 28);
  const start = localOff + 30 + nameLen + extraLen;
  const body = buf.subarray(start, start + compSize);
  try {
    if (method === 0) return Buffer.from(body);
    if (method === 8) return inflateRawSync(body);
  } catch { return null; }
  return null;                                            // 其它压缩方式不支持（如实返回 null）
}

function readLocalHeaders(buf) {
  const out = {};
  let p = 0;
  while (p + 30 <= buf.length && buf.readUInt32LE(p) === SIG_LOCAL) {
    const method = buf.readUInt16LE(p + 8);
    const compSize = buf.readUInt32LE(p + 18);
    const nameLen = buf.readUInt16LE(p + 26);
    const extraLen = buf.readUInt16LE(p + 28);
    const name = buf.toString('utf8', p + 30, p + 30 + nameLen);
    const start = p + 30 + nameLen + extraLen;
    const data = extractLocal(buf, p, method, compSize);
    if (data && !name.endsWith('/')) out[name] = data;
    p = start + compSize;
  }
  return out;
}
