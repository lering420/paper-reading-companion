// 构建本地术语库：ECDICT CSV（MIT）+ 种子表 → app/dict/termbase.tsv.gz
// 用法：node tools/build-termbase.js（缺少 tools/ecdict.csv 时自动下载）
'use strict';
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

const ROOT = path.join(__dirname, '..');
const CSV = path.join(__dirname, 'ecdict.csv');
const SEED = path.join(ROOT, 'app', 'dict', 'seed-nlp.tsv');
const OUT = path.join(ROOT, 'app', 'dict', 'termbase.tsv.gz');
const SRC = 'https://raw.githubusercontent.com/skywind3000/ECDICT/master/ecdict.csv';

// 屈折形别名只取「同一词元的形态变化」；d(派生词)/其他码可能语义漂移，弃用
const ALIAS_CODES = new Set(['p', 'i', '3', 's']);

function normalizeKey(s) {
  let k = String(s || '').replace(/\s+/g, ' ').trim().toLowerCase();
  k = k.replace(/^[\p{P}\p{S}]+|[\p{P}\p{S}]+$/gu, '');
  return k;
}

function hasCJK(s) {
  return /[一-鿿]/.test(s);
}

// 多行译文清洗：ECDICT 以字面 \n 分隔多行；丢弃 [网络] 行与屈折元信息行、限长、以「；」连接
const META_LINE = /^[\w-]+的?(过去式|现在分词|第三人称单数|复数|比较级|最高级)[一-鿿\w]*$/;
function cleanTrans(raw) {
  const lines = String(raw || '')
    .split(/\\n|\r?\n/)
    .map((s) => s.trim())
    .filter((s) => s && !/^\[网络\]/.test(s) && !META_LINE.test(s));
  if (!lines.length) return '';
  let out = '';
  for (const l of lines) {
    const next = out ? out + '；' + l : l;
    if (out && next.length > 150) break;
    out = next;
    if (out.length > 300) break;
  }
  return out.replace(/\t/g, ' ').trim();
}

async function ensureCsv() {
  if (fs.existsSync(CSV) && fs.statSync(CSV).size > 10 * 1024 * 1024) return;
  console.log('下载 ECDICT →', CSV);
  const res = await fetch(SRC);
  if (!res.ok) throw new Error('下载失败 HTTP ' + res.status);
  fs.writeFileSync(CSV, Buffer.from(await res.arrayBuffer()));
  console.log('下载完成:', fs.statSync(CSV).size, 'bytes');
}

// 流式逐行解析 CSV（带引号字段可含逗号/换行），行完成即回调，不整表驻留内存
function parseCsv(text, onRow) {
  let row = [];
  let field = '';
  let inQ = false;
  const flush = () => {
    row.push(field);
    onRow(row);
    row = [];
    field = '';
  };
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (inQ) {
      if (ch === '"') {
        if (text[i + 1] === '"') { field += '"'; i++; }
        else inQ = false;
      } else field += ch;
    } else if (ch === '"') inQ = true;
    else if (ch === ',') { row.push(field); field = ''; }
    else if (ch === '\n') flush();
    else if (ch !== '\r') field += ch;
  }
  if (field !== '' || row.length) flush();
}

(async () => {
  await ensureCsv();
  const text = fs.readFileSync(CSV, 'utf8');

  /** @type {Map<string, {t: string, s: number}>} */
  const primaries = new Map();
  /** @type {Map<string, string>} alias → 基词条 */
  const aliases = new Map();
  let stats = { rows: 0, noTrans: 0, noCJK: 0, badKey: 0 };
  let col = null;

  parseCsv(text, (row) => {
    if (!col) {
      col = {};
      row.forEach((h, i) => { col[h.trim()] = i; });
      return;
    }
    stats.rows++;
    const word = row[col.word];
    const rawTrans = row[col.translation];
    if (!word) { stats.badKey++; return; }
    const trans = cleanTrans(rawTrans);
    if (!trans) { stats.noTrans++; return; }
    if (!hasCJK(trans)) { stats.noCJK++; return; }
    const key = normalizeKey(word);
    if (!key || key.length > 80) { stats.badKey++; return; }
    const score = (parseInt(row[col.bnc], 10) || 0) + (parseInt(row[col.frq], 10) || 0);
    const prev = primaries.get(key);
    if (!prev || score > prev.s) primaries.set(key, { t: trans, s: score });

    // 屈折形别名（先收集，输出时再过滤与主词条冲突的）
    const ex = row[col.exchange];
    if (ex) {
      for (const part of String(ex).split('/')) {
        const ci = part.indexOf(':');
        if (ci <= 0) continue;
        const code = part.slice(0, ci);
        if (!ALIAS_CODES.has(code)) continue;
        const form = normalizeKey(part.slice(ci + 1));
        if (!form || form === key) continue;
        if (!aliases.has(form)) aliases.set(form, key);
      }
    }
  });

  // 种子表（覆盖 ECDICT 同名词条：直接替换 primaries 中的值）
  let seedCount = 0;
  if (fs.existsSync(SEED)) {
    for (const line of fs.readFileSync(SEED, 'utf8').split(/\r?\n/)) {
      if (!line || line.startsWith('#')) continue;
      const ti = line.indexOf('\t');
      if (ti <= 0) continue;
      const key = normalizeKey(line.slice(0, ti));
      const val = line.slice(ti + 1).replace(/\t/g, ' ').trim();
      if (!key || !val || !hasCJK(val)) continue;
      primaries.set(key, { t: val, s: Infinity });
      seedCount++;
    }
  }

  // 多词词条补「无分隔符合并形」别名：back propagation → backpropagation
  for (const k of primaries.keys()) {
    if (!/[ -]/.test(k)) continue;
    const joined = k.replace(/[ -]/g, '');
    if (!joined || primaries.has(joined) || aliases.has(joined)) continue;
    aliases.set(joined, k);
  }

  const out = [];
  for (const [k, v] of primaries) out.push(k + '\t' + v.t);
  let aliasKept = 0;
  for (const [k, base] of aliases) {
    if (primaries.has(k)) continue;   // 真实词条优先
    out.push(k + '\t@' + base);
    aliasKept++;
  }

  const buf = zlib.gzipSync(Buffer.from(out.join('\n') + '\n', 'utf8'), { level: 9 });
  fs.mkdirSync(path.dirname(OUT), { recursive: true });
  fs.writeFileSync(OUT, buf);

  console.log('CSV 行数:      ', stats.rows);
  console.log('主词条:        ', primaries.size, '(含种子', seedCount, ')');
  console.log('屈折别名:      ', aliasKept);
  console.log('丢弃: 无译文', stats.noTrans, '/ 非中文', stats.noCJK, '/ 无效键', stats.badKey);
  console.log('输出:', OUT, (buf.length / 1024 / 1024).toFixed(2) + ' MB');
})().catch((e) => { console.error(e); process.exit(1); });
