#!/usr/bin/env node
/**
 * HTML Editor 后端服务
 * - 提供静态文件服务（HTML 编辑器前端）
 * - 提供 /api/html-to-pdf 接口，基于 Puppeteer + Chromium 将 HTML 转为 PDF
 *
 * PDF 生成策略：
 * - 截图模式（默认）：全页截图 → 嵌入PDF（无限长单页，与HTML完全一致，不分页）
 * - 打印模式（可选）：Puppeteer page.pdf()，文字可选，但部分CSS效果可能丢失
 */

import express from 'express';
import cors from 'cors';
import puppeteer from 'puppeteer-core';
import { writeFileSync, mkdirSync, existsSync, unlinkSync } from 'fs';
import { join } from 'path';
import { randomUUID } from 'crypto';
import { PDFDocument } from 'pdf-lib';

// ====== HTML 预处理模块 ======
// 处理各种来源的 HTML 文件格式差异，确保 Puppeteer 渲染时视觉一致

/**
 * 全面预处理 HTML 内容，使其在 Puppeteer 中正确渲染
 * 处理场景：
 * 1. 纯 HTML 片段（无 html/head/body 标签）
 * 2. 缺少 charset 声明（中文乱码）
 * 3. 缺少 viewport meta（移动端布局错乱）
 * 4. XML 声明或 BOM 头干扰
 * 5. @media print 样式改变渲染效果
 * 6. 非标准结构（meta 在 body 中等）
 * 7. 框架构建产物（React/Vue等）
 * 8. 外部资源（字体/图标）加载失败
 * 9. 编码异常字符
 */
