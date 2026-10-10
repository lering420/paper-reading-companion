// 核心：API 封装、状态、路由、通用 UI（toast / 确认 / 下载 / Markdown / 数学公式）
(function () {
  'use strict';
  const PR = (window.PR = window.PR || {});

  // ---------- 状态 ----------
  PR.state = { settings: null, docs: [], dataDir: '', cache: { count: 0 } };

  // ---------- HTTP ----------
  async function req(method, url, body) {
    const opts = { method, headers: {} };
    if (body !== undefined && body !== null) {
      if (body instanceof ArrayBuffer || ArrayBuffer.isView(body)) {
        opts.headers['Content-Type'] = 'application/octet-stream';
        opts.body = body;
      } else {
        opts.headers['Content-Type'] = 'application/json';
        opts.body = JSON.stringify(body);
      }
    }
    let res;
    try {
      res = await fetch(url, opts);
    } catch (e) {
      throw new Error('无法连接本地服务，请确认应用已启动');
    }
    let data = null;
    try { data = await res.json(); } catch (_) {}
    if (!res.ok) throw new Error((data && data.error) || '请求失败（HTTP ' + res.status + '）');
    return data;
  }

  PR.api = {
    async bootstrap() {
      const d = await req('GET', '/api/bootstrap');
      PR.state.docs = d.docs || [];
      PR.state.settings = d.settings;
      PR.state.dataDir = d.dataDir || '';
      PR.state.cache = d.cache || { count: 0 };
      return d;
    },
    getDoc: (id) => req('GET', '/api/doc/' + id),
    putDoc: (id, doc) => req('PUT', '/api/doc/' + id, doc),
    delDoc: (id) => req('DELETE', '/api/doc/' + id),
    importPdf: (name, buf) => req('POST', '/api/import?name=' + encodeURIComponent(name), buf),
    translate: (text) => req('POST', '/api/translate', { text }),
    async saveSettings(patch) {
      const d = await req('POST', '/api/settings', patch);
      PR.state.settings = d.settings;
      return d.settings;
    },
    test: (settings) => req('POST', '/api/test', { settings }),
    restore: (buf) => req('POST', '/api/restore', buf),
    vocabList: () => req('GET', '/api/vocab'),
    vocabAdd: (word, trans) => req('POST', '/api/vocab', { word, trans }),
    vocabDel: (word) => req('POST', '/api/vocab/delete', { word }),
    vocabLearned: (word, learned) => req('POST', '/api/vocab/learned', { word, learned }),
  };

  // ---------- 通用 UI ----------
  PR.toast = function (msg, type, ms) {
    const box = document.getElementById('toasts');
    const el = document.createElement('div');
    el.className = 'toast ' + (type || 'info');
    el.textContent = msg;
    box.appendChild(el);
    requestAnimationFrame(() => el.classList.add('show'));
    setTimeout(() => {
      el.classList.remove('show');
      setTimeout(() => el.remove(), 300);
    }, ms || 2600);
  };
  PR.toastErr = function (e) {
    PR.toast((e && e.message) || String(e), 'error', 4000);
  };
  PR.confirmBox = function (msg) {
    return Promise.resolve(window.confirm(msg));
  };
  PR.downloadBlob = function (filename, blob) {
    const a = document.createElement('a');
    const url = URL.createObjectURL(blob);
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 4000);
  };
  PR.escapeHtml = function (s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({
      '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
    })[c]);
  };
  PR.fmtTime = function (ts) {
    if (!ts) return '';
    const d = new Date(ts);
    const now = new Date();
    const hm = String(d.getHours()).padStart(2, '0') + ':' + String(d.getMinutes()).padStart(2, '0');
    if (d.toDateString() === now.toDateString()) return '今天 ' + hm;
    return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' +
      String(d.getDate()).padStart(2, '0') + ' ' + hm;
  };
  PR.renderMarkdown = function (md) {
    try {
      const m = window.marked;
      const html = m && m.parse ? m.parse(md || '') : String(md || '');
      return html;
    } catch (e) {
      return '<pre>' + PR.escapeHtml(md) + '</pre>';
    }
  };
  PR.renderMath = function (el) {
    if (typeof window.renderMathInElement === 'function') {
      try {
        window.renderMathInElement(el, {
          delimiters: [
            { left: '$$', right: '$$', display: true },
            { left: '$', right: '$', display: false },
            { left: '\\[', right: '\\]', display: true },
            { left: '\\(', right: '\\)', display: false },
          ],
          ignoredTags: ['script', 'noscript', 'style', 'pre', 'code'],
        });
      } catch (_) {}
    }
  };

  // ---------- 路由 ----------
  const views = (PR.views = PR.views || {});
  let current = null;
  let routing = false;

  function parseHash() {
    const h = (location.hash || '#/').replace(/^#/, '') || '/';
    const qi = h.indexOf('?');
    const path = qi >= 0 ? h.slice(0, qi) : h;
    const query = {};
    if (qi >= 0) new URLSearchParams(h.slice(qi + 1)).forEach((v, k) => (query[k] = v));
    const seg = path.split('/').filter(Boolean);
    if (seg[0] === 'read' && seg[1]) return { name: 'reader', id: decodeURIComponent(seg[1]), query };
    if (seg[0] === 'notes') return { name: 'manager', query };
    if (seg[0] === 'vocab') return { name: 'vocab', query };
    if (seg[0] === 'settings') return { name: 'settings', query };
    return { name: 'home', query };
  }

  async function route() {
    if (routing) return;
    routing = true;
    try {
      if (current && typeof current.destroy === 'function') {
        try { await current.destroy(); } catch (e) { console.error(e); }
      }
      current = null;
      const el = document.getElementById('app');
      el.innerHTML = '';
      window.scrollTo(0, 0);
      const r = parseHash();
      const view = views[r.name] || views.home;
      if (!view) { el.innerHTML = '<p style="padding:40px">视图未注册：' + r.name + '</p>'; return; }
      current = { destroy: view.destroy };
      await view.render(el, r);
    } finally {
      routing = false;
    }
  }
  PR.rerender = route;
  PR.go = function (hash) {
    if (location.hash === hash) route();
    else location.hash = hash;
  };

  window.addEventListener('hashchange', route);

  // ---------- 启动 ----------
  async function boot() {
    try {
      await PR.api.bootstrap();
    } catch (e) {
      document.getElementById('app').innerHTML =
        '<div class="boot-error"><h2>无法连接本地服务</h2><p>' + PR.escapeHtml(e.message) +
        '</p><p>请通过 start.bat（或 start.command）启动应用后刷新本页面。</p></div>';
      return;
    }
    if (!location.hash) location.hash = '#/';
    route();
  }
  // 等所有经典脚本（home/settings/manager/reader）执行完再启动：
  // bootstrap 响应可能先于后续脚本加载完成，过早路由会因视图未注册而回退首页
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
  else boot();
})();
