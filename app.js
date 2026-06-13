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
  const dragState   = { active: false, el: null, offsetX: 0, offsetY: 0, originalPosition: '', originalTop: '', originalLeft: '' };

  /* ── 撤销/重做 状态 ── */
  let undoStack = [];
  let redoStack = [];
  let isUndoing = false; // 标记正在执行撤销，避免记录
  const MAX_UNDO = 50; // 最大保留50步历史

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
    phonePreviewContainer: $('#phone-preview-container'),
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
    propPosition    : $('#prop-position'),
    propTopVal      : $('#prop-top-val'),
    propLeftVal     : $('#prop-left-val'),

    btnReset        : $('#btn-reset'),
    btnNew          : $('#btn-new'),
    btnDownload     : $('#btn-download'),
    btnDownloadPdf  : $('#btn-download-pdf'),
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

    // AI 命令助手面板
    aiAssistantPanel   : $('#ai-assistant-panel'),
    aiAssistantHeader  : $('#ai-assistant-header'),
    aiAssistantToggle  : $('#ai-assistant-toggle'),
    aiAssistantArrow   : $('#ai-assistant-arrow'),
    aiAssistantClose   : $('#ai-assistant-close'),
    aiAssistantBody    : $('#ai-assistant-body'),
    aiAssistantMessages: $('#ai-assistant-messages'),
    cmdTextInput       : $('#cmd-text-input'),
    cmdSendBtn         : $('#cmd-send-btn'),
    cmdVoiceBtn        : $('#cmd-voice-btn'),
    cmdClearHistory    : $('#cmd-clear-history'),
    voiceStatusBar     : $('#voice-status-bar'),
    voiceStatusText    : $('#voice-status-text'),
  };

  /* ── 初始化 ── */
  function init() {
    bindEvents();
    loadDefaultContent();
    updateUndoUI();
    // ★ 窗口大小变化时重新计算预览缩放
    window.addEventListener('resize', () => {
      requestAnimationFrame(updatePreviewScale);
    });
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

    // 定位类型
    els.propPosition.addEventListener('change', () => {
      const val = els.propPosition.value;
      if (!currentEl) return;
      pushUndo(`修改定位: ${val || 'static'}`, currentHtml);
      if (val) {
        currentEl.style.position = val;
      } else {
        currentEl.style.position = '';
      }
      syncFromFrame(); refreshAfterEdit(); addHistory(`修改定位: ${val || 'static'}`);
    });

    // 位置微调按钮（使用 transform: translate）
    function getTranslateValues(el) {
      const t = el.style.transform;
      const m = t.match(/translate\(([-\d.]+)px\s*,?\s*([-\d.]+)px\)/);
      return m ? [parseFloat(m[1]), parseFloat(m[2])] : [0, 0];
    }
    function setTranslate(el, x, y) {
      if (x === 0 && y === 0) {
        el.style.transform = '';
      } else {
        el.style.transform = `translate(${x}px, ${y}px)`;
      }
    }

    $$('.nudge-btn').forEach(btn => {
      btn.addEventListener('click', () => {
        if (!currentEl) return;
        const dir = btn.dataset.dir;
        const delta = parseInt(btn.dataset.delta, 10);
        pushUndo(`微调 ${dir === 'x' ? '水平' : '垂直'}: ${delta > 0 ? '+' : ''}${delta}px`, currentHtml);
        const [tx, ty] = getTranslateValues(currentEl);
        if (dir === 'x') {
          const newX = tx + delta;
          setTranslate(currentEl, newX, ty);
          els.propTopVal.value = newX;
        } else if (dir === 'y') {
          const newY = ty + delta;
          setTranslate(currentEl, tx, newY);
          els.propLeftVal.value = newY;
        }
        syncFromFrame(); addHistory(`微调 ${dir === 'x' ? '水平' : '垂直'}: ${delta > 0 ? '+' : ''}${delta}px`);
      });
    });

    // 位置输入框回车确认
    els.propTopVal.addEventListener('change', () => {
      if (!currentEl) return;
      pushUndo('设置 X 偏移', currentHtml);
      const val = els.propTopVal.value;
      const [, ty] = getTranslateValues(currentEl);
      const newX = val === '' ? 0 : parseFloat(val);
      setTranslate(currentEl, newX, ty);
      syncFromFrame(); addHistory('设置 X 偏移');
    });
    els.propLeftVal.addEventListener('change', () => {
      if (!currentEl) return;
      pushUndo('设置 Y 偏移', currentHtml);
      const val = els.propLeftVal.value;
      const [tx] = getTranslateValues(currentEl);
      const newY = val === '' ? 0 : parseFloat(val);
      setTranslate(currentEl, tx, newY);
      syncFromFrame(); addHistory('设置 Y 偏移');
    });

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
      pushUndo('修改自定义CSS', currentHtml);
      currentEl.setAttribute('style', els.propCustomCss.value);
      refreshAfterEdit(); addHistory('修改自定义CSS');
    });

    /* 对齐 */
    $$('#prop-align .btn-icon').forEach(btn =>
      btn.addEventListener('click', () => {
        pushUndo('修改对齐方式', currentHtml);
        updateStyle('textAlign', btn.dataset.value);
        $$('#prop-align .btn-icon').forEach(b => b.classList.remove('active'));
        btn.classList.add('active');
      }));

    /* 属性改动 */
    els.propHref.addEventListener('input', () => {
      if (!currentEl) return;
      pushUndo('修改 href', currentHtml);
      currentEl.setAttribute('href', els.propHref.value);
      refreshAfterEdit(); addHistory('修改 href');
    });
    els.propSrc.addEventListener('input', () => {
      if (!currentEl) return;
      pushUndo('修改 src', currentHtml);
      currentEl.setAttribute('src', els.propSrc.value);
      refreshAfterEdit(); addHistory('修改 src');
    });
    els.propId.addEventListener('input', () => {
      if (!currentEl) return;
      pushUndo('修改 ID', currentHtml);
      currentEl.setAttribute('id', els.propId.value);
      refreshAfterEdit(); addHistory('修改 ID');
    });
    els.propClass.addEventListener('input', () => {
      if (!currentEl) return;
      pushUndo('修改 Class', currentHtml);
      currentEl.setAttribute('class', els.propClass.value);
      refreshAfterEdit(); addHistory('修改 Class');
    });

    /* 工具栏 */
    els.btnReset     .addEventListener('click', resetEditor);
    els.btnNew       .addEventListener('click', () => loadDefaultContent());
    els.btnDownload  .addEventListener('click', downloadHtml);
    els.btnDownloadPdf.addEventListener('click', downloadPdf);
    els.btnCopyCode  .addEventListener('click', copyCode);
    els.btnFormatCode.addEventListener('click', formatCode);
    els.btnDeleteEl  .addEventListener('click', deleteCurrentElement);
    els.btnEditHtml  .addEventListener('click', openHtmlModal);

    /* 撤销/重做按钮 */
    const btnUndo = $('#btn-undo');
    const btnRedo = $('#btn-redo');
    if (btnUndo) btnUndo.addEventListener('click', undo);
    if (btnRedo) btnRedo.addEventListener('click', redo);

    /* 键盘快捷键 Ctrl+Z / Ctrl+Shift+Z */
    document.addEventListener('keydown', (e) => {
      if (e.ctrlKey || e.metaKey) {
        if (e.key === 'z' || e.key === 'Z') {
          e.preventDefault();
          if (e.shiftKey) { redo(); }
          else { undo(); }
        } else if (e.key === 'y' || e.key === 'Y') {
          e.preventDefault();
          redo();
        }
      }
    });

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

  /* ── HTML 预处理：规范化各种来源的 HTML 格式 ── */
  function normalizeHtml(html) {
    if (!html || typeof html !== 'string') return html;
    let h = html;

    // 1. 清除 BOM 和异常前缀
    h = h.replace(/^\uFEFF/, '');
    h = h.replace(/^\u00BB\u00BF/, '');
    h = h.replace(/^[\x00-\x08\x0B\x0C\x0E-\x1F]+/, '');

    // 2. 移除 XML 声明
    h = h.replace(/<\?xml[^?]*\?>/gi, '');

    // 3. 检测是否为完整 HTML 文档
    const hasHtmlTag = /<html[\s>]/i.test(h);
    const hasHeadTag = /<head[\s>]/i.test(h);
    const hasBodyTag = /<body[\s>]/i.test(h);

    // 4. 如果不是完整文档，包装为标准结构
    if (!hasHtmlTag) {
      let headContent = '';
      let bodyContent = h;

      const headMatch = h.match(/<head[^>]*>([\s\S]*?)<\/head>/i);
      if (headMatch) {
        headContent = headMatch[1];
        bodyContent = h.replace(/<head[^>]*>[\s\S]*?<\/head>/i, '');
      }

      const bodyMatch = bodyContent.match(/<body[^>]*>([\s\S]*?)<\/body>/i);
      if (bodyMatch) {
        bodyContent = bodyMatch[1];
      }

      h = `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
${headContent}
</head>
<body>
${bodyContent}
</body>
</html>`;
    } else if (!hasHeadTag) {
      h = h.replace(/<html([^>]*)>/i, (match, attrs) => {
        return `${match}<head><meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1.0"></head>`;
      });
    }

    // 5. 确保 charset 声明
    if (!/<meta[^>]+charset/i.test(h)) {
      if (h.includes('<head>')) {
        h = h.replace(/<head>/i, '<head>\n<meta charset="UTF-8">');
      } else if (h.includes('<head ')) {
        h = h.replace(/<head([^>]*)>/i, '<head$1>\n<meta charset="UTF-8">');
      }
    }

    // 6. 确保 viewport meta
    if (!/<meta[^>]+viewport/i.test(h)) {
      const vp = '<meta name="viewport" content="width=device-width, initial-scale=1.0">';
      if (h.includes('<head>')) {
        h = h.replace(/<head>/i, `<head>\n${vp}`);
      } else if (h.includes('<head ')) {
        h = h.replace(/<head([^>]*)>/i, `<head$1>\n${vp}`);
      }
    }

    // 7. 修复非标准结构：将 body 中的 meta/link[stylesheet] 移到 head
    const bodyHeadEls = [];
    const bodyTagReg = /<body[^>]*>([\s\S]*?)<\/body>/i;
    const bMatch = h.match(bodyTagReg);
    if (bMatch) {
      let bContent = bMatch[1];
      bContent = bContent.replace(/<meta(?![^>]*charset)(?![^>]*viewport)[^>]*>/gi, (m) => {
        bodyHeadEls.push(m); return '';
      });
      bContent = bContent.replace(/<link[^>]+rel\s*=\s*["']stylesheet["'][^>]*>/gi, (m) => {
        bodyHeadEls.push(m); return '';
      });
      if (bodyHeadEls.length > 0) {
        h = h.replace(bodyTagReg, `<body>${bContent}</body>`);
        if (h.includes('</head>')) {
          h = h.replace('</head>', bodyHeadEls.join('\n') + '\n</head>');
        }
      }
    }

    // 8. 确保有 DOCTYPE 声明
    if (!h.trim().toLowerCase().startsWith('<!doctype')) {
      h = '<!DOCTYPE html>\n' + h;
    }

    // 9. 清理 HTML 注释（保留条件注释）
    h = h.replace(/<!--(?!\[if)[\s\S]*?-->/g, '');

    return h;
  }

  function loadHtml(html, name, size) {
    currentHtml = normalizeHtml(html); // ★ 上传时即预处理规范化
    renderPreview(); buildElementTree(); updateCodePanel();
    els.fileName.textContent = name;
    els.fileSize.textContent = formatBytes(size || new Blob([html]).size);
    els.dropZone.style.display = 'none';
    els.fileInfo.classList.add('show');
    editHistory = []; undoStack = []; redoStack = []; voiceLog = [];
    updateHistoryUI(); updateUndoUI(); updateVoiceLogUI();
    showToast(`已加载「${name}」(HTML已规范化)`, 'success');
  }

  /* ── 预览缩放：让手机宽度（390px）的iframe等比缩放到预览容器宽度 ── */
  function updatePreviewScale() {
    const container = els.previewWrap;
    const phoneContainer = els.phonePreviewContainer;
    const iframe = els.previewFrame;
    if (!container || !phoneContainer || !iframe) return;

    const wrapWidth = container.clientWidth - 40; // 减去 padding
    const phoneWidth = 390; // 固定手机宽度

    // 计算缩放比例（只在容器宽度小于手机宽度时缩放，否则1:1显示）
    const scale = wrapWidth < phoneWidth ? wrapWidth / phoneWidth : 1;

    phoneContainer.style.transform = `scale(${scale})`;
    phoneContainer.style.transformOrigin = 'top center';

    // ★ 动态调整 iframe 高度 = 内容实际高度
    const iframeDoc = iframe.contentDocument;
    if (iframeDoc && iframeDoc.body) {
      const contentHeight = Math.max(
        iframeDoc.documentElement.scrollHeight || 0,
        iframeDoc.body.scrollHeight || 0,
        844 // 最小一个手机屏高度
      );
      iframe.style.height = contentHeight + 'px';
      phoneContainer.style.minHeight = (contentHeight * scale) + 'px';
    }
  }

  /* ── 预览渲染 ── */
  function renderPreview() {
    const doc = els.previewFrame.contentDocument || els.previewFrame.contentWindow?.document;
    if (!doc) return;
    doc.open(); doc.write(currentHtml); doc.close();
    // 延迟计算缩放（等iframe内容渲染完成）
    setTimeout(updatePreviewScale, 100);
  }

  function onFrameLoad() {
    const iframe = els.previewFrame;
    const doc = iframe.contentDocument || iframe.contentWindow?.document;
    if (!doc || !doc.body) return;

    // ★ 更新预览缩放（iframe内容加载完成后计算）
    setTimeout(updatePreviewScale, 150);

    /* 注入编辑器交互样式（含拖拽移动支持） */
    let style = doc.getElementById('html-editor-injected');
    if (!style) {
      style = doc.createElement('style');
      style.id = 'html-editor-injected';
      style.textContent = EDITOR_INJECTED_CSS;
      if (doc.head) doc.head.appendChild(style);
    }

    let selectedEl = null; /* 当前选中的元素 */

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
      /* ── 拖拽移动：mousedown ── */
      el.addEventListener('mousedown', function (e) {
        if (e.button !== 0) return; // 仅左键
        // 只有当前已选中的元素才能拖拽
        if (this !== currentEl) return;
        e.preventDefault(); e.stopPropagation();
        dragState.active = true;
        dragState.el = this;
        isDragging = true;

        // 解析当前已有的 transform，保留除 translate 外的其他变换
        const cs = getComputedStyle(this);
        const currentTransform = cs.transform;
        let baseTx = 0, baseTy = 0;
        const match = currentTransform.match(/matrix\(([^)]+)\)/);
        if (match) {
          const vals = match[1].split(/,\s*/).map(Number);
          baseTx = vals[4] || 0;
          baseTy = vals[5] || 0;
        }
        dragState.baseTx = baseTx;
        dragState.baseTy = baseTy;

        // 计算鼠标相对于元素左上角的偏移（用于平滑拖拽）
        const rect = this.getBoundingClientRect();
        dragState.offsetX = e.clientX - rect.left;
        dragState.offsetY = e.clientY - rect.top;
        dragState.startMouseX = e.clientX;
        dragState.startMouseY = e.clientY;

        // 视觉反馈
        this.classList.add('html-editor-dragging');
        showToast('🖱 拖动鼠标以移动元素', 'info');
      });

      Array.from(el.children).forEach(walk);
    }
    walk(doc.body);

    /* ── iframe 内全局 mousemove / mouseup ── */
    doc.addEventListener('mousemove', function(e) {
      if (!dragState.active || !dragState.el) return;
      e.preventDefault();

      // 使用 transform: translate() 来移动元素，不改变任何定位属性
      // 这样元素始终在文档流中，不会破坏页面布局
      const dx = e.clientX - dragState.startMouseX;
      const dy = e.clientY - dragState.startMouseY;

      const newTx = dragState.baseTx + dx;
      const newTy = dragState.baseTy + dy;

      dragState.el.style.transform = `translate(${newTx}px, ${newTy}px)`;
    });

    doc.addEventListener('mouseup', function(e) {
      if (!dragState.active) return;
      if (dragState.el) {
        dragState.el.classList.remove('html-editor-dragging');
      }
      dragState.active = false;
      isDragging = false;
      // 延迟重置，让click事件先触发完成选中状态同步
      setTimeout(() => {
        dragState.el = null;
        pushUndo('拖拽移动元素', currentHtml);
        syncFromFrame();
        addHistory('拖拽移动元素');
        showToast('✅ 元素位置已更新', 'success');
      }, 50);
    });
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
      pushUndo('编辑文本: ' + (el.textContent.trim().slice(0,20) || '[空]'), currentHtml);
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

    /* 定位相关（读取 transform: translate 的值） */
    els.propPosition.value = cs.position === 'static' ? '' : cs.position;
    const tMatch = (el.getAttribute('style') || '').match(/translate\(([-\d.]+)px\s*,?\s*([-\d.]+)px\)/);
    if (tMatch) {
      els.propTopVal.value = Math.round(parseFloat(tMatch[1]));
      els.propLeftVal.value = Math.round(parseFloat(tMatch[2]));
    } else {
      els.propTopVal.value = '';
      els.propLeftVal.value = '';
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

  /* ── 编辑器注入样式（共享，onFrameLoad 和 refreshAfterEdit 都用） ── */
  const EDITOR_INJECTED_CSS = `
    .html-editor-selected {
      outline: 2.5px solid #6366f1 !important;
      outline-offset: 2px !important;
      cursor: move !important;
      background: rgba(99,102,241,0.05) !important;
    }
    .html-editor-hover {
      outline: 1.5px dashed rgba(99,102,241,0.5) !important;
      outline-offset: 1px !important;
      cursor: text !important;
    }
    .html-editor-dragging {
      outline: 3px solid #10b981 !important;
      outline-offset: 2px !important;
      opacity: 0.85 !important;
      z-index: 99999 !important;
      cursor: grabbing !important;
      box-shadow: 0 8px 30px rgba(16,185,129,0.3) !important;
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

  /* ── 编辑后刷新（不重写 iframe，保留 currentEl 引用） ── */
  function refreshAfterEdit() {
    syncFromFrame();                 // 同步 HTML 字符串（会移除注入样式和编辑器 class）
    // 重新注入编辑器交互样式
    const doc = els.previewFrame.contentDocument;
    if (doc && doc.head) {
      let style = doc.getElementById('html-editor-injected');
      if (!style) {
        style = doc.createElement('style');
        style.id = 'html-editor-injected';
        doc.head.appendChild(style);
      }
      style.textContent = EDITOR_INJECTED_CSS;
    }
    // 重新添加 data-tag 属性（事件监听器还在，不需要重新绑定）
    if (doc && doc.body) {
      doc.querySelectorAll('*').forEach(el => {
        if (el.id !== 'html-editor-injected') {
          el.setAttribute('data-tag', el.tagName.toLowerCase());
        }
      });
    }
    // 重新应用选中样式
    if (currentEl) {
      currentEl.classList.add('html-editor-selected');
    }
    buildElementTree();              // 更新元素树
    updateCodePanel();               // 更新代码面板
  }

  function updateStyle(prop, val) {
    if (!currentEl || !val) return;
    pushUndo(`修改样式: ${prop}`, currentHtml);
    currentEl.style[prop] = val;
    refreshAfterEdit(); addHistory(`修改样式: ${prop}`);
  }

  function updateTextContent() {
    if (!currentEl) return;
    pushUndo('修改文本', currentHtml);
    currentEl.textContent = els.propTextContent.value;
    refreshAfterEdit(); addHistory('修改文本');
  }

  function updateHtmlContent() {
    if (!currentEl) return;
    pushUndo('修改 HTML 内容', currentHtml);
    currentEl.innerHTML = els.propHtmlContent.value;
    refreshAfterEdit(); addHistory('修改 HTML 内容');
  }

  function deleteCurrentElement() {
    if (!currentEl) return;
    if (!confirm('确定删除此元素？')) return;
    pushUndo('删除元素', currentHtml);
    currentEl.remove(); syncFromFrame();
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
      pushUndo('修改 HTML 源码', currentHtml);
      currentEl.innerHTML = els.modalTextarea.value;
      els.propHtmlContent.value = currentEl.innerHTML;
      refreshAfterEdit(); addHistory('修改 HTML 源码');
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
    pushUndo('格式化代码', currentHtml);
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

  /* ── 语音命令日志 ── */
  let voiceLog = [];
  function addVoiceLog(type, command, success, message) {
    const entry = {
      type: type,
      command: command,
      success: success,
      message: message,
      time: new Date().toLocaleTimeString('zh-CN', { hour:'2-digit', minute:'2-digit', second:'2-digit' }),
      timestamp: Date.now()
    };
    voiceLog.unshift(entry);
    if (voiceLog.length > 50) voiceLog.pop();
    updateVoiceLogUI();
  }

  function updateVoiceLogUI() {
    // 语音日志已合并到AI命令助手面板中，通过addCmdMessage显示
    // 保留此函数以免break现有addVoiceLog调用
  }

  function escapeHtml(str) {
    const div = document.createElement('div');
    div.textContent = str;
    return div.innerHTML;
  }

  /* ── 撤销/重做 核心系统 ── */

  /**
   * 用 DOMParser 把 currentHtml 解析为完整的 Document，
   * 提取出 body 里面的第一个子节点（即 <body> 本身），
   * 这样可以保留完整的结构信息用于快照恢复。
   */
  function parseHtmlToBody(html) {
    try {
      const parser = new DOMParser();
      const doc = parser.parseFromString(html, 'text/html');
      // 返回 body 元素的 outerHTML，这样恢复时最完整
      return { body: doc.body.outerHTML, full: html };
    } catch (e) {
      return { body: html, full: html };
    }
  }

  /**
   * 压入一个可以撤销的快照。
   * @param {string} label - 人类可读的操作描述
   * @param {string} bodyHtml - body 的 HTML（不含 head/style/script）
   */
  function pushUndo(label, bodyHtml) {
    if (isUndoing) return; // 撤销过程中不记录
    const snap = {
      label: label,
      body: bodyHtml || currentHtml,
      time: new Date().toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit', second: '2-digit' }),
      timestamp: Date.now()
    };
    undoStack.push(snap);
    redoStack = []; // 新操作清空重做栈
    if (undoStack.length > MAX_UNDO) undoStack.shift();
    updateUndoUI();
    addHistory(label);
  }

  /**
   * 撤销一步
   */
  function undo() {
    if (undoStack.length === 0) { showToast('没有可撤销的操作', 'info'); return; }
    isUndoing = true;
    const lastSnap = undoStack.pop();
    redoStack.push({
      label: lastSnap.label,
      body: currentHtml,
      time: new Date().toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit', second: '2-digit' }),
      timestamp: Date.now()
    });
    // 恢复状态
    restoreFromSnapshot(lastSnap.body);
    showToast(`↩ 已撤销: ${lastSnap.label}`, 'success');
    updateUndoUI();
    updateHistoryUI();
    setTimeout(() => { isUndoing = false; }, 50);
  }

  /**
   * 重做一步
   */
  function redo() {
    if (redoStack.length === 0) { showToast('没有可重做的操作', 'info'); return; }
    isUndoing = true;
    const snap = redoStack.pop();
    undoStack.push({
      label: snap.label,
      body: currentHtml,
      time: new Date().toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit', second: '2-digit' }),
      timestamp: Date.now()
    });
    restoreFromSnapshot(snap.body);
    showToast(`↪ 已重做: ${snap.label}`, 'success');
    updateUndoUI();
    updateHistoryUI();
    setTimeout(() => { isUndoing = false; }, 50);
  }

  /**
   * 从快照恢复当前 HTML 并重新渲染
   */
  function restoreFromSnapshot(html) {
    currentHtml = html;
    renderPreview();
    buildElementTree();
    updateCodePanel();
    // 取消选中
    currentEl = null;
    const doc = els.previewFrame.contentDocument;
    if (doc) doc.querySelectorAll('.html-editor-selected').forEach(e => e.classList.remove('html-editor-selected'));
    closePropertiesPanel();
  }

  /**
   * 更新撤销/重做按钮 UI 状态
   */
  function updateUndoUI() {
    const undoBtn = $('#btn-undo');
    const redoBtn = $('#btn-redo');

    if (undoBtn) undoBtn.disabled = undoStack.length === 0;
    if (redoBtn) redoBtn.disabled = redoStack.length === 0;
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

  /* ═══════════════════════════════════════════════════════════════
     导出 PDF — 基于 html-to-pdf-convertor-SKILL.md 规范的工作流
     步骤：
       1. 检查HTML结构规范
       2. 自动修复不满足规范的部分
       3. 传递给后端生成矢量PDF
  ═══════════════════════════════════════════════════════════════ */

  /**
   * 检查并修复HTML结构，使其符合PDF生成规范
   */
  function checkAndFixHtmlForPdf(html) {
    let fixed = html;
    const issues = [];
    const fixes = [];

    // === 检查1: 确保标准HTML结构 ===
    if (!/<!DOCTYPE\s+html/i.test(fixed)) {
      fixed = '<!DOCTYPE html>\n' + fixed;
      fixes.push('添加 <!DOCTYPE html>');
    }
    if (!/<html[\s>]/i.test(fixed)) {
      fixed = '<html lang="zh-CN">' + fixed + '</html>';
      fixes.push('添加 <html> 标签');
    }
    if (!/<head[\s>]/i.test(fixed)) {
      fixed = fixed.replace(/<html[^>]*>/i, (m) => m + '<head><meta charset="UTF-8"></head>');
      fixes.push('添加 <head> 和 charset');
    }
    if (!/<meta[^>]+charset/i.test(fixed)) {
      fixed = fixed.replace(/<head[^>]*>/i, (m) => m + '\n<meta charset="UTF-8">');
      fixes.push('添加 charset meta');
    }
    if (!/<body[\s>]/i.test(fixed)) {
      // 提取样式到head，其余放body
      const styleMatch = fixed.match(/<style[\s\S]*?<\/style>/gi);
      let bodyContent = fixed;
      if (styleMatch) {
        const styles = styleMatch.join('\n');
        bodyContent = fixed.replace(/<style[\s\S]*?<\/style>/gi, '');
        fixed = fixed.replace(/<\/head>/i, styles + '\n</head>');
      }
      fixed = fixed.replace(/(<\/head>[\s\S]*?)(<\/html>|$)/i, '$1<body>' + bodyContent + '</body>');
      fixes.push('添加 <body> 标签');
    }

    // === 检查2: @media print CSS ===
    const hasMediaPrint = /@media\s+print\s*\{/i.test(fixed);
    if (!hasMediaPrint) {
      const mediaPrintCss = `
@media print {
  @page { margin: 0; }
  body {
    background: transparent;
    -webkit-print-color-adjust: exact;
    print-color-adjust: exact;
    overflow: visible !important;
  }
  html { overflow: visible !important; }
  .slide {
    page-break-after: auto;
    page-break-inside: avoid;
    break-inside: avoid;
    width: 100% !important;
    min-height: auto !important;
    height: auto !important;
    overflow: visible !important;
    box-sizing: border-box !important;
  }
  #particle-canvas, .dots, .prog, .arrow { display: none !important; }
  .ani {
    opacity: 1 !important;
    animation: none !important;
    transform: none !important;
  }
}`;
      if (/<\/style>/i.test(fixed)) {
        // 在 </style> 标签组之后插入
        const lastStyleIndex = fixed.lastIndexOf('</style>');
        if (lastStyleIndex > -1) {
          fixed = fixed.slice(0, lastStyleIndex + 8) + '\n<style id="pdf-media-print">' + mediaPrintCss + '</style>' + fixed.slice(lastStyleIndex + 8);
        }
      } else if (/<\/head>/i.test(fixed)) {
        fixed = fixed.replace(/<\/head>/i, '<style id="pdf-media-print">' + mediaPrintCss + '</style>\n</head>');
      } else {
        fixed = '<style id="pdf-media-print">' + mediaPrintCss + '</style>\n' + fixed;
      }
      fixes.push('补入 @media print CSS');
    }

    // === 检查3: slide结构 ===
    const hasSlideClass = /class=["'][^"']*slide/i.test(fixed) || /<section[\s\S]*?class=["'].*slide/i.test(fixed);
    if (!hasSlideClass) {
      issues.push('未检测到 .slide 类，建议用 <section class="slide"> 包裹每页内容');
    }

    // === 检查4: .ani类标记 ===
    const hasAniClass = /class=["'][^"']*\bani\b/i.test(fixed);
    if (!hasAniClass) {
      issues.push('未检测到 .ani 类标记，动画元素可能不可见');
    }

    // === 检查5: 粒子canvas id ===
    const hasParticleCanvas = /id=["']particle-canvas["']/i.test(fixed);
    if (!hasParticleCanvas) {
      issues.push('未检测到 id="particle-canvas" 的canvas元素');
    }

    // === 自动包裹非结构化内容（如果内容之间没有section包装）===
    // 如果内容直接放在body里且没有.slide包裹，自动添加
    const bodyMatch = fixed.match(/<body[^>]*>([\s\S]*)<\/body>/i);
    if (bodyMatch) {
      const bodyContent = bodyMatch[1];
      const hasDirectSections = /<(section|div)[^>]*class=["'][^"']*slide/i.test(bodyContent);
      if (!hasDirectSections && !hasSlideClass) {
        // 内容没有正确包裹，自动包装为一个slide
        const trimmedContent = bodyContent.trim();
        if (trimmedContent && trimmedContent.length > 50) {
          const newBodyContent = '<section class="slide">\n' + trimmedContent + '\n</section>';
          fixed = fixed.replace(/(<body[^>]*>)([\s\S]*?)(<\/body>)/i, '$1' + newBodyContent + '$3');
          fixes.push('自动用 <section class="slide"> 包裹内容');
        }
      }
    }

    return { fixedHtml: fixed, issues, fixes };
  }

  async function downloadPdf() {
    syncFromFrame();
    if (!currentHtml || currentHtml.trim() === '') {
      showToast('没有可导出的内容', 'error');
      return;
    }

    const btn = els.btnDownloadPdf;
    const originalHTML = btn.innerHTML;
    btn.disabled = true;
    btn.innerHTML = '<span class="spinner"></span> 生成中…';

    try {
      // === Step 1-2: 检查并修复HTML结构 ===
      console.log('[PDF] 开始HTML规范检查...');
      let fullHtml = currentHtml;

      // 移除编辑器注入的交互样式（避免选中框/悬停效果出现在PDF中）
      fullHtml = fullHtml.replace(/<style id="html-editor-injected">[\s\S]*?<\/style>/gi, '');
      fullHtml = fullHtml.replace(/\s*class="html-editor-selected"/gi, '');
      fullHtml = fullHtml.replace(/\s*class="html-editor-hover"/gi, '');
      fullHtml = fullHtml.replace(/\s*class="html-editor-dragging"/gi, '');
      fullHtml = fullHtml.replace(/\s*data-tag="[^"]*"/gi, '');
      fullHtml = fullHtml.replace(/\s*contenteditable="[^"]*"/gi, '');

      // 执行规范检查与自动修复
      const { fixedHtml, issues, fixes } = checkAndFixHtmlForPdf(fullHtml);
      fullHtml = fixedHtml;

      if (fixes.length > 0) {
        console.log('[PDF] 自动修复:', fixes.join(', '));
      }
      if (issues.length > 0) {
        console.log('[PDF] 检查提示:', issues.join('; '));
      }

      // 如果进行了修复，更新编辑器的HTML
      if (fixes.length > 0) {
        currentHtml = fixedHtml;
        // 异步刷新预览（不阻塞PDF生成）
        setTimeout(() => {
          renderPreview();
          buildElementTree();
          updateCodePanel();
        }, 0);
      }

      // === Step 3-5: 后端生成PDF ===
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), 55000); // 55秒超时

      let response;
      try {
        response = await fetch('/api/html-to-pdf', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            html: fullHtml,
            filename: currentFileName
          }),
          signal: controller.signal
        });
      } catch (fetchErr) {
        clearTimeout(timeoutId);
        if (fetchErr.name === 'AbortError') {
          throw new Error('PDF 生成超时，内容可能过大');
        }
        throw new Error('无法连接 PDF 服务，请确认后端服务已启动 (node server.js)');
      }
      clearTimeout(timeoutId);

      if (!response.ok) {
        let errMsg = `HTTP ${response.status}`;
        try {
          const errData = await response.json();
          errMsg = errData.error || errMsg;
        } catch (_) {}
        throw new Error(errMsg);
      }

      const blob = await response.blob();
      if (blob.size < 100 || blob.type === 'application/json') {
        throw new Error('PDF 生成结果异常，文件过小或格式错误');
      }

      // === Step 6: 下载 ===
      const pdfName = currentFileName.replace(/\.html?$/i, '') + '.pdf';
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = pdfName;
      a.click();
      URL.revokeObjectURL(url);

      const pdfWidth = response.headers.get('X-PDF-Width') || '?';
      const pdfHeight = response.headers.get('X-PDF-Height') || '?';
      const sizeKB = response.headers.get('X-PDF-Size-KB') || '?';
      showToast(`✅ PDF 已导出: ${pdfWidth}×${pdfHeight}px, ${sizeKB}KB`, 'success');

    } catch (err) {
      console.error('PDF 导出失败:', err);
      showToast(`PDF 导出失败: ${err.message}`, 'error');
    } finally {
      btn.disabled = false;
      btn.innerHTML = originalHTML;
    }
  }

  function resetEditor() {
    if (!confirm('确定重置？未保存的修改将丢失。')) return;
    currentHtml = ''; currentEl = null;
    els.dropZone.style.display = null;
    els.fileInfo.classList.remove('show');
    editHistory = []; undoStack = []; redoStack = []; voiceLog = [];
    updateHistoryUI(); updateUndoUI(); updateVoiceLogUI();
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

  /* ═══════════════════════════════════════════════════════════════
     语音控制命令系统 (Voice Command System)
     原理: Web Speech API + 关键词正则匹配
     支持: Chrome/Safari/Edge (Firefox不支持)
  ═══════════════════════════════════════════════════════════════ */

  const VoiceEngine = (function() {
    const SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition;
    if (!SpeechRecognition) {
      console.warn('[Voice] 当前浏览器不支持 Web Speech API');
      return null;
    }

    let recognition = null;
    let isListening = false;

    // 颜色名称到hex映射
    const colorMap = {
      '红': '#ef4444', '红色': '#ef4444',
      '绿': '#22c55e', '绿色': '#22c55e',
      '蓝': '#3b82f6', '蓝色': '#3b82f6',
      '黄': '#eab308', '黄色': '#eab308',
      '紫': '#8b5cf6', '紫色': '#8b5cf6',
      '橙': '#f97316', '橙色': '#f97316',
      '粉': '#ec4899', '粉色': '#ec4899',
      '白': '#ffffff', '白色': '#ffffff',
      '黑': '#000000', '黑色': '#000000',
      '灰': '#6b7280', '灰色': '#6b7280',
      '金': '#fbbf24', '金色': '#fbbf24',
      '银': '#9ca3af', '银色': '#9ca3af',
    };

    // 方向映射
    const directionMap = {
      '下': 'down', '向下': 'down', '往下': 'down', '向下方': 'down',
      '上': 'up',   '向上': 'up',   '往上': 'up',   '向上方': 'up',
      '左': 'left', '向左': 'left', '往左': 'left',
      '右': 'right','向右': 'right','往右': 'right',
    };

    // 单位映射到px
    const unitMap = {
      '厘米': 37.8, 'cm': 37.8,
      '毫米': 3.78, 'mm': 3.78,
      '像素': 1,    'px': 1,
      '点': 1.33,   'pt': 1.33,
      '厘米': 37.8,
    };

    // 命令正则模板
    const commandPatterns = [
      // 1. 替换文字: "把[目标]改成[新文字]"（优先级低于颜色/字号等，避免误匹配）
      {
        id: 'replace',
        name: '替换文字',
        icon: 'fa-text',
        tag: 'replace',
        patterns: [
          /把(.+?)(?:改成|换成)(.+)/,
          /将(.+?)(?:改成|换成)(.+)/,
          /把(.+?)(?:改为|换为)(.+)/,
          /将(.+?)(?:改为|换为)(.+)/,
        ],
        desc: '将选中的文字替换为新的内容',
        example: '把讨论稿改成初稿',
        priority: 2,
        execute: (m) => ({ type:'replace', target:m[1].trim(), replacement:m[2].trim() })
      },
      // 1b. 简化替换：省略目标，默认替换当前选中元素（如"改成2025年"、"换成初稿"）
      {
        id: 'replace_selected',
        name: '替换选中文字',
        icon: 'fa-text',
        tag: 'replace',
        patterns: [
          /^(?:改成|换成|改为|换为)(.+)$/,
        ],
        desc: '将当前选中元素的文字替换为新内容',
        example: '改成2025年',
        priority: 1,
        execute: (m) => ({ type:'replace_selected', replacement:m[1].trim() })
      },
      // 2. 移动元素: "把[元素]往[方向]移[数值][单位]"
      {
        id: 'move',
        name: '移动元素',
        icon: 'fa-arrows-up-down-left-right',
        tag: 'move',
        priority: 7,
        patterns: [
          /把(.+?)(?:向|往)?(下|上|左|右|向下|向上|向左|向右|往下|往上|往左|往右)(?:移|挪|移动|调整)(\d+(?:\.\d+)?)(?:个|格)?(.{0,3})/,
          /将(.+?)(?:向|往)?(下|上|左|右|向下|向上|向左|向右|往下|往上|往左|往右)(?:移|挪|移动|调整)(\d+(?:\.\d+)?)(?:个|格)?(.{0,3})/,
          /(.+?)往(下|上|左|右)(?:移|挪|移动|调整)(\d+(?:\.\d+)?)(?:个)?(.{0,3})/,
        ],
        desc: '将选中的元素向指定方向移动指定距离',
        example: '把讨论稿向下移1厘米',
        execute: (m) => {
          const el = m[1].trim();
          const dirRaw = m[2].trim();
          const num = parseFloat(m[3]);
          const unitRaw = (m[4] || '厘米').trim();
          const dir = directionMap[dirRaw] || 'down';
          const unit = unitMap[unitRaw] || 37.8;
          return { type:'move', element:el, direction:dir, distance:num * unit };
        }
      },
      // 3. 改颜色（优先级高于替换，避免"把标题改成红色"被替换命令误匹配）
      {
        id: 'color',
        name: '改颜色',
        icon: 'fa-palette',
        tag: 'style',
        priority: 4,
        patterns: [
          /把(.+?)(?:的?颜色)(?:改|换|设)成(.+)/,
          /将(.+?)(?:的?颜色)(?:改|换|设)成(.+)/,
          /把(.+?)(?:改成|换成)(红|绿|蓝|黄|紫|橙|粉|白|黑|灰|金|银)色?$/,
          /把(.+?)(?:改成|换成)(.+色)$/,
          /(.+?)(?:用|使用)(.+色)/,
        ],
        desc: '将文字颜色修改为指定颜色',
        example: '把标题改成红色',
        execute: (m) => {
          const el = m[1].trim();
          const colorRaw = m[2].trim();
          const color = colorMap[colorRaw] || colorMap[colorRaw.replace('色','')] || colorRaw;
          return { type:'color', element:el, color:color };
        }
      },
      // 4. 改大小/字号（优先级高于替换）
      {
        id: 'fontsize',
        name: '改字号',
        icon: 'fa-text-height',
        tag: 'style',
        priority: 5,
        patterns: [
          /把(.+?)(?:的字号|字体大小|大小)(?:改|换|设|调整)成?(\d+)(?:号|px|像素|点|pt)?/,
          /将(.+?)(?:的字号|字体大小|大小)(?:改|换|设|调整)成?(\d+)(?:号|px|像素|点|pt)?/,
          /把(.+?)(?:改成|换成)(\d+)(?:号字|号|px|像素)/,
          /(.+?)(?:字号|字体|大小)(\d+)(?:号|px)?/,
        ],
        desc: '将元素字号调整为指定大小',
        example: '把日期改成14号字',
        execute: (m) => ({ type:'fontsize', element:m[1].trim(), size:m[2]+'px' })
      },
      // 5. 选中文本（优先级最低，仅作为兜底）
      {
        id: 'select',
        name: '选中元素',
        icon: 'fa-mouse-pointer',
        tag: 'action',
        patterns: [
          /选中(.+)/, /选择(.+)/,
        ],
        desc: '在页面中选中指定元素',
        example: '选中讨论稿',
        execute: (m) => ({ type:'select', keyword:m[1].trim() }),
        priority: -1
      },
      // 6. 撤销（最高优先级，短关键词容易被其他模式误匹配）
      {
        id: 'undo',
        name: '撤销操作',
        icon: 'fa-rotate-left',
        tag: 'action',
        priority: 10,
        patterns: [/^(撤销|回退|撤消|取消这一步|上一步)$/],
        desc: '撤销最近一次操作',
        example: '撤销',
        execute: () => ({ type:'undo' })
      },
      // 7. 改背景色（优先级高于替换和颜色）
      {
        id: 'bgcolor',
        name: '改背景色',
        icon: 'fa-fill-drip',
        tag: 'style',
        priority: 6,
        patterns: [
          /把(.+?)(?:的?背景)(?:改|换|设)成(.+)/,
          /(.+?)背景(.+色)/,
        ],
        desc: '将元素背景颜色修改为指定颜色',
        example: '把标题背景改成蓝色',
        execute: (m) => ({
          type:'bgcolor',
          element:m[1].trim(),
          color: colorMap[m[2].trim()] || colorMap[m[2].trim().replace('色','')] || m[2].trim()
        })
      },
      // 8. 设置加粗
      {
        id: 'bold',
        name: '加粗/取消加粗',
        icon: 'fa-bold',
        tag: 'style',
        priority: 5,
        patterns: [
          /把(.+?)加粗/, /(.+?)加粗/, /加粗(.+)/,
          /把(.+?)取消加粗/, /(.+?)不要加粗/, /取消(.+?)加粗/,
        ],
        desc: '切换元素加粗状态',
        example: '把标题加粗',
        execute: (m) => {
          const text = m[0];
          const isCancel = /取消|不要|去掉/.test(text);
          return { type:'bold', element:m[1].trim(), bold:!isCancel };
        }
      },
    ];

    // 初始化语音识别器
    function init() {
      recognition = new SpeechRecognition();
      recognition.lang = 'zh-CN';
      recognition.continuous = false;   // 单次识别
      recognition.interimResults = true; // 实时中间结果
      recognition.maxAlternatives = 5;

      recognition.onstart = () => {
        isListening = true;
        updateVoiceUI(true);
      };

      recognition.onend = () => {
        isListening = false;
        updateVoiceUI(false);
      };

      recognition.onresult = (e) => {
        const last = e.results[e.results.length - 1];
        const transcript = last[0].transcript.trim();
        if (last.isFinal) {
          processCommand(transcript, 'voice');
        } else {
          updateVoiceStatus('聆听中: ' + transcript + '...');
        }
      };

      recognition.onerror = (e) => {
        console.error('[Voice] 识别错误:', e.error);
        const msg = {
          'no-speech': '未检测到语音，请靠近麦克风重试',
          'audio-capture': '无法捕获音频，请检查麦克风',
          'not-allowed': '麦克风权限被拒绝，请在浏览器设置中允许',
          'network': '网络错误，语音识别需要联网',
        }[e.error] || '语音识别出错: ' + e.error;
        showToast(msg, 'error');
        stop();
      };
    }

    // 解析并执行命令
    function processCommand(text, source) {
      console.log('[Voice] 识别到:', text);
      updateVoiceStatus('识别: ' + text, 3000);

      // 按优先级排序尝试匹配
      const sorted = [...commandPatterns].sort((a,b) => (b.priority||0)-(a.priority||0));
      for (const cmd of sorted) {
        for (const pattern of cmd.patterns) {
          const m = text.match(pattern);
          if (m) {
            try {
              const parsed = cmd.execute(m);
              if (parsed) {
                parsed.rawText = text;   // 保留原始文本
                showToast('💬 "' + text + '"', 'info');
                addVoiceLog('recognize', text, true, '指令已识别: ' + (cmd.name || cmd.id || ''));
                // 同步到命令助手聊天面板（区分语音和文字来源）
                if (source === 'voice') {
                  addCmdMessage('user', '🎤 ' + text);
                } else if (source === 'text') {
                  addCmdMessage('user', '⌨️ ' + text);
                }
                VoiceExecutor.execute(parsed);
                return;
              }
            } catch(err) {
              console.error('[Voice] 解析命令失败:', err);
            }
          }
        }
      }
      showToast('❓ 未识别的指令: "' + text + '"，请使用规定格式', 'error');
      addVoiceLog('unknown', text, false, '未识别的指令，请使用规定格式');
      addCmdMessage('error', '❓ 未识别的指令: "' + text + '"', text);
    }

    function start() {
      if (!recognition) init();
      try {
        recognition.start();
      } catch(e) {
        // 可能已经开启
        console.warn('[Voice] start() 错误:', e.message);
      }
    }
    function stop() {
      if (recognition) {
        try { recognition.stop(); } catch(e) {}
      }
      isListening = false;
      updateVoiceUI(false);
    }
    function toggle() {
      if (isListening) { stop(); }
      else { start(); }
      return isListening;
    }

    // 更新语音按钮UI
    function updateVoiceUI(active) {
      const btn = document.getElementById('btn-ai-assistant');
      if (!btn) return;
      if (active) {
        btn.classList.add('active');
        btn.innerHTML = '<i class="fas fa-microphone-lines"></i> 聆听中...';
      } else {
        btn.classList.remove('active');
        btn.innerHTML = '<i class="fas fa-wand-magic-sparkles"></i> 助手';
      }
      // 同步更新面板内的语音按钮状态
      const panelVoiceBtn = els.cmdVoiceBtn;
      if (panelVoiceBtn) {
        panelVoiceBtn.classList.toggle('recording', active);
        panelVoiceBtn.style.color = active ? '#ef4444' : '';
        panelVoiceBtn.style.borderColor = active ? 'rgba(239,68,68,0.4)' : '';
      }
      // 更新面板内的语音状态条
      const statusBar = els.voiceStatusBar;
      if (statusBar) {
        // 如果语音停止但有自动隐藏计时器正在倒计时（如"识别: xxx"提示），
        // 不要立即隐藏，让计时器自然处理，否则用户看不到识别结果
        if (!active && _voiceStatusTimer) {
          // 保持显示，等计时器自动隐藏
        } else {
          statusBar.style.display = active ? 'flex' : 'none';
        }
      }
    }

    // 更新语音状态文本
    let _voiceStatusTimer = null;
    function updateVoiceStatus(text, autoHideDelay) {
      const el = els.voiceStatusText;
      if (el) el.textContent = text;
      const bar = els.voiceStatusBar;
      if (bar) bar.style.display = 'flex';
      // 清除之前的定时器
      if (_voiceStatusTimer) { clearTimeout(_voiceStatusTimer); _voiceStatusTimer = null; }
      // 如果指定了自动隐藏延迟（毫秒），到时自动隐藏状态条
      if (typeof autoHideDelay === 'number' && autoHideDelay > 0) {
        _voiceStatusTimer = setTimeout(() => {
          if (bar) bar.style.display = 'none';
          _voiceStatusTimer = null;
          // 同步：如果语音已停止但按钮状态还残留，也一并清理
          if (!isListening) {
            const btn = document.getElementById('btn-ai-assistant');
            if (btn && btn.classList.contains('active')) {
              btn.classList.remove('active');
              btn.innerHTML = '<i class="fas fa-wand-magic-sparkles"></i> 助手';
            }
          }
        }, autoHideDelay);
      }
    }

return { start, stop, toggle, isListening: () => isListening, colorMap, init, processCommand };
  })();

  /* ═══════════════════════════════════════════════════════════════
     语音命令执行器 (Voice Executor)
     将解析后的命令映射为实际DOM操作
  ═══════════════════════════════════════════════════════════════ */

  const VoiceExecutor = {
    execute: function(cmd) {
      const doc = els.previewFrame.contentDocument;
      if (!doc) { showToast('请先加载HTML文件', 'error'); return; }

      switch(cmd.type) {
        case 'replace': this.doReplace(cmd); break;
        case 'replace_selected': this.doReplaceSelected(cmd); break;
        case 'move':    this.doMove(cmd); break;
        case 'color':   this.doColor(cmd); break;
        case 'bgcolor': this.doBgColor(cmd); break;
        case 'fontsize':this.doFontSize(cmd); break;
        case 'bold':    this.doBold(cmd); break;
        case 'select':  this.doSelect(cmd); break;
        case 'undo':    undo(); break;
        default: showToast('未实现的命令类型: ' + cmd.type, 'error');
      }
    },

    // 在iframe中搜索包含指定文本的元素（增强版）
    findElement: function(keyword, doc) {
      if (!doc) doc = els.previewFrame.contentDocument;
      if (!doc || !doc.body) return null;

      const all = doc.querySelectorAll('body *');
      // 过滤掉编辑器注入的元素
      const visible = Array.from(all).filter(el =>
        el.id !== 'html-editor-injected'
      );

      // 策略0: 优先搜索当前选中的元素（精确匹配）
      if (currentEl && currentEl.textContent.trim() === keyword.trim()) return currentEl;

      // 策略1: 精确文本匹配（叶子节点优先）
      for (const el of visible) {
        if (el.children.length === 0 && el.textContent.trim() === keyword.trim()) return el;
      }

      // 策略2: 去除标点/空格后精确匹配
      const normalize = s => s.replace(/[\s\u3000，。、；：！？·\-\(\)（）]/g, '');
      const kwNorm = normalize(keyword);
      for (const el of visible) {
        if (el.children.length === 0 && normalize(el.textContent) === kwNorm) return el;
      }

      // 策略3: 包含文本匹配（最短匹配优先——最精确的元素）
      let bestMatch = null;
      let bestLen = Infinity;
      for (const el of visible) {
        const text = el.textContent;
        if (text.includes(keyword) && text.length < bestLen) {
          bestMatch = el;
          bestLen = text.length;
        }
      }
      if (bestMatch) return bestMatch;

      // 策略4: 模糊匹配（去掉空格后）
      for (const el of visible) {
        if (normalize(el.textContent).includes(kwNorm)) return el;
      }

      // 策略5: 部分关键词匹配（支持"六月九号"匹配"6月9日"等中文数字）
      const chineseNumMap = {'零':'0','一':'1','二':'2','三':'3','四':'4','五':'5','六':'6','七':'7','八':'8','九':'9','十':'10','号':'日','月':'月','年':'年'};
      const toArabic = s => s.replace(/[零一二三四五六七八十号]/g, c => chineseNumMap[c] || c);
      const kwArabic = toArabic(keyword);
      if (kwArabic !== keyword) {
        for (const el of visible) {
          const elArabic = toArabic(el.textContent);
          if (elArabic.includes(kwArabic) || kwArabic.includes(elArabic)) return el;
        }
      }

      return null;
    },

    doReplace: function(cmd) {
      const el = this.findElement(cmd.target);
      if (!el) {
        showToast('未找到 "' + cmd.target + '"', 'error');
        addVoiceLog('replace', cmd.target + ' → ' + cmd.replacement, false, '未找到 "' + cmd.target + '"');
        addCmdMessage('error', '未找到 "' + cmd.target + '"，请先选中或确认文字存在', cmd.rawText);
        return;
      }
      pushUndo('语音替换: ' + cmd.target + ' → ' + cmd.replacement, currentHtml);
      selectElement(el);
      el.textContent = cmd.replacement;
      refreshAfterEdit();
      syncPropertiesPanel();
      addHistory('语音替换: ' + cmd.target + ' → ' + cmd.replacement);
      showToast('✅ 已将 "' + cmd.target + '" 改成 "' + cmd.replacement + '"', 'success');
      addVoiceLog('replace', cmd.target + ' → ' + cmd.replacement, true, '已将 "' + cmd.target + '" 改成 "' + cmd.replacement + '"');
      addCmdMessage('system', '✅ 已将 "' + cmd.target + '" 改成 "' + cmd.replacement + '"');
    },

    doReplaceSelected: function(cmd) {
      if (!currentEl) {
        showToast('请先选中要修改的元素', 'error');
        addCmdMessage('error', '请先在预览区点击选中要修改的元素，然后再说"改成XXX"', cmd.rawText);
        return;
      }
      const oldText = currentEl.textContent.trim();
      pushUndo('语音替换: ' + oldText + ' → ' + cmd.replacement, currentHtml);
      currentEl.textContent = cmd.replacement;
      refreshAfterEdit();
      syncPropertiesPanel();
      addHistory('语音替换: ' + oldText + ' → ' + cmd.replacement);
      showToast('✅ 已将 "' + oldText + '" 改成 "' + cmd.replacement + '"', 'success');
      addVoiceLog('replace', oldText + ' → ' + cmd.replacement, true, '已将 "' + oldText + '" 改成 "' + cmd.replacement + '"');
      addCmdMessage('system', '✅ 已将 "' + oldText + '" 改成 "' + cmd.replacement + '"');
    },

    doMove: function(cmd) {
      const el = currentEl || this.findElement(cmd.element);
      if (!el) {
        showToast('请先选中元素或说出"选中'+cmd.element+'"', 'error');
        addVoiceLog('move', cmd.element, false, '请先选中元素或说出"选中'+cmd.element+'"');
        addCmdMessage('error', '未找到 "' + cmd.element + '"，请先选中该元素', cmd.rawText);
        return;
      }
      pushUndo('语音移动: ' + cmd.direction + ' ' + cmd.distance + 'px', currentHtml);
      if (el !== currentEl) selectElement(el);
      const [tx, ty] = this._getTranslate(el);
      let nx = tx, ny = ty;
      const d = cmd.distance;
      switch(cmd.direction) {
        case 'down':  ny += d; break;
        case 'up':    ny -= d; break;
        case 'left':  nx -= d; break;
        case 'right': nx += d; break;
      }
      this._setTranslate(el, nx, ny);
      // 使用统一的刷新函数
      refreshAfterEdit();
      // 同步属性面板位置值
      if (els.propTopVal) els.propTopVal.value = Math.round(nx);
      if (els.propLeftVal) els.propLeftVal.value = Math.round(ny);
      const dirText = {down:'向下',up:'向上',left:'向左',right:'向右'}[cmd.direction];
      addHistory('语音移动: ' + dirText + ' ' + Math.round(cmd.distance) + 'px');
      showToast('✅ 已' + dirText + '移动 ' + Math.round(cmd.distance) + 'px', 'success');
      addVoiceLog('move', dirText + ' ' + Math.round(cmd.distance) + 'px', true, '已' + dirText + '移动 ' + Math.round(cmd.distance) + 'px');
      addCmdMessage('system', '✅ 已' + dirText + '移动 ' + Math.round(cmd.distance) + 'px');
    },

    doColor: function(cmd) {
      const el = currentEl || this.findElement(cmd.element);
      if (!el) {
        showToast('未找到 "' + cmd.element + '"', 'error');
        addVoiceLog('color', cmd.element + ' → ' + cmd.color, false, '未找到 "' + cmd.element + '"');
        addCmdMessage('error', '未找到 "' + cmd.element + '"，请先选中该元素', cmd.rawText);
        return;
      }
      pushUndo('语音改颜色: ' + cmd.color, currentHtml);
      if (el !== currentEl) selectElement(el);
      updateStyle('color', cmd.color);
      showToast('✅ 颜色已改为 ' + cmd.color, 'success');
      addVoiceLog('color', cmd.element + ' → ' + cmd.color, true, '颜色已改为 ' + cmd.color);
      addCmdMessage('system', '✅ 颜色已改为 ' + cmd.color);
    },

    doBgColor: function(cmd) {
      const el = currentEl || this.findElement(cmd.element);
      if (!el) {
        showToast('未找到 "' + cmd.element + '"', 'error');
        addVoiceLog('bgcolor', cmd.element + ' → ' + cmd.color, false, '未找到 "' + cmd.element + '"');
        addCmdMessage('error', '未找到 "' + cmd.element + '"，请先选中该元素', cmd.rawText);
        return;
      }
      pushUndo('语音改背景色: ' + cmd.color, currentHtml);
      if (el !== currentEl) selectElement(el);
      updateStyle('backgroundColor', cmd.color);
      showToast('✅ 背景色已改为 ' + cmd.color, 'success');
      addVoiceLog('bgcolor', cmd.element + ' → ' + cmd.color, true, '背景色已改为 ' + cmd.color);
      addCmdMessage('system', '✅ 背景色已改为 ' + cmd.color);
    },

    doFontSize: function(cmd) {
      const el = currentEl || this.findElement(cmd.element);
      if (!el) {
        showToast('未找到 "' + cmd.element + '"', 'error');
        addVoiceLog('fontsize', cmd.element + ' → ' + cmd.size, false, '未找到 "' + cmd.element + '"');
        addCmdMessage('error', '未找到 "' + cmd.element + '"，请先选中该元素', cmd.rawText);
        return;
      }
      pushUndo('语音改字号: ' + cmd.size, currentHtml);
      if (el !== currentEl) selectElement(el);
      updateStyle('fontSize', cmd.size);
      showToast('✅ 字号已改为 ' + cmd.size, 'success');
      addVoiceLog('fontsize', cmd.element + ' → ' + cmd.size, true, '字号已改为 ' + cmd.size);
      addCmdMessage('system', '✅ 字号已改为 ' + cmd.size);
    },

    doBold: function(cmd) {
      const el = currentEl || this.findElement(cmd.element);
      if (!el) {
        showToast('未找到 "' + cmd.element + '"', 'error');
        addVoiceLog('bold', cmd.element, false, '未找到 "' + cmd.element + '"');
        addCmdMessage('error', '未找到 "' + cmd.element + '"，请先选中该元素', cmd.rawText);
        return;
      }
      pushUndo(cmd.bold ? '语音加粗' : '语音取消加粗', currentHtml);
      if (el !== currentEl) selectElement(el);
      updateStyle('fontWeight', cmd.bold ? '700' : '400');
      showToast('✅ ' + (cmd.bold ? '加粗' : '取消加粗'), 'success');
      addVoiceLog('bold', cmd.element + (cmd.bold ? ' 加粗' : ' 取消加粗'), true, cmd.bold ? '加粗' : '取消加粗');
      addCmdMessage('system', '✅ ' + (cmd.bold ? '加粗' : '取消加粗'));
    },

    doSelect: function(cmd) {
      const el = this.findElement(cmd.keyword);
      if (!el) {
        showToast('未找到包含 "' + cmd.keyword + '" 的元素', 'error');
        addVoiceLog('select', cmd.keyword, false, '未找到包含 "' + cmd.keyword + '" 的元素');
        addCmdMessage('error', '未找到包含 "' + cmd.keyword + '" 的元素', cmd.rawText);
        return;
      }
      selectElement(el);
      showToast('✅ 已选中 "' + cmd.keyword + '"', 'success');
      addVoiceLog('select', cmd.keyword, true, '已选中 "' + cmd.keyword + '"');
      addCmdMessage('system', '✅ 已选中 "' + cmd.keyword + '"');
      el.scrollIntoView({ behavior:'smooth', block:'center' });
    },

    _getTranslate: function(el) {
      const t = el.style.transform;
      const m = t.match(/translate\(([-\d.]+)px\s*,?\s*([-\d.]+)px\)/);
      return m ? [parseFloat(m[1]), parseFloat(m[2])] : [0, 0];
    },
    _setTranslate: function(el, x, y) {
      if (x === 0 && y === 0) el.style.transform = '';
      else el.style.transform = 'translate(' + x + 'px, ' + y + 'px)';
    }
  };

  /* ═══════════════════════════════════════════════════════════════
     语音帮助面板渲染
  ═══════════════════════════════════════════════════════════════ */

  function renderVoiceHelp() {
    const container = document.getElementById('voice-command-list');
    if (!container) return;
    const cmds = [
      {icon:'fa-text', title:'替换文字', desc:'将选中元素的文字内容替换为新内容', example:'把讨论稿改成初稿', tag:'replace'},
      {icon:'fa-arrows-up-down-left-right', title:'移动元素', desc:'将元素向指定方向移动指定距离', example:'把讨论稿向下移1厘米', tag:'move'},
      {icon:'fa-palette', title:'改颜色', desc:'修改元素文字颜色为指定颜色', example:'把标题改成红色', tag:'style'},
      {icon:'fa-fill-drip', title:'改背景色', desc:'修改元素背景色为指定颜色', example:'把标题背景改成蓝色', tag:'style'},
      {icon:'fa-text-height', title:'改字号', desc:'将元素字号调整为指定大小', example:'把日期改成14号字', tag:'style'},
      {icon:'fa-bold', title:'加粗', desc:'切换元素加粗状态', example:'把标题加粗', tag:'style'},
      {icon:'fa-mouse-pointer', title:'选中元素', desc:'通过文字内容查找并选中元素', example:'选中讨论稿', tag:'action'},
      {icon:'fa-rotate-left', title:'撤销', desc:'撤销上一步操作', example:'撤销', tag:'action'},
    ];
    container.innerHTML = cmds.map(c => `
      <div class="voice-cmd-card">
        <div class="voice-cmd-icon" style="background:rgba(99,102,241,.1);color:var(--accent-hover);">
          <i class="fas ${c.icon}"></i>
        </div>
        <div class="voice-cmd-text">
          <div class="cmd-title">${c.title} <span class="voice-cmd-tag ${c.tag}">${c.tag}</span></div>
          <div class="cmd-desc">${c.desc}</div>
          <span class="voice-cmd-example">💬 "${c.example}"</span>
        </div>
      </div>
    `).join('');
  }

  /* ═══════════════════════════════════════════════════════════════
     绑定语音相关事件
  ═══════════════════════════════════════════════════════════════ */

  function bindVoiceEvents() {
    const btnVoice = document.getElementById('btn-ai-assistant');
    const btnCloseHelp = document.getElementById('btn-close-voice-help');
    const btnHelpClose = document.getElementById('btn-voice-help-close');
    const modalHelp = document.getElementById('voice-help-modal');

    if (btnVoice) {
      // 长按显示帮助
      let pressTimer = null;
      btnVoice.addEventListener('mousedown', () => {
        pressTimer = setTimeout(() => {
          renderVoiceHelp();
          document.getElementById('overlay').classList.add('show');
          modalHelp.classList.add('show');
        }, 800);
      });
      btnVoice.addEventListener('mouseup', () => clearTimeout(pressTimer));
      btnVoice.addEventListener('mouseleave', () => clearTimeout(pressTimer));
      // 点击切换语音
      btnVoice.addEventListener('click', (e) => {
        // 如果是长按触发的则不执行click
        if (pressTimer) clearTimeout(pressTimer);
        if (!VoiceEngine) {
          showToast('当前浏览器不支持语音识别，请使用 Chrome/Safari/Edge', 'error');
          return;
        }
        // 如果面板未显示，先显示并展开面板
        const panel = els.aiAssistantPanel;
        if (panel) {
          panel.classList.add('show');
          panel.classList.remove('collapsed');
          cmdAssistantOpen = true;
          if (els.aiAssistantArrow) els.aiAssistantArrow.className = 'fas fa-chevron-down';
          // 收起右侧属性面板避免遮挡
          const rightSidebar = document.getElementById('sidebar-right');
          if (rightSidebar) rightSidebar.style.display = 'none';
        }
        VoiceEngine.toggle();
      });
    }

    // 键盘快捷键 Ctrl+Shift+V
    document.addEventListener('keydown', (e) => {
      if (e.ctrlKey && e.shiftKey && (e.key === 'V' || e.key === 'v')) {
        e.preventDefault();
        if (VoiceEngine) VoiceEngine.toggle();
        else showToast('当前浏览器不支持语音识别', 'error');
      }
      // ESC 停止录音
      if (e.key === 'Escape' && VoiceEngine && VoiceEngine.isListening()) {
        VoiceEngine.stop();
        showToast('语音输入已停止', 'info');
      }
    });

    // 帮助面板关闭
    [btnCloseHelp, btnHelpClose].forEach(btn => {
      if (btn) btn.addEventListener('click', () => {
        document.getElementById('overlay').classList.remove('show');
        modalHelp.classList.remove('show');
      });
    });

    // 点击遮罩关闭帮助
    const overlay = document.getElementById('overlay');
    overlay.addEventListener('click', () => {
      modalHelp.classList.remove('show');
      // 只有没有html-modal的时候才移除overlay
      if (!document.getElementById('html-modal').classList.contains('show')) {
        overlay.classList.remove('show');
      }
    });

  }

  /* ═══════════════════════════════════════════════════════════════
     命令助手聊天面板 (Command Assistant Chat Panel)
     功能：文字命令输入、语音命令记录、执行反馈、历史重试
  ═══════════════════════════════════════════════════════════════ */

  let cmdAssistantOpen = true;
  let cmdMessageCount = 0;
  let cmdUnreadCount = 0;

  function initCmdAssistant() {
    const panel = els.aiAssistantPanel;
    const header = els.aiAssistantHeader;
    const toggleBtn = els.aiAssistantToggle;
    const arrow = els.aiAssistantArrow;
    const body = els.aiAssistantBody;
    const textInput = els.cmdTextInput;
    const sendBtn = els.cmdSendBtn;
    const voiceBtn = els.cmdVoiceBtn;
    const clearBtn = els.cmdClearHistory;
    const messages = els.aiAssistantMessages;
    const closeBtn = els.aiAssistantClose;

    // 默认显示并展开
    if (panel) {
      panel.classList.add('show');
      panel.classList.remove('collapsed');
      // 面板默认显示时收起右侧属性面板避免遮挡
      const rightSidebar = document.getElementById('sidebar-right');
      if (rightSidebar) rightSidebar.style.display = 'none';
    }
    cmdAssistantOpen = true;
    if (els.aiAssistantArrow) els.aiAssistantArrow.className = 'fas fa-chevron-down';

    // 展开/收起
    function togglePanel() {
      cmdAssistantOpen = !cmdAssistantOpen;
      panel.classList.toggle('collapsed', !cmdAssistantOpen);
      if (arrow) arrow.className = cmdAssistantOpen ? 'fas fa-chevron-down' : 'fas fa-chevron-up';
      if (cmdAssistantOpen) {
        cmdUnreadCount = 0;
        updateBadge();
      }
    }

    if (header) header.addEventListener('click', (e) => {
      // 不响应按钮点击
      if (e.target.closest('.btn-icon')) return;
      if (!cmdAssistantOpen) togglePanel();
    });
    if (toggleBtn) toggleBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      togglePanel();
    });

    // 关闭按钮 - 隐藏面板（可通过header按钮重新打开）
    if (closeBtn) closeBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      if (panel) panel.classList.remove('show');
      // 恢复右侧属性面板
      const rightSidebar = document.getElementById('sidebar-right');
      if (rightSidebar) rightSidebar.style.display = '';
    });

    // 文字命令输入
    function executeTextCommand() {
      const text = textInput.value.trim();
      if (!text) return;
      textInput.value = '';
      // 显示用户消息
      addCmdMessage('user', text);
      // 延迟执行命令
      setTimeout(() => {
        if (VoiceEngine) {
          VoiceEngine.processCommand ? VoiceEngine.processCommand(text) : processCommandPublic(text);
        } else {
          processCommandPublic(text);
        }
      }, 100);
    }

    if (sendBtn) sendBtn.addEventListener('click', executeTextCommand);
    if (textInput) {
      textInput.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' && !e.shiftKey) {
          e.preventDefault();
          executeTextCommand();
        }
      });
    }

    // 语音按钮（面板内的）
    if (voiceBtn) {
      voiceBtn.addEventListener('click', () => {
        if (VoiceEngine) {
          VoiceEngine.toggle();
          voiceBtn.classList.toggle('recording', VoiceEngine.isListening());
        } else {
          showToast('当前浏览器不支持语音识别', 'error');
        }
      });
    }

    // 清空历史
    if (clearBtn) clearBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      const messagesEl = els.aiAssistantMessages;
      if (messagesEl) {
        messagesEl.innerHTML = '<div class="cmd-welcome">' +
          '<div style="text-align:center; padding:20px 0;">' +
            '<div style="width:48px;height:48px;border-radius:50%;background:rgba(99,102,241,0.1);display:flex;align-items:center;justify-content:center;margin:0 auto 12px;color:var(--accent);font-size:20px;">' +
              '<i class="fas fa-wand-magic-sparkles"></i>' +
            '</div>' +
            '<div style="font-size:13px;font-weight:600;color:var(--text);margin-bottom:6px;">👋 你好！我是命令助手</div>' +
            '<div style="font-size:11px;color:var(--text-muted);line-height:1.6;margin-bottom:16px;">你可以通过语音或文字下达编辑指令<br/>所有操作记录都会显示在这里</div>' +
            '<div style="display:flex; flex-wrap:wrap; gap:6px; justify-content:center;">' +
              '<div class="cmd-example-chip" data-cmd="把第6稿改成第7稿"><i class="fas fa-text" style="font-size:9px;"></i> 替换文字</div>' +
              '<div class="cmd-example-chip" data-cmd="改成2025年"><i class="fas fa-pen" style="font-size:9px;"></i> 改选中文字</div>' +
              '<div class="cmd-example-chip" data-cmd="把标题改成红色"><i class="fas fa-palette" style="font-size:9px;"></i> 改颜色</div>' +
              '<div class="cmd-example-chip" data-cmd="把标题加粗"><i class="fas fa-bold" style="font-size:9px;"></i> 加粗</div>' +
              '<div class="cmd-example-chip" data-cmd="撤销"><i class="fas fa-rotate-left" style="font-size:9px;"></i> 撤销</div>' +
            '</div>' +
          '</div>' +
        '</div>';
        bindExampleChips();
      }
      cmdMessageCount = 0;
      cmdUnreadCount = 0;
      updateBadge();
      showToast('命令记录已清空', 'info');
    });

    // 绑定示例芯片点击
    bindExampleChips();
  }

  function bindExampleChips() {
    document.querySelectorAll('.cmd-example-chip').forEach(chip => {
      chip.addEventListener('click', () => {
        const cmd = chip.dataset.cmd;
        if (cmd) {
          if (els.cmdTextInput) els.cmdTextInput.value = cmd;
          // 直接执行
          addCmdMessage('user', cmd);
          setTimeout(() => processCommandPublic(cmd), 100);
        }
      });
    });
  }

  function updateBadge() {
    const badge = document.getElementById('ai-assistant-badge');
    if (badge) {
      if (cmdUnreadCount > 0) {
        badge.style.display = 'flex';
        badge.textContent = cmdUnreadCount;
      } else {
        badge.style.display = 'none';
      }
    }
  }

  /**
   * 向命令助手聊天面板添加一条消息
   * @param {'user'|'system'|'error'} role - 消息角色
   * @param {string} text - 消息内容
   * @param {string} [retryCmd] - 可选：重试命令文本
   */
  function addCmdMessage(role, text, retryCmd) {
    const container = els.aiAssistantMessages;
    if (!container) return;

    // 移除欢迎消息（如果有）
    const welcome = container.querySelector('.cmd-welcome');
    if (welcome) welcome.remove();

    cmdMessageCount++;
    if (!cmdAssistantOpen && role !== 'user') {
      cmdUnreadCount++;
      updateBadge();
    }

    const iconMap = {
      user: 'fa-user',
      system: 'fa-check',
      error: 'fa-xmark'
    };

    const msg = document.createElement('div');
    msg.className = 'cmd-msg ' + role;
    const time = new Date().toLocaleTimeString('zh-CN', { hour:'2-digit', minute:'2-digit', second:'2-digit' });

    let retryHtml = '';
    if (retryCmd) {
      retryHtml = '<div class="cmd-msg-retry" data-retry-cmd="' + escapeHtml(retryCmd) + '"><i class="fas fa-rotate-right"></i> 重试</div>';
    }

    msg.innerHTML =
      '<div class="cmd-msg-avatar"><i class="fas ' + iconMap[role] + '"></i></div>' +
      '<div>' +
        '<div class="cmd-msg-bubble">' + escapeHtml(text) + '</div>' +
        retryHtml +
        '<div class="cmd-msg-time">' + time + '</div>' +
      '</div>';

    container.appendChild(msg);

    // 绑定重试按钮
    const retryBtn = msg.querySelector('.cmd-msg-retry');
    if (retryBtn) {
      retryBtn.addEventListener('click', () => {
        const cmd = retryBtn.dataset.retryCmd;
        if (cmd) {
          addCmdMessage('user', cmd);
          setTimeout(() => processCommandPublic(cmd), 100);
        }
      });
    }

    // 自动滚动到底部
    container.scrollTop = container.scrollHeight;
  }

  /**
   * 公开的命令处理入口（供文字输入和重试调用）
   */
  function processCommandPublic(text) {
    if (!text || !text.trim()) return;
    // 优先使用 VoiceEngine 内部的 processCommand
    if (VoiceEngine && VoiceEngine.processCommand) {
      VoiceEngine.processCommand(text, 'text');
      return;
    }
    // 降级：使用本地 commandPatterns
    const sorted = [...commandPatterns].sort((a,b) => (b.priority||0)-(a.priority||0));
    for (const cmd of sorted) {
      for (const pattern of cmd.patterns) {
        const m = text.match(pattern);
        if (m) {
          try {
            const parsed = cmd.execute(m);
            if (parsed) {
              parsed.rawText = text;
              addVoiceLog('recognize', text, true, '指令已识别: ' + (cmd.name || cmd.id || ''));
              VoiceExecutor.execute(parsed);
              return;
            }
          } catch(err) {
            console.error('[CmdAssistant] 解析命令失败:', err);
          }
        }
      }
    }
    showToast('❓ 未识别的指令: "' + text + '"', 'error');
    addVoiceLog('unknown', text, false, '未识别的指令');
    addCmdMessage('error', '未识别的指令: "' + text + '"\n支持格式：把XX改成YY / 把XX改成红色 / 撤销 等', text);
  }

  // 暴露 commandPatterns 给 processCommandPublic 使用
  // （它们在 VoiceEngine IIFE 内部，需要重新声明引用）
  const commandPatterns = [
    // 1. 替换文字
    {
      id: 'replace', name: '替换文字', priority: 2,
      patterns: [/把(.+?)(?:改成|换成)(.+)/, /将(.+?)(?:改成|换成)(.+)/, /把(.+?)(?:改为|换为)(.+)/, /将(.+?)(?:改为|换为)(.+)/],
      execute: (m) => ({ type:'replace', target:m[1].trim(), replacement:m[2].trim() })
    },
    // 1b. 简化替换：省略目标，默认替换当前选中元素
    {
      id: 'replace_selected', name: '替换选中文字', priority: 1,
      patterns: [/^(?:改成|换成|改为|换为)(.+)$/],
      execute: (m) => ({ type:'replace_selected', replacement:m[1].trim() })
    },
    // 2. 移动元素
    {
      id: 'move', name: '移动元素', priority: 7,
      patterns: [
        /把(.+?)(?:向|往)?(下|上|左|右|向下|向上|向左|向右|往下|往上|往左|往右)(?:移|挪|移动|调整)(\d+(?:\.\d+)?)(?:个|格)?(.{0,3})/,
        /将(.+?)(?:向|往)?(下|上|左|右|向下|向上|向左|向右|往下|往上|往左|往右)(?:移|挪|移动|调整)(\d+(?:\.\d+)?)(?:个|格)?(.{0,3})/,
      ],
      execute: (m) => {
        const dirMap = {'下':'down','上':'up','左':'left','右':'right','向下':'down','向上':'up','向左':'left','向右':'right','往下':'down','往上':'up','往左':'left','往右':'right'};
        const unitMap = {'厘米':37.8,'cm':37.8,'毫米':3.78,'mm':3.78,'像素':1,'px':1,'点':1.33,'pt':1.33};
        const el = m[1].trim();
        const dir = dirMap[m[2].trim()] || 'down';
        const num = parseFloat(m[3]);
        const unit = unitMap[(m[4]||'厘米').trim()] || 37.8;
        return { type:'move', element:el, direction:dir, distance:num * unit };
      }
    },
    // 3. 改颜色
    {
      id: 'color', name: '改颜色', priority: 4,
      patterns: [
        /把(.+?)(?:的?颜色)(?:改|换|设)成(.+)/,
        /将(.+?)(?:的?颜色)(?:改|换|设)成(.+)/,
        /把(.+?)(?:改成|换成)(红|绿|蓝|黄|紫|橙|粉|白|黑|灰|金|银)色?$/,
        /把(.+?)(?:改成|换成)(.+色)$/,
      ],
      execute: (m) => {
        const colorMap = {'红':'#ef4444','红色':'#ef4444','绿':'#22c55e','绿色':'#22c55e','蓝':'#3b82f6','蓝色':'#3b82f6','黄':'#eab308','黄色':'#eab308','紫':'#8b5cf6','紫色':'#8b5cf6','橙':'#f97316','橙色':'#f97316','粉':'#ec4899','粉色':'#ec4899','白':'#ffffff','白色':'#ffffff','黑':'#000000','黑色':'#000000','灰':'#6b7280','灰色':'#6b7280','金':'#fbbf24','金色':'#fbbf24','银':'#9ca3af','银色':'#9ca3af'};
        const el = m[1].trim();
        const colorRaw = m[2].trim();
        const color = colorMap[colorRaw] || colorMap[colorRaw.replace('色','')] || colorRaw;
        return { type:'color', element:el, color:color };
      }
    },
    // 4. 改字号
    {
      id: 'fontsize', name: '改字号', priority: 5,
      patterns: [
        /把(.+?)(?:的字号|字体大小|大小)(?:改|换|设|调整)成?(\d+)(?:号|px|像素|点|pt)?/,
        /将(.+?)(?:的字号|字体大小|大小)(?:改|换|设|调整)成?(\d+)(?:号|px|像素|点|pt)?/,
        /把(.+?)(?:改成|换成)(\d+)(?:号字|号|px|像素)/,
      ],
      execute: (m) => ({ type:'fontsize', element:m[1].trim(), size:m[2]+'px' })
    },
    // 5. 选中文本
    {
      id: 'select', name: '选中元素', priority: -1,
      patterns: [/选中(.+)/, /选择(.+)/],
      execute: (m) => ({ type:'select', keyword:m[1].trim() })
    },
    // 6. 撤销
    {
      id: 'undo', name: '撤销操作', priority: 10,
      patterns: [/^(撤销|回退|撤消|取消这一步|上一步)$/],
      execute: () => ({ type:'undo' })
    },
    // 7. 改背景色
    {
      id: 'bgcolor', name: '改背景色', priority: 6,
      patterns: [/把(.+?)(?:的?背景)(?:改|换|设)成(.+)/, /(.+?)背景(.+色)/],
      execute: (m) => {
        const colorMap = {'红':'#ef4444','红色':'#ef4444','绿':'#22c55e','绿色':'#22c55e','蓝':'#3b82f6','蓝色':'#3b82f6','黄':'#eab308','黄色':'#eab308','紫':'#8b5cf6','紫色':'#8b5cf6','橙':'#f97316','橙色':'#f97316','粉':'#ec4899','粉色':'#ec4899','白':'#ffffff','白色':'#ffffff','黑':'#000000','黑色':'#000000','灰':'#6b7280','灰色':'#6b7280','金':'#fbbf24','金色':'#fbbf24','银':'#9ca3af','银色':'#9ca3af'};
        return { type:'bgcolor', element:m[1].trim(), color: colorMap[m[2].trim()] || colorMap[m[2].trim().replace('色','')] || m[2].trim() };
      }
    },
    // 8. 设置加粗
    {
      id: 'bold', name: '加粗/取消加粗', priority: 5,
      patterns: [/把(.+?)加粗/, /(.+?)加粗/, /加粗(.+)/, /把(.+?)取消加粗/, /(.+?)不要加粗/, /取消(.+?)加粗/],
      execute: (m) => {
        const isCancel = /取消|不要|去掉/.test(m[0]);
        return { type:'bold', element:m[1].trim(), bold:!isCancel };
      }
    },
  ];

  /* ── 启动 ── */
  init();
  bindVoiceEvents();
  initCmdAssistant();
  if (VoiceEngine) VoiceEngine.init();
})();