function normalizeHtmlForPdf(rawHtml) {
  let html = rawHtml;

  // ── Step 1: 清除 BOM 和异常前缀 ──
  html = html.replace(/^\uFEFF/, '');               // UTF-8 BOM
  html = html.replace(/^\u00BB\u00BF/, '');          // UTF-8 BOM (另一种)
  html = html.replace(/^[\x00-\x08\x0B\x0C\x0E-\x1F]+/, ''); // 控制字符

  // ── Step 2: 移除 XML 声明（Puppeteer 不需要） ──
  html = html.replace(/<\?xml[^?]*\?>/gi, '');

  // ── Step 3: 检测是否为完整 HTML 文档 ──
  const hasDoctype = /^\s*<!DOCTYPE/i.test(html);
  const hasHtmlTag = /<html[\s>]/i.test(html);
  const hasHeadTag = /<head[\s>]/i.test(html);
  const hasBodyTag = /<body[\s>]/i.test(html);

  // ── Step 4: 如果不是完整文档，包装为标准结构 ──
  if (!hasHtmlTag) {
    // 纯片段或部分 HTML
    let headContent = '';
    let bodyContent = html;

    // 尝试提取已有的 <head> 内容（可能出现在片段中）
    const headMatch = html.match(/<head[^>]*>([\s\S]*?)<\/head>/i);
    if (headMatch) {
      headContent = headMatch[1];
      bodyContent = html.replace(/<head[^>]*>[\s\S]*?<\/head>/i, '');
    }

    // 尝试提取已有的 <body> 内容
    const bodyMatch = bodyContent.match(/<body[^>]*>([\s\S]*?)<\/body>/i);
    if (bodyMatch) {
      bodyContent = bodyMatch[1];
    }

    html = `<!DOCTYPE html>
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
    // 有 <html> 但没有 <head>
    html = html.replace(/<html([^>]*)>/i, (match, attrs) => {
      return `${match}<head><meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1.0"></head>`;
    });
  }

  // ── Step 5: 确保 charset 声明存在 ──
  const hasCharset = /<meta[^>]+charset/i.test(html);
  if (!hasCharset && html.includes('<head>')) {
    html = html.replace(/<head>/i, '<head>\n<meta charset="UTF-8">');
  } else if (!hasCharset && html.includes('<head ')) {
    html = html.replace(/<head([^>]*)>/i, '<head$1>\n<meta charset="UTF-8">');
  }

  // ── Step 6: 确保 viewport meta 存在 ──
  const hasViewport = /<meta[^>]+viewport/i.test(html);
  if (!hasViewport) {
    const viewportMeta = '<meta name="viewport" content="width=device-width, initial-scale=1.0">';
    if (html.includes('<head>')) {
      html = html.replace(/<head>/i, `<head>\n${viewportMeta}`);
    } else if (html.includes('<head ')) {
      html = html.replace(/<head([^>]*)>/i, `<head$1>\n${viewportMeta}`);
    }
  }

  // ── Step 7: 修复非标准结构 — 把 body 中的 <meta>/<link>/<style> 移到 <head> ──
  // 找出 <body> 内的 <meta> 和 <link rel="stylesheet"> 标签
  const bodyHeadElements = [];
  const bodyTagRegex = /<body[^>]*>([\s\S]*?)<\/body>/i;
  const bodyMatch = html.match(bodyTagRegex);
  if (bodyMatch) {
    let bodyContent = bodyMatch[1];
    // 提取 <meta> 标签（排除 charset 和 viewport，避免重复）
    bodyContent = bodyContent.replace(/<meta(?![^>]*charset)(?![^>]*viewport)[^>]*>/gi, (match) => {
      bodyHeadElements.push(match);
      return '';
    });
    // 提取 <link rel="stylesheet"> 标签
    bodyContent = bodyContent.replace(/<link[^>]+rel\s*=\s*["']stylesheet["'][^>]*>/gi, (match) => {
      bodyHeadElements.push(match);
      return '';
    });
    if (bodyHeadElements.length > 0) {
      html = html.replace(bodyTagRegex, `<body>${bodyContent}</body>`);
      // 插入到 </head> 前
      if (html.includes('</head>')) {
        html = html.replace('</head>', bodyHeadElements.join('\n') + '\n</head>');
      }
    }
  }

  // ── Step 8: 移除 @media print 样式 ──
  // 用户的 @media print 通常是为 A4 纸打印设计（如强制分页、透明背景、隐藏元素等）
  // 而我们的目标是"所见即所得"的单页长 PDF，与 A4 打印完全不同
  // 因此需要移除 @media print，确保浏览器中看到的效果 = PDF 中看到的效果
  html = html.replace(/@media\s+print\s*\{[\s\S]*?\}\s*(?=\s*<\/style>|\s*@media|\s*<\/head>|\s*$)/gi, '');
  // 同时移除独立的 @page 规则
  html = html.replace(/@page\s*\{[\s\S]*?\}\s*/gi, '');

  // ── Step 9: 确保基础字体栈存在（防止系统无字体时渲染异常） ──
  const hasFontFamily = /font-family/i.test(html);
  if (!hasFontFamily && html.includes('<head>')) {
    const baseFontCss = `<style>
html, body {
  font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Helvetica Neue", Arial, "Noto Sans SC", "PingFang SC", "Microsoft YaHei", sans-serif;
}
</style>`;
    html = html.replace(/<head>/i, `<head>\n${baseFontCss}`);
  }

  // ── Step 10: 处理常见的框架构建产物 ──
  // React: 确保根节点存在
  if (html.includes('react') && html.includes('root') && !html.includes('id="root"')) {
    // React 应用通常需要 <div id="root">
    if (html.includes('<body>')) {
      html = html.replace('<body>', '<body>\n<div id="root"></div>');
    }
  }
  // Vue: 确保 #app 节点
  if (html.includes('vue') && !html.includes('id="app"')) {
    if (html.includes('<body>')) {
      html = html.replace('<body>', '<body>\n<div id="app"></div>');
    }
  }

  // ── Step 11: 清理空白和格式化 ──
  // 移除 HTML 注释（保留条件注释）
  html = html.replace(/<!--(?!\[if)[\s\S]*?-->/g, '');

  // ── Step 12: 确保有 DOCTYPE 声明 ──
  if (!html.trim().toLowerCase().startsWith('<!doctype')) {
    html = '<!DOCTYPE html>\n' + html;
  }

  console.log(`🔧 HTML 预处理完成: 原始 ${rawHtml.length} 字符 → 处理后 ${html.length} 字符, Doctype=${hasDoctype || html.includes('<!DOCTYPE')}, Head=${html.includes('<head')}, Charset=${html.includes('charset')}, Viewport=${html.includes('viewport')}`);

  return html;
}

// ====== 配置 ======
const PORT = process.env.PORT || 3100;
const HOST = '0.0.0.0';
const TMP_DIR = join(process.cwd(), '.tmp');

