// 数据层：本地 data/ 目录的读写（原子写入），library / 单篇文档 / 设置 / 翻译缓存
'use strict';
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const ROOT = path.join(__dirname, '..');
const DATA = path.join(ROOT, 'data');
const DOCS = path.join(DATA, 'docs');

const FILES = {
  settings: path.join(DATA, 'settings.json'),
  library: path.join(DATA, 'library.json'),
  cache: path.join(DATA, 'translation_cache.json'),
  vocab: path.join(DATA, 'vocab.json'),
};

const DEFAULT_SETTINGS = {
  translate: {
    provider: 'mymemory', // mymemory | openai | deepl
    target: 'zh-CN',      // zh-CN | zh-TW | en | ja
    mymemory: {},
    openai: { baseUrl: 'https://api.openai.com/v1', apiKey: '', model: 'gpt-4o-mini' },
    deepl: { url: 'https://api-free.deepl.com/v2/translate', apiKey: '' },
  },
  linkageOn: false,
};

const CACHE_MAX_ENTRIES = 20000;

function atomicWrite(file, buf) {
  const tmp = file + '.tmp-' + process.pid;
  fs.writeFileSync(tmp, buf);
  fs.renameSync(tmp, file);
}

function readJson(file, fallback) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (e) {
    // 单文件损坏时隔离，不拖垮整体
    try {
      if (fs.existsSync(file)) fs.renameSync(file, file + '.corrupt-' + Date.now());
    } catch (_) {}
    if (fallback !== undefined) return fallback;
    throw e;
  }
}

function writeJson(file, obj) {
  atomicWrite(file, Buffer.from(JSON.stringify(obj, null, 2), 'utf8'));
}

function ensureInit() {
  fs.mkdirSync(DOCS, { recursive: true });
  if (!fs.existsSync(FILES.settings)) writeJson(FILES.settings, DEFAULT_SETTINGS);
  if (!fs.existsSync(FILES.library)) writeJson(FILES.library, { docs: [] });
  if (!fs.existsSync(FILES.cache)) writeJson(FILES.cache, { entries: {} });
  if (!fs.existsSync(FILES.vocab)) writeJson(FILES.vocab, { words: [] });
}

function mergeDefaults(base, defaults) {
  const out = Object.assign({}, defaults);
  for (const k of Object.keys(base || {})) {
    const v = base[k];
    if (v && typeof v === 'object' && !Array.isArray(v) && defaults[k] && typeof defaults[k] === 'object') {
      out[k] = mergeDefaults(v, defaults[k]);
    } else if (v !== undefined) {
      out[k] = v;
    }
  }
  return out;
}

// ---------- 设置 ----------
function getSettings() {
  return mergeDefaults(readJson(FILES.settings, {}), DEFAULT_SETTINGS);
}
function saveSettings(patch) {
  const merged = mergeDefaults(Object.assign(getSettings(), patch), DEFAULT_SETTINGS);
  writeJson(FILES.settings, merged);
  return merged;
}

// ---------- 文档库 ----------
function listDocs() {
  const lib = readJson(FILES.library, { docs: [] });
  return (lib.docs || []).slice().sort((a, b) => (b.lastOpenedAt || 0) - (a.lastOpenedAt || 0));
}
function saveLibrary(docs) {
  writeJson(FILES.library, { docs, updatedAt: Date.now() });
}
function getMeta(id) {
  return listDocs().find((d) => d.id === id) || null;
}
function updateMeta(id, patch) {
  const lib = readJson(FILES.library, { docs: [] });
  const i = (lib.docs || []).findIndex((d) => d.id === id);
  if (i < 0) return null;
  lib.docs[i] = Object.assign(lib.docs[i], patch);
  saveLibrary(lib.docs);
  return lib.docs[i];
}

function validId(id) {
  return typeof id === 'string' && /^[A-Za-z0-9_-]{1,64}$/.test(id);
}
function newId() {
  return 'd' + Date.now().toString(36) + crypto.randomBytes(4).toString('hex');
}

