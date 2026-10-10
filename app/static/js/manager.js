// 笔记集中管理页：按论文分组、全文搜索（关键词/标签/标题）、跳回原文、一键导出
(function () {
  'use strict';
  const PR = window.PR;

  let docs = [];            // [{...doc}] 全部文档数据
  let query = '';           // 关键词
  let activeTag = '';       // 标签过滤
  let selected = null;      // {kind:'note'|'hl', docId, hlId}

  function allTags() {
    const map = new Map();
    for (const d of docs) {
      for (const t of d.note.tags || []) map.set(t, (map.get(t) || 0) + 1);
    }
    return [...map.entries()].sort((a, b) => b[1] - a[1]);
  }

  function itemMatches(d, kind, text, hl) {
    if (activeTag) {
      if (kind === 'note') { if (!(d.note.tags || []).includes(activeTag)) return false; }
      else if (!(d.note.tags || []).includes(activeTag)) return false; // 高亮归属其文档的标签
    }
    if (!query) return true;
    const q = query.toLowerCase();
    if (kind === 'note') {
      return (d.meta.name || '').toLowerCase().includes(q) ||
        (d.note.md || '').toLowerCase().includes(q) ||
        (d.note.tags || []).some((t) => t.toLowerCase().includes(q));
    }
    return (d.meta.name || '').toLowerCase().includes(q) ||
      (text || '').toLowerCase().includes(q) ||
      (hl.trans || '').toLowerCase().includes(q) ||
      (d.annotations.filter((a) => a.highlightId === hl.id)
        .some((a) => (a.body || '').toLowerCase().includes(q)));
  }

  function buildGroups() {
    const groups = [];
    for (const d of docs) {
      const titleHit = !query || (d.meta.name || '').toLowerCase().includes(query.toLowerCase());
      const tagOk = !activeTag || (d.note.tags || []).includes(activeTag);
      if (!tagOk) continue;
      const items = [];
      if ((d.note.md || '').trim() && (titleHit || itemMatches(d, 'note', '', null))) {
        items.push({ kind: 'note' });
      }
      for (const hl of d.highlights) {
        if (titleHit || itemMatches(d, 'hl', hl.text, hl)) items.push({ kind: 'hl', hl });
      }
      if (items.length) groups.push({ doc: d, items });
    }
    return groups;
  }

  function exportNote(d) {
    const md = '# 《' + d.meta.name + '》读书笔记\n\n' +
      '导出时间：' + new Date().toLocaleString() + '\n\n' +
      (d.note.tags && d.note.tags.length ? '标签：' + d.note.tags.map((t) => '#' + t).join(' ') + '\n\n' : '') +
      (d.note.md || '（空）');
    PR.downloadBlob(safeName(d.meta.name) + '-笔记.md', new Blob([md], { type: 'text/markdown' }));
    PR.toast('已导出笔记', 'ok');
  }

  function exportHighlights(d) {
    let out = '# 《' + d.meta.name + '》高亮与批注整理\n\n导出时间：' +
      new Date().toLocaleString() + ' · 共 ' + d.highlights.length + ' 条高亮\n\n';
    const byPage = d.highlights.slice().sort((a, b) => (a.rects[0] ? a.rects[0].p : 0) - (b.rects[0] ? b.rects[0].p : 0));
    byPage.forEach((hl, i) => {
      const page = hl.rects.length ? hl.rects[0].p : '?';
      out += '## ' + (i + 1) + '. 第 ' + page + ' 页\n\n';
      out += '> ' + (hl.text || '').replace(/\n/g, '\n> ') + '\n\n';
      if (hl.trans) out += '译文：' + hl.trans + '\n\n';
      const ans = d.annotations.filter((a) => a.highlightId === hl.id);
      for (const a of ans) out += '- 批注（' + PR.fmtTime(a.updatedAt || a.createdAt) + '）：' + a.body + '\n';
      if (ans.length) out += '\n';
      out += '---\n\n';
    });
    PR.downloadBlob(safeName(d.meta.name) + '-高亮批注.md', new Blob([out], { type: 'text/markdown' }));
    PR.toast('已导出高亮与批注', 'ok');
  }

  function safeName(n) {
    return String(n || '未命名').replace(/\.pdf$/i, '').replace(/[\\/:*?"<>|]/g, '_').slice(0, 80);
  }

  function renderSidebar(groups) {
    if (!groups.length) {
      return '<div class="empty">没有匹配的笔记或高亮' + (query || activeTag ? '，试试换个关键词' : '。先去阅读页记录些什么吧') + '</div>';
    }
    return groups.map((g, gi) =>
      '<div class="m-group" data-doc="' + g.doc.meta.id + '">' +
      '<div class="m-group-head" title="' + PR.escapeHtml(g.doc.meta.name) + '">📄 ' +
      '<span class="m-docname">' + PR.escapeHtml(g.doc.meta.name) + '</span>' +
      '<button class="btn mini" data-export-note="' + g.doc.meta.id + '" title="导出本篇笔记为 Markdown">导出笔记</button>' +
      '<button class="btn mini" data-export-hl="' + g.doc.meta.id + '" title="导出本篇全部高亮与批注">导出高亮</button>' +
      '</div>' +
      g.items.map((it) => {
        const key = it.kind + ':' + g.doc.meta.id + ':' + (it.hl ? it.hl.id : '');
        const active = selected && (selected.kind === it.kind && selected.docId === g.doc.meta.id &&
          (it.hl ? selected.hlId === it.hl.id : !selected.hlId));
        if (it.kind === 'note') {
          const firstLine = (it.hl, (g.doc.note.md || '').split('\n').find((l) => l.trim()) || '（笔记）');
          return '<div class="m-item' + (active ? ' active' : '') + '" data-kind="note" data-doc="' +
            g.doc.meta.id + '" data-key="' + PR.escapeHtml(key) + '">' +
            '<div class="m-item-type">✍️ 笔记</div>' +
            '<div class="m-item-text">' + PR.escapeHtml(firstLine.replace(/^#+\s*/, '').slice(0, 80)) + '</div>' +
            '<div class="m-item-meta">' + (g.doc.note.tags || []).map((t) => '<span class="chip">#' + PR.escapeHtml(t) + '</span>').join('') +
            PR.fmtTime(g.doc.note.updatedAt) + '</div></div>';
        }
        const hl = it.hl;
        const ans = g.doc.annotations.filter((a) => a.highlightId === hl.id);
        return '<div class="m-item' + (active ? ' active' : '') + '" data-kind="hl" data-doc="' +
          g.doc.meta.id + '" data-hl="' + hl.id + '" data-key="' + PR.escapeHtml(key) + '">' +
          '<div class="m-item-type">🖍 高亮 · 第 ' + (hl.rects[0] ? hl.rects[0].p : '?') + ' 页</div>' +
          '<div class="m-item-text">' + PR.escapeHtml((hl.text || '').slice(0, 90)) + '</div>' +
          '<div class="m-item-meta">' + (ans.length ? '💬 ' + ans.length + ' 条批注 · ' : '') + PR.fmtTime(hl.createdAt) + '</div>' +
          '</div>';
      }).join('') +
      '</div>'
    ).join('');
  }

  function renderDetail() {
    const box = document.querySelector('#mgr-detail');
    if (!box) return;
    if (!selected) {
      box.innerHTML = '<div class="empty">← 在左侧选择一条笔记或高亮<br><small>点击可跳回 PDF 原文位置</small></div>';
      return;
    }
    const d = docs.find((x) => x.meta.id === selected.docId);
    if (!d) { box.innerHTML = '<div class="empty">内容已不存在</div>'; return; }
    const head =
      '<div class="d-head"><div class="d-title">' + PR.escapeHtml(d.meta.name) + '</div>' +
      '<div class="d-actions">' +
      '<button class="btn primary" id="d-jump">跳转到原文</button>' +
      (selected.kind === 'note'
        ? '<button class="btn" id="d-export-note">导出笔记 .md</button>'
        : '<button class="btn" id="d-export-hl">导出高亮批注 .md</button>') +
      '</div></div>';

    if (selected.kind === 'note') {
      box.innerHTML = head +
        '<div class="d-tags">' + (d.note.tags || []).map((t) => '<span class="chip">#' + PR.escapeHtml(t) + '</span>').join('') +
        '<span class="hint">更新于 ' + PR.fmtTime(d.note.updatedAt) + '</span></div>' +
        '<article class="markdown" id="d-md">' + PR.renderMarkdown(d.note.md || '（还没有内容）') + '</article>';
      PR.renderMath(box.querySelector('#d-md'));
      box.querySelector('#d-jump').addEventListener('click', () => PR.go('#/read/' + d.meta.id));
      box.querySelector('#d-export-note').addEventListener('click', () => exportNote(d));
      return;
    }

    const hl = d.highlights.find((h) => h.id === selected.hlId);
    if (!hl) { box.innerHTML = '<div class="empty">该高亮已被删除</div>'; return; }
    const ans = d.annotations.filter((a) => a.highlightId === hl.id);
    box.innerHTML = head +
      '<div class="d-tags"><span class="chip">第 ' + (hl.rects[0] ? hl.rects[0].p : '?') + ' 页</span>' +
      PR.fmtTime(hl.createdAt) + '</div>' +
      '<blockquote class="d-quote">' + PR.escapeHtml(hl.text) + '</blockquote>' +
      (hl.trans ? '<div class="d-trans"><b>译文：</b>' + PR.escapeHtml(hl.trans) + '</div>' : '') +
      (ans.length
        ? '<div class="d-anns"><h4>批注</h4>' + ans.map((a) =>
            '<div class="d-ann"><div class="d-ann-body">' + PR.escapeHtml(a.body) + '</div>' +
            '<div class="hint">' + PR.fmtTime(a.updatedAt || a.createdAt) + '</div></div>').join('') + '</div>'
        : '<div class="hint">暂无批注</div>');
    box.querySelector('#d-jump').addEventListener('click', () =>
      PR.go('#/read/' + d.meta.id + '?hl=' + encodeURIComponent(hl.id)));
    box.querySelector('#d-export-hl').addEventListener('click', () => exportHighlights(d));
  }

  function renderSidebarOnly() {
    const groups = buildGroups();
    document.querySelector('#mgr-list').innerHTML = renderSidebar(groups);
    bindSidebar();
  }

  function bindSidebar() {
    document.querySelectorAll('#mgr-list .m-item').forEach((el) => {
      el.addEventListener('click', () => {
        selected = {
          kind: el.dataset.kind,
          docId: el.dataset.doc,
          hlId: el.dataset.hl || null,
        };
        document.querySelectorAll('#mgr-list .m-item').forEach((x) => x.classList.remove('active'));
        el.classList.add('active');
        renderDetail();
      });
    });
    document.querySelectorAll('[data-export-note]').forEach((b) =>
      b.addEventListener('click', (e) => {
        e.stopPropagation();
        const d = docs.find((x) => x.meta.id === b.dataset.exportNote);
        if (d) exportNote(d);
      }));
    document.querySelectorAll('[data-export-hl]').forEach((b) =>
      b.addEventListener('click', (e) => {
        e.stopPropagation();
        const d = docs.find((x) => x.meta.id === b.dataset.exportHl);
        if (d) exportHighlights(d);
      }));
  }

  const view = {
    async render(el) {
      query = ''; activeTag = ''; selected = null;
      el.innerHTML =
        '<header class="gh">' +
        '<a class="logo" href="#/">📖 论文伴读</a>' +
        '<nav><a href="#/">文档库</a><a href="#/vocab">词库</a><a href="#/settings">设置</a></nav>' +
        '</header>' +
        '<main class="mgr">' +
        '<div class="mgr-side">' +
        '<input class="mgr-search" id="mgr-q" placeholder="搜索笔记、高亮、批注、论文标题…">' +
        '<div class="mgr-tags" id="mgr-tags"></div>' +
        '<div class="mgr-list" id="mgr-list"><div class="empty">正在加载…</div></div>' +
        '</div>' +
        '<div class="mgr-main" id="mgr-detail"></div>' +
        '</main>';

      docs = await Promise.all(PR.state.docs.map((d) => PR.api.getDoc(d.id)));
      docs.sort((a, b) => (b.meta.lastOpenedAt || 0) - (a.meta.lastOpenedAt || 0));

      const tagsEl = el.querySelector('#mgr-tags');
      tagsEl.innerHTML = allTags().map(([t, n]) =>
        '<button class="chip tag" data-tag="' + PR.escapeHtml(t) + '">#' + PR.escapeHtml(t) + ' <i>' + n + '</i></button>').join('');
      tagsEl.querySelectorAll('.tag').forEach((c) => {
        c.addEventListener('click', () => {
          activeTag = activeTag === c.dataset.tag ? '' : c.dataset.tag;
          tagsEl.querySelectorAll('.tag').forEach((x) => x.classList.toggle('on', x.dataset.tag === activeTag));
          renderSidebarOnly();
        });
      });

      let timer = null;
      el.querySelector('#mgr-q').addEventListener('input', (e) => {
        clearTimeout(timer);
        timer = setTimeout(() => { query = e.target.value.trim(); renderSidebarOnly(); }, 180);
      });

      renderSidebarOnly();
      renderDetail();
    },
    async destroy() { docs = []; query = ''; activeTag = ''; selected = null; },
  };
  PR.views.manager = view;
})();