const CHROME_PATH = process.env.CHROME_PATH ||
  (process.platform === 'darwin'
    ? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'
    : ['/usr/bin/ungoogled-chromium', '/usr/bin/chromium-browser', '/usr/bin/chromium', '/usr/bin/google-chrome']
      .find(p => { try { require('fs').accessSync(p); return true; } catch(_) { return false; } })
    || '/usr/bin/ungoogled-chromium');

const CHROME_ARGS = [
  '--no-sandbox', '--disable-gpu', '--disable-dev-shm-usage',
  '--font-render-hinting=none', '--enable-font-antialiasing',
  '--disable-software-rasterizer',
  '--disable-features=PaintHolding',
  '--font-cache-shared-handle'
];

// ★ 不再硬编码手机屏尺寸，改为自动检测 HTML 的设计宽度
const DEFAULT_VIEWPORT = { width: 1280, height: 900 }; // 默认用PC宽度渲染，后续自动检测实际宽度
const TIMEOUTS = {
  pageLoad: 15000,     // 页面加载（15秒，避免networkidle0等太久）
  canvasWait: 5000,    // Canvas图表等待（5秒，大部分图表2秒内渲染完成）
  postRender: 500,     // 渲染后等待（500ms，大部分页面足够）
  postExpand: 150,     // 展开隐藏内容（150ms）
  postStyle: 100,      // CSS注入后（100ms）
  postViewport: 150,   // viewport切换后（150ms）
  requestTotal: 25000  // ★ 请求级总超时（25秒，必须在网关30秒超时前返回）
};

// 截图模式：单页最大高度（超过此高度将分段截图后拼接）
const MAX_SINGLE_PAGE_HEIGHT_PX = 16384;

// ====== Express 应用 ======
const app = express();
app.use(cors());
app.use(express.json({ limit: '50mb' }));
app.use(express.static(join(process.cwd())));

// 确保 tmp 目录存在
if (!existsSync(TMP_DIR)) mkdirSync(TMP_DIR, { recursive: true });

// ====== Puppeteer 浏览器池 ======
let browserInstance = null;
let browserLaunchTime = 0;
const BROWSER_MAX_AGE = 2 * 60 * 60 * 1000; // 浏览器最大存活2小时，定期重启防内存泄漏
const MAX_BROWSER_PAGES = 20; // 最大同时打开的页面数

async function getBrowser() {
  // ★ 定期重启浏览器（防内存泄漏）
  if (browserInstance && browserInstance.isConnected()) {
    const age = Date.now() - browserLaunchTime;
    if (age > BROWSER_MAX_AGE) {
      console.log(`🔄 Chromium 已运行 ${Math.round(age / 60000)} 分钟，执行定期重启`);
      try {
        const pages = await browserInstance.pages();
        await Promise.all(pages.map(p => p.close().catch(() => {})));
        await browserInstance.close();
      } catch (_) {}
      browserInstance = null;
    }
  }

  if (browserInstance && browserInstance.isConnected()) {
    // ★ 检查打开的页面数量，防止资源泄漏
    try {
      const pages = await browserInstance.pages();
      if (pages.length > MAX_BROWSER_PAGES) {
        console.warn(`⚠️ Chromium 打开了 ${pages.length} 个页面（上限 ${MAX_BROWSER_PAGES}），强制关闭多余页面`);
        // 关闭除第一个（about:blank）之外的所有页面
        for (let i = 1; i < pages.length; i++) {
          try { await pages[i].close(); } catch (_) {}
        }
      }
    } catch (_) {}
    return browserInstance;
  }

  console.log(`🚀 启动 Chromium: ${CHROME_PATH}`);
  browserLaunchTime = Date.now();
  browserInstance = await puppeteer.launch({
    executablePath: CHROME_PATH,
    headless: 'new',
    args: CHROME_ARGS
  });
  browserInstance.on('disconnected', () => {
    console.log('⚠️ Chromium 浏览器已断开');
    browserInstance = null;
  });
  return browserInstance;
}

/**
 * 注入关键CSS，确保打印模式下视觉一致性
 * 1. 禁止所有分页行为
 * 2. 强制保留背景色/渐变/阴影
 * 3. 禁用 @media print 样式
 */
