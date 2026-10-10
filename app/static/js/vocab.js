// 词库页：阅读时翻译过的单词自动收录于此 —— 搜索 / 筛选 / 标记掌握 / 随机复习 / 导出 CSV
(function () {
  'use strict';
  const PR = window.PR;

  let words = [];       // 全部词条（服务端按最近查阅排序）
  let query = '';
  let filter = 'all';   // all | new | learned

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
      list.innerHTML = '<div class="empty">词库还是空的。<br>在阅读页悬停取词或选中单词翻译后，单词会自动收录到这里。</div>';
      return;
    }
    if (!items.length) {
      list.innerHTML = '<div class="empty">没有匹配的单词，试试换个关键词。</div>';
      return;
    }
    list.innerHTML = items.map((w) =>
      '<div class="v-row' + (w.learned ? ' learned' : '') + '" data-w="' + PR.escapeHtml(w.w) + '">' +
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
          renderList();
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
    if (!deck.length) { PR.toast('词库是空的，先去阅读页收集单词吧', 'error'); return; }
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
    },
  };
  PR.views.vocab = view;
})();
