// 备份：把 data/ 打包为 zip 导出；从 zip 恢复 data/（自实现 zip 读写，仅用内置 zlib）
'use strict';
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const store = require('./store');

// ---------- CRC32 ----------
const CRC_TABLE = (() => {
  const t = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c;
  }
  return t;
})();
function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function dosDateTime(d) {
  const time = (d.getHours() << 11) | (d.getMinutes() << 5) | (d.getSeconds() >> 1);
  const date = ((d.getFullYear() - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate();
  return { time, date };
}

// ---------- zip 写 ----------
function createZip(entries) {
  // entries: [{ name: 'data/a.json', data: Buffer }]
  const { time, date } = dosDateTime(new Date());
  const locals = [];
  const centrals = [];
  let offset = 0;
  for (const e of entries) {
    const nameBuf = Buffer.from(e.name, 'utf8');
    const raw = e.data;
    let method = 0;
    let body = raw;
    if (raw.length > 1024) {
      body = zlib.deflateRawSync(raw, { level: 6 });
      method = 8;
    }
    const crc = crc32(raw);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);          // version needed
    local.writeUInt16LE(0x0800, 6);      // UTF-8 文件名标志
    local.writeUInt16LE(method, 8);
    local.writeUInt16LE(time, 10);
    local.writeUInt16LE(date, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(body.length, 18);
    local.writeUInt32LE(raw.length, 22);
    local.writeUInt16LE(nameBuf.length, 26);
    local.writeUInt16LE(0, 28);
    locals.push(local, nameBuf, body);

    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(0x0800, 8);
    central.writeUInt16LE(method, 10);
    central.writeUInt16LE(time, 12);
    central.writeUInt16LE(date, 14);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(body.length, 20);
    central.writeUInt32LE(raw.length, 24);
    central.writeUInt16LE(nameBuf.length, 28);
    central.writeUInt32LE(offset, 42);
    centrals.push(Buffer.concat([central, nameBuf]));
    offset += local.length + nameBuf.length + body.length;
  }
  const centralBuf = Buffer.concat(centrals);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(entries.length, 8);
  eocd.writeUInt16LE(entries.length, 10);
  eocd.writeUInt32LE(centralBuf.length, 12);
  eocd.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, centralBuf, eocd]);
}

// ---------- zip 读 ----------
function listFilesRecursive(dir, prefix) {
  const out = [];
  for (const name of fs.readdirSync(dir)) {
    const full = path.join(dir, name);
    const rel = prefix + name;
    const st = fs.statSync(full);
    if (st.isDirectory()) out.push(...listFilesRecursive(full, rel + '/'));
    else out.push({ full, rel, size: st.size });
  }
  return out;
}

function exportBackup() {
  const files = listFilesRecursive(store.DATA, 'data/');
  const entries = files.map((f) => ({ name: f.rel, data: fs.readFileSync(f.full) }));
  return { zip: createZip(entries), count: entries.length };
}

function parseZip(buf) {
  // 从尾部找 EOCD
  let eocd = -1;
  for (let i = buf.length - 22; i >= 0 && i >= buf.length - 22 - 65535; i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
  }
  if (eocd < 0) throw new Error('不是有效的备份文件（缺少目录结尾）');
  const count = buf.readUInt16LE(eocd + 10);
  let p = buf.readUInt32LE(eocd + 16);
  const entries = [];
  for (let i = 0; i < count; i++) {
    if (buf.readUInt32LE(p) !== 0x02014b50) throw new Error('备份文件目录损坏');
    const method = buf.readUInt16LE(p + 10);
    const csize = buf.readUInt32LE(p + 20);
    const usize = buf.readUInt32LE(p + 24);
    const nlen = buf.readUInt16LE(p + 28);
    const elen = buf.readUInt16LE(p + 30);
    const clen = buf.readUInt16LE(p + 32);
    const lho = buf.readUInt32LE(p + 42);
    const name = buf.slice(p + 46, p + 46 + nlen).toString('utf8');
    entries.push({ name, method, csize, usize, lho });
    p += 46 + nlen + elen + clen;
  }
  return entries.map((e) => {
    if (buf.readUInt32LE(e.lho) !== 0x04034b50) throw new Error('备份文件条目损坏：' + e.name);
    const nlen = buf.readUInt16LE(e.lho + 26);
    const elen = buf.readUInt16LE(e.lho + 28);
    const start = e.lho + 30 + nlen + elen;
    const body = buf.slice(start, start + e.csize);
    let data;
    if (e.method === 0) data = Buffer.from(body);
    else if (e.method === 8) data = zlib.inflateRawSync(body);
    else throw new Error('不支持的压缩方式：' + e.name);
    return { name: e.name, data };
  });
}

// 恢复：先解到临时目录并校验，再原子换入
function restoreBackup(zipBuf) {
  const entries = parseZip(zipBuf).filter((e) => e.name.startsWith('data/'));
  if (!entries.some((e) => e.name === 'data/library.json')) {
    throw new Error('备份文件无效：缺少 data/library.json');
  }
  for (const e of entries) {
    if (e.name.includes('..') || e.name.includes('\\')) throw new Error('备份文件含非法路径');
  }
  const dataDir = store.DATA;
  const tmp = dataDir + '.restore-tmp';
  const old = dataDir + '.old-' + Date.now();
  fs.rmSync(tmp, { recursive: true, force: true });
  fs.mkdirSync(path.join(tmp, 'docs'), { recursive: true });
  for (const e of entries) {
    const rel = e.name.slice('data/'.length);
    const target = path.join(tmp, rel);
    if (!path.resolve(target).startsWith(path.resolve(tmp))) throw new Error('非法路径');
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, e.data);
  }
  let docCount = 0;
  try {
    const lib = JSON.parse(fs.readFileSync(path.join(tmp, 'library.json'), 'utf8'));
    docCount = (lib.docs || []).length;
  } catch (_) {
    fs.rmSync(tmp, { recursive: true, force: true });
    throw new Error('备份文件无效：library.json 无法解析');
  }
  const hadData = fs.existsSync(dataDir);
  if (hadData) fs.renameSync(dataDir, old);
  try {
    fs.renameSync(tmp, dataDir);
  } catch (e) {
    if (hadData) fs.renameSync(old, dataDir); // 尽力回滚
    throw e;
  }
  fs.rmSync(old, { recursive: true, force: true });
  return { docCount, fileCount: entries.length };
}

module.exports = { createZip, exportBackup, restoreBackup };