const PDF_PRINT_OVERRIDE_CSS = `
  @media print {
    * {
      page-break-inside: auto !important;
      break-inside: auto !important;
      page-break-after: auto !important;
      break-after: auto !important;
      page-break-before: auto !important;
      break-before: auto !important;
    }
  }
  * {
    -webkit-print-color-adjust: exact !important;
    print-color-adjust: exact !important;
    color-adjust: exact !important;
  }
  html, body {
    overflow: visible !important;
    width: 100% !important;
    height: auto !important;
    min-height: auto !important;
    float: none !important;
    position: relative !important;
    -webkit-print-color-adjust: exact !important;
    print-color-adjust: exact !important;
    color-adjust: exact !important;
  }
  /* 强制保留所有元素的背景色、渐变、阴影、边框 */
  *, *::before, *::after {
    -webkit-print-color-adjust: exact !important;
    print-color-adjust: exact !important;
    color-adjust: exact !important;
  }
`;

/**
 * 公共：创建 Puppeteer 页面，渲染 HTML，返回 page 和测量信息
 */
async function createRenderedPage(htmlContent, options = {}) {
  // ★ 预处理 HTML：规范化各种格式差异但保留内容完整性
  htmlContent = normalizeHtmlForPdf(htmlContent);

  // 如果前端传了 pdfWidth 且不是 'auto'，则使用指定宽度；否则自动检测
  const userPdfWidth = options.pdfWidth && options.pdfWidth !== 'auto'
    ? parseInt(options.pdfWidth, 10)
    : null;

  let browser;
  try {
    browser = await getBrowser();
  } catch (launchErr) {
    console.error('❌ Chromium 启动失败:', launchErr.message);
    throw new Error('Chromium 浏览器启动失败: ' + launchErr.message);
  }

  let page;
  try {
    page = await browser.newPage();
  } catch (pageErr) {
    console.error('❌ 创建页面失败，尝试重启浏览器:', pageErr.message);
    try { await browser.close(); } catch (_) {}
    browserInstance = null;
    try {
      browser = await getBrowser();
      page = await browser.newPage();
    } catch (retryErr) {
      throw new Error('创建渲染页面失败，请重试: ' + retryErr.message);
    }
  }

  // Step0: 使用 setContent 直接加载 HTML（比 file:// 更可靠，避免资源加载问题）
  await page.setViewport(DEFAULT_VIEWPORT);
  await page.setContent(htmlContent, {
    waitUntil: 'networkidle0',
    timeout: TIMEOUTS.pageLoad
  });

  // 等待 canvas 图表完成渲染
  const hasCanvas = await page.evaluate(() =>
    document.querySelectorAll('canvas').length
  );
  if (hasCanvas > 0) {
    try {
      await page.waitForFunction(
        () => Array.from(document.querySelectorAll('canvas')).every(c => c.width > 0),
        { timeout: TIMEOUTS.canvasWait }
      );
    } catch (_) {
      console.warn('⚠️ Canvas 图表等待超时，继续生成 PDF');
    }
  }
  await new Promise(r => setTimeout(r, TIMEOUTS.postRender));

  // Step1: 展开隐藏内容 + 检测背景色
  const bgColor = await page.evaluate(() => {
    const cssVar = getComputedStyle(document.documentElement)
      .getPropertyValue('--bg').trim();
    return cssVar || getComputedStyle(document.body || document.documentElement)
      .backgroundColor || '#ffffff';
  });

  await page.evaluate(() => {
    document.querySelectorAll('.tc').forEach(t => t.classList.add('act'));
    document.querySelectorAll('.fi').forEach(el => el.classList.add('sho'));
    const sug = document.getElementById('sugGrid');
    if (sug) sug.style.display = '';
  });
  await new Promise(r => setTimeout(r, TIMEOUTS.postExpand));

  // Step2: ★ 宽度检测（仅用于PDF页面尺寸，不再改变viewport）
  // ⚠️ 注意：不可在此改变viewport！否则scale=2时page.screenshot()可能返回0字节(Chromium bug)
  let pdfWidth = DEFAULT_VIEWPORT.width;
  if (userPdfWidth) {
    pdfWidth = userPdfWidth;
  } else {
    const detected = await page.evaluate(() => {
      let maxRight = 0;
      document.querySelectorAll('body *').forEach(el => {
        const cs = getComputedStyle(el);
        if (cs.display === 'none' || cs.visibility === 'hidden' || cs.opacity === '0') return;
        const rect = el.getBoundingClientRect();
        if (rect.right > maxRight) maxRight = rect.right;
      });
      let contentMaxWidth = 0;
      [document.body, ...document.querySelectorAll('body > *')].forEach(el => {
        if (!el) return;
        const cs = getComputedStyle(el);
        if (cs.maxWidth && cs.maxWidth !== 'none') { const mw = parseFloat(cs.maxWidth); if (mw > 0 && mw < 800) contentMaxWidth = Math.max(contentMaxWidth, mw); }
        if (cs.width && cs.width !== 'auto') { const w = parseFloat(cs.width); if (w > 0 && w < 800) contentMaxWidth = Math.max(contentMaxWidth, w); }
      });
      let viewportWidth = 0;
      const vm = document.querySelector('meta[name="viewport"]');
      if (vm) { const c = vm.getAttribute('content') || ''; const m = c.match(/width\s*=\s*(\d+)/); if (m) viewportWidth = parseInt(m[1], 10); }
      let finalW;
      if (contentMaxWidth > 300 && contentMaxWidth <= 500) finalW = Math.ceil(contentMaxWidth);
      else if (viewportWidth > 300 && viewportWidth <= 500) finalW = Math.ceil(viewportWidth);
      else finalW = Math.max(Math.ceil(maxRight), document.body?.scrollWidth || 0, document.documentElement?.scrollWidth || 0, 320);
      return { finalW, maxRight, contentMaxWidth, viewportWidth, scrollW: document.documentElement.scrollWidth };
    });
    pdfWidth = detected.finalW || DEFAULT_VIEWPORT.width;
    // ★ 关键：保持viewport不变，只把检测到的宽度用于PDF页面尺寸计算
    console.log(`📐 检测到内容宽度: ${pdfWidth}px (maxRight=${detected.maxRight}, contentMaxWidth=${detected.contentMaxWidth}, scrollW=${detected.scrollW}), viewport保持 ${DEFAULT_VIEWPORT.width}px 不变`);
  }

  // Step3: 测量内容高度（使用 scrollHeight，与 V12 一致）
  let contentHeight = await page.evaluate(() => Math.max(
    document.documentElement.scrollHeight || 0,
    document.body ? document.body.scrollHeight : 0
  ));

  // Step4: 底部 filler div（消除 Chromium PDF 渲染器底部白色缝隙）
  await page.evaluate((bg) => {
    const filler = document.createElement('div');
    filler.style.cssText = `height:2px;width:100%;background:${bg};`;
    document.body.appendChild(filler);
  }, bgColor);

  contentHeight = await page.evaluate(() => Math.max(
    document.documentElement.scrollHeight || 0,
    document.body ? document.body.scrollHeight : 0
  ));

  // 重新测量确认
  contentHeight = Math.max(contentHeight, 100);

  console.log(`📐 PDF渲染参数: 宽度=${pdfWidth}px, 内容高度=${contentHeight}px`);

  return { page, contentHeight, viewport: { width: pdfWidth, height: DEFAULT_VIEWPORT.height } };
}

