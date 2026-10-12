// 论文伴读 — 本地服务：静态文件 + REST API
'use strict';
const http = require('http');
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const store = require('./store');
const { translate, testConnection } = require('./translate');
const termbase = require('./termbase');
const backup = require('./backup');

const ROOT = path.join(__dirname, '..');
const STATIC = path.join(__dirname, 'static');
const MAX_PDF = 300 * 1024 * 1024;
const MAX_RESTORE = 800 * 1024 * 1024;

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.pdf': 'application/pdf',
  '.png': 'image/png', '.jpg': 'image/jpeg', '.svg': 'image/svg+xml',
  '.woff2': 'font/woff2', '.woff': 'font/woff', '.ttf': 'font/ttf',
  '.bcmap': 'application/octet-stream',
  '.md': 'text/markdown; charset=utf-8',
  '.zip': 'application/zip',
};

function sendJson(res, status, obj) {
  const buf = Buffer.from(JSON.stringify(obj));
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(buf);
}
function sendErr(res, status, msg) {
  sendJson(res, status, { error: String(msg || '未知错误') });
}
function readBody(req, limit) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (c) => {
      size += c.length;
      if (size > limit) {
        reject(Object.assign(new Error('内容超过大小限制'), { status: 413 }));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}
function jsonBody(req, limit) {
  return readBody(req, limit || 10 * 1024 * 1024).then((b) => {
    try { return JSON.parse(b.toString('utf8') || '{}'); }
    catch (_) { throw Object.assign(new Error('JSON 格式错误'), { status: 400 }); }
  });
}

function serveStatic(res, rel) {
  const safe = path.normalize(rel).replace(/^(\.\.[/\\])+/, '');
  const file = path.join(STATIC, safe);
  if (!file.startsWith(STATIC)) { sendErr(res, 403, 'forbidden'); return; }
  fs.stat(file, (err, st) => {
    if (err || !st.isFile()) { sendErr(res, 404, 'not found'); return; }
    res.writeHead(200, {
      'Content-Type': MIME[path.extname(file).toLowerCase()] || 'application/octet-stream',
      'Content-Length': st.size,
      'Cache-Control': 'no-cache',
    });
    fs.createReadStream(file).pipe(res);
  });
}

function servePdf(res, id, req) {
  if (!store.pdfExists(id)) { sendErr(res, 404, 'PDF 不存在'); return; }
  const file = store.docPdfPath(id);
  const st = fs.statSync(file);
  const range = req.headers.range;
  if (range) {
    const m = /bytes=(\d*)-(\d*)/.exec(range);
    if (m) {
      let start = m[1] === '' ? null : parseInt(m[1], 10);
      let end = m[2] === '' ? null : parseInt(m[2], 10);
      if (start === null) { start = Math.max(0, st.size - (end || 0)); end = st.size - 1; }
      else if (end === null || end >= st.size) end = st.size - 1;
      if (start >= st.size || start > end) {
        res.writeHead(416, { 'Content-Range': `bytes */${st.size}` });
        res.end();
        return;
      }
      res.writeHead(206, {
        'Content-Type': 'application/pdf',
        'Content-Range': `bytes ${start}-${end}/${st.size}`,
        'Content-Length': end - start + 1,
        'Accept-Ranges': 'bytes',
        'Cache-Control': 'no-cache',
      });
      fs.createReadStream(file, { start, end }).pipe(res);
      return;
    }
  }
  res.writeHead(200, {
    'Content-Type': 'application/pdf',
    'Content-Length': st.size,
    'Accept-Ranges': 'bytes',
    'Cache-Control': 'no-cache',
  });
  fs.createReadStream(file).pipe(res);
}

async function handleApi(req, res, parsed) {
  const parts = parsed.pathname.split('/').filter(Boolean); // ['api', ...]
  const method = req.method;

  // GET /api/bootstrap
  if (method === 'GET' && parsed.pathname === '/api/bootstrap') {
    return sendJson(res, 200, {
      docs: store.listDocs(),
      settings: store.getSettings(),
      dataDir: store.DATA,
      cache: store.cacheStats(),
      now: Date.now(),
    });
  }
  // POST /api/import?name=xx.pdf
  if (method === 'POST' && parsed.pathname === '/api/import') {
    const name = decodeURIComponent(parsed.searchParams.get('name') || '未命名.pdf').replace(/[\\/:*?"<>|]/g, '_').slice(0, 180);
    if (!/\.pdf$/i.test(name)) return sendErr(res, 400, '仅支持 PDF 文件');
    const meta = store.createDoc(name, 0);
    try {
      const buf = await readBody(req, MAX_PDF);
      if (buf.length < 5 || buf.slice(0, 5).toString() !== '%PDF-') {
        store.deleteDoc(meta.id);
        return sendErr(res, 400, '这不是有效的 PDF 文件');
      }
      store.savePdf(meta.id, buf);
      return sendJson(res, 200, { meta: store.getMeta(meta.id) });
    } catch (e) {
      store.deleteDoc(meta.id);
      throw e;
    }
  }
  // GET/PUT/DELETE /api/doc/:id
  if (parts[0] === 'api' && parts[1] === 'doc' && parts[2]) {
    const id = parts[2];
    if (!store.validId(id)) return sendErr(res, 400, '非法 id');
    if (method === 'GET') {
      const doc = store.getDoc(id);
      if (!doc) return sendErr(res, 404, '文档不存在');
      store.updateMeta(id, { lastOpenedAt: Date.now() });
      doc.meta = store.getMeta(id);
      return sendJson(res, 200, doc);
    }
    if (method === 'PUT') {
      if (!store.getMeta(id)) return sendErr(res, 404, '文档不存在');
      const body = await jsonBody(req, 20 * 1024 * 1024);
      body.meta = Object.assign({}, body.meta, { id });
      const saved = store.saveDoc(body);
      return sendJson(res, 200, { ok: true, savedAt: Date.now(), meta: saved.meta });
    }
    if (method === 'DELETE') {
      const ok = store.deleteDoc(id);
      return ok ? sendJson(res, 200, { ok: true }) : sendErr(res, 404, '文档不存在');
    }
  }
  // GET /api/pdf/:id
  if (method === 'GET' && parts[0] === 'api' && parts[1] === 'pdf' && parts[2]) {
    if (!store.validId(parts[2])) return sendErr(res, 400, '非法 id');
    return servePdf(res, parts[2], req);
  }
  // POST /api/translate
  if (method === 'POST' && parsed.pathname === '/api/translate') {
    const body = await jsonBody(req, 1 * 1024 * 1024);
    try {
      const out = await translate(body.text || '');
      return sendJson(res, 200, out);
    } catch (e) {
      return sendErr(res, e.status || 502, e.message);
    }
  }
  // GET /api/termbase/stats — 本地术语库统计
  if (method === 'GET' && parsed.pathname === '/api/termbase/stats') {
    return sendJson(res, 200, termbase.stats());
  }
  // POST /api/settings
  if (method === 'POST' && parsed.pathname === '/api/settings') {
    const body = await jsonBody(req);
    const saved = store.saveSettings(body || {});
    return sendJson(res, 200, { ok: true, settings: saved });
  }
  // POST /api/test  — 用（未保存的）配置测试翻译连通性
  if (method === 'POST' && parsed.pathname === '/api/test') {
    const body = await jsonBody(req);
    try {
      const out = await testConnection(body && body.settings);
      return sendJson(res, 200, out);
    } catch (e) {
      return sendErr(res, e.status || 502, e.message);
    }
  }
  // GET /api/vocab — 词库列表
  if (method === 'GET' && parsed.pathname === '/api/vocab') {
    return sendJson(res, 200, { words: store.getVocab() });
  }
  // POST /api/vocab — 收录单词（用户在翻译弹窗点「＋ 词库」手动调用）
  if (method === 'POST' && parsed.pathname === '/api/vocab') {
    const body = await jsonBody(req, 64 * 1024);
    const item = store.addVocabWord(body.word, body.trans);
    if (!item) return sendErr(res, 400, '缺少单词');
    return sendJson(res, 200, { ok: true, item });
  }
  // POST /api/vocab/delete — 删除单词 { word }
  if (method === 'POST' && parsed.pathname === '/api/vocab/delete') {
    const body = await jsonBody(req, 64 * 1024);
    const ok = store.deleteVocabWord(body.word);
    return ok ? sendJson(res, 200, { ok: true }) : sendErr(res, 404, '单词不存在');
  }
  // POST /api/vocab/learned — 标记掌握状态 { word, learned }
  if (method === 'POST' && parsed.pathname === '/api/vocab/learned') {
    const body = await jsonBody(req, 64 * 1024);
    const item = store.setVocabLearned(body.word, body.learned);
    if (!item) return sendErr(res, 404, '单词不存在');
    return sendJson(res, 200, { ok: true, item });
  }
  // GET /api/backup
  if (method === 'GET' && parsed.pathname === '/api/backup') {
    const { zip } = backup.exportBackup();
    const d = new Date();
    const stamp = `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, '0')}${String(d.getDate()).padStart(2, '0')}-${String(d.getHours()).padStart(2, '0')}${String(d.getMinutes()).padStart(2, '0')}`;
    res.writeHead(200, {
      'Content-Type': 'application/zip',
      'Content-Disposition': `attachment; filename*=UTF-8''${encodeURIComponent('paper-reader-backup-' + stamp + '.zip')}`,
      'Content-Length': zip.length,
    });
    return res.end(zip);
  }
  // POST /api/restore
  if (method === 'POST' && parsed.pathname === '/api/restore') {
    const buf = await readBody(req, MAX_RESTORE);
    try {
      const out = backup.restoreBackup(buf);
      return sendJson(res, 200, { ok: true, ...out });
    } catch (e) {
      return sendErr(res, 400, e.message);
    }
  }

  return sendErr(res, 404, 'API 不存在');
}

const server = http.createServer(async (req, res) => {
  const parsed = new URL(req.url, 'http://localhost');
  try {
    if (parsed.pathname.startsWith('/api/')) {
      await handleApi(req, res, parsed);
      return;
    }
    if (req.method !== 'GET' && req.method !== 'HEAD') return sendErr(res, 405, 'method not allowed');
    if (parsed.pathname === '/' || parsed.pathname === '/index.html') {
      return serveStatic(res, 'index.html');
    }
    if (parsed.pathname.startsWith('/static/')) {
      return serveStatic(res, decodedPath(parsed.pathname.slice('/static/'.length)));
    }
    return sendErr(res, 404, 'not found');
  } catch (e) {
    const status = e.status || 500;
    if (status >= 500) console.error('[error]', e);
    if (!res.headersSent) sendErr(res, status, e.message || '服务器错误');
    else res.end();
  }
});

function decodedPath(p) {
  try { return decodeURIComponent(p); } catch (_) { return p; }
}

function openBrowser(url) {
  const opts = { detached: true, stdio: 'ignore' };
  try {
    if (process.platform === 'win32') spawn('cmd', ['/c', 'start', '', url], opts).unref();
    else if (process.platform === 'darwin') spawn('open', [url], opts).unref();
    else spawn('xdg-open', [url], opts).unref();
  } catch (_) {}
}

function listen(port, attemptsLeft) {
  server.once('error', (err) => {
    if (err.code === 'EADDRINUSE' && attemptsLeft > 0) {
      listen(port + 1, attemptsLeft - 1);
    } else if (err.code === 'EADDRINUSE') {
      console.error(`[论文伴读] 端口 ${port} 及备用端口都被占用，请关闭占用程序后重试。`);
      process.exit(1);
    } else {
      console.error('[论文伴读] 启动失败：', err.message);
      process.exit(1);
    }
  });
  server.listen(port, '127.0.0.1', () => {
    const url = `http://127.0.0.1:${port}`;
    console.log('');
    console.log('  ┌─────────────────────────────────────────┐');
    console.log('  │   论文伴读 已启动                        │');
    console.log('  │   ' + url.padEnd(39) + '│');
    console.log('  │   关闭本窗口即可退出                      │');
    console.log('  └─────────────────────────────────────────┘');
    console.log('');
    if (!process.env.NO_BROWSER) openBrowser(url);
    // 预热本地术语库（首次悬停取词不卡顿）
    setTimeout(() => { try { termbase.stats(); } catch (_) {} }, 800);
  });
}

process.on('uncaughtException', (e) => console.error('[uncaught]', e));
process.on('unhandledRejection', (e) => console.error('[unhandled]', e));
process.on('exit', () => { try { store.cacheFlush(); } catch (_) {} });

store.ensureInit();
listen(parseInt(process.env.PORT || '7788', 10), 10);
