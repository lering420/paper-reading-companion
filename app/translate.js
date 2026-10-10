// 翻译：提供方适配（mymemory 免费 / openai 兼容 / deepl）、长文本分块、缓存、本地术语库优先
'use strict';
const store = require('./store');
const termbase = require('./termbase');

const TARGET_NAMES = {
  'zh-CN': 'Simplified Chinese (简体中文)',
  'zh-TW': 'Traditional Chinese (繁體中文)',
  en: 'English',
  ja: 'Japanese',
};
const DEEPL_TARGET = { 'zh-CN': 'ZH', 'zh-TW': 'ZH', en: 'EN-US', ja: 'JA' };
const MYMEMORY_PAIR = { 'zh-CN': 'zh-CN', 'zh-TW': 'zh-TW', en: 'en', ja: 'ja' };

function httpError(status, msg) {
  const e = new Error(msg || 'HTTP ' + status);
  e.status = status;
  return e;
}

async function fetchWithTimeout(url, opts, ms) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), ms || 20000);
  try {
    return await fetch(url, Object.assign({}, opts, { signal: ctrl.signal }));
  } catch (e) {
    if (e.name === 'AbortError') throw httpError(504, '翻译服务响应超时');
    throw httpError(502, '网络无法访问翻译服务（请检查网络）');
  } finally {
    clearTimeout(timer);
  }
}

// ---------- 提供方实现，入参为已规整的单块文本 ----------
async function pvMyMemory(text, tcfg, target) {
  const pair = 'en|' + (MYMEMORY_PAIR[target] || 'zh-CN');
  const url =
    'https://api.mymemory.translated.net/get?q=' +
    encodeURIComponent(text.slice(0, 450)) +
    '&langpair=' + encodeURIComponent(pair);
  const res = await fetchWithTimeout(url, { headers: { 'User-Agent': 'paper-reader/1.0' } });
  const data = await res.json().catch(() => null);
  if (!data || data.responseStatus !== 200) {
    const detail = (data && (data.responseDetails || data.quotaFinished)) || 'HTTP ' + res.status;
    if (data && data.quotaFinished) throw httpError(429, '免费翻译接口今日额度已用完，请稍后再试或在设置中更换接口');
    throw httpError(res.status === 200 ? 502 : res.status, '免费翻译接口异常：' + detail);
  }
  const out = String(data.responseData && data.responseData.translatedText || '').trim();
  if (!out) throw httpError(502, '翻译接口返回为空');
  if (/MYMEMORY WARNING/i.test(out)) throw httpError(429, '免费翻译接口额度受限，请稍后再试或更换接口');
  return out;
}

async function pvOpenAI(text, tcfg, target) {
  const base = String(tcfg.baseUrl || 'https://api.openai.com/v1').replace(/\/+$/, '');
  const key = tcfg.apiKey || '';
  if (!key) throw httpError(400, '未配置 API Key，请到设置页填写');
  const lang = TARGET_NAMES[target] || 'Simplified Chinese';
  const res = await fetchWithTimeout(base + '/chat/completions', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + key },
    body: JSON.stringify({
      model: tcfg.model || 'gpt-4o-mini',
      temperature: 0.2,
      messages: [
        { role: 'system', content: 'You are a professional academic translator. Translate the user\'s text into ' + lang + '. Keep terminology precise. Output only the translation, no quotes or notes.' },
        { role: 'user', content: text },
      ],
    }),
  });
  const data = await res.json().catch(() => null);
  if (!res.ok) {
    const msg = (data && data.error && data.error.message) || 'HTTP ' + res.status;
    throw httpError(res.status, 'OpenAI 接口错误：' + msg);
  }
  const out = String(data && data.choices && data.choices[0] && data.choices[0].message && data.choices[0].message.content || '').trim();
  if (!out) throw httpError(502, '翻译接口返回为空');
  return out;
}