/**
 * 模式 A：打印模式 HTML → PDF（单页长 PDF，保持文字可选）
 * 
 * 核心优化：
 * 1. 注入全面CSS覆盖，禁止分页、强制保留背景色
 * 2. 精确设置页面尺寸为内容实际尺寸
 * 3. 设置 margin 为 0 避免额外空白
 */
async function convertHtmlToPdfPrint(htmlContent, options = {}) {
  const { page, contentHeight, viewport } = await createRenderedPage(htmlContent, options);

  try {
    // 注入打印覆盖CSS
    await page.addStyleTag({ content: PDF_PRINT_OVERRIDE_CSS });
    await new Promise(r => setTimeout(r, TIMEOUTS.postStyle));

    // 生成单页长PDF
    const pdfBuffer = await page.pdf({
      width: `${viewport.width}px`,
      height: `${contentHeight}px`,
      printBackground: true,
      margin: { top: 0, right: 0, bottom: 0, left: 0 },
      preferCSSPageSize: false,
      displayHeaderFooter: false
    });

    const doc = await PDFDocument.load(pdfBuffer);
    const pageCount = doc.getPageCount();
    const pageSize = pageCount > 0 ? doc.getPage(0).getSize() : { width: 0, height: 0 };

    console.log(`✅ [打印模式] PDF 生成成功: ${pageCount} 页, ${(pdfBuffer.length / 1024).toFixed(1)} KB, 尺寸: ${pageSize.width.toFixed(0)}x${pageSize.height.toFixed(0)}pt`);

    return {
      buffer: pdfBuffer,
      pageCount,
      pageSize,
      sizeKB: (pdfBuffer.length / 1024).toFixed(1),
      mode: 'print'
    };
  } finally {
    await page.close();
  }
}

