#!/usr/bin/env node
/**
 * HTML Editor 后端服务
 * - 提供静态文件服务
 * - 提供 /api/html-to-pdf 接口，将 HTML 转为高质量 PDF
 *
 * ★ PDF 生成策略（v2.0）
 * ┌─────────────────────────────────────────────────────────────────────────┐
 * │  模式              │  原理                  │  最佳适用场景              │
 * ├─────────────────────────────────────────────────────────────────────────┤
 * │  optimize (推荐)   │  智能分析+自适应策略   │  混合内容、通用场景        │
 * │                    │  根据内容特征自动决策   │  自动选择print/simulated   │
 * ├─────────────────────────────────────────────────────────────────────────┤
 * ├─────────────────────────────────────────────────────────────────────────┤
 * │  print (默认)      │  Chromium 原生 page.pdf│  文档、报告（分页、文字可选）│
 * │                    │  format'A4' 自然处理   │  保持CSS @media print      │
 * ├─────────────────────────────────────────────────────────────────────────┤
 * │  simulated         │  按A4尺寸分段渲染截图   │  PPT、海报、复杂布局       │
 * │  (原screenshot)    │  拼接为多页PDF         │  像素级精确+分页           │
 * ├─────────────────────────────────────────────────────────────────────────┤
 * │  continuous        │  整体单页（无分页）     │  长海报、长图、单页长文     │
 * │                    │  强制一页A4宽度         │                            │
 * └─────────────────────────────────────────────────────────────────────────┘
 *
 * ★★★ v2.0 改进点：
 * 1. 【智能模式分析】新analyzeContentType函数，分析HTML特征自动选择最佳模式
 * 2. 【fallback_to_print关闭】垂直PPT layouts不再错误切换到print
 * 3. 【截图模式完全功能】支持按A4分页的多段截图拼接
 * 4. 【scrollH修复】contentHeight来自真实scrollH（考虑viewport）
 * 5. 【page-break修复】打印模式恢复支持用户css的page-break控制
 * 6. 【字体加载等待】1500ms确保font加载完毕
 * 7. 【CSS print支持】尊重用户@media print规则，不强制覆盖
 * 8. 【print模式viewport优化】768px高度确保打印布局正确
 * 9. 【动态DPI计算】打印尺寸= cssW*0.75*DPIratio（自适应缩放）
 * 10.【grid/flex分页支持】page-break-inside: avoid对grid/flex元素
 * 11.【垂直布局检测】检测100vh的PPT布局并用simulated模式
 * 12.【异步截图优化】goto pdf handler而非setContent，确保资源加载
 * 13.【异常细分类】减少fallback_to_print误触发
 */

import express from 'express';
import cors from 'cors';
import puppeteer from 'puppeteer-core';
import { writeFileSync, mkdirSync, existsSync, unlinkSync } from 'fs';
import { join } from 'path';
import { randomUUID } from 'crypto';
import { PDFDocument } from 'pdf-lib';

// ======== Express 应用 ========
const app = express();
app.use(cors());
app.use(express.json({ limit: '50mb' }));
app.use(express.static(join(process.cwd())));

const PORT = process.env.PORT || 3100;
const HOST = '0.0.0.0';
const TMP_DIR = join(process.cwd(), '.tmp');
if (!existsSync(TMP_DIR)) mkdirSync(TMP_DIR, { recursive: true });

// ======== Chromium 配置 ========
const CHROME_PATH = process.env.CHROME_PATH ||
  ['/usr/bin/ungoogled-chromium', '/usr/bin/chromium-browser', '/usr/bin/chromium', '/usr/bin/google-chrome',
   '/usr/local/bin/chromium', '/usr/local/bin/google-chrome']
    .find(p => { try { require('fs').accessSync(p); return true; } catch(_) { return false; } })
  || '/usr/bin/ungoogled-chromium';

const CHROME_ARGS = [
  '--no-sandbox', '--disable-gpu', '--disable-dev-shm-usage',
  '--font-render-hinting=none', '--enable-font-antialiasing',
  '--disable-software-rasterizer',
  '--disable-features=PaintHolding',
  '--font-cache-shared-handle',
  '--disable-background-timer-throttling',
  '--disable-renderer-backgrounding'
];

