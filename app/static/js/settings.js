// 设置页：翻译接口配置、测试连接、联动开关默认值、备份与恢复
(function () {
  'use strict';
  const PR = window.PR;

  function formValues(el) {
    const s = PR.state.settings;
    const provider = el.querySelector('#f-provider').value;
    const target = el.querySelector('#f-target').value;
    return {
      translate: {
        provider,
        target,
        openai: {
          baseUrl: el.querySelector('#f-oa-url').value.trim(),
          apiKey: el.querySelector('#f-oa-key').value.trim(),
          model: el.querySelector('#f-oa-model').value.trim() || 'gpt-4o-mini',
        },
        deepl: {
          url: el.querySelector('#f-dl-url').value.trim(),
          apiKey: el.querySelector('#f-dl-key').value.trim(),
        },
      },
      linkageOn: el.querySelector('#f-linkage').checked,
      _saved: s,
    };
  }

  function toggleProviderFields(el, provider) {
    el.querySelector('.pf-mymemory').style.display = provider === 'mymemory' ? '' : 'none';
    el.querySelector('.pf-openai').style.display = provider === 'openai' ? '' : 'none';
    el.querySelector('.pf-deepl').style.display = provider === 'deepl' ? '' : 'none';
  }

  const view = {
    async render(el) {
      const s = PR.state.settings || {};
      const t = s.translate || {};
      const oa = t.openai || {};
      const dl = t.deepl || {};
      el.innerHTML =
        '<header class="gh">' +
        '<a class="logo" href="#/">📖 论文伴读</a>' +
        '<nav><a href="#/">文档库</a><a href="#/notes">笔记管理</a><a href="#/vocab">词库</a></nav>' +
        '</header>' +
        '<main class="settings">' +
        '<h1>设置</h1>' +

        '<section class="card">' +
        '<h2>翻译接口</h2>' +
        '<div class="row"><label>接口类型</label>' +
        '<select id="f-provider">' +
        '<option value="mymemory"' + (t.provider !== 'openai' && t.provider !== 'deepl' ? ' selected' : '') + '>MyMemory（免费，无需 Key，默认）</option>' +
        '<option value="openai"' + (t.provider === 'openai' ? ' selected' : '') + '>OpenAI 兼容接口（需 API Key）</option>' +
        '<option value="deepl"' + (t.provider === 'deepl' ? ' selected' : '') + '>DeepL（需 API Key）</option>' +
        '</select></div>' +
        '<div class="row"><label>翻译目标语言</label>' +
        '<select id="f-target">' +
        ['zh-CN:简体中文', 'zh-TW:繁體中文', 'en:English', 'ja:日本語'].map((x) => {
          const [v, n] = x.split(':');
          return '<option value="' + v + '"' + (t.target === v ? ' selected' : '') + '>' + n + '</option>';
        }).join('') +
        '</select></div>' +
        '<div class="pf pf-mymemory"><p class="hint">免费接口有每日额度限制，适合轻度使用；翻译结果会缓存在本地，重复内容不重复请求。</p></div>' +
        '<div class="pf pf-openai">' +
        '<div class="row"><label>接口地址</label><input id="f-oa-url" value="' + PR.escapeHtml(oa.baseUrl || 'https://api.openai.com/v1') + '" placeholder="https://api.openai.com/v1"></div>' +
        '<div class="row"><label>API Key</label><input id="f-oa-key" type="password" value="' + PR.escapeHtml(oa.apiKey || '') + '" placeholder="sk-..."></div>' +
        '<div class="row"><label>模型</label><input id="f-oa-model" value="' + PR.escapeHtml(oa.model || 'gpt-4o-mini') + '"></div>' +
        '<p class="hint">支持任何 OpenAI 兼容接口（如 DeepSeek、Kimi、硅基流动等），填对应地址、Key 和模型名即可。</p>' +
        '</div>' +
        '<div class="pf pf-deepl">' +
        '<div class="row"><label>接口地址</label><input id="f-dl-url" value="' + PR.escapeHtml(dl.url || 'https://api-free.deepl.com/v2/translate') + '"></div>' +
        '<div class="row"><label>API Key</label><input id="f-dl-key" type="password" value="' + PR.escapeHtml(dl.apiKey || '') + '"></div>' +
        '</div>' +
        '<div class="row"><label></label><span><button class="btn" id="btn-test">测试连接</button> <span id="test-result" class="hint"></span></span></div>' +
        '</section>' +

        '<section class="card">' +
        '<h2>阅读偏好</h2>' +
        '<div class="row"><label>全文联动高亮（默认）</label>' +
        '<label class="switch"><input type="checkbox" id="f-linkage"' + (s.linkageOn ? ' checked' : '') + '><span></span>打开后，高亮过的词在全文自动标注</label></div>' +
        '</section>' +

        '<section class="card">' +
        '<h2>数据备份与恢复</h2>' +
        '<p class="hint">全部数据保存在本机目录：<code>' + PR.escapeHtml(PR.state.dataDir) + '</code><br>' +
        '当前共 ' + PR.state.docs.length + ' 篇论文 · 翻译缓存 ' + (PR.state.cache && PR.state.cache.count || 0) + ' 条</p>' +
        '<div class="row"><label>导出备份</label><a class="btn" href="/api/backup" id="btn-backup">下载备份 zip</a></div>' +
        '<div class="row"><label>从备份恢复</label><span><button class="btn danger" id="btn-restore">选择备份文件恢复…</button>' +
        '<input type="file" id="restore-input" accept=".zip,application/zip" hidden></span></div>' +
        '<p class="hint">恢复会<b>覆盖当前全部数据</b>，请先导出备份再操作。最低成本的备份方式是直接复制整个应用文件夹。</p>' +
        '</section>' +

        '<section class="card">' +
        '<h2>关于</h2>' +
        '<p class="hint">论文伴读 v1.0 · 本地网页应用 · 数据不上传任何云端</p>' +
        '</section>' +
        '</main>';

      const providerSel = el.querySelector('#f-provider');
      toggleProviderFields(el, providerSel.value);
      providerSel.addEventListener('change', () => toggleProviderFields(el, providerSel.value));

      el.querySelector('#btn-test').addEventListener('click', async () => {
        const btn = el.querySelector('#btn-test');
        const out = el.querySelector('#test-result');
        btn.disabled = true;
        out.textContent = '测试中…';
        try {
          const patch = formValues(el);
          delete patch._saved;
          const r = await PR.api.test(patch);
          out.textContent = '连接成功：' + r.sample;
          out.className = 'hint ok';
        } catch (e) {
          out.textContent = '失败：' + e.message;
          out.className = 'hint err';
        }
        btn.disabled = false;
      });

      el.querySelector('#btn-restore').addEventListener('click', () => el.querySelector('#restore-input').click());
      el.querySelector('#restore-input').addEventListener('change', async (ev) => {
        const f = ev.target.files && ev.target.files[0];
        ev.target.value = '';
        if (!f) return;
        const ok = await PR.confirmBox(
          '恢复备份将【覆盖】当前全部数据（论文列表、笔记、高亮、批注、设置）。\n当前数据将被替换为备份内容，确定继续吗？'
        );
        if (!ok) return;
        try {
          PR.toast('正在恢复…');
          const buf = await f.arrayBuffer();
          const r = await PR.restore(buf);
          PR.toast('恢复完成：' + r.docCount + ' 篇论文 · ' + r.fileCount + ' 个文件，即将刷新', 'ok', 3500);
          setTimeout(() => location.reload(), 1200);
        } catch (e) {
          PR.toastErr(e);
        }
      });

      // 任意设置修改即保存（显式保存按钮统一处理：改动后自动落盘）
      let saveTimer = null;
      const scheduleSave = async () => {
        clearTimeout(saveTimer);
        saveTimer = setTimeout(async () => {
          try {
            const patch = formValues(el);
            delete patch._saved;
            await PR.api.saveSettings(patch);
            PR.toast('设置已保存', 'ok', 1500);
          } catch (e) {
            PR.toastErr(e);
          }
        }, 500);
      };
      el.querySelectorAll('select, input').forEach((i) => i.addEventListener('change', scheduleSave));
      el.querySelectorAll('.pf input').forEach((i) => i.addEventListener('input', scheduleSave));
    },
    async destroy() {},
  };
  PR.views.settings = view;
})();