/**
 * 模式 B：截图模式 HTML → PDF（像素级精确，100% 保留背景色/渐变/阴影）
 *
 * ★ 核心设计原则：PDF 打开看起来跟 HTML 一模一样
 * ★ 不做A4分页！生成一张无限长的单页PDF，内容有多长页面就有多长
 *
 * ★★★ 大页面分段截图拼接：
 * Chromium 截图有像素上限（宽×高 × scale² 不得超过 ~16384×16384 像素）
 * PPT 风格的 HTML（如20个min-height:100vh的幻灯片）内容高度可达 18000+px
 * 在 deviceScaleFactor=2 时，实际像素高度 = 18000×2 = 36000px → 超限 → "Page is too large"
 * 解决：将长页面按段分段截图，每段不超过上限，然后用 pdf-lib 拼接为单页 PDF
 *
 * 优势：
 * 1. 像素级精确：100% 保留背景色/渐变/阴影
 * 2. 无分页切断：不会在卡片/表格中间硬切
 * 3. 无多余空白：页面高度 = 内容实际高度
 * 4. 与HTML完全一致：所见即所得
 * 5. 支持任意长度的内容：超长页面自动分段截图拼接
 */
async function convertHtmlToPdfScreenshot(htmlContent, options = {}) {
  const { page, contentHeight, viewport } = await createRenderedPage(htmlContent, options);
  const scale = 2; // deviceScaleFactor，2x高清

  try {
    // ★ 计算分段策略：Chromium 截图像素上限（宽和高各自不能超过 MAX_SCREENSHOT_DIM）
    // 在 deviceScaleFactor=2 时，CSS 像素上限 = MAX_SCREENSHOT_DIM / 2
    const MAX_SCREENSHOT_DIM = 16384;
    const maxCssHeight = Math.floor(MAX_SCREENSHOT_DIM / scale) - 100; // 留100px安全余量

    // 宽度也需要检查
    const maxCssWidth = Math.floor(MAX_SCREENSHOT_DIM / scale) - 100;
    const effectiveWidth = Math.min(viewport.width, maxCssWidth);

    const needsSegmenting = contentHeight > maxCssHeight;
    const segmentHeight = needsSegmenting ? maxCssHeight : contentHeight;
    const segmentCount = needsSegmenting ? Math.ceil(contentHeight / segmentHeight) : 1;

    console.log(`📐 截图策略: 内容=${viewport.width}x${contentHeight}px, scale=${scale}x, ` +
      `像素上限=${MAX_SCREENSHOT_DIM}px, CSS高度上限=${maxCssHeight}px, ` +
      `需要分段=${needsSegmenting}, 段数=${segmentCount}, 段高=${segmentHeight}px`);

    // ★ 设置 viewport（使用有效宽度，防止宽度也超限）
    await page.setViewport({
      width: effectiveWidth,
      height: needsSegmenting ? segmentHeight : contentHeight,
      deviceScaleFactor: scale
    });
    await new Promise(r => setTimeout(r, TIMEOUTS.postViewport));

    if (!needsSegmenting) {
      // ── 小页面：直接全页截图，简单高效 ──
      let screenshotBuffer;
      try {
        screenshotBuffer = await page.screenshot({ type: 'jpeg', quality: 95, fullPage: true });
      } catch (screenshotErr) {
        throw new Error(`截图失败: ${screenshotErr.message}`);
      }
      // ★ 防御：截图返回 0 字节是 Chromium 已知问题，捕获后抛出降级
      if (!screenshotBuffer || screenshotBuffer.length === 0) {
        throw new Error('截图返回空数据(0 bytes)，可能是 Chromium 渲染异常');
      }

      const pdfW = effectiveWidth * 0.75;
      const pdfH = contentHeight * 0.75;

      const pdfDoc = await PDFDocument.create();
      const img = await pdfDoc.embedJpg(screenshotBuffer);
      const pdfPage = pdfDoc.addPage([pdfW, pdfH]);
      pdfPage.drawImage(img, { x: 0, y: 0, width: pdfW, height: pdfH });

      const pdfBuffer = await pdfDoc.save();
      const sizeKB = (pdfBuffer.length / 1024).toFixed(1);

      console.log(`✅ [截图模式-单段] PDF 生成成功: 1 页, ${sizeKB} KB, 尺寸: ${pdfW.toFixed(0)}x${pdfH.toFixed(0)}pt`);

      return {
        buffer: Buffer.from(pdfBuffer),
        pageCount: 1,
        pageSize: { width: pdfW, height: pdfH },
        sizeKB,
        mode: 'screenshot'
      };
    }

    // ── 大页面：分段截图 + 拼接到单页 PDF ──
    const pdfW = effectiveWidth * 0.75;
    const pdfH = contentHeight * 0.75;
    const pdfDoc = await PDFDocument.create();
    const pdfPage = pdfDoc.addPage([pdfW, pdfH]);

    // 从底部往上画（pdf-lib 的 y 轴从底部开始）
    let currentY = pdfH; // PDF坐标系中当前段的底部位置

    for (let i = 0; i < segmentCount; i++) {
      const scrollY = i * segmentHeight;
      const isLast = i === segmentCount - 1;
      // 最后一段可能不满 segmentHeight
      const thisSegmentCssHeight = isLast
        ? (contentHeight - scrollY)
        : segmentHeight;

      // ★ 滚动页面到对应位置
      await page.evaluate((y) => {
        window.scrollTo(0, y);
      }, scrollY);
      // 短暂等待滚动完成和渲染
      await new Promise(r => setTimeout(r, 50));

      // ★ 如果段高度与 viewport 高度差异大，调整 viewport 以避免多余空白
      if (thisSegmentCssHeight !== segmentHeight) {
        await page.setViewport({
          width: effectiveWidth,
          height: thisSegmentCssHeight,
          deviceScaleFactor: scale
        });
        await new Promise(r => setTimeout(r, 80));
        // 滚动可能被重置，重新设置
        await page.evaluate((y) => {
          window.scrollTo(0, y);
        }, scrollY);
        await new Promise(r => setTimeout(r, 30));
      }

      // 截取当前可视区域
      const clipRect = {
        x: 0,
        y: 0,
        width: effectiveWidth,
        height: thisSegmentCssHeight
      };

      let segBuffer;
      try {
        segBuffer = await page.screenshot({ type: 'jpeg', quality: 95, clip: clipRect });
      } catch (clipErr) {
        console.warn(`⚠️ 段 ${i + 1} clip截图失败，尝试fullPage:`, clipErr.message);
        segBuffer = await page.screenshot({ type: 'jpeg', quality: 90, fullPage: true });
      }
      if (!segBuffer || segBuffer.length === 0) {
        throw new Error(`段 ${i + 1} 截图返回空数据(0 bytes)`);
      }

      // ★ 计算本段在 PDF 中的位置（从底部往上排列）
      const segPdfHeight = thisSegmentCssHeight * 0.75;
      currentY -= segPdfHeight;

      const img = await pdfDoc.embedJpg(segBuffer);
      pdfPage.drawImage(img, {
        x: 0,
        y: currentY,
        width: pdfW,
        height: segPdfHeight
      });

      console.log(`  📸 段 ${i + 1}/${segmentCount}: scrollY=${scrollY}px, 高度=${thisSegmentCssHeight}px, PDF位置 y=${currentY.toFixed(0)}pt`);
    }

    const pdfBuffer = await pdfDoc.save();
    const sizeKB = (pdfBuffer.length / 1024).toFixed(1);

    console.log(`✅ [截图模式-分段拼接] PDF 生成成功: 1 页, ${sizeKB} KB, 尺寸: ${pdfW.toFixed(0)}x${pdfH.toFixed(0)}pt (${segmentCount}段拼接)`);

    return {
      buffer: Buffer.from(pdfBuffer),
      pageCount: 1,
      pageSize: { width: pdfW, height: pdfH },
      sizeKB,
      mode: 'screenshot'
    };
  } finally {
    await page.close();
  }
}
/**
 * 核心：HTML → PDF 转换（自动根据模式分发）
 */
