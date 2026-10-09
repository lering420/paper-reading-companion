// 阅读页：PDF 渲染、悬停/选中即译、高亮 + 全文联动、批注、笔记抽屉、本地持久化
(function () {
  'use strict';
  const PR = window.PR;
  const PAD = 24;            // 页面左右留白
  const HOVER_DELAY = 420;   // 悬停取词延迟 ms

  // ---------- 模块状态 ----------
  let root = null;           // 容器
  let box = null;            // 滚动容器（.rbody）
  let doc = null;            // 单篇文档完整数据
  let pdf = null;
  let numPages = 0;
  let pageEls = [];          // 1-based
  let fitScale = 1;
  let scale = 1;
  let zoomFactor = 1;
  let fitWidth = 0;
  let linkageOn = false;
  let renderedSet = new Set();
  let queue = [];
  let inFlight = new Map();
  let rendering = 0;
  let observer = null;
  let dirty = false;
  let saveTimer = null;
  let destroyed = true;
  let curPage = 1;
  let pendingFlash = null;
  let boundFns = [];
  let hover = { timer: null, word: '', el: null, hideTimer: null, trans: null, rect: null, range: null };
  let selPop = null;
  let notePop = null;
  let rafScroll = 0;

  // ---------- 高亮配色（按词稳定取色，同词同色） ----------
  const HL_PALETTE = [
    [250, 204, 21], [34, 197, 94], [56, 189, 248], [168, 85, 247],
    [244, 63, 94], [249, 115, 22], [20, 184, 166], [236, 72, 153],
  ];
  function hlColor(text, alpha) {
    const t = (text || '').toLowerCase();
    let h = 5381;
    for (let i = 0; i < t.length; i++) h = ((h << 5) + h + t.charCodeAt(i)) >>> 0;
    const c = HL_PALETTE[h % HL_PALETTE.length];
    return 'rgba(' + c[0] + ',' + c[1] + ',' + c[2] + ',' + alpha + ')';
  }

  function uid(p) { return (p || 'x') + Date.now().toString(36) + Math.random().toString(36).slice(2, 6); }
  function on(target, ev, fn, opts) {
    target.addEventListener(ev, fn, opts);
    boundFns.push(() => target.removeEventListener(ev, fn, opts));
  }

  // ---------- 翻译（去重 + 缓存直连服务端） ----------
  const inflight = new Map();
  function doTranslate(text) {
    if (inflight.has(text)) return inflight.get(text);
    const p = PR.api.translate(text);
    inflight.set(text, p);
    p.catch(() => {}).then(() => inflight.delete(text));
    return p;
  }

  // ---------- 骨架 ----------
  function skeleton(name) {
    return (
      '<div class="reader">' +
      '<header class="rbar">' +
      '<button class="btn ghost" id="r-back">← 文档库</button>' +
      '<div class="r-title" title="' + PR.escapeHtml(name) + '">' + PR.escapeHtml(name) + '</div>' +
      '<label class="switch r-link"><input type="checkbox" id="r-linkage"><span></span>全文联动高亮</label>' +
      '<div class="r-pager"><button class="btn mini" id="r-prev">‹</button>' +
      '<input id="r-page" type="number" min="1" value="1"><span id="r-total">/ ?</span>' +
      '<button class="btn mini" id="r-next">›</button></div>' +
      '<div class="r-zoom"><button class="btn mini" id="r-zout">－</button>' +
      '<span id="r-zval">100%</span>' +
      '<button class="btn mini" id="r-zin">＋</button></div>' +
      '<button class="btn ghost" id="r-tab-note">📝 笔记</button>' +
      '<button class="btn ghost" id="r-tab-hl">🖍 高亮</button>' +
      '<span class="r-saved" id="r-saved"></span>' +
      '</header>' +
      '<div class="rbody" id="rbody">' +
      '<div class="r-banner" id="r-banner" hidden></div>' +
      '<div class="pages" id="pages"></div>' +
      '</div>' +
      '<aside class="drawer" id="drawer">' +
      '<div class="d-tabs">' +
      '<button class="on" data-t="note">📝 本篇笔记</button>' +
      '<button data-t="hl">🖍 高亮 · 批注 <i id="d-hlcount"></i></button>' +
      '<button class="d-close" id="d-close" title="收起">×</button>' +
      '</div>' +
      '<div class="d-pane" id="pane-note">' +
      '<div class="np-head">' +
      '<div class="np-tags" id="np-tags"></div>' +
      '<input id="np-tagin" placeholder="＋ 标签后回车添加" maxlength="20">' +
      '</div>' +
      '<div class="np-toolbar">' +
      '<button data-m="edit" class="on">编辑</button>' +
      '<button data-m="preview">预览</button>' +
      '<button data-m="split">分屏</button>' +
      '</div>' +
      '<div class="np-body mode-edit" id="np-body">' +
      '<textarea id="np-md" placeholder="用 Markdown 记点什么…&#10;&#10;支持 $公式$、# 标题、- 列表、`代码`"></textarea>' +
      '<div class="np-preview" id="np-pv" hidden></div>' +
      '</div>' +
      '</div>' +
      '<div class="d-pane" id="pane-hl" hidden><div class="hl-list" id="hl-list"></div></div>' +
      '</aside>' +
      '</div>'
    );
  }

  // ---------- 页面占位与渲染 ----------
  async function buildPlaceholders() {
    const p1 = await pdf.getPage(1);
    const vp1 = p1.getViewport({ scale: 1 });
    const w = Math.max(320, box.clientWidth - PAD * 2);
    fitScale = w / vp1.width;
    fitWidth = box.clientWidth;
    scale = fitScale * zoomFactor;
    const pagesEl = root.querySelector('#pages');
    pagesEl.style.setProperty('--aspect', vp1.height / vp1.width);
    for (let n = 1; n <= numPages; n++) {
      const d = document.createElement('div');
      d.className = 'page loading';
      d.dataset.page = n;
      d.style.width = Math.round(w) + 'px';
      d.style.height = Math.round(w * (vp1.height / vp1.width)) + 'px';
      d.innerHTML = '<div class="pg-spin">第 ' + n + ' 页渲染中…</div>';
      pagesEl.appendChild(d);
      pageEls[n] = d;
    }
  }

  const pageAtViewport = () => {
    const br = box.getBoundingClientRect();
    let best = 1;
    for (let n = 1; n <= numPages; n++) {
      const el = pageEls[n];
      if (!el) continue;
      if (el.getBoundingClientRect().top - br.top <= 80) best = n;
    }
    return best;
  };

  function scheduleRender(n) {
    if (n < 1 || n > numPages) return Promise.resolve();
    const el = pageEls[n];
    if (!el) return Promise.resolve();
    if (el.dataset.rendered === String(scale) && renderedSet.has(n)) return Promise.resolve();
    if (inFlight.has(n)) return inFlight.get(n);
    if (queue.includes(n)) return Promise.resolve();
    queue.push(n);
    pump();
    return inFlight.get(n) || Promise.resolve();
  }

  function pump() {
    while (rendering < 2 && queue.length) {
      const n = queue.shift();
      rendering++;
      const p = doRender(n)
        .catch((e) => console.error('render page ' + n, e))
        .finally(() => {
          rendering--;
          inFlight.delete(n);
          pump();
        });
      inFlight.set(n, p);
    }
  }

  async function doRender(n) {
    const el = pageEls[n];
    if (!el || !pdf) return;
    const myScale = scale;
    if (el.dataset.rendered === String(myScale) && el.querySelector('canvas')) {
      drawnOverlays(n);
      return;
    }
    const page = await pdf.getPage(n);
    if (destroyed || !pdf) return;
    const viewport = page.getViewport({ scale: myScale });
    el.style.width = Math.floor(viewport.width) + 'px';
    el.style.height = Math.floor(viewport.height) + 'px';
    el.style.setProperty('--scale-factor', myScale);
    let canvas = el.querySelector('canvas');
    if (!canvas) {
      canvas = document.createElement('canvas');
      el.insertBefore(canvas, el.firstChild);
    }
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    canvas.width = Math.floor(viewport.width * dpr);
    canvas.height = Math.floor(viewport.height * dpr);
    canvas.style.width = Math.floor(viewport.width) + 'px';
    canvas.style.height = Math.floor(viewport.height) + 'px';
    const ctx = canvas.getContext('2d', { alpha: false });
    await page.render({
      canvasContext: ctx,
      viewport,
      transform: dpr !== 1 ? [dpr, 0, 0, dpr, 0, 0] : null,
    }).promise;
    if (destroyed || !pdf || scale !== myScale) {
      // 缩放已变化，重新排队
      el.dataset.rendered = '';
      scheduleRender(n);
      return;
    }
    // 文本层
    let tl = el.querySelector('.textLayer');
    if (!tl) {
      tl = document.createElement('div');
      tl.className = 'textLayer';
      el.appendChild(tl);
    }
    tl.innerHTML = '';
    tl.style.width = Math.floor(viewport.width) + 'px';
    tl.style.height = Math.floor(viewport.height) + 'px';
    const task = pdfjsLib.renderTextLayer({
      textContentSource: page.streamTextContent({ includeMarkedContent: false, disableNormalization: true }),
      container: tl,
      viewport,
    });
    if (task && task.promise) {
      try { await task.promise; } catch (_) {}
    }
    if (destroyed || scale !== myScale) return;
    el.classList.remove('loading');
    el.dataset.rendered = String(myScale);
    renderedSet.add(n);
    if (n === 1) checkScanned(tl);
    drawnOverlays(n);
    if (pendingFlash) applyFlash();
  }

  function checkScanned(tl) {
    const txt = (tl.textContent || '').replace(/\s+/g, '');
    if (txt.length < 40) {
      const b = root.querySelector('#r-banner');
      b.hidden = false;
      b.textContent = '⚠️ 这篇 PDF 没有可选文字层（可能是扫描版图片），取词翻译与高亮暂不可用。';
    }
  }

  // ---------- 高亮绘制 ----------
  function overlayOf(n) {
    const el = pageEls[n];
    if (!el) return null;
    let ov = el.querySelector('.overlay');
    if (!ov) {
      ov = document.createElement('div');
      ov.className = 'overlay';
      el.appendChild(ov);
    }
    return ov;
  }

  function drawnOverlays(n) {
    drawManual(n);
    if (linkageOn) drawLinkage(n);
    else {
      const ov = overlayOf(n);
      if (ov) ov.querySelectorAll('.rhl').forEach((x) => x.remove());
    }
  }
  function redrawAllOverlays() {
    for (const n of renderedSet) drawnOverlays(n);
  }

  function drawManual(n) {
    const ov = overlayOf(n);
    if (!ov) return;
    ov.querySelectorAll('.mhl').forEach((x) => x.remove());
    for (const hl of doc.highlights) {
      for (const r of hl.rects) {
        if (r.p !== n) continue;
        const d = document.createElement('div');
        d.className = 'mhl';
        d.dataset.hl = hl.id;
        d.style.setProperty('--hlc', hlColor(hl.text, 0.52));
        d.style.left = (r.x * 100) + '%';
        d.style.top = (r.y * 100) + '%';
        d.style.width = (r.w * 100) + '%';
        d.style.height = (r.h * 100) + '%';
        ov.appendChild(d);
      }
    }
  }

  function linkText(t) {
    t = (t || '').trim();
    if (t && !/\s/.test(t)) t = t.replace(/^[^A-Za-z0-9']+|[^A-Za-z0-9']+$/g, '');
    return t;
  }
  function buildRe(text) {
    if (!text) return null;
    let body = text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    if (/[A-Za-z0-9]/.test(text[0])) body = '(?<![A-Za-z0-9])' + body;
    if (/[A-Za-z0-9]/.test(text[text.length - 1])) body = body + '(?![A-Za-z0-9])';
    try { return new RegExp(body, 'gi'); } catch (_) { return null; }
  }

  function drawLinkage(n) {
    const ov = overlayOf(n);
    const el = pageEls[n];
    if (!ov || !el) return;
    ov.querySelectorAll('.rhl').forEach((x) => x.remove());
    if (!linkageOn) return;
    const tl = el.querySelector('.textLayer');
    if (!tl || !doc.highlights.length) return;
    const res = [];
    for (const hl of doc.highlights) {
      const re = buildRe(linkText(hl.text));
      if (re) res.push({ re, hl });
    }
    if (!res.length) return;
    // 拼接全部文本节点
    const walker = document.createTreeWalker(tl, NodeFilter.SHOW_TEXT);
    const nodes = [];
    let str = '';
    while (walker.nextNode()) {
      const t = walker.currentNode;
      if (!t.data) continue;
      nodes.push({ node: t, start: str.length, end: str.length + t.data.length });
      str += t.data;
    }
    if (!nodes.length) return;
    const nodeAt = (idx) => {
      for (const nd of nodes) if (idx >= nd.start && idx < nd.end) return nd;
      return null;
    };
    const pr = el.getBoundingClientRect();
    let made = 0;
    for (const item of res) {
      const re = item.re;
      const linkHl = hlColor(item.hl.text, 0.24);
      re.lastIndex = 0;
      let m;
      while (made < 800 && (m = re.exec(str))) {
        if (!m[0].length) { re.lastIndex++; continue; }
        made++;
        const a = nodeAt(m.index);
        const b = nodeAt(m.index + m[0].length - 1);
        if (!a || !b) continue;
        const range = document.createRange();
        try {
          range.setStart(a.node, m.index - a.start);
          range.setEnd(b.node, m.index + m[0].length - b.start);
        } catch (_) { continue; }
        for (const r of range.getClientRects()) {
          if (r.width < 0.5 || r.height < 0.5) continue;
          const d = document.createElement('div');
          d.className = 'rhl';
          d.style.setProperty('--hlc', linkHl);
          d.style.left = ((r.left - pr.left) / pr.width * 100) + '%';
          d.style.top = ((r.top - pr.top) / pr.height * 100) + '%';
          d.style.width = (r.width / pr.width * 100) + '%';
          d.style.height = (r.height / pr.height * 100) + '%';
          ov.appendChild(d);
        }
      }
      if (made >= 800) break;
    }
  }

  // ---------- 持久化 ----------
  function savedTip(text, cls) {
    const el = root.querySelector('#r-saved');
    if (!el) return;
    el.textContent = text || '';
    el.className = 'r-saved ' + (cls || '');
  }
  function markDirty() {
    dirty = true;
    savedTip('保存中…', 'saving');
    clearTimeout(saveTimer);
    saveTimer = setTimeout(save, 600);
  }
  async function save() {
    if (!doc || !dirty) return;
    dirty = false;
    try {
      await PR.api.putDoc(doc.meta.id, doc);
      savedTip('✓ 已保存', 'ok');
      setTimeout(() => savedTip(''), 2500);
    } catch (e) {
      dirty = true;
      savedTip('保存失败', 'err');
      PR.toastErr(e);
    }
  }
  function beforeUnload() {
    if (doc && dirty) {
      try {
        fetch('/api/doc/' + doc.meta.id, {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(doc),
          keepalive: true,
        });
      } catch (_) {}
    }
  }

  // ---------- 弹层 ----------
  function popRoot() { return document.getElementById('pop-root'); }
  function closePop(which) {
    if (which === 'sel' || !which) { if (selPop) { selPop.remove(); selPop = null; } }
    if (which === 'note' || !which) { if (notePop) { notePop.remove(); notePop = null; } }
    if (which === 'hover' || !which) hideHover();
  }
  function positionPop(pop, x, y) {
    pop.style.visibility = 'hidden';
    pop.style.left = '0px'; pop.style.top = '0px';
    popRoot().appendChild(pop);
    const w = pop.offsetWidth, h = pop.offsetHeight;
    const cx = Math.min(Math.max(8, x), window.innerWidth - w - 8);
    const cy = y + h + 8 < window.innerHeight ? y : Math.max(8, y - h - 8);
    pop.style.left = cx + 'px';
    pop.style.top = cy + 'px';
    pop.style.visibility = '';
  }

  // 悬停取词（单点探测：从光标处抽出整词，返回 { word, range }）
  function wordAtProbe(x, y) {
    let range = null;
    if (document.caretRangeFromPoint) range = document.caretRangeFromPoint(x, y);
    else if (document.caretPositionFromPoint) {
      const p = document.caretPositionFromPoint(x, y);
      if (p) { range = document.createRange(); range.setStart(p.offsetNode, p.offset); }
    }
    if (!range || range.startContainer.nodeType !== 3) return null;
    const node = range.startContainer;
    if (!node.parentElement || !node.parentElement.closest('.textLayer')) return null;
    const data = node.data;
    let i = range.startOffset;
    if (i >= data.length) i = data.length - 1;
    if (i < 0) return null;
    if (!/[A-Za-z0-9'’-]/.test(data[i] || '')) {
      if (/[A-Za-z0-9'’-]/.test(data[i - 1] || '')) i = i - 1;
      else return null;
    }
    let s = i, e = i;
    while (s > 0 && /[A-Za-z0-9'’-]/.test(data[s - 1])) s--;
    while (e < data.length - 1 && /[A-Za-z0-9'’-]/.test(data[e + 1])) e++;
    let w = data.slice(s, e + 1).replace(/^['’-]+|['’-]+$/g, '');
    if (w.length < 2 || w.length > 40 || !/[A-Za-z]/.test(w)) return null;
    const r2 = document.createRange();
    r2.setStart(node, s); r2.setEnd(node, e + 1);
    return { word: w, range: r2 };
  }

  // 宽松判定：光标落点常在字缝/行间隙，按偏移多点探测
  const HOVER_PROBES = [
    [0, 0], [-6, 0], [6, 0], [0, -4], [0, 4],
    [-12, 0], [12, 0], [0, -8], [0, 8], [-18, 0], [18, 0],
    [0, -12], [0, 12], [-24, 0], [24, 0],
  ];
  function wordInfoAt(x, y) {
    for (const [dx, dy] of HOVER_PROBES) {
      const info = wordAtProbe(x + dx, y + dy);
      if (info) {
        hover.rect = info.range.getBoundingClientRect();
        return info;
      }
    }
    return null;
  }

  // 取消高亮（可批量）：有关联批注（或强制）时先确认，再级联删除
  function removeHighlights(hlIds, forceConfirm) {
    const ids = new Set(hlIds);
    if (!ids.size || !doc) return Promise.resolve(false);
    const n = doc.annotations.filter((a) => ids.has(a.highlightId)).length;
    const p = (forceConfirm || n)
      ? PR.confirmBox(n
          ? '删除这 ' + ids.size + ' 条高亮？关联的 ' + n + ' 条批注也会一并删除。'
          : '取消这 ' + ids.size + ' 条高亮？')
      : Promise.resolve(true);
    return Promise.resolve(p).then((ok) => {
      if (!ok || !doc) return false;
      doc.highlights = doc.highlights.filter((h) => !ids.has(h.id));
      doc.annotations = doc.annotations.filter((a) => !ids.has(a.highlightId));
      markDirty();
      redrawAllOverlays();
      renderHlList();
      return true;
    });
  }

  // 悬停词关联的高亮：文本相同（不分大小写）或几何上落在某条高亮内
  function highlightTargetsFor(word, range) {
    const ids = new Set();
    if (!doc) return [];
    const lw = (word || '').toLowerCase();
    for (const h of doc.highlights) {
      if (h.text && h.text.toLowerCase() === lw) ids.add(h.id);
    }
    try {
      const r0 = range.getClientRects()[0];
      if (r0) {
        const cx = r0.left + r0.width / 2, cy = r0.top + r0.height / 2;
        const pe = findPageAt(cx, cy);
        if (pe) {
          const pr = pe.getBoundingClientRect();
          const hit = hitHighlight(pe, (cx - pr.left) / pr.width, (cy - pr.top) / pr.height);
          if (hit) ids.add(hit.id);
        }
      }
    } catch (_) {}
    return [...ids];
  }

  function showHover(info, x, y) {
    const word = info.word;
    const already = hover.el && hover.el.dataset.word === word;
    hover.range = info.range.cloneRange();   // 捕获供「高亮」按钮使用的范围
    if (!hover.el || !already) {
      if (hover.el) { hover.el.remove(); hover.el = null; }
      const hlIds = highlightTargetsFor(word, info.range);
      const isHl = hlIds.length > 0;
      const pop = document.createElement('div');
      pop.className = 'pop hoverpop';
      pop.dataset.word = word;
      pop.innerHTML =
        '<div class="hp-word">' + PR.escapeHtml(word) + '</div>' +
        '<div class="hp-trans"><span class="loading">翻译中…</span></div>' +
        '<div class="hp-acts">' +
        (isHl
          ? '<button class="btn mini hp-un" title="取消这个词的高亮">✕ 取消高亮</button>'
          : '<button class="btn mini hp-hl" title="将这个词加入高亮">🖍 高亮</button>') +
        '<button class="btn mini hp-copy" title="复制译文">复制</button></div>';
      const r = hover.rect;
      positionPop(pop, r ? r.left : x, r ? r.bottom + 6 : y + 14);
      hover.el = pop;
      pop.addEventListener('mouseenter', () => clearTimeout(hover.hideTimer));
      pop.addEventListener('mouseleave', () => scheduleHideHover(700));
      pop.querySelector('.hp-copy').addEventListener('click', () => {
        const t = pop.querySelector('.hp-trans').dataset.full || '';
        if (t) { navigator.clipboard.writeText(t); PR.toast('已复制译文', 'ok', 1400); }
      });
      if (isHl) {
        pop.querySelector('.hp-un').addEventListener('click', async () => {
          const ok = await removeHighlights(hlIds, false);
          if (ok) PR.toast('已取消高亮', 'ok', 1400);
          hideHover();
        });
      } else {
        pop.querySelector('.hp-hl').addEventListener('click', () => {
          const trans = pop.querySelector('.hp-trans').dataset.full || '';
          let range = null;
          try { range = hover.range ? hover.range.cloneRange() : null; } catch (_) {}
          if (!range || range.collapsed) { PR.toast('选区已失效，请重新悬停', 'error'); return; }
          createHighlight(range, word, trans);
          hideHover();
        });
      }
      const tr = pop.querySelector('.hp-trans');
      doTranslate(word)
        .then((r2) => {
          if (hover.el !== pop) return;
          tr.dataset.full = r2.text;
          tr.textContent = r2.text;
        })
        .catch((e) => {
          if (hover.el !== pop) return;
          tr.innerHTML = '<span class="err">' + PR.escapeHtml(e.message) + '</span>';
        });
    }
  }
  function hideHover() {
    clearTimeout(hover.timer);
    if (hover.el) { hover.el.remove(); hover.el = null; }
    hover.word = '';
    hover.range = null;
  }
  function scheduleHideHover(ms) {
    clearTimeout(hover.hideTimer);
    hover.hideTimer = setTimeout(hideHover, ms || 500);
  }

  // 选中翻译
  function showSelPopup(text, rect, range) {
    hideHover();   // 两种弹窗不可共存：清掉可能残留的悬停窗及其排队定时器
    closePop('sel');
    const isWord = !/\s/.test(text);
    const pop = document.createElement('div');
    pop.className = 'pop selpop';
    pop.innerHTML =
      '<div class="pop-head"><span>' + (isWord ? '单词' : '句子') + '翻译</span>' +
      '<button class="pop-x">×</button></div>' +
      '<div class="sp-src">' + PR.escapeHtml(text.length > 120 ? text.slice(0, 120) + '…' : text) + '</div>' +
      '<div class="sp-trans"><span class="loading">翻译中…</span></div>' +
      '<div class="sp-actions">' +
      '<button class="btn primary mini" id="sp-hl">🖍 高亮</button>' +
      '<button class="btn mini" id="sp-copy">复制译文</button>' +
      '</div>';
    positionPop(pop, rect.left, rect.bottom + 8);
    selPop = pop;
    pop.querySelector('.pop-x').addEventListener('click', () => closePop('sel'));
    const tr = pop.querySelector('.sp-trans');
    const p = doTranslate(text);
    p.then((r) => {
      if (selPop !== pop) return;
      tr.dataset.full = r.text;
      tr.textContent = r.text;
      // 若已按该文本建高亮且无译文，补写
      const hl = doc.highlights.find((h) => h.text === text && !h.trans);
      if (hl) { hl.trans = r.text; markDirty(); redrawAllOverlays(); renderHlList(); }
    }).catch((e) => {
      if (selPop !== pop) return;
      tr.innerHTML = '<span class="err">' + PR.escapeHtml(e.message) + ' </span>';
      const btn = document.createElement('button');
      btn.className = 'btn mini';
      btn.textContent = '重试';
      btn.addEventListener('click', () => {
        tr.innerHTML = '<span class="loading">翻译中…</span>';
        doTranslate(text).then((r2) => { tr.dataset.full = r2.text; tr.textContent = r2.text; })
          .catch((e2) => { tr.innerHTML = '<span class="err">' + PR.escapeHtml(e2.message) + '</span>'; });
      });
      tr.appendChild(btn);
    });
    pop.querySelector('#sp-copy').addEventListener('click', () => {
      const t = tr.dataset.full || '';
      if (t) { navigator.clipboard.writeText(t); PR.toast('已复制译文', 'ok', 1400); }
      else PR.toast('翻译还没好', 'error');
    });
    pop.querySelector('#sp-hl').addEventListener('click', () => {
      const trans = tr.dataset.full || '';
      createHighlight(range, text, trans);
      closePop('sel');
      window.getSelection().removeAllRanges();
    });
  }

  function findPageAt(x, y) {
    for (let n = 1; n <= numPages; n++) {
      const el = pageEls[n];
      if (!el) continue;
      const r = el.getBoundingClientRect();
      if (x >= r.left && x <= r.right && y >= r.top && y <= r.bottom) return el;
    }
    return null;
  }

  function createHighlight(range, text, trans) {
    if (!range) return;
    const items = [];
    for (const r of range.getClientRects()) {
      if (r.width < 0.5 || r.height < 0.5) continue;
      const pe = findPageAt(r.left + r.width / 2, r.top + r.height / 2);
      if (!pe) continue;
      const pr = pe.getBoundingClientRect();
      items.push({
        p: parseInt(pe.dataset.page, 10),
        x: (r.left - pr.left) / pr.width,
        y: (r.top - pr.top) / pr.height,
        w: r.width / pr.width,
        h: r.height / pr.height,
      });
    }
    if (!items.length) { PR.toast('无法定位高亮位置，请重试', 'error'); return; }
    const hl = { id: uid('h'), text, trans: trans || '', rects: items, createdAt: Date.now() };
    doc.highlights.push(hl);
    markDirty();
    const pages = new Set(items.map((i) => i.p));
    for (const p of pages) { drawManual(p); if (linkageOn) drawLinkage(p); }
    if (linkageOn) for (const n of renderedSet) if (!pages.has(n)) drawLinkage(n);
    renderHlList();
    PR.toast('已高亮，可在右侧查看/批注', 'ok', 1600);
  }

  // 批注弹窗
  function hitHighlight(pe, nx, ny) {
    const pr = pe.getBoundingClientRect();
    const tolX = 3 / pr.width, tolY = 3 / pr.height;
    const pNum = parseInt(pe.dataset.page, 10);
    for (let i = doc.highlights.length - 1; i >= 0; i--) {
      const hl = doc.highlights[i];
      for (const r of hl.rects) {
        if (r.p !== pNum) continue;
        if (nx >= r.x - tolX && nx <= r.x + r.w + tolX && ny >= r.y - tolY && ny <= r.y + r.h + tolY) return hl;
      }
    }
    return null;
  }

  function openNotePop(hl, x, y) {
    closePop('note');
    const pop = document.createElement('div');
    pop.className = 'pop notepop';
    pop.innerHTML =
      '<div class="pop-head"><span>高亮批注</span><button class="pop-x">×</button></div>' +
      '<div class="np-quote">' + PR.escapeHtml(hl.text.length > 200 ? hl.text.slice(0, 200) + '…' : hl.text) + '</div>' +
      '<div class="np-anns"></div>' +
      '<textarea class="np-input" placeholder="写批注…（回车保存）" rows="2"></textarea>' +
      '<div class="sp-actions"><button class="btn primary mini" id="np-save">保存批注</button>' +
      '<button class="btn danger mini" id="np-del">删除高亮</button></div>';
    positionPop(pop, x, y);
    notePop = pop;
    let editingId = null;
    const list = pop.querySelector('.np-anns');
    const input = pop.querySelector('.np-input');

    function renderAnns() {
      const anns = doc.annotations.filter((a) => a.highlightId === hl.id);
      list.innerHTML = anns.length
        ? anns.map((a) =>
            '<div class="np-ann"><div class="np-ann-body">' + PR.escapeHtml(a.body) + '</div>' +
            '<div class="np-ann-meta"><span>' + PR.fmtTime(a.updatedAt || a.createdAt) + '</span>' +
            '<button class="btn mini" data-edit="' + a.id + '">编辑</button>' +
            '<button class="btn mini" data-del="' + a.id + '">删除</button></div></div>').join('')
        : '<div class="hint">还没有批注</div>';
      list.querySelectorAll('[data-edit]').forEach((b) => b.addEventListener('click', () => {
        const a = doc.annotations.find((z) => z.id === b.dataset.edit);
        if (a) { input.value = a.body; editingId = a.id; input.focus(); }
      }));
      list.querySelectorAll('[data-del]').forEach((b) => b.addEventListener('click', async () => {
        const ok = await PR.confirmBox('删除这条批注？');
        if (!ok) return;
        doc.annotations = doc.annotations.filter((z) => z.id !== b.dataset.del);
        if (editingId === b.dataset.del) editingId = null;
        markDirty(); renderAnns(); renderHlList();
      }));
    }
    renderAnns();

    pop.querySelector('.pop-x').addEventListener('click', () => closePop('note'));
    function doSave() {
      const body = input.value.trim();
      if (!body) { PR.toast('先写点批注内容', 'error'); return; }
      if (editingId) {
        const a = doc.annotations.find((z) => z.id === editingId);
        if (a) { a.body = body; a.updatedAt = Date.now(); }
      } else {
        doc.annotations.push({
          id: uid('a'), highlightId: hl.id, body, excerpt: hl.text,
          createdAt: Date.now(), updatedAt: Date.now(),
        });
      }
      editingId = null;
      input.value = '';
      markDirty(); renderAnns(); renderHlList();
    }
    pop.querySelector('#np-save').addEventListener('click', doSave);
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); doSave(); }
      if (e.key === 'Escape') closePop('note');
    });
    pop.querySelector('#np-del').addEventListener('click', async () => {
      const ok = await removeHighlights([hl.id], true);
      if (ok) closePop('note');
    });
  }

  // ---------- 右侧抽屉 ----------
  function renderTags() {
    const box2 = root.querySelector('#np-tags');
    box2.innerHTML = (doc.note.tags || []).map((t, i) =>
      '<span class="chip">#' + PR.escapeHtml(t) +
      '<button data-rm="' + i + '" title="移除">×</button></span>').join('');
    box2.querySelectorAll('[data-rm]').forEach((b) => b.addEventListener('click', () => {
      doc.note.tags.splice(parseInt(b.dataset.rm, 10), 1);
      doc.note.updatedAt = Date.now();
      markDirty(); renderTags();
    }));
  }
  function renderPreview() {
    const pv = root.querySelector('#np-pv');
    pv.innerHTML = PR.renderMarkdown(doc.note.md || '');
    PR.renderMath(pv);
  }
  function renderHlList() {
    const list = root.querySelector('#hl-list');
    if (!list || !doc) return;
    root.querySelector('#d-hlcount').textContent = doc.highlights.length ? ' ' + doc.highlights.length : '';
    if (!doc.highlights.length) {
      list.innerHTML = '<div class="empty">还没有高亮。<br><br>选中正文任意文字，点弹出的「🖍 高亮」即可；打开顶部「全文联动」，相同词会自动全文标注。</div>';
      return;
    }
    const items = doc.highlights.slice().reverse();
    list.innerHTML = items.map((hl) => {
      const n = doc.annotations.filter((a) => a.highlightId === hl.id).length;
      return '<div class="hl-item" data-hl="' + hl.id + '" style="border-left:3px solid ' + hlColor(hl.text, 0.9) + '">' +
        '<div class="hl-item-top"><span class="chip">第 ' + (hl.rects[0] ? hl.rects[0].p : '?') + ' 页</span>' +
        '<span class="hint">' + PR.fmtTime(hl.createdAt) + '</span></div>' +
        '<div class="hl-item-text">' + PR.escapeHtml(hl.text.length > 110 ? hl.text.slice(0, 110) + '…' : hl.text) + '</div>' +
        (hl.trans ? '<div class="hl-item-trans">' + PR.escapeHtml(hl.trans.length > 90 ? hl.trans.slice(0, 90) + '…' : hl.trans) + '</div>' : '') +
        (n ? '<div class="hint">💬 ' + n + ' 条批注</div>' : '') +
        '<div class="hl-item-acts"><button class="btn mini hl-un" data-un="' + hl.id + '" title="取消这条高亮">取消高亮</button></div>' +
        '</div>';
    }).join('');
    list.querySelectorAll('.hl-un').forEach((b) => b.addEventListener('click', async (e) => {
      e.stopPropagation();
      const ok = await removeHighlights([b.dataset.un], false);
      if (ok) PR.toast('已取消高亮', 'ok', 1400);
    }));
    list.querySelectorAll('.hl-item').forEach((it) => it.addEventListener('click', () => {
      jumpToHighlight(it.dataset.hl);
    }));
  }

  function jumpToHighlight(hlId) {
    const hl = doc.highlights.find((h) => h.id === hlId);
    if (!hl || !hl.rects.length) return;
    pendingFlash = hlId;
    scrollToPage(hl.rects[0].p, () => applyFlash());
  }
  function applyFlash() {
    if (!pendingFlash || !root) return;
    const els = root.querySelectorAll('.mhl[data-hl="' + pendingFlash + '"]');
    if (!els.length) return;
    els.forEach((e) => {
      e.classList.add('flash');
      setTimeout(() => e.classList.remove('flash'), 2200);
    });
    pendingFlash = null;
  }

  function scrollToPage(n, cb) {
    n = Math.min(Math.max(1, n), numPages);
    const el = pageEls[n];
    if (!el) { if (cb) cb(); return; }
    const br = box.getBoundingClientRect();
    const target = box.scrollTop + el.getBoundingClientRect().top - br.top - 14;
    box.scrollTo({ top: target, behavior: 'smooth' });
    scheduleRender(n);
    if (cb) setTimeout(cb, 450);
  }

  function setZoom(f) {
    f = Math.min(3, Math.max(0.4, f));
    if (Math.abs(f - zoomFactor) < 0.001) return;
    const anchorN = pageAtViewport();
    const br = box.getBoundingClientRect();
    const before = pageEls[anchorN] ? pageEls[anchorN].getBoundingClientRect().top - br.top : 0;
    zoomFactor = f;
    scale = fitScale * zoomFactor;
    root.querySelector('#r-zval').textContent = Math.round(zoomFactor * 100) + '%';
    const jobs = [];
    for (const n of [...renderedSet]) { renderedSet.delete(n); jobs.push(scheduleRender(n)); }
    Promise.all(jobs).then(() => {
      if (destroyed || !pageEls[anchorN]) return;
      const br2 = box.getBoundingClientRect();
      const after = pageEls[anchorN].getBoundingClientRect().top - br2.top;
      box.scrollTop += after - before;
    });
  }

  // ---------- 视图 ----------
  const view = {
    async render(el, params) {
      destroyed = false;
      root = el;
      try {
        doc = await PR.api.getDoc(params.id);
      } catch (e) {
        PR.toastErr(e);
        PR.go('#/');
        return;
      }
      el.innerHTML = skeleton(doc.meta.name);
      box = el.querySelector('#rbody');
      pageEls = [];
      renderedSet = new Set();
      queue = [];
      curPage = 1;
      linkageOn = !!(PR.state.settings && PR.state.settings.linkageOn);

      if (typeof pdfjsLib === 'undefined') {
        box.innerHTML = '<div class="boot-error"><h2>PDF 渲染组件加载失败</h2><p>请刷新页面重试。</p></div>';
        return;
      }
      pdfjsLib.GlobalWorkerOptions.workerSrc = '/static/vendor/pdfjs/pdf.worker.min.js';

      // --- 抽屉初始 ---
      const md = el.querySelector('#np-md');
      md.value = doc.note.md || '';
      renderTags();
      renderHlList();
      if (doc.note.tags && doc.note.tags.length) { /* 已渲染 */ }
      let mode = 'edit';
      el.querySelectorAll('.np-toolbar button').forEach((b) => b.addEventListener('click', () => {
        mode = b.dataset.m;
        const body = el.querySelector('#np-body');
        body.className = 'np-body mode-' + mode;
        el.querySelectorAll('.np-toolbar button').forEach((x) => x.classList.toggle('on', x === b));
        el.querySelector('#np-pv').hidden = mode === 'edit';
        el.querySelector('#np-md').hidden = mode === 'preview';
        if (mode !== 'edit') renderPreview();
      }));
      let pvTimer = null;
      md.addEventListener('input', () => {
        doc.note.md = md.value;
        doc.note.updatedAt = Date.now();
        markDirty();
        clearTimeout(pvTimer);
        pvTimer = setTimeout(() => { if (mode !== 'edit') renderPreview(); }, 300);
      });
      el.querySelector('#np-tagin').addEventListener('keydown', (e) => {
        if (e.key !== 'Enter') return;
        const t = e.target.value.trim().replace(/^#+/, '');
        if (!t) return;
        doc.note.tags = doc.note.tags || [];
        if (!doc.note.tags.includes(t) && doc.note.tags.length < 30) {
          doc.note.tags.push(t);
          doc.note.updatedAt = Date.now();
          markDirty(); renderTags();
        }
        e.target.value = '';
      });

      const drawer = el.querySelector('#drawer');
      function openDrawer(tab) {
        drawer.classList.add('open');
        el.querySelectorAll('.d-tabs button[data-t]').forEach((b) => b.classList.toggle('on', b.dataset.t === tab));
        el.querySelector('#pane-note').hidden = tab !== 'note';
        el.querySelector('#pane-hl').hidden = tab !== 'hl';
      }
      function toggleDrawer(tab) {
        const sameOpen = drawer.classList.contains('open') &&
          !el.querySelector('#pane-' + (tab === 'note' ? 'note' : 'hl')).hidden;
        if (sameOpen) drawer.classList.remove('open');
        else openDrawer(tab);
      }
      on(el.querySelector('#r-tab-note'), 'click', () => toggleDrawer('note'));
      on(el.querySelector('#r-tab-hl'), 'click', () => toggleDrawer('hl'));
      on(el.querySelector('#d-close'), 'click', () => drawer.classList.remove('open'));
      el.querySelectorAll('.d-tabs button[data-t]').forEach((b) =>
        on(b, 'click', () => openDrawer(b.dataset.t)));

      // --- 顶栏 ---
      on(el.querySelector('#r-back'), 'click', async () => { await save(); PR.go('#/'); });
      const linkCb = el.querySelector('#r-linkage');
      linkCb.checked = linkageOn;
      on(linkCb, 'change', async () => {
        linkageOn = linkCb.checked;
        try { await PR.api.saveSettings({ linkageOn }); PR.state.settings.linkageOn = linkageOn; } catch (_) {}
        for (const n of renderedSet) drawnOverlays(n);
      });
      on(el.querySelector('#r-zin'), 'click', () => setZoom(zoomFactor + 0.15));
      on(el.querySelector('#r-zout'), 'click', () => setZoom(zoomFactor - 0.15));
      on(el.querySelector('#r-prev'), 'click', () => scrollToPage(pageAtViewport() - 1));
      on(el.querySelector('#r-next'), 'click', () => scrollToPage(pageAtViewport() + 1));
      const pageInput = el.querySelector('#r-page');
      on(pageInput, 'change', () => {
        const n = parseInt(pageInput.value, 10);
        if (n >= 1 && n <= numPages) scrollToPage(n);
        else pageInput.value = pageAtViewport();
      });
      on(pageInput, 'keydown', (e) => { if (e.key === 'Enter') pageInput.blur(); });

      // --- PDF 加载 ---
      try {
        pdf = await pdfjsLib.getDocument({
          url: '/api/pdf/' + doc.meta.id,
          cMapUrl: '/static/vendor/pdfjs/cmaps/',
          cMapPacked: true,
          standardFontDataUrl: '/static/vendor/pdfjs/standard_fonts/',
        }).promise;
      } catch (e) {
        box.innerHTML = '<div class="boot-error"><h2>PDF 打开失败</h2><p>' + PR.escapeHtml(e.message) + '</p></div>';
        return;
      }
      numPages = pdf.numPages;
      el.querySelector('#r-total').textContent = '/ ' + numPages;
      el.querySelector('#r-zval').textContent = Math.round(zoomFactor * 100) + '%';
      if (doc.meta.pages !== numPages) { doc.meta.pages = numPages; markDirty(); }
      await buildPlaceholders();

      // 初始定位
      const startPage = parseInt(params.query.page, 10);
      if (startPage >= 1 && startPage <= numPages) scrollToPage(startPage);
      if (params.query.hl) pendingFlash = params.query.hl;

      // 懒渲染
      observer = new IntersectionObserver((entries) => {
        for (const e of entries) {
          if (e.isIntersecting) {
            const n = parseInt(e.target.dataset.page, 10);
            scheduleRender(n);
            // 预取邻近页
            scheduleRender(n + 1);
            scheduleRender(n - 1);
          }
        }
      }, { root: box, rootMargin: '900px 0px' });
      pageEls.forEach((p) => p && observer.observe(p));

      // 当前页指示
      on(box, 'scroll', () => {
        if (rafScroll) return;
        rafScroll = requestAnimationFrame(() => {
          rafScroll = 0;
          const n = pageAtViewport();
          if (n !== curPage) { curPage = n; pageInput.value = n; }
        });
        hideHover();
        closePop('sel');
      }, { passive: true });

      // 窗口尺寸变化 → 重新适配宽度
      let rzTimer = null;
      on(window, 'resize', () => {
        clearTimeout(rzTimer);
        rzTimer = setTimeout(() => {
          if (destroyed || !pdf) return;
          const w = box.clientWidth;
          if (Math.abs(w - fitWidth) < 24) return;
          const p1 = pageEls[1];
          if (!p1) return;
          fitWidth = w;
          fitScale = (w - PAD * 2) / (parseFloat(p1.style.width) / scale);
          setZoom(zoomFactor);
          // setZoom 对相同 factor 不生效，强制重排：
          scale = fitScale * zoomFactor;
          const jobs = [];
          for (const n of [...renderedSet]) { renderedSet.delete(n); jobs.push(scheduleRender(n)); }
        }, 220);
      });

      // --- 交互：悬停 / 选中 / 点击 ---
      on(box, 'mousemove', (e) => {
        if (destroyed) return;
        const sel = window.getSelection();
        // 选区存在时不仅不弹悬停，还要撤掉拖动开始前排下的定时器
        if (sel && !sel.isCollapsed) { clearTimeout(hover.timer); return; }
        clearTimeout(hover.timer);
        const info = wordInfoAt(e.clientX, e.clientY);
        if (!info) { scheduleHideHover(500); return; }
        if (info.word === hover.word && hover.el) {
          hover.range = info.range.cloneRange();   // 同词重新悬停时刷新选区
          return;
        }
        hover.word = info.word;
        const x = e.clientX, y = e.clientY;
        hover.timer = setTimeout(() => {
          if (destroyed) return;
          // 到点时再查一次选区：拖动选中期间排下的旧定时器不许再弹窗
          const s = window.getSelection();
          if (s && !s.isCollapsed) return;
          showHover(info, x, y);
        }, HOVER_DELAY);
      });
      on(box, 'mousedown', (e) => {
        if (e.target.closest && e.target.closest('.pop')) return;
        closePop('sel');
        closePop('note');
        hideHover();
      });

      on(box, 'mouseup', () => {
        setTimeout(() => {
          if (destroyed) return;
          const sel = window.getSelection();
          if (!sel || sel.isCollapsed) return;
          const text = sel.toString().replace(/\s+/g, ' ').trim();
          if (!text) return;
          const range = sel.getRangeAt(0);
          const rects = range.getClientRects();
          const r = rects.length ? rects[rects.length - 1] : range.getBoundingClientRect();
          showSelPopup(text, r, range.cloneRange());
        }, 10);
      });

      on(box, 'click', (e) => {
        if (destroyed) return;
        const sel = window.getSelection();
        if (sel && !sel.isCollapsed) return;
        const pe = e.target.closest ? e.target.closest('.page') : null;
        if (!pe) { closePop('note'); return; }
        const pr = pe.getBoundingClientRect();
        const nx = (e.clientX - pr.left) / pr.width;
        const ny = (e.clientY - pr.top) / pr.height;
        const hit = hitHighlight(pe, nx, ny);
        if (hit) openNotePop(hit, e.clientX, e.clientY);
        else closePop('note');
      });

      on(document, 'mousedown', (e) => {
        if (e.target.closest && (e.target.closest('.pop') || e.target.closest('.rbody'))) return;
        closePop('sel'); closePop('note'); hideHover();
      });
      on(document, 'keydown', (e) => { if (e.key === 'Escape') closePop(); });
      on(window, 'beforeunload', beforeUnload);
      on(document, 'visibilitychange', () => { if (document.hidden) save(); });
    },

    async destroy() {
      destroyed = true;
      clearTimeout(saveTimer);
      clearTimeout(hover.timer);
      clearTimeout(hover.hideTimer);
      await save();
      if (observer) { observer.disconnect(); observer = null; }
      if (pdf) { try { await pdf.destroy(); } catch (_) {} pdf = null; }
      closePop();
      if (selPop) { selPop.remove(); selPop = null; }
      if (notePop) { notePop.remove(); notePop = null; }
      popRoot().innerHTML = '';
      boundFns.forEach((f) => { try { f(); } catch (_) {} });
      boundFns = [];
      if (rafScroll) cancelAnimationFrame(rafScroll);
      doc = null;
      renderedSet = new Set();
      queue = [];
      inFlight = new Map();
      pageEls = [];
      dirty = false;
    },
  };

  PR.views.reader = view;
})();
