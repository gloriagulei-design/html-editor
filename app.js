/**
 * HTML可视化编辑器 Pro — 核心逻辑
 * 功能：文件上传、可视化编辑、实时预览、代码视图、导出
 */
(function () {
  'use strict';

  /* ── 状态 ── */
  let currentHtml   = '';
  let currentFileName = 'untitled.html';
  let currentEl     = null;
  let editHistory   = [];
  let isDragging    = false;

  /* ── DOM 缓存 ── */
  const $  = s => document.querySelector(s);
  const $$ = s => Array.from(document.querySelectorAll(s));

  const els = {
    dropZone        : $('#drop-zone'),
    fileInput       : $('#file-input'),
    fileInfo        : $('#file-info'),
    fileName        : $('#file-name'),
    fileSize        : $('#file-size'),
    btnReplace      : $('#btn-replace'),

    previewFrame    : $('#preview-frame'),
    previewWrap     : $('#preview-wrap'),
    codePanel       : $('#code-panel'),
    contentArea     : $('#content-area'),

    codeContent     : $('#code-content'),
    codeInfo        : $('#code-info'),

    elementTree     : $('#element-tree'),
    elementCount    : $('#element-count'),
    elementSearch   : $('#element-search'),

    sidebarRight    : $('#sidebar-right'),
    sidebarMsg      : $('#sidebar-message'),
    propertiesPanel : $('#properties-panel'),

    propTextContent : $('#prop-text-content'),
    propHtmlContent : $('#prop-html-content'),
    propHtmlGroup   : $('#prop-html-group'),
    propTag         : $('#prop-tag'),

    propColor       : $('#prop-color'),
    propColorText   : $('#prop-color-text'),
    propBgColor     : $('#prop-bg-color'),
    propBgColorText : $('#prop-bg-color-text'),
    propFontSize    : $('#prop-font-size'),
    propFontWeight  : $('#prop-font-weight'),
    propPadding     : $('#prop-padding'),
    propMargin      : $('#prop-margin'),
    propRadius      : $('#prop-radius'),
    propBorder      : $('#prop-border'),
    propCustomCss   : $('#prop-custom-css'),
    propAlign       : $('#prop-align'),

    propHref        : $('#prop-href'),
    propSrc         : $('#prop-src'),
    propId          : $('#prop-id'),
    propClass       : $('#prop-class'),

    btnReset        : $('#btn-reset'),
    btnNew          : $('#btn-new'),
    btnDownload     : $('#btn-download'),
    btnDeleteEl     : $('#btn-delete-el'),
    btnCopyCode     : $('#btn-copy-code'),
    btnFormatCode   : $('#btn-format-code'),
    btnEditHtml     : $('#btn-edit-html'),

    overlay         : $('#overlay'),
    htmlModal       : $('#html-modal'),
    modalTextarea   : $('#modal-html-textarea'),
    btnCloseModal   : $('#btn-close-modal'),
    btnModalCancel  : $('#btn-modal-cancel'),
    btnModalOk      : $('#btn-modal-ok'),

    toastContainer  : $('#toast-container'),
  };

  /* ── 初始化 ── */
  function init() {
    bindEvents();
    loadDefaultContent();
    showToast('HTML 可视化编辑器已就绪，拖拽文件或双击文字即可编辑', 'success');
  }

  /* ── 事件绑定 ── */
  function bindEvents() {
    /* 文件上传 */
    els.dropZone.addEventListener('click', () => els.fileInput.click());
    els.dropZone.addEventListener('dragover', e => { e.preventDefault(); els.dropZone.classList.add('dragover'); });
    els.dropZone.addEventListener('dragleave', () => els.dropZone.classList.remove('dragover'));
    els.dropZone.addEventListener('drop', onFileDrop);
    els.fileInput.addEventListener('change', e => handleFile(e.target.files[0]));
    els.btnReplace.addEventListener('click', () => els.fileInput.click());

    /* 顶部"打开本地文件"按钮 */
    const btnOpenFile = $('#btn-open-file');
    if (btnOpenFile) {
      btnOpenFile.addEventListener('click', () => els.fileInput.click());
    }

    /* 全局拖拽：拦截整个页面的 drag/drop，防止浏览器默认打开文件 */
    document.addEventListener('dragover', e => {
      e.preventDefault();
      document.body.classList.add('drag-active');
    });
    document.addEventListener('dragleave', e => {
      if (!e.relatedTarget || !document.contains(e.relatedTarget)) {
        document.body.classList.remove('drag-active');
      }
    });
    document.addEventListener('drop', e => {
      e.preventDefault();
      document.body.classList.remove('drag-active');
      if (e.dataTransfer.files && e.dataTransfer.files.length > 0) {
        handleFile(e.dataTransfer.files[0]);
      }
    });

    /* 视图切换 */
    $$('.tab-btn').forEach(b => b.addEventListener('click', onViewSwitch));

    /* 属性面板标签页 */
    $$('.prop-tab').forEach(t => t.addEventListener('click', onPropTabSwitch));

    /* 文本内容改动 */
    els.propTextContent.addEventListener('input', updateTextContent);
    els.propHtmlContent.addEventListener('input', updateHtmlContent);

    /* 样式改动 */
    [els.propColor, els.propColorText].forEach(el =>
      el.addEventListener('input', () => updateStyle('color', els.propColorText.value || els.propColor.value)));
    [els.propBgColor, els.propBgColorText].forEach(el =>
      el.addEventListener('input', () => updateStyle('backgroundColor', els.propBgColorText.value || els.propBgColor.value)));
    els.propFontSize .addEventListener('input', () => updateStyle('fontSize', els.propFontSize.value));
    els.propFontWeight.addEventListener('change',() => updateStyle('fontWeight', els.propFontWeight.value));
    els.propPadding  .addEventListener('input', () => updateStyle('padding', els.propPadding.value));
    els.propMargin   .addEventListener('input', () => updateStyle('margin', els.propMargin.value));
    els.propBorder   .addEventListener('input', () => updateStyle('border', els.propBorder.value));
    els.propRadius   .addEventListener('input', () => updateStyle('borderRadius', els.propRadius.value));
    els.propCustomCss.addEventListener('input', () => {
      if (!currentEl) return;
      currentEl.setAttribute('style', els.propCustomCss.value);
      renderPreview(); addHistory('修改自定义CSS');
    });

    /* 对齐 */
    $$('#prop-align .btn-icon').forEach(btn =>
      btn.addEventListener('click', () => {
        updateStyle('textAlign', btn.dataset.value);
        $$('#prop-align .btn-icon').forEach(b => b.classList.remove('active'));
        btn.classList.add('active');
      }));

    /* 属性改动 */
    els.propHref.addEventListener('input', () => {
      if (!currentEl) return;
      currentEl.setAttribute('href', els.propHref.value);
      renderPreview(); addHistory('修改 href');
    });
    els.propSrc.addEventListener('input', () => {
      if (!currentEl) return;
      currentEl.setAttribute('src', els.propSrc.value);
      renderPreview(); addHistory('修改 src');
    });
    els.propId.addEventListener('input', () => {
      if (!currentEl) return;
      currentEl.setAttribute('id', els.propId.value);
      renderPreview(); addHistory('修改 ID');
    });
    els.propClass.addEventListener('input', () => {
      if (!currentEl) return;
      currentEl.setAttribute('class', els.propClass.value);
      renderPreview(); addHistory('修改 Class');
    });

    /* 工具栏 */
    els.btnReset     .addEventListener('click', resetEditor);
    els.btnNew       .addEventListener('click', () => loadDefaultContent());
    els.btnDownload  .addEventListener('click', downloadHtml);
    els.btnCopyCode  .addEventListener('click', copyCode);
    els.btnFormatCode.addEventListener('click', formatCode);
    els.btnDeleteEl  .addEventListener('click', deleteCurrentElement);
    els.btnEditHtml  .addEventListener('click', openHtmlModal);

    /* 弹窗 */
    els.btnCloseModal .addEventListener('click', closeHtmlModal);
    els.btnModalCancel.addEventListener('click', closeHtmlModal);
    els.btnModalOk    .addEventListener('click', saveModalHtml);
    els.overlay       .addEventListener('click', closeHtmlModal);

    /* 搜索 */
    els.elementSearch.addEventListener('input', onElementSearch);

    /* iframe 加载完成 */
    els.previewFrame.addEventListener('load', () => setTimeout(onFrameLoad, 50));
  }

  /* ── 文件处理 ── */
  function onFileDrop(e) {
    e.preventDefault();
    els.dropZone.classList.remove('dragover');
    handleFile(e.dataTransfer.files[0]);
  }

  function handleFile(file) {
    if (!file || (!/\.(html?|txt)$/i.test(file.name))) {
      showToast('请上传 .html / .htm / .txt 文件', 'error'); return;
    }
    currentFileName = file.name;
    const r = new FileReader();
    r.onload = e => loadHtml(e.target.result, file.name, file.size);
    r.readAsText(file);
  }

  function loadHtml(html, name, size) {
    currentHtml = html;
    renderPreview(); buildElementTree(); updateCodePanel();
    els.fileName.textContent = name;
    els.fileSize.textContent = formatBytes(size || new Blob([html]).size);
    els.dropZone.style.display = 'none';
    els.fileInfo.classList.add('show');
    editHistory = []; updateHistoryUI();
    showToast(`已加载「${name}」`, 'success');
  }

  /* ── 预览渲染 ── */
  function renderPreview() {
    const doc = els.previewFrame.contentDocument || els.previewFrame.contentWindow?.document;
    if (!doc) return;
    doc.open(); doc.write(currentHtml); doc.close();
  }

  function onFrameLoad() {
    const iframe = els.previewFrame;
    const doc = iframe.contentDocument || iframe.contentWindow?.document;
    if (!doc || !doc.body) return;

    /* 注入编辑器交互样式 */
    let style = doc.getElementById('html-editor-injected');
    if (!style) {
      style = doc.createElement('style');
      style.id = 'html-editor-injected';
      style.textContent = `
        .html-editor-selected {
          outline: 2.5px solid #6366f1 !important;
          outline-offset: 2px !important;
          cursor: text !important;
          background: rgba(99,102,241,0.05) !important;
        }
        .html-editor-hover {
          outline: 1.5px dashed rgba(99,102,241,0.5) !important;
          outline-offset: 1px !important;
          cursor: text !important;
        }
        .html-editor-hover::after {
          content: attr(data-tag);
          position: absolute; top: -18px; left: 0;
          background: #6366f1; color: #fff; font-size: 10px;
          padding: 1px 6px; border-radius: 4px; pointer-events: none; z-index: 999999; white-space: nowrap;
        }
        body { position: relative; }
        * { position: relative; transition: background-color 0.15s; }
        body *:hover { background-color: rgba(99,102,241,0.02); }
      `;
      if (doc.head) doc.head.appendChild(style);
    }

    function walk(el) {
      if (!el || el.nodeType !== 1 || el.id === 'html-editor-injected') return;
      el.setAttribute('data-tag', el.tagName.toLowerCase());

      el.addEventListener('mouseenter', function (e) {
        if (isDragging) return; this.classList.add('html-editor-hover'); e.stopPropagation();
      });
      el.addEventListener('mouseleave', function (e) {
        this.classList.remove('html-editor-hover'); e.stopPropagation();
      });
      el.addEventListener('click', function (e) {
        e.preventDefault(); e.stopPropagation(); selectElement(this);
      });
      el.addEventListener('dblclick', function (e) {
        e.preventDefault(); e.stopPropagation(); enableInlineEdit(this);
      });
      Array.from(el.children).forEach(walk);
    }
    walk(doc.body);
  }

  /* ── 元素选中 / 编辑 ── */
  function selectElement(el) {
    const doc = els.previewFrame.contentDocument;
    doc.querySelectorAll('.html-editor-selected').forEach(e => e.classList.remove('html-editor-selected'));
    el.classList.add('html-editor-selected');
    currentEl = el;
    showPropertiesPanel(); syncPropertiesPanel(); highlightTreeNode(el);
  }

  function enableInlineEdit(el) {
    if (/^(img|input|textarea|br|hr|iframe|video|audio|canvas|svg)$/i.test(el.tagName)) return;
    el.contentEditable = 'true'; el.focus();
    try {
      const r = docR(el); const s = sel();
      if (r && s) { r.selectNodeContents(el); s.removeAllRanges(); s.addRange(r); }
    } catch (_) {}

    const onBlur = () => {
      el.contentEditable = 'false';
      el.removeEventListener('blur', onBlur);
      el.removeEventListener('input', onInput);
      syncFromFrame(); buildElementTree(); updateCodePanel();
      addHistory('编辑文本: ' + (el.textContent.trim().slice(0,20) || '[空]'));
    };
    const onInput = () => { els.propTextContent.value = el.textContent; };
    el.addEventListener('blur', onBlur, { once: true });
    el.addEventListener('input', onInput);
  }

  function docR(el) {
    const d = els.previewFrame.contentDocument;
    return d && d.createRange ? d.createRange() : null;
  }
  function sel() {
    const w = els.previewFrame.contentWindow;
    return w && w.getSelection ? w.getSelection() : null;
  }

  function syncFromFrame() {
    const doc = els.previewFrame.contentDocument;
    const s = doc.getElementById('html-editor-injected'); if (s) s.remove();
    doc.querySelectorAll('.html-editor-selected, .html-editor-hover').forEach(e => {
      e.classList.remove('html-editor-selected', 'html-editor-hover');
      e.removeAttribute('contenteditable'); e.removeAttribute('data-tag');
    });
    currentHtml = '<!DOCTYPE html>\n' + doc.documentElement.outerHTML;
  }

  /* ── 属性面板 ── */
  function showPropertiesPanel() {
    els.sidebarMsg.style.display = 'none';
    els.propertiesPanel.style.display = 'flex';
  }

  function closePropertiesPanel() {
    els.propertiesPanel.style.display = 'none';
    els.sidebarMsg.style.display = 'flex';
    currentEl = null;
    const doc = els.previewFrame.contentDocument;
    doc.querySelectorAll('.html-editor-selected').forEach(e => e.classList.remove('html-editor-selected'));
    $$('.tree-node').forEach(n => n.classList.remove('selected'));
  }

  function syncPropertiesPanel() {
    if (!currentEl) return;
    const el = currentEl;
    const cs = getComputedStyle(el);
    els.propTag.textContent = el.tagName.toLowerCase();

    const isEmptyTag = /^(img|input|textarea|br|hr|iframe|video|audio|canvas|svg)$/i.test(el.tagName);
    if (isEmptyTag) {
      els.propTextContent.parentElement.style.display = 'none';
      els.propHtmlGroup.style.display = 'none';
    } else {
      els.propTextContent.parentElement.style.display = 'block';
      els.propHtmlGroup.style.display = 'block';
      els.propTextContent.value = el.textContent;
      els.propHtmlContent.value = el.innerHTML;
    }

    const rgbToHex = rgb => {
      if (!rgb || /rgba?\(0\s*,\s*0\s*,\s*0/i.test(rgb) || rgb === 'transparent') return '';
      const m = rgb.match(/rgba?\((\d+)\s*,\s*(\d+)\s*,\s*(\d+)/);
      return m ? '#' + [m[1],m[2],m[3]].map(x => (+x).toString(16).padStart(2,'0')).join('') : rgb;
    };

    const cHex = rgbToHex(cs.color);
    els.propColor.value = cHex || '#000000';
    els.propColorText.value = cHex || '';

    const bgHex = rgbToHex(cs.backgroundColor);
    els.propBgColor.value = bgHex || '#ffffff';
    els.propBgColorText.value = bgHex === '#ffffff' ? '' : bgHex;

    els.propFontSize.value    = cs.fontSize === 'normal' ? '' : cs.fontSize;
    els.propFontWeight.value  = cs.fontWeight;
    els.propPadding.value     = cs.padding;
    els.propMargin.value      = cs.margin;
    els.propBorder.value      = cs.border;
    els.propRadius.value      = cs.borderRadius;
    els.propCustomCss.value   = el.getAttribute('style') || '';

    const align = cs.textAlign;
    $$('#prop-align .btn-icon').forEach(b => b.classList.toggle('active', b.dataset.value === align));

    els.propHref.value  = el.getAttribute('href') || '';
    els.propSrc.value   = el.getAttribute('src') || '';
    els.propId.value    = el.id || '';
    els.propClass.value = el.className || '';
  }

  function updateStyle(prop, val) {
    if (!currentEl || !val) return;
    currentEl.style[prop] = val;
    syncFromFrame(); renderPreview(); addHistory(`修改样式: ${prop}`);
  }

  function updateTextContent() {
    if (!currentEl) return;
    currentEl.textContent = els.propTextContent.value;
    syncFromFrame(); renderPreview(); buildElementTree(); addHistory('修改文本');
  }

  function updateHtmlContent() {
    if (!currentEl) return;
    currentEl.innerHTML = els.propHtmlContent.value;
    syncFromFrame(); renderPreview(); addHistory('修改 HTML 内容');
  }

  function deleteCurrentElement() {
    if (!currentEl) return;
    if (!confirm('确定删除此元素？')) return;
    currentEl.remove(); syncFromFrame(); renderPreview();
    buildElementTree(); updateCodePanel(); closePropertiesPanel();
    addHistory('删除元素'); showToast('元素已删除', 'success');
  }

  /* ── HTML 弹窗 ── */
  function openHtmlModal() {
    if (!currentEl) return;
    els.modalTextarea.value = currentEl.innerHTML;
    els.overlay.classList.add('show');
    els.htmlModal.classList.add('show');
  }
  function closeHtmlModal() {
    els.overlay.classList.remove('show');
    els.htmlModal.classList.remove('show');
  }
  function saveModalHtml() {
    if (currentEl) {
      currentEl.innerHTML = els.modalTextarea.value;
      els.propHtmlContent.value = currentEl.innerHTML;
      syncFromFrame(); renderPreview(); addHistory('修改 HTML 源码');
      showToast('HTML 源码已更新', 'success');
    }
    closeHtmlModal();
  }

  /* ── 元素树 ── */
  function buildElementTree() {
    const doc = new DOMParser().parseFromString(currentHtml, 'text/html');
    const root = document.createElement('div');
    let count = 0;

    function build(node, depth = 0) {
      if (node.nodeType !== 1) return;
      const tag = node.tagName.toLowerCase();
      if (/^(script|style|meta|link|title|head)$/i.test(tag)) return;

      count++;
      const item = document.createElement('div');
      item.className = 'tree-node';
      item.dataset.tag = tag;
      item.dataset.idx = count;
      item.style.paddingLeft = (14 + depth * 16) + 'px';
      const txt = (node.textContent || '').trim().slice(0, 18);
      item.innerHTML = `
        <i class="fas fa-tag"></i>
        <span class="node-tag">${tag}</span>
        <span class="node-text">${txt || '&nbsp;'}</span>
      `;
      item.addEventListener('click', e => {
        e.stopPropagation();
        const iframeDoc = els.previewFrame.contentDocument;
        const flat = [];
        const walk = el => {
          if (el.nodeType === 1 && !/^(script|style|meta|link|title|head)$/i.test(el.tagName)) {
            flat.push(el);
          }
          Array.from(el.children).forEach(walk);
        };
        walk(iframeDoc.body);
        const target = flat[count - 1];
        if (target) selectElement(target);
      });
      root.appendChild(item);
      Array.from(node.children).forEach(c => build(c, depth + 1));
    }

    root.innerHTML = '';
    build(doc.body);
    els.elementTree.innerHTML = '';
    els.elementTree.appendChild(root);
    els.elementCount.textContent = count;
  }

  function highlightTreeNode(el) {
    $$('.tree-node').forEach(n => n.classList.remove('selected'));
    const tag = el.tagName.toLowerCase();
    const text = (el.textContent || '').trim().slice(0, 18);
    for (const node of $$('.tree-node')) {
      if (node.dataset.tag === tag && node.textContent.includes(text)) {
        node.classList.add('selected'); node.scrollIntoView({ block: 'nearest' }); break;
      }
    }
  }

  function onElementSearch(e) {
    const q = e.target.value.toLowerCase();
    $$('.tree-node').forEach(n => {
      n.style.display = n.textContent.toLowerCase().includes(q) ? 'flex' : 'none';
    });
  }

  /* ── 代码面板 ── */
  function updateCodePanel() {
    els.codeContent.textContent = currentHtml;
    if (window.hljs) hljs.highlightElement(els.codeContent);
    els.codeInfo.textContent = `HTML · ${formatBytes(new Blob([currentHtml]).size)}`;
  }

  function onViewSwitch(e) {
    const btn = e.currentTarget;
    const view = btn.dataset.view;
    $$('.tab-btn').forEach(b => b.classList.remove('active'));
    btn.classList.add('active');

    if (view === 'design') {
      els.previewWrap.style.display = 'flex';
      els.codePanel.style.display = 'none';
      els.contentArea.classList.remove('view-split');
    } else if (view === 'code') {
      els.previewWrap.style.display = 'none';
      els.codePanel.style.display = 'flex';
      els.contentArea.classList.remove('view-split');
      syncFromFrame(); updateCodePanel();
    } else if (view === 'split') {
      els.previewWrap.style.display = 'flex';
      els.codePanel.style.display = 'flex';
      els.contentArea.classList.add('view-split');
      syncFromFrame(); updateCodePanel();
    }
  }

  function onPropTabSwitch(e) {
    const tab = e.currentTarget.dataset.tab;
    $$('.prop-tab').forEach(t => t.classList.remove('active'));
    e.currentTarget.classList.add('active');
    $$('.prop-body').forEach(b => b.style.display = (b.dataset.panel === tab ? 'block' : 'none'));
  }

  function copyCode() {
    navigator.clipboard.writeText(currentHtml).then(() => showToast('代码已复制', 'success'));
  }

  function formatCode() {
    let out = '', indent = 0;
    const lines = currentHtml.replace(/>(\s*)</g, '>\n<').split('\n');
    for (const ln of lines) {
      const t = ln.trim(); if (!t) continue;
      if (t.startsWith('</')) indent = Math.max(0, indent - 1);
      out += '  '.repeat(indent) + t + '\n';
      if (t.startsWith('<') && !t.startsWith('</') && !t.endsWith('/>') && t.includes('<')) indent++;
    }
    currentHtml = out.trim();
    updateCodePanel(); renderPreview();
    showToast('代码已格式化', 'success');
  }

  /* ── 历史记录 ── */
  function addHistory(action) {
    editHistory.unshift({ action, time: new Date().toLocaleTimeString('zh-CN', { hour:'2-digit', minute:'2-digit', second:'2-digit' }) });
    if (editHistory.length > 30) editHistory.pop();
  }
  function updateHistoryUI() { /* side effect: empty since no history-node DOM now, harmless */ }

  /* ── 导出 & 工具 ── */
  function downloadHtml() {
    syncFromFrame();
    const blob = new Blob([currentHtml], { type: 'text/html;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url; a.download = currentFileName; a.click();
    URL.revokeObjectURL(url);
    showToast(`已导出 ${currentFileName}`, 'success');
  }

  function resetEditor() {
    if (!confirm('确定重置？未保存的修改将丢失。')) return;
    currentHtml = ''; currentEl = null;
    els.dropZone.style.display = null;
    els.fileInfo.classList.remove('show');
    editHistory = []; updateHistoryUI();
    loadDefaultContent();
    showToast('编辑器已重置', 'success');
  }

  function showToast(msg, type = 'info') {
    const t = document.createElement('div');
    t.className = `toast toast-${type}`;
    const icon = { error: 'fa-circle-exclamation', success: 'fa-circle-check', info: 'fa-circle-info' }[type] || 'fa-circle-info';
    t.innerHTML = `<i class="fas ${icon}"></i><span>${msg}</span>`;
    els.toastContainer.appendChild(t);
    setTimeout(() => t.remove(), 3000);
  }

  function formatBytes(b) {
    if (b < 1024) return b + ' B';
    if (b < 1024 * 1024) return (b / 1024).toFixed(1) + ' KB';
    return (b / 1024 / 1024).toFixed(1) + ' MB';
  }

  /* ── 默认示例内容 ── */
  function loadDefaultContent() {
    currentFileName = 'untitled.html';
    currentHtml = `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>示例报告</title>
<style>
  body { font-family: 'Noto Sans SC', -apple-system, sans-serif; max-width: 900px; margin: 0 auto; padding: 40px 20px; line-height: 1.8; color: #333; background: #fff; }
  h1 { color: #1a1a2e; border-bottom: 3px solid #4f46e5; padding-bottom: 14px; margin-bottom: 24px; }
  h2 { color: #1e1b4b; margin-top: 36px; border-left: 4px solid #7c3aed; padding-left: 14px; }
  .highlight-box { background: #eef2ff; border: 1px solid #c7d2fe; border-radius: 12px; padding: 18px 22px; margin: 18px 0; }
  .highlight-box strong { color: #4338ca; }
  table { width: 100%; border-collapse: collapse; margin: 18px 0; }
  th, td { border: 1px solid #e2e8f0; padding: 12px 16px; text-align: left; }
  th { background: #f8fafc; font-weight: 600; }
  tr:nth-child(even) { background: #f8fafc; }
  .badge { display: inline-block; padding: 3px 12px; border-radius: 999px; font-size: 12px; font-weight: 600; }
  .good { background: #d1fae5; color: #065f46; }
  .great { background: #bfdbfe; color: #1e40af; }
</style>
</head>
<body>
<h1>📊 2024年第一季度数据分析报告</h1>
<p>本报告总结了公司第一季度的整体运营数据，包括销售、用户增长和市场反馈等核心指标。</p>

<div class="highlight-box">
  <strong>📌 核心亮点：</strong><br/>
  销售额同比增长 <strong>32%</strong>，用户活跃度提升 <strong>18%</strong>，客户满意度达到历史新高。
</div>

<h2>一、销售数据概览</h2>
<table>
  <tr><th>月份</th><th>销售额（万元）</th><th>环比增长</th><th>状态</th></tr>
  <tr><td>1月</td><td>285</td><td>+5%</td><td><span class="badge good">良好</span></td></tr>
  <tr><td>2月</td><td>312</td><td>+9%</td><td><span class="badge good">良好</span></td></tr>
  <tr><td>3月</td><td>398</td><td>+28%</td><td><span class="badge great">优秀</span></td></tr>
</table>

<h2>二、用户增长趋势</h2>
<p>本季度新增注册用户 <strong>15,420</strong> 人，日活跃用户（DAU）突破 <strong>8,500</strong> 人。用户留存率保持在 <strong>72%</strong>。</p>

<h2>三、下季度重点计划</h2>
<ul>
  <li>推出会员升级功能，提升用户付费转化率</li>
  <li>优化移动端体验，提升加载速度 30%</li>
  <li>拓展海外市场，建立本地化团队</li>
</ul>

<p style="color:#64748b; font-size:13px; margin-top:48px; border-top:1px solid #e2e8f0; padding-top:14px;">
  报告生成时间：2024年4月5日 | 数据来源：企业数据中心
</p>
</body>
</html>`;

    renderPreview(); buildElementTree(); updateCodePanel();
    els.fileName.textContent = '示例报告 (未保存)';
    els.fileSize.textContent = formatBytes(new Blob([currentHtml]).size);
    els.dropZone.style.display = 'none';
    els.fileInfo.classList.add('show');
  }

  /* ── 启动 ── */
  init();
})();