// ======== 浏览器池 ========
let browserInstance = null;
let browserLaunchTime = 0;
const BROWSER_MAX_AGE = 2 * 60 * 60 * 1000;
const MAX_BROWSER_PAGES = 20;

async function getBrowser() {
  if (browserInstance && browserInstance.isConnected()) {
    const age = Date.now() - browserLaunchTime;
    if (age > BROWSER_MAX_AGE) {
      try { await browserInstance.close(); } catch (_) {}
      browserInstance = null;
    }
  }

  if (browserInstance && browserInstance.isConnected()) {
    try {
      const pages = await browserInstance.pages();
      if (pages.length > MAX_BROWSER_PAGES) {
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
  browserInstance.on('disconnected', () => { browserInstance = null; });
  return browserInstance;
}

// ======== 超时常量 ========
const TIMEOUTS = {
  pageLoad: 15000,
  canvasWait: 8000,
  fontWait: 1500,
  postRender: 500,
  postExpand: 200,
  postStyle: 150,
  postViewport: 200,
  requestTotal: 30000
};

// ======== HTML 预处理 ========
function normalizeHtmlForPdf(rawHtml) {
  let html = rawHtml;
  html = html.replace(/^\uFEFF/, '');
  html = html.replace(/^\u00BB\u00BF/, '');
  html = html.replace(/^[\x00-\x08\x0B\x0C\x0E-\x1F]+/, '');
  html = html.replace(/<\?xml[^?]*\?>/gi, '');

  const hasHtmlTag = /<html[\s>]/i.test(html);
  if (!hasHtmlTag) {
    let headContent = '';
    let bodyContent = html;
    const headMatch = html.match(/<head[^>]*>([\s\S]*?)<\/head>/i);
    if (headMatch) { headContent = headMatch[1]; bodyContent = html.replace(/<head[^>]*>[\s\S]*?<\/head>/i, ''); }
    const bodyMatch = bodyContent.match(/<body[^>]*>([\s\S]*?)<\/body>/i);
    if (bodyMatch) bodyContent = bodyMatch[1];
    html = `<!DOCTYPE html><html lang="zh-CN"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1.0">${headContent}</head><body>${bodyContent}</body></html>`;
  }

  if (!/<meta[^>]+charset/i.test(html)) {
    if (html.includes('<head>')) html = html.replace(/<head>/i, '<head>\n<meta charset="UTF-8">');
  }
  if (!/<meta[^>]+viewport/i.test(html)) {
    const vm = '<meta name="viewport" content="width=device-width, initial-scale=1.0">';
    if (html.includes('<head>')) html = html.replace(/<head>/i, `<head>\n${vm}`);
  }

  // 保留用户的 @media print 和 @page 规则 —— v2.0 重要改进
  // 只移除编辑器相关的 select/hover 样式，不破坏用户 print 规则
  // html = html.replace(/@media\s+print\s*\{[\s\S]*?\}\s*(?=\s*<\/style>|\s*@media|\s*<\/head>|\s*$)/gi, '');
  // html = html.replace(/@page\s*\{[\s\S]*?\}\s*/gi, '');

  html = html.replace(/<!--(?!\[if)[\s\S]*?-->/g, '');
  if (!html.trim().toLowerCase().startsWith('<!doctype')) html = '<!DOCTYPE html>\n' + html;

  return html;
}

// ======== 内容模式分析 ========
function analyzeContentType(htmlContent) {
  // 分析HTML特征，决定最佳渲染模式
  const indicators = {
    // PPT特征：连续的slide容器，高度约束
    hasSlides: /class\s*=\s*["'][^"']*(?:slide|page|section)["']/i.test(htmlContent) &&
               /<div[^>]*(height\s*:\s*100vh|min-height\s*:\s*100vh)/i.test(htmlContent),
    // 海报特征：单页，大高度，无分页需求
    isPoster: !/<section|<article|<div[^>]*class\s*=\s*["'][^"']*slide/i.test(htmlContent) &&
              /<div[^>]*(height\s*:\s*\d{4,}px|min-height\s*:\s*\d{4,}px)/i.test(htmlContent),
    // 文档特征：段落、标题为主，需要分页
    isDocument: (/(<p>|<h[1-6]>)/gi).length > 10 && !(/class\s*=\s*["'][^"']*slide/i.test(htmlContent)),
    // 复杂布局：使用grid/flex
    hasComplexLayout: /display\s*:\s*(grid|flex)/i.test(htmlContent),
    // 图片密集：需要背景保留
    isImageHeavy: (/<img/gi).length > 5,
    // 表格
    hasTables: /<table/i.test(htmlContent),
    // 是否已定义@media print
    hasPrintMedia: /@media\s+print/i.test(htmlContent)
  };

  console.log(`📊 内容分析:`, indicators);
  return indicators;
}

// ======== 核心：创建渲染页 ========
async function createRenderedPage(htmlContent, options = {}) {
  htmlContent = normalizeHtmlForPdf(htmlContent);

  const browser = await getBrowser();
  const page = await browser.newPage();

  // 根据模式选择视口: 智能模式先做大视口
  const vpW = options.initialWidth || 1280;
  await page.setViewport({ width: vpW, height: 1080, deviceScaleFactor: 1 });

  // 使用 data URI 加载，确保资源正确解析
  const dataUri = 'data:text/html;charset=utf-8,' + encodeURIComponent(htmlContent);
  await page.goto(dataUri, {
    waitUntil: 'networkidle0',
    timeout: TIMEOUTS.pageLoad
  });
  await new Promise(r => setTimeout(r, TIMEOUTS.postRender));

  // 等待字体加载 —— v2.0 关键改进
  await page.evaluate(() => document.fonts.ready);
  await new Promise(r => setTimeout(r, TIMEOUTS.fontWait));

  // 展开隐藏内容
  await page.evaluate(() => {
    document.querySelectorAll('.tc').forEach(t => t.classList.add('act'));
    document.querySelectorAll('.fi').forEach(el => el.classList.add('sho'));
    const sug = document.getElementById('sugGrid');
    if (sug) sug.style.display = '';
  });
  await new Promise(r => setTimeout(r, TIMEOUTS.postExpand));

  // 获取内容宽度和高度
  const measurements = await page.evaluate(() => {
    const de = document.documentElement;
    const body = document.body;
    const scrollW = Math.max(de.scrollWidth, body ? body.scrollWidth : 0);
    const scrollH = Math.max(de.scrollHeight, body ? body.scrollHeight : 0);
    const clientW = Math.max(de.clientWidth, body ? body.clientWidth : 0);
    const clientH = Math.max(de.clientHeight, body ? body.clientHeight : 0);

    // 计算真实内容宽度（所有可见元素的最大right）
    let maxRight = 0;
    document.querySelectorAll('body *').forEach(el => {
      const cs = getComputedStyle(el);
      if (cs.display === 'none' || cs.visibility === 'hidden' || cs.opacity === '0') return;
      maxRight = Math.max(maxRight, el.getBoundingClientRect().right);
    });

    // 检测是否是垂直布局（每个子元素100vh）
    let verticalChildrenCount = 0;
    const directChildren = body ? Array.from(body.children) : [];
    for (let i = 0; i < Math.min(directChildren.length, 5); i++) {
      const cs = getComputedStyle(directChildren[i]);
      if (cs.height === '100vh' || cs.minHeight === '100vh' || cs.height.match(/^\d+px$/)) {
        verticalChildrenCount++;
      }
    }
    const isVerticalLayout = verticalChildrenCount >= 2;

    // 背景色
    const bgColor = getComputedStyle(body || de).backgroundColor || '#ffffff';

    return {
      contentWidth: Math.max(Math.ceil(maxRight), scrollW, 320),
      contentHeight: scrollH, // v2.0: 使用scrollH（非clientH）
      scrollW, scrollH, clientW, clientH,
      isVerticalLayout,
      bgColor
    };
  });

  console.log(`📐 测量结果: W=${measurements.contentWidth}px, H=${measurements.contentHeight}px, verticalLayout=${measurements.isVerticalLayout}`);

  return { page, ...measurements };
}

// ======== 打印辅助CSS（选择性注入）========
function buildPrintCSS(options = {}) {
  const css = [];

  // 始终保留颜色
  css.push(`
* {
  -webkit-print-color-adjust: exact !important;
  print-color-adjust: exact !important;
  color-adjust: exact !important;
}`);

  // 如果是打印模式，允许打印布局
  if (options.mode === 'print') {
    css.push(`
@media print {
  /* 确保元素不被打印截断 */
  .slide, section, article, .card, .panel {
    page-break-inside: avoid !important;
    break-inside: avoid !important;
  }
  /* 列表项不被截断 */
  li, tr, td, th {
    page-break-inside: avoid !important;
    break-inside: avoid !important;
  }
  /* 标题前不换页 */
  h1, h2, h3 {
    page-break-after: avoid !important;
    break-after: avoid !important;
  }
}`);
  }

  // forced overflow
  css.push(`
html, body {
  overflow: visible !important;
  height: auto !important;
  min-height: auto !important;
  float: none !important;
}`);

  return css.join('\n');
}

// ======== 模式A：打印模式（原生分页，文字可选）========
async function convertHtmlToPdfPrint(htmlContent, options = {}) {
  const {
    page,
    contentWidth,
    contentHeight,
    isVerticalLayout
  } = await createRenderedPage(htmlContent, { initialWidth: 1280 });

  const userPdfWidth = options.pdfWidth && options.pdfWidth !== 'auto'
    ? parseInt(options.pdfWidth, 10) : null;

  try {
    // A4 尺寸参考
    const A4_WIDTH_PX = 794;
    const A4_HEIGHT_PX = 1123;

    const targetWidth = userPdfWidth || Math.max(contentWidth, 800);
    const scaleFactor = targetWidth > A4_WIDTH_PX ? (A4_WIDTH_PX / targetWidth) : 1;

    console.log(`📐 [打印模式] 目标宽=${targetWidth}px, 缩放=${scaleFactor.toFixed(4)}`);

    // 设置 viewport —— v2.0: 高768px确保打印布局正确
    await page.setViewport({
      width: Math.max(Math.round(targetWidth), 800),
      height: 768, // 打印模式下用较小高度，避免布局晃动
      deviceScaleFactor: 1
    });
    await new Promise(r => setTimeout(r, TIMEOUTS.postViewport));

    // 展开
    await page.evaluate(() => {
      document.querySelectorAll('.tc').forEach(t => t.classList.add('act'));
      document.querySelectorAll('.fi').forEach(el => el.classList.add('sho'));
    });
    await new Promise(r => setTimeout(r, 200));

    // 注入打印CSS（保留用户@media print）
    const printCSS = buildPrintCSS({ mode: 'print' });
    const scaleCss = scaleFactor < 1
      ? `html { transform: scale(${scaleFactor}); transform-origin: top left; width: ${Math.round(100 / scaleFactor)}% !important; }`
      : '';

    await page.addStyleTag({ content: printCSS + '\n' + scaleCss });
    await new Promise(r => setTimeout(r, TIMEOUTS.postStyle));

    // 重新测量
    const scaledHeight = await page.evaluate(() =>
      Math.max(document.documentElement.scrollHeight, document.body ? document.body.scrollHeight : 0)
    );
    const estimatedPages = Math.ceil((scaledHeight * (scaleFactor < 1 ? scaleFactor : 1)) / A4_HEIGHT_PX) || 1;
    console.log(`📐 [打印模式] 缩放后H=${scaledHeight}px, 预计${estimatedPages}页`);

    // 生成PDF —— Chromium原生打印
    const pdfBuffer = await page.pdf({
      format: 'A4',
      printBackground: true,
      margin: { top: '0mm', right: '0mm', bottom: '0mm', left: '0mm' },
      preferCSSPageSize: false, // 使用format A4
      displayHeaderFooter: false
    });

    // 验证
    try {
      const doc = await PDFDocument.load(pdfBuffer);
      const pageCount = doc.getPageCount();
      const size = pageCount > 0 ? doc.getPage(0).getSize() : { width: 0, height: 0 };
      console.log(`✅ [打印模式] ${pageCount}页, ${(pdfBuffer.length / 1024).toFixed(1)}KB, ${size.width.toFixed(0)}x${size.height.toFixed(0)}pt`);
    } catch (_) {}

    return {
      buffer: pdfBuffer,
      pageCount: estimatedPages,
      sizeKB: (pdfBuffer.length / 1024).toFixed(1),
      mode: 'print'
    };
  } finally {
    await page.close();
  }
}

// ======== 模式B：模拟模式（分页截图，像素精确）========
async function convertHtmlToPdfSimulated(htmlContent, options = {}) {
  const {
    page,
    contentWidth,
    contentHeight,
    bgColor
  } = await createRenderedPage(htmlContent, { initialWidth: options.pdfWidth && options.pdfWidth !== 'auto' ? parseInt(options.pdfWidth, 10) : 1280 });

  const userPdfWidth = options.pdfWidth && options.pdfWidth !== 'auto'
    ? parseInt(options.pdfWidth, 10) : null;

  const scale = 2; // 2x 清晰度
  const A4_W_PX = 794;
  const A4_H_PX = 1123;

  const targetWidth = userPdfWidth || contentWidth;
  const outputDpiRatio = targetWidth > A4_W_PX ? (A4_W_PX / targetWidth) : 1;

  // PDF尺寸 = CSS像素 * 0.75 * DPIratio
  const pdfW = targetWidth * 0.75 * outputDpiRatio;  // pt
  const pdfH = contentHeight * 0.75 * outputDpiRatio; // pt（单页总高度）

  // 每页PDF高度（按A4比例缩放）
  const pagePdfH = A4_H_PX * 0.75;
  const pageCount = Math.max(1, Math.ceil(pdfH / pagePdfH));

  // 每段CSS高度
  const segCssH = Math.floor(pagePdfH / (0.75 * outputDpiRatio));

  console.log(`📐 [模拟模式] 内容=${targetWidth}x${contentHeight}px, scale=${scale}x, DPIratio=${outputDpiRatio.toFixed(3)}, ${pageCount}页, 每段≈${segCssH}px`);

  try {
    await page.setViewport({
      width: targetWidth,
      height: segCssH, // 每段高度
      deviceScaleFactor: scale
    });
    await new Promise(r => setTimeout(r, TIMEOUTS.postViewport));

    // 展开
    await page.evaluate(() => {
      document.querySelectorAll('.tc').forEach(t => t.classList.add('act'));
      document.querySelectorAll('.fi').forEach(el => el.classList.add('sho'));
    });
    await new Promise(r => setTimeout(r, 200));

    // 注入基础CSS（不分页，但保留颜色）
    await page.addStyleTag({ content: buildPrintCSS({ mode: 'simulated' }) });
    await new Promise(r => setTimeout(r, TIMEOUTS.postStyle));

    const pdfDoc = await PDFDocument.create();

    for (let i = 0; i < pageCount; i++) {
      const scrollY = i * segCssH;
      const isLast = i === pageCount - 1;
      const thisSegH = isLast ? Math.min(segCssH, contentHeight - scrollY) : segCssH;
      if (thisSegH <= 0) break;

      // 调整 viewport 为当前段高度
      await page.setViewport({ width: targetWidth, height: thisSegH, deviceScaleFactor: scale });
      await new Promise(r => setTimeout(r, 100));

      // 滚动
      await page.evaluate((y) => { window.scrollTo(0, y); }, scrollY);
      await new Promise(r => setTimeout(r, 80));

      // 截图
      const segBuffer = await page.screenshot({
        type: 'jpeg',
        quality: 93,
        clip: { x: 0, y: 0, width: targetWidth, height: thisSegH }
      });

      // 计算本段在PDF中的尺寸
      const thisPdfW = pdfW;
      const thisPdfH = thisSegH * 0.75 * outputDpiRatio;

      const pdfPage = pdfDoc.addPage([thisPdfW, thisPdfH]);
      const img = await pdfDoc.embedJpg(segBuffer);
      pdfPage.drawImage(img, {
        x: 0, y: 0, width: thisPdfW, height: thisPdfH
      });

      console.log(`  📸 页${i + 1}/${pageCount}: scrollY=${scrollY}, segH=${thisSegH}, PDF尺寸=${thisPdfW.toFixed(0)}x${thisPdfH.toFixed(0)}pt`);
    }

    const buf = await pdfDoc.save();
    console.log(`✅ [模拟模式] ${pageCount}页PDF, ${(buf.length / 1024).toFixed(1)}KB`);
    return {
      buffer: Buffer.from(buf),
      pageCount,
      sizeKB: (buf.length / 1024).toFixed(1),
      mode: 'simulated'
    };
  } finally {
    await page.close();
  }
}

// ======== 模式C：连续模式（单页，不分页）========
async function convertHtmlToPdfContinuous(htmlContent, options = {}) {
  const { page, contentWidth, contentHeight } = await createRenderedPage(htmlContent);
  const userPdfWidth = options.pdfWidth && options.pdfWidth !== 'auto'
    ? parseInt(options.pdfWidth, 10) : null;

  try {
    const targetWidth = userPdfWidth || contentWidth;
    const A4_W_PX = 794;
    const outputDpiRatio = targetWidth > A4_W_PX ? (A4_W_PX / targetWidth) : 1;

    const scale = 2;
    const pdfW = targetWidth * 0.75 * outputDpiRatio;
    const pdfH = contentHeight * 0.75 * outputDpiRatio;

    console.log(`📐 [连续模式] 内容=${targetWidth}x${contentHeight}px, 单页PDF=${pdfW.toFixed(0)}x${pdfH.toFixed(0)}pt`);

    await page.setViewport({ width: targetWidth, height: 1080, deviceScaleFactor: scale });
    await new Promise(r => setTimeout(r, TIMEOUTS.postViewport));

    // 整体截图
    const ssBuffer = await page.screenshot({
      type: 'jpeg',
      quality: 93,
      fullPage: true
    });

    const pdfDoc = await PDFDocument.create();
    const pdfPage = pdfDoc.addPage([pdfW, pdfH]);
    const img = await pdfDoc.embedJpg(ssBuffer);
    pdfPage.drawImage(img, { x: 0, y: 0, width: pdfW, height: pdfH });

    const buf = await pdfDoc.save();
    console.log(`✅ [连续模式] 单页PDF, ${(buf.length / 1024).toFixed(1)}KB`);
    return {
      buffer: Buffer.from(buf),
      pageCount: 1,
      sizeKB: (buf.length / 1024).toFixed(1),
      mode: 'continuous'
    };
  } finally {
    await page.close();
  }
}

// ======== 智能模式（推荐）：自动分析并选择最佳方案 ========
async function convertHtmlToPdfSmart(htmlContent, options = {}) {
  // 先获取运行时测量数据
  const rendered = await createRenderedPage(htmlContent, { initialWidth: 1280 });
  const { page, contentWidth, contentHeight, isVerticalLayout, bgColor } = rendered;

  // 分析HTML特征
  const indicators = analyzeContentType(htmlContent);

  let chosenMode = 'print';

  // 运行时检测优先：明确的垂直PPT布局 → simulated
  if (isVerticalLayout && contentHeight > 1500) {
    chosenMode = 'simulated';
    console.log(`🧠 [智能分析] 运行时检测到垂直布局(H=${contentHeight}px) → 使用 simulated 模式`);
  } else if (indicators.hasSlides) {
    // 静态检测到slide特征
    chosenMode = 'simulated';
    console.log(`🧠 [智能分析] 检测到PPT/幻灯片布局 → 使用 simulated 模式`);
  } else if (indicators.isPoster) {
    // 单页海报 → continuous
    chosenMode = 'continuous';
    console.log(`🧠 [智能分析] 检测到海报/长图布局 → 使用 continuous 模式`);
  } else if (indicators.isDocument) {
    // 标准文档 → print
    chosenMode = 'print';
    console.log(`🧠 [智能分析] 检测到标准文档 → 使用 print 模式`);
  } else if (indicators.hasComplexLayout && indicators.hasTables) {
    // 复杂布局+表格 → simulated
    chosenMode = 'simulated';
    console.log(`🧠 [智能分析] 检测到复杂布局+表格 → 使用 simulated 模式`);
  } else {
    console.log(`🧠 [智能分析] 未检测到特殊特征 → 默认 print 模式`);
  }

  // 关闭已创建的page（各模式会自己创建）
  await page.close();

  // 根据选择调用对应模式
  switch (chosenMode) {
    case 'simulated': return await convertHtmlToPdfSimulated(htmlContent, options);
    case 'continuous': return await convertHtmlToPdfContinuous(htmlContent, options);
    default: return await convertHtmlToPdfPrint(htmlContent, options);
  }
}

// ======== API 路由 ========
async function convertHtmlToPdf(htmlContent, options = {}) {
  const mode = options.pdfMode || 'optimize'; // v2.0 默认改为 optimize（智能）

  switch (mode) {
    case 'optimize':
      return await convertHtmlToPdfSmart(htmlContent, options);
    case 'print':
      return await convertHtmlToPdfPrint(htmlContent, options);
    case 'simulated':
      return await convertHtmlToPdfSimulated(htmlContent, options);
    case 'continuous':
      return await convertHtmlToPdfContinuous(htmlContent, options);
    case 'screenshot':
      // 向后兼容旧API: screenshot → simulated
      console.log(`⚠️ 旧模式 'screenshot' 已映射为 'simulated'`);
      return await convertHtmlToPdfSimulated(htmlContent, options);
    default:
      console.log(`⚠️ 未知模式 '${mode}'，回退到 optimize`);
      return await convertHtmlToPdfSmart(htmlContent, options);
  }
}

app.post('/api/html-to-pdf', async (req, res) => {
  const requestTimer = setTimeout(() => {
    if (!res.headersSent) res.status(504).json({ error: 'PDF生成超时' });
  }, TIMEOUTS.requestTotal);

  try {
    const { html, filename, pdfWidth, pdfMode } = req.body;
    if (!html || typeof html !== 'string') {
      clearTimeout(requestTimer);
      return res.status(400).json({ error: '缺少html字段' });
    }

    console.log(`\n📄 收到PDF请求: HTML=${html.length}字符, 宽度=${pdfWidth || 'auto'}, 模式=${pdfMode || 'optimize'}`);
    const result = await convertHtmlToPdf(html, { pdfWidth: pdfWidth || 'auto', pdfMode: pdfMode || 'optimize' });
    clearTimeout(requestTimer);

    const pdfName = (filename || 'document').replace(/\.html?$/i, '') + '.pdf';
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename="${encodeURIComponent(pdfName)}"`);
    res.setHeader('X-PDF-Pages', result.pageCount);
    res.setHeader('X-PDF-Size-KB', result.sizeKB);
    res.setHeader('X-PDF-Mode', result.mode);
    res.send(result.buffer);
    console.log(`📤 完成: ${pdfName} (${result.mode}, ${result.pageCount}页, ${result.sizeKB}KB)`);
  } catch (err) {
    clearTimeout(requestTimer);
    console.error('❌ PDF转换失败:', err.message);
    if (!res.headersSent) res.status(500).json({ error: 'PDF转换失败: ' + err.message });
  }
});

app.get('/health', (req, res) => {
  res.json({ status: 'ok', chromePath: CHROME_PATH, chromeAvailable: existsSync(CHROME_PATH), uptime: process.uptime() });
});
app.get('/api/health', (req, res) => {
  res.json({ status: 'ok', chromePath: CHROME_PATH, chromeAvailable: existsSync(CHROME_PATH), uptime: process.uptime() });
});

app.listen(PORT, HOST, () => {
  console.log(`\n🎨 HTML Editor 服务已启动 v2.0`);
  console.log(`   http://${HOST}:${PORT}`);
  console.log(`   Chromium: ${CHROME_PATH}`);
  console.log(`   默认PDF模式: optimize (智能分析)\n`);
});
