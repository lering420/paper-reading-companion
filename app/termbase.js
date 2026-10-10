// 本地术语库：dict/termbase.tsv.gz（ECDICT 裁剪版 + NLP 种子表）按需加载
// 命中即离线直译（学术名词优先），未命中由 translate.js 回退到在线接口
'use strict';
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

const FILE = path.join(__dirname, 'dict', 'termbase.tsv.gz');
let words = null;    // Map: 词条 → 中文译文
let aliases = null;  // Map: 屈折形 → 基词条

function ensureLoaded() {
  if (words) return true;
  words = new Map();
  aliases = new Map();
  try {
    if (!fs.existsSync(FILE)) return false;
    const txt = zlib.gunzipSync(fs.readFileSync(FILE)).toString('utf8');
    for (const line of txt.split('\n')) {
      if (!line) continue;
      const i = line.indexOf('\t');
      if (i <= 0) continue;
      const k = line.slice(0, i);
      const v = line.slice(i + 1);
      if (v.charCodeAt(0) === 64) aliases.set(k, v.slice(1)); // '@' 指向基词条
      else words.set(k, v);
    }
    return words.size > 0;
  } catch (e) {
    console.error('[termbase] 加载失败:', e.message);
    words = new Map();
    aliases = new Map();
    return false;
  }
}

function normalize(s) {
  let k = String(s || '').replace(/\s+/g, ' ').trim().toLowerCase();
  k = k.replace(/^[\p{P}\p{S}]+|[\p{P}\p{S}]+$/gu, '');
  return k;
}

function probe(k) {
  const v = words.get(k);
  if (v) return v;
  const a = aliases.get(k);
  if (a) {
    const b = words.get(a);
    if (b) return b;
  }
  return null;
}

function lookup(text) {
  if (!ensureLoaded()) return null;
  const k = normalize(text);
  if (!k || k.length > 80) return null;
  let hit = probe(k);
  if (!hit && k.includes('-')) hit = probe(k.replace(/-/g, ' '));
  if (!hit && k.includes(' ')) hit = probe(k.replace(/ /g, '-'));
  if (!hit && k.length >= 4 && k.endsWith('ies')) hit = probe(k.slice(0, -3) + 'y');
  if (!hit && k.length >= 4 && k.endsWith('es')) hit = probe(k.slice(0, -2));
  if (!hit && k.length >= 3 && k.endsWith('s')) hit = probe(k.slice(0, -1));
  return hit;
}

function stats() {
  ensureLoaded();
  return { count: words.size, aliases: aliases.size };
}

module.exports = { lookup, stats, normalize };