async function pvDeepL(text, tcfg, target) {
  const url = String(tcfg.url || 'https://api-free.deepl.com/v2/translate').replace(/\/+$/, '');
  const key = tcfg.apiKey || '';
  if (!key) throw httpError(400, '未配置 API Key，请到设置页填写');
  const res = await fetchWithTimeout(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: 'DeepL-Auth-Key ' + key },
    body: JSON.stringify({ text: [text], target_lang: DEEPL_TARGET[target] || 'ZH' }),
  });
  const data = await res.json().catch(() => null);
  if (!res.ok) {
    const msg = (data && data.message) || 'HTTP ' + res.status;
    throw httpError(res.status, 'DeepL 接口错误：' + msg);
  }
  const out = data && data.translations && data.translations[0] && data.translations[0].text;
  if (!out) throw httpError(502, '翻译接口返回为空');
  return String(out).trim();
}

const PROVIDERS = { mymemory: pvMyMemory, openai: pvOpenAI, deepl: pvDeepL };
const CHUNK_LIMIT = { mymemory: 440, openai: 4000, deepl: 4500 };

function splitChunks(text, limit) {
  if (text.length <= limit) return [text];
  const chunks = [];
  let rest = text;
  while (rest.length > limit) {
    let cut = -1;
    // 优先在句子边界切，其次在空格处切
    const window = rest.slice(0, limit);
    const m = window.match(/[.!?。！？]['"”’)\]]*\s+/g);
    if (m && m.length) cut = m[m.length - 1].index + m[m.length - 1][0].length;
    if (cut < limit * 0.4) {
      const sp = window.lastIndexOf(' ');
      if (sp > limit * 0.5) cut = sp + 1;
    }
    if (cut <= 0) cut = limit;
    chunks.push(rest.slice(0, cut).trim());
    rest = rest.slice(cut).trim();
  }
  if (rest) chunks.push(rest);
  return chunks;
}

async function translate(text) {
  const settings = store.getSettings();
  const tcfg = settings.translate || {};
  const provider = PROVIDERS[tcfg.provider] ? tcfg.provider : 'mymemory';
  const target = tcfg.target || 'zh-CN';
  const norm = String(text || '').replace(/\s+/g, ' ').trim();
  if (!norm) return { text: '', cached: false, provider };
  if (norm.length > 8000) throw httpError(413, '选中内容过长（超过 8000 字符），请分段翻译');

  // 简体中文目标：本地术语库优先（学术名词准确且离线可用），未命中再走在线接口
  if (target === 'zh-CN') {
    const dict = termbase.lookup(norm);
    if (dict) return { text: dict, cached: false, provider: 'termbase' };
  }

  const key = store.cacheKey(provider, target, norm);
  const hit = store.cacheGet(key);
  if (hit !== null && hit !== undefined) return { text: hit, cached: true, provider };

  const limit = CHUNK_LIMIT[provider] || 440;
  const chunks = splitChunks(norm, limit);
  const parts = [];
  for (const c of chunks) {
    parts.push(await PROVIDERS[provider](c, tcfg.translate || tcfg, target));
  }
  const out = parts.join(' ').replace(/\s+/g, ' ').trim();
  store.cachePut(key, out);
  return { text: out, cached: false, provider };
}

async function testConnection(settingsPatch) {
  const saved = store.getSettings();
  const effective = settingsPatch ? deepMerge(saved, settingsPatch) : saved;
  const tcfg = effective.translate || {};
  const provider = PROVIDERS[tcfg.provider] ? tcfg.provider : 'mymemory';
  const target = tcfg.target || 'zh-CN';
  const out = await PROVIDERS[provider]('The quick brown fox jumps over the lazy dog.', tcfg, target);
  return { ok: true, provider, sample: out };
}

function deepMerge(a, b) {
  const out = Object.assign({}, a);
  for (const k of Object.keys(b || {})) {
    const v = b[k];
    if (v && typeof v === 'object' && !Array.isArray(v) && a[k] && typeof a[k] === 'object') {
      out[k] = deepMerge(a[k], v);
    } else if (v !== undefined) out[k] = v;
  }
  return out;
}

module.exports = { translate, testConnection };
