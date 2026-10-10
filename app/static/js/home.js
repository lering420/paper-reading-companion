// 首页：文档库（导入 / 打开 / 删除，支持拖拽）
(function () {
  'use strict';
  const PR = window.PR;
  let container = null;
  let dragging = false;

  async function importFiles(files) {
    for (const f of files) {
      if (!/\.pdf$/i.test(f.name)) {
        PR.toast('跳过「' + f.name + '」：仅支持 PDF', 'error');
        continue;
      }
      PR.toast('正在导入《' + f.name + '》…');
      try {
        const buf = await f.arrayBuffer();
        await PR.api.importPdf(f.name, buf);
        PR.toast('导入成功：' + f.name, 'ok');
      } catch (e) {
        PR.toastErr(e);
      }
    }
    await PR.api.bootstrap();
    PR.rerender();
  }

  function docCard(d) {
    const pages = d.pages ? d.pages + ' 页' : '页数待首读统计';
    return (
      '<div class="doc-card" data-id="' + d.id + '">' +
      '<div class="doc-icon">📄</div>' +
      '<div class="doc-info">' +
      '<div class="doc-name" title="' + PR.escapeHtml(d.name) + '">' + PR.escapeHtml(d.name) + '</div>' +
      '<div class="doc-meta">' + pages + ' · ' + (d.size ? (d.size / 1048576).toFixed(1) + ' MB · ' : '') +
      '最近阅读 ' + PR.fmtTime(d.lastOpenedAt) + '</div>' +
      '</div>' +
      '<div class="doc-actions">' +
      '<button class="btn primary act-open">打开阅读</button>' +
      '<button class="btn ghost act-del" title="删除论文及其全部笔记高亮">删除</button>' +
      '</div>' +
      '</div>'
    );
  }

  const view = {
    async render(el) {
      container = el;
      const docs = PR.state.docs;
      el.innerHTML =
        '<header class="gh">' +
        '<a class="logo" href="#/">📖 论文伴读</a>' +
        '<nav><a href="#/notes">笔记管理</a><a href="#/vocab">词库</a><a href="#/settings">设置</a></nav>' +
        '</header>' +
        '<main class="home">' +
        '<section class="hero">' +
        '<h1>把英文论文读成中文</h1>' +
        '<p>悬停取词 · 选中成句 · 高亮批注 · 边读边记，数据全部保存在本机</p>' +
        '<div class="import-zone" id="dropzone">' +
        '<button class="btn primary big" id="btn-import">＋ 导入 PDF 论文</button>' +
        '<div class="import-hint">或将 PDF 文件拖到此处（可多选）</div>' +
        '<input type="file" id="file-input" accept="application/pdf,.pdf" multiple hidden>' +
        '</div>' +
        '</section>' +
        '<section class="doc-section">' +
        '<h2>文档库 <span class="count">' + docs.length + ' 篇</span></h2>' +
        (docs.length
          ? '<div class="doc-grid">' + docs.map(docCard).join('') + '</div>'
          : '<div class="empty">还没有论文，点击上方按钮导入第一篇吧。</div>') +
        '</section>' +
        '<footer class="home-foot">数据目录：<code>' + PR.escapeHtml(PR.state.dataDir) +
        '</code> · 备份只需复制此目录或在设置页导出备份</footer>' +
        '</main>';

      const input = el.querySelector('#file-input');
      el.querySelector('#btn-import').addEventListener('click', () => input.click());
      input.addEventListener('change', () => {
        if (input.files && input.files.length) importFiles(Array.from(input.files));
        input.value = '';
      });

      const dz = el.querySelector('#dropzone');
      const home = el.querySelector('.home');
      home.addEventListener('dragover', (e) => {
        e.preventDefault();
        if (!dragging) { dragging = true; dz.classList.add('over'); }
      });
      home.addEventListener('dragleave', (e) => {
        if (e.target === home || e.target === dz) {
          dragging = false; dz.classList.remove('over');
        }
      });
      home.addEventListener('drop', (e) => {
        e.preventDefault();
        dragging = false; dz.classList.remove('over');
        const files = Array.from(e.dataTransfer.files || []);
        if (files.length) importFiles(files);
      });

      el.querySelectorAll('.doc-card').forEach((card) => {
        const id = card.dataset.id;
        card.querySelector('.act-open').addEventListener('click', () => PR.go('#/read/' + id));
        card.querySelector('.act-del').addEventListener('click', async () => {
          const d = PR.state.docs.find((x) => x.id === id);
          const ok = await PR.confirmBox(
            '确定删除《' + (d ? d.name : id) + '》吗？\n它的高亮、批注和笔记会一并删除，且无法恢复。'
          );
          if (!ok) return;
          try {
            await PR.api.delDoc(id);
            PR.toast('已删除', 'ok');
            await PR.api.bootstrap();
            PR.rerender();
          } catch (e) {
            PR.toastErr(e);
          }
        });
      });
    },
  };
  PR.views.home = view;
})();