// ---------- 文档数据 ----------
function docJsonPath(id) {
  if (!validId(id)) throw new Error('非法文档 id');
  return path.join(DOCS, id + '.json');
}
function docPdfPath(id) {
  if (!validId(id)) throw new Error('非法文档 id');
  return path.join(DOCS, id + '.pdf');
}
function emptyDoc(meta) {
  return {
    meta,
    note: { md: '', tags: [], updatedAt: 0 },
    highlights: [],
    annotations: [],
  };
}
function getDoc(id) {
  if (!getMeta(id)) return null;
  const p = docJsonPath(id);
  if (!fs.existsSync(p)) return emptyDoc(getMeta(id));
  const doc = readJson(p, null);
  if (!doc) return emptyDoc(getMeta(id));
  doc.note = Object.assign({ md: '', tags: [], updatedAt: 0 }, doc.note || {});
  doc.highlights = doc.highlights || [];
  doc.annotations = doc.annotations || [];
  doc.meta = getMeta(id); // meta 以 library 为准
  return doc;
}
function saveDoc(doc) {
  const id = doc.meta && doc.meta.id;
  if (!getMeta(id)) throw new Error('文档不存在');
  const { meta, ...rest } = doc;
  // meta 中只接受受控字段的更新
  const patch = {};
  if (Number.isFinite(meta.pages)) patch.pages = meta.pages;
  if (patch.pages !== undefined) updateMeta(id, patch);
  const out = { meta: getMeta(id), note: rest.note, highlights: rest.highlights, annotations: rest.annotations };
  writeJson(docJsonPath(id), out);
  return out;
}
function createDoc(name, size) {
  const id = newId();
  const meta = {
    id,
    name,
    size: size || 0,
    pages: 0,
    importedAt: Date.now(),
    lastOpenedAt: Date.now(),
  };
  const lib = readJson(FILES.library, { docs: [] });
  lib.docs = lib.docs || [];
  lib.docs.push(meta);
  saveLibrary(lib.docs);
  writeJson(docJsonPath(id), emptyDoc(meta));
  return meta;
}
function deleteDoc(id) {
  const meta = getMeta(id);
  if (!meta) return false;
  saveLibrary(listDocs().filter((d) => d.id !== id));
  try { fs.unlinkSync(docJsonPath(id)); } catch (_) {}
  try { fs.unlinkSync(docPdfPath(id)); } catch (_) {}
  return true;
}
function savePdf(id, buf) {
  atomicWrite(docPdfPath(id), buf);
  const meta = getMeta(id);
  if (meta) updateMeta(id, { size: buf.length });
}
function pdfExists(id) {
  return validId(id) && fs.existsSync(docPdfPath(id));
}

// ---------- 翻译缓存（内存 + 落盘，LRU） ----------
let cacheMem = null;
let cacheTimer = null;
function cacheLoad() {
  if (!cacheMem) {
    const data = readJson(FILES.cache, { entries: {} });
    cacheMem = data.entries || {};
  }
  return cacheMem;
}
function cacheFlush() {
  if (!cacheMem) return;
  try { writeJson(FILES.cache, { entries: cacheMem }); } catch (_) {}
}
function cacheScheduleFlush() {
  if (cacheTimer) return;
  cacheTimer = setTimeout(() => { cacheTimer = null; cacheFlush(); }, 2000);
}
function cacheKey(provider, target, text) {
  return crypto.createHash('sha1').update(provider + '|' + target + '|' + text).digest('hex');
}
function cacheGet(key) {
  const entries = cacheLoad();
  const e = entries[key];
  if (!e) return null;
  e.ts = Date.now();
  return e.t;
}
function cachePut(key, value) {
  const entries = cacheLoad();
  entries[key] = { t: value, ts: Date.now() };
  const keys = Object.keys(entries);
  if (keys.length > CACHE_MAX_ENTRIES) {
    keys.sort((a, b) => entries[a].ts - entries[b].ts);
    const drop = keys.slice(0, keys.length - CACHE_MAX_ENTRIES);
    for (const k of drop) delete entries[k];
  }
  cacheScheduleFlush();
}
function cacheStats() {
  try {
    if (cacheMem) return { count: Object.keys(cacheMem).length };
    const data = readJson(FILES.cache, { entries: {} });
    return { count: Object.keys(data.entries || {}).length };
  } catch (_) {
    return { count: 0 };
  }
}

// ---------- 词库（收集翻译过的单词，供学习复习） ----------
// 词以小写 key 去重；count 为累计查阅次数；learned 为「已掌握」标记
function vocabLoad() {
  const data = readJson(FILES.vocab, { words: [] });
  return Array.isArray(data.words) ? data.words : [];
}
function vocabSave(words) {
  writeJson(FILES.vocab, { words, updatedAt: Date.now() });
}
function getVocab() {
  return vocabLoad().slice().sort((a, b) => (b.lastAt || 0) - (a.lastAt || 0));
}
function addVocabWord(word, trans) {
  const w = String(word || '').trim();
  if (!w) return null;
  const key = w.toLowerCase();
  const words = vocabLoad();
  const now = Date.now();
  let item = words.find((x) => x.key === key);
  if (item) {
    item.count = (item.count || 1) + 1;
    item.lastAt = now;
    if (trans) item.trans = trans;   // 更换翻译引擎后译文随之更新
  } else {
    item = { key, w, trans: trans || '', count: 1, firstAt: now, lastAt: now, learned: false };
    words.push(item);
  }
  vocabSave(words);
  return item;
}
function deleteVocabWord(word) {
  const key = String(word || '').trim().toLowerCase();
  const words = vocabLoad();
  const next = words.filter((x) => x.key !== key);
  if (next.length === words.length) return false;
  vocabSave(next);
  return true;
}
function setVocabLearned(word, learned) {
  const key = String(word || '').trim().toLowerCase();
  const words = vocabLoad();
  const item = words.find((x) => x.key === key);
  if (!item) return null;
  item.learned = !!learned;
  vocabSave(words);
  return item;
}

module.exports = {
  ROOT, DATA, DOCS, FILES, DEFAULT_SETTINGS,
  ensureInit, readJson, writeJson, atomicWrite,
  getSettings, saveSettings,
  listDocs, getMeta, updateMeta, validId,
  getDoc, saveDoc, createDoc, deleteDoc, savePdf, pdfExists,
  docJsonPath, docPdfPath,
  getVocab, addVocabWord, deleteVocabWord, setVocabLearned,
  cacheKey, cacheGet, cachePut, cacheStats, cacheFlush,
};
