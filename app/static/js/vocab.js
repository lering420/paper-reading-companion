// 词库页：阅读时手动点「＋ 词库」加入的单词 —— 搜索 / 筛选 / 标记掌握 / 随机复习 / 导出 CSV
(function () {
  'use strict';
  const PR = window.PR;

  let words = [];       // 全部词条（服务端按最近查阅排序）
  let query = '';
  let filter = 'all';   // all | new | learned
  let selMode = false;  // 多选删除模式
  const selected = new Set();   // 已勾选的 w（跨搜索/筛选保留，可分批挑选）

  function filtered() {
    const q = query.toLowerCase();
    return words.filter((w) => {
      if (filter === 'learned' && !w.learned) return false;
      if (filter === 'new' && w.learned) return false;
      if (!q) return true;
      return String(w.w || '').toLowerCase().includes(q) ||
        String(w.trans || '').toLowerCase().includes(q);
    });
  }

  // ---------- 多选删除 ----------
  function setSelMode(on) {
    selMode = on;
    if (!on) selected.clear();
    const bulk = document.getElementById('v-bulk');
    if (bulk) bulk.hidden = !on;
    const t = document.getElementById('v-multisel');
    if (t) { t.classList.toggle('on', on); t.textContent = on ? '☑ 多选中' : '☑ 多选'; }
    renderList();
    updateBulk();
  }

  function updateBulk() {
    const c = document.getElementById('v-selcount');
    if (c) c.textContent = selected.size;
    const d = document.getElementById('v-seldel');
    if (d) {
      d.disabled = !selected.size;
      d.textContent = '🗑 删除所选' + (selected.size ? ' (' + selected.size + ')' : '');
    }
  }

  async function bulkDelete() {
    const list = [...selected];
    if (!list.length) return;
    const ok = await PR.confirmBox('从词库删除所选 ' + list.length + ' 个单词？');
    if (!ok) return;
    const done = new Set();
    const fail = [];
    for (const w of list) {
      try { await PR.api.vocabDel(w); selected.delete(w); done.add(w); }
      catch (e) { fail.push(w); }
    }
    words = words.filter((x) => !done.has(x.w));
    renderList();
    updateBulk();
    if (fail.length) PR.toast('已删除 ' + done.size + ' 个，' + fail.length + ' 个失败', 'error');
    else PR.toast('已删除 ' + done.size + ' 个', 'ok', 1600);
  }

  function renderList() {
    const list = document.getElementById('v-list');
    const stat = document.getElementById('v-stat');
    if (!list) return;
    const learnedN = words.filter((w) => w.learned).length;
    if (stat) {
      stat.textContent = '共 ' + words.length + ' 词 · 待学习 ' +
        (words.length - learnedN) + ' · 已掌握 ' + learnedN;
    }
    const items = filtered();
    if (!words.length) {
      list.innerHTML = '<div class="empty">词库还是空的。<br>在阅读页把鼠标停在单词上，或选中文字翻译，点弹窗里的「＋ 词库」即可加入。</div>';
      return;
    }
    if (!items.length) {
      list.innerHTML = '<div class="empty">没有匹配的单词，试试换个关键词。</div>';
      return;
    }
    list.classList.toggle('selmode', selMode);
    list.innerHTML = items.map((w) =>
      '<div class="v-row' + (w.learned ? ' learned' : '') + (selected.has(w.w) ? ' sel' : '') +
      '" data-w="' + PR.escapeHtml(w.w) + '">' +
      '<label class="v-check"><input type="checkbox" class="v-cb"' +
      (selected.has(w.w) ? ' checked' : '') + '></label>' +
      '<span class="v-word">' + PR.escapeHtml(w.w) + '</span>' +
      '<span class="v-trans">' + PR.escapeHtml(w.trans || '（无译文）') + '</span>' +
      '<span class="v-meta" title="查阅次数 / 最近查阅">×' + (w.count || 1) + ' · ' +
      PR.fmtTime(w.lastAt) + '</span>' +
      '<button class="btn mini v-learned' + (w.learned ? ' on' : '') + '" title="标记掌握状态">' +
      (w.learned ? '✓ 已掌握' : '学习中') + '</button>' +
      '<button class="btn mini ghost v-del" title="从词库删除">✕</button>' +
      '</div>'
    ).join('');

    list.querySelectorAll('.v-row').forEach((row) => {
      const w = row.dataset.w;
      // 多选：点勾选框（原生切换）或点行空白处都能切换；行内按钮不触发
      row.querySelector('.v-cb').addEventListener('change', (e) => {
        if (e.target.checked) selected.add(w); else selected.delete(w);
        row.classList.toggle('sel', e.target.checked);
        updateBulk();
      });
      row.addEventListener('click', (e) => {
        if (!selMode || e.target.closest('button') || e.target.closest('.v-check')) return;
        const on = !selected.has(w);
        if (on) selected.add(w); else selected.delete(w);
        row.classList.toggle('sel', on);
        row.querySelector('.v-cb').checked = on;
        updateBulk();
      });
      row.querySelector('.v-learned').addEventListener('click', async () => {
        const item = words.find((x) => x.w === w);
        if (!item) return;
        try {
          await PR.api.vocabLearned(w, !item.learned);
          item.learned = !item.learned;
          renderList();
        } catch (e) { PR.toastErr(e); }
      });
      row.querySelector('.v-del').addEventListener('click', async () => {
        const ok = await PR.confirmBox('从词库删除「' + w + '」？');
        if (!ok) return;
        try {
          await PR.api.vocabDel(w);
          words = words.filter((x) => x.w !== w);
          selected.delete(w);
          renderList();
          updateBulk();
          PR.toast('已删除', 'ok', 1400);
        } catch (e) { PR.toastErr(e); }
      });
    });
  }

  function exportCsv() {
    const items = filtered();
    if (!items.length) { PR.toast('没有可导出的单词', 'error'); return; }
    const rows = [['单词', '译文', '查阅次数', '首次收录', '最近查阅', '状态']];
    items.forEach((w) => rows.push([
      w.w, w.trans || '', String(w.count || 1),
      PR.fmtTime(w.firstAt), PR.fmtTime(w.lastAt),
      w.learned ? '已掌握' : '学习中',
    ]));
    const csv = '\uFEFF' + rows.map((r) =>
      r.map((c) => '"' + String(c).replace(/"/g, '""') + '"').join(',')).join('\r\n');
    const d = new Date();
    const stamp = d.getFullYear() + String(d.getMonth() + 1).padStart(2, '0') +
      String(d.getDate()).padStart(2, '0');
    PR.downloadBlob('词库-' + stamp + '.csv', new Blob([csv], { type: 'text/csv' }));
    PR.toast('已导出 ' + items.length + ' 个单词', 'ok');
  }

  // ---------- 随机复习：卡片正面单词，翻面看译文，标记「认识 / 再看看」 ----------
  let review = null; // { deck, i, revealed }

  function openReview() {
    const pool = words.filter((w) => !w.learned);
    const deck = (pool.length ? pool : words).slice();
    for (let i = deck.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [deck[i], deck[j]] = [deck[j], deck[i]];
    }
    if (!deck.length) { PR.toast('词库是空的，先去阅读页加几个单词吧', 'error'); return; }
    review = { deck, i: 0, revealed: false };
    const wrap = document.createElement('div');
    wrap.className = 'v-review';
    wrap.id = 'v-review-pop';   // 不可与工具栏按钮 #v-review 重名（getElementById 会命中按钮）
    document.body.appendChild(wrap);
    drawReview();
  }

  function drawReview() {
    const wrap = document.getElementById('v-review-pop');
    if (!wrap || !review) return;
    if (review.i >= review.deck.length) {
      wrap.remove();
      review = null;
      PR.toast('复习完成 🎉', 'ok');
      return;
    }
    const w = review.deck[review.i];
    wrap.innerHTML =
      '<div class="v-card">' +
      '<div class="v-card-prog">第 ' + (review.i + 1) + ' / ' + review.deck.length + ' 词 · Esc 退出</div>' +
      '<div class="v-card-word">' + PR.escapeHtml(w.w) + '</div>' +
      (review.revealed
        ? '<div class="v-card-trans">' + PR.escapeHtml(w.trans || '（无译文）') + '</div>' +
          '<div class="v-card-acts">' +
          '<button class="btn primary" id="v-know">✓ 认识，标记掌握</button>' +
          '<button class="btn" id="v-again">✕ 再复习一遍</button></div>'
        : '<div class="v-card-acts"><button class="btn primary" id="v-flip">显示译文</button></div>') +
      '</div>';
    const flip = wrap.querySelector('#v-flip');
    if (flip) flip.addEventListener('click', () => { review.revealed = true; drawReview(); });
    const know = wrap.querySelector('#v-know');
    if (know) know.addEventListener('click', async () => {
      try { await PR.api.vocabLearned(w.w, true); w.learned = true; } catch (e) { PR.toastErr(e); }
      review.i++; review.revealed = false;
      drawReview();
      renderList();
    });
    const again = wrap.querySelector('#v-again');
    if (again) again.addEventListener('click', () => {
      review.i++; review.revealed = false;
      drawReview();
    });
  }

  function closeReview() {
    const wrap = document.getElementById('v-review-pop');
    if (wrap) wrap.remove();
    review = null;
    renderList();
  }

  function onKey(e) {
    if (e.key === 'Escape' && review) closeReview();
  }

  const view = {
    async render(el) {
      query = ''; filter = 'all';
      el.innerHTML =
        '<header class="gh">' +
        '<a class="logo" href="#/">📖 论文伴读</a>' +
        '<nav><a href="#/">文档库</a><a href="#/notes">笔记管理</a><a href="#/vocab">词库</a><a href="#/settings">设置</a></nav>' +
        '</header>' +
        '<main class="vocab">' +
        '<div class="vocab-bar">' +
        '<span class="vocab-stat" id="v-stat"></span>' +
        '<input class="vocab-search" id="v-q" placeholder="搜索单词或译文…">' +
        '<span class="v-filters">' +
        '<button class="chip tag on" data-f="all">全部</button>' +
        '<button class="chip tag" data-f="new">待学习</button>' +
        '<button class="chip tag" data-f="learned">已掌握</button>' +
        '</span>' +
        '<button class="btn primary" id="v-review">🎴 随机复习</button>' +
        '<button class="btn" id="v-export">⬇ 导出 CSV</button>' +
        '<button class="btn" id="v-multisel">☑ 多选</button>' +
        '</div>' +
        '<div class="v-bulk" id="v-bulk" hidden>' +
        '<span class="v-bulk-info">已选 <b id="v-selcount">0</b></span>' +
        '<button class="btn mini" id="v-selall">全选当前结果</button>' +
        '<button class="btn mini" id="v-selnone">清空</button>' +
        '<button class="btn mini danger" id="v-seldel" disabled>🗑 删除所选</button>' +
        '<button class="btn mini ghost" id="v-selx">退出多选</button>' +
        '</div>' +
        '<div class="v-list" id="v-list"><div class="empty">正在加载…</div></div>' +
        '</main>';

      el.querySelectorAll('.v-filters .tag').forEach((c) => {
        c.addEventListener('click', () => {
          filter = c.dataset.f;
          el.querySelectorAll('.v-filters .tag').forEach((x) => x.classList.toggle('on', x === c));
          renderList();
        });
      });
      let timer = null;
      el.querySelector('#v-q').addEventListener('input', (e) => {
        clearTimeout(timer);
        timer = setTimeout(() => { query = e.target.value.trim(); renderList(); }, 180);
      });
      el.querySelector('#v-export').addEventListener('click', exportCsv);
      el.querySelector('#v-review').addEventListener('click', openReview);
      el.querySelector('#v-multisel').addEventListener('click', () => setSelMode(!selMode));
      el.querySelector('#v-selall').addEventListener('click', () => {
        filtered().forEach((w) => selected.add(w.w));
        renderList();
        updateBulk();
      });
      el.querySelector('#v-selnone').addEventListener('click', () => {
        selected.clear();
        renderList();
        updateBulk();
      });
      el.querySelector('#v-seldel').addEventListener('click', bulkDelete);
      el.querySelector('#v-selx').addEventListener('click', () => setSelMode(false));

      try {
        const d = await PR.api.vocabList();
        words = d.words || [];
      } catch (e) {
        words = [];
        PR.toastErr(e);
      }
      renderList();
      document.addEventListener('keydown', onKey);
    },
    async destroy() {
      document.removeEventListener('keydown', onKey);
      closeReview();
      words = []; query = ''; filter = 'all';
      selMode = false; selected.clear();
    },
  };
  PR.views.vocab = view;
})();