async function convertHtmlToPdf(htmlContent, options = {}) {
  // 如果前端显式指定了模式，尊重前端选择；否则默认 screenshot
  const mode = options.pdfMode || 'screenshot';

  // strategy: 优先截图模式（像素级精确），如果截图失败自动降级到打印模式
  if (mode === 'screenshot') {
    try {
      return await convertHtmlToPdfScreenshot(htmlContent, options);
    } catch (screenshotErr) {
      // 截图失败（如 Chromium 返回 0 字节、Page is too large 等）
      // 自动降级到打印模式，确保用户始终能拿到 PDF
      console.warn(`⚠️ 截图模式失败: ${screenshotErr.message}，自动降级到打印模式`);
      return await convertHtmlToPdfPrint(htmlContent, options);
    }
  }
  return convertHtmlToPdfPrint(htmlContent, options);
}

// ====== API 路由 ======

/**
 * POST /api/html-to-pdf
 * 接收 HTML 内容，返回 PDF 文件
 */
app.post('/api/html-to-pdf', async (req, res) => {
  // ★ 请求级总超时保护：25秒后自动终止，必须在网关30秒超时前返回
  const requestTimer = setTimeout(() => {
    if (!res.headersSent) {
      res.status(504).json({ error: 'PDF 生成超时（25秒），内容可能过大。建议：①减少内容长度 ②使用浏览器"打印→另存为PDF"' });
    }
  }, TIMEOUTS.requestTotal);

  try {
    const { html, filename, pdfWidth, pdfMode } = req.body;

    if (!html || typeof html !== 'string') {
      clearTimeout(requestTimer);
      return res.status(400).json({ error: '缺少 html 字段' });
    }

    console.log(`📄 收到 PDF 转换请求，HTML 长度: ${html.length} 字符, PDF宽度: ${pdfWidth || 'auto'}, 模式: ${pdfMode || 'print'}`);

    const result = await convertHtmlToPdf(html, { pdfWidth: pdfWidth || 'auto', pdfMode: pdfMode || 'print' });

    clearTimeout(requestTimer);

    // 设置响应头，返回 PDF 文件
    const pdfFilename = (filename || 'document').replace(/\.html?$/i, '') + '.pdf';
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename="${encodeURIComponent(pdfFilename)}"`);
    res.setHeader('X-PDF-Pages', result.pageCount);
    res.setHeader('X-PDF-Size-KB', result.sizeKB);
    res.setHeader('X-PDF-Mode', result.mode);
    res.send(result.buffer);

    console.log(`📤 PDF 已发送: ${pdfFilename} (${result.mode}模式, ${result.pageCount}页)`);
  } catch (err) {
    clearTimeout(requestTimer);
    console.error('❌ PDF 转换失败:', err.message);
    if (!res.headersSent) {
      res.status(500).json({ error: 'PDF 转换失败: ' + err.message });
    }
  }
});

/**
 * GET /health
 * Docker 健康检查（兼容标准路径）
 */
app.get('/health', (req, res) => {
  res.json({
    status: 'ok',
    chromePath: CHROME_PATH,
    chromeAvailable: existsSync(CHROME_PATH),
    uptime: process.uptime()
  });
});

/**
 * GET /api/health
 * 健康检查（API路径）
 */
app.get('/api/health', (req, res) => {
  res.json({
    status: 'ok',
    chromePath: CHROME_PATH,
    chromeAvailable: existsSync(CHROME_PATH),
    uptime: process.uptime()
  });
});

// ====== 启动服务 ======
app.listen(PORT, HOST, () => {
  console.log(`\n🎨 HTML Editor 后端服务已启动`);
  console.log(`   地址: http://${HOST}:${PORT}`);
  console.log(`   Chromium: ${CHROME_PATH}`);
  console.log(`   静态文件: ${process.cwd()}`);
  console.log(`   PDF 转换: POST /api/html-to-pdf`);
  console.log(`   默认模式: 截图模式 (像素级精确)\n`);
});
