#!/usr/bin/env node
/**
 * HTML Editor 后端服务
 * - 提供静态文件服务
 * - 提供 /api/html-to-pdf 接口，基于 Puppeteer + Chromium 将 HTML 转为 PDF
 *
 * ★ PDF 生成策略（基于行业最佳实践和全网搜索总结）
 * ┌─────────────────────────────────────────────────────────────────────────┐
 * │  模式          │  原理                  │  适用场景                │
 * ├─────────────────────────────────────────────────────────────────────────┤
 * │  print (默认)   │  Puppeteer page.pdf()  │  文档、报告（分页，可选字）│
 * │  screenshot    │  全页截图→嵌入PDF      │  PPT、海报（像素精确）    │
 * └─────────────────────────────────────────────────────────────────────────┘
 *
 * ★★★ 核心bug修复：
 * 1. 【打印模式】不强行拼接成单页，而是基于A4格式正常分页，避免文字被切断
 *    - 先检测内容宽度，然后通过CSS transform:scale整体缩放适配A4宽度
 *    - 让 Chromium 的 page.pdf({format:'A4'}) 自然处理分页
 * 2. 【截图模式】Y轴拼接方向错误修复（pdf-lib坐标系原点在左下角，当前代码从底部往上导致内容超出页面）
 *    - 改为从顶部（y = pdfH - 本段顶部偏移量）往下贴
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
  '--font-cache-shared-handle'
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
  canvasWait: 5000,
  postRender: 500,
  postExpand: 150,
  postStyle: 100,
  postViewport: 150,
  requestTotal: 25000
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

  html = html.replace(/@media\s+print\s*\{[\s\S]*?\}\s*(?=\s*<\/style>|\s*@media|\s*<\/head>|\s*$)/gi, '');
  html = html.replace(/@page\s*\{[\s\S]*?\}\s*/gi, '');
  html = html.replace(/<!--(?!\[if)[\s\S]*?-->/g, '');
  if (!html.trim().toLowerCase().startsWith('<!doctype')) html = '<!DOCTYPE html>\n' + html;

  return html;
}

// ======== 核心渲染函数 ========
async function createRenderedPage(htmlContent) {
  htmlContent = normalizeHtmlForPdf(htmlContent);

  const browser = await getBrowser();
  const page = await browser.newPage();

  // 先用大视口加载，让内容自然展开
  await page.setViewport({ width: 1920, height: 1080, deviceScaleFactor: 1 });
  await page.setContent(htmlContent, {
    waitUntil: 'networkidle0',
    timeout: TIMEOUTS.pageLoad
  });
  await new Promise(r => setTimeout(r, TIMEOUTS.postRender));

  // 展开隐藏内容
  await page.evaluate(() => {
    document.querySelectorAll('.tc').forEach(t => t.classList.add('act'));
    document.querySelectorAll('.fi').forEach(el => el.classList.add('sho'));
    const sug = document.getElementById('sugGrid');
    if (sug) sug.style.display = '';
  });
  await new Promise(r => setTimeout(r, TIMEOUTS.postExpand));

  // 获取背景和测量信息
  const measurements = await page.evaluate(() => {
    const de = document.documentElement;
    const body = document.body;
    // 内容实际宽度和高度
    const scrollW = Math.max(de.scrollWidth, body ? body.scrollWidth : 0);
    const scrollH = Math.max(de.scrollHeight, body ? body.scrollHeight : 0);
    // 获取所有可见元素的最大right（真正内容宽度）
    let maxRight = 0;
    document.querySelectorAll('body *').forEach(el => {
      const cs = getComputedStyle(el);
      if (cs.display === 'none' || cs.visibility === 'hidden' || cs.opacity === '0') return;
      maxRight = Math.max(maxRight, el.getBoundingClientRect().right);
    });
    const contentWidth = Math.max(Math.ceil(maxRight), scrollW, 320);
    const contentHeight = Math.max(scrollH, 100);

    // 背景色
    const bgColor = getComputedStyle(body || de).backgroundColor || '#ffffff';

    return { contentWidth, contentHeight, maxRight, scrollW, bgColor };
  });

  // 底部增加2px填充条，消除 Chromium 底部白缝
  await page.evaluate((bg) => {
    const filler = document.createElement('div');
    filler.style.cssText = `height:4px;width:100%;background:${bg};flex-shrink:0;`;
    document.body.appendChild(filler);
  }, measurements.bgColor);

  // 重新测量高度
  const finalHeight = await page.evaluate(() =>
    Math.max(document.documentElement.scrollHeight, document.body ? document.body.scrollHeight : 0, 100)
  );

  console.log(`📐 测量结果: 内容宽=${measurements.contentWidth}px, 内容高=${finalHeight}px, maxRight=${measurements.maxRight}`);

  return { page, contentWidth: measurements.contentWidth, contentHeight: finalHeight, bgColor: measurements.bgColor };
}

// ======== 打印覆盖CSS ========
const PRINT_CSS = `
@media print {
  *, *::before, *::after {
    -webkit-print-color-adjust: exact !important;
    print-color-adjust: exact !important;
    color-adjust: exact !important;
  }
}
* {
  -webkit-print-color-adjust: exact !important;
  print-color-adjust: exact !important;
  color-adjust: exact !important;
}
html, body {
  overflow: visible !important;
  height: auto !important;
  min-height: auto !important;
  float: none !important;
}
`;

// ======== 模式A：打印模式（基于A4分页，文字可选） ========
async function convertHtmlToPdfPrint(htmlContent, options = {}) {
  const { page, contentWidth, contentHeight, bgColor } = await createRenderedPage(htmlContent);
  const userPdfWidth = options.pdfWidth && options.pdfWidth !== 'auto'
    ? parseInt(options.pdfWidth, 10) : null;

  try {
    // A4 页面尺寸（CSS像素，约 210mm x 297mm）
    const A4_WIDTH_PX = 794;   // 8.27英寸 * 96 DPI
    const A4_HEIGHT_PX = 1123; // 11.69英寸 * 96 DPI
    const MARGIN = 0;          // 0边距，内容最大化

    // 确定目标渲染宽度
    const targetWidth = userPdfWidth || contentWidth;

    // ★★★ 核心策略：如果内容宽度超过 A4 宽度，先通过 CSS transform 缩放页面
    // 这样 page.pdf() 看到的内容已经是适配好宽度的，然后再用 format:'A4' 自然分页
    let scaleFactor = 1;
    let needsScale = false;

    if (targetWidth > A4_WIDTH_PX) {
      scaleFactor = A4_WIDTH_PX / targetWidth;
      needsScale = true;
      console.log(`📐 [打印模式] 内容宽度 ${targetWidth}px 超过 A4(${A4_WIDTH_PX}px)，缩放因子=${scaleFactor.toFixed(4)}`);
    } else {
      console.log(`📐 [打印模式] 内容宽度 ${targetWidth}px 在 A4 范围内，无需缩放`);
    }

    // ★ 设置 viewport 为内容实际宽度，这样渲染更准确
    await page.setViewport({
      width: Math.max(Math.round(targetWidth), 800),
      height: 1080,
      deviceScaleFactor: 1
    });
    await new Promise(r => setTimeout(r, TIMEOUTS.postViewport));

    // 展开隐藏内容
    await page.evaluate(() => {
      document.querySelectorAll('.tc').forEach(t => t.classList.add('act'));
      document.querySelectorAll('.fi').forEach(el => el.classList.add('sho'));
    });
    await new Promise(r => setTimeout(r, 200));

    // ★ 注入缩放 CSS（如果内容太宽）以及打印保真 CSS
    const scaleCss = needsScale
      ? `html { transform: scale(${scaleFactor}); transform-origin: top left; width: ${Math.round(100 / scaleFactor)}% !important; }`
      : '';

    await page.addStyleTag({ content: scaleCss + PRINT_CSS });
    await new Promise(r => setTimeout(r, TIMEOUTS.postStyle));

    // 重新测量缩放后的高度
    const scaledHeight = await page.evaluate(() =>
      Math.max(document.documentElement.scrollHeight, document.body ? document.body.scrollHeight : 0)
    );
    const estimatedPages = Math.ceil((scaledHeight * (needsScale ? scaleFactor : 1)) / A4_HEIGHT_PX) || 1;

    console.log(`📐 [打印模式] 缩放后高度=${scaledHeight}px, 预计分页=${estimatedPages}页`);

    // ★ 生成 PDF —— 使用 A4 格式，让 Chromium 自然分页
    const pdfBuffer = await page.pdf({
      format: 'A4',
      printBackground: true,
      margin: { top: MARGIN, right: MARGIN, bottom: MARGIN, left: MARGIN },
      preferCSSPageSize: false,
      displayHeaderFooter: false
    });

    // 验证
    try {
      const doc = await PDFDocument.load(pdfBuffer);
      const pageCount = doc.getPageCount();
      const size = pageCount > 0 ? doc.getPage(0).getSize() : { width: 0, height: 0 };
      console.log(`✅ [打印模式] PDF生成成功: ${pageCount}页, ${(pdfBuffer.length / 1024).toFixed(1)}KB, 尺寸:${size.width.toFixed(0)}x${size.height.toFixed(0)}pt`);
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

// ======== 模式B：截图模式（像素精确）========
async function convertHtmlToPdfScreenshot(htmlContent, options = {}) {
  const { page, contentWidth, contentHeight } = await createRenderedPage(htmlContent);
  const userPdfWidth = options.pdfWidth && options.pdfWidth !== 'auto'
    ? parseInt(options.pdfWidth, 10) : null;
  const scale = 2;

  try {
    const targetWidth = userPdfWidth || contentWidth;
    const MAX_DIM = 16384;
    const maxCssH = Math.floor(MAX_DIM / scale) - 50;

    const needsSeg = contentHeight > maxCssH;
    const segH = needsSeg ? maxCssH : contentHeight;
    const segCount = needsSeg ? Math.ceil(contentHeight / segH) : 1;

    console.log(`📐 [截图模式] 内容=${targetWidth}x${contentHeight}px, scale=${scale}x, 分段=${needsSeg}, 段数=${segCount}`);

    await page.setViewport({
      width: targetWidth,
      height: needsSeg ? segH : contentHeight,
      deviceScaleFactor: scale
    });
    await new Promise(r => setTimeout(r, TIMEOUTS.postViewport));

    // 展开隐藏内容
    await page.evaluate(() => {
      document.querySelectorAll('.tc').forEach(t => t.classList.add('act'));
      document.querySelectorAll('.fi').forEach(el => el.classList.add('sho'));
    });
    await new Promise(r => setTimeout(r, 200));

    // ----- 单段直接截图 -----
    if (!needsSeg) {
      const ss = await page.screenshot({ type: 'jpeg', quality: 95, fullPage: true });
      if (!ss || ss.length === 0) throw new Error('截图返回空数据');

      const pdfW = targetWidth * 0.75;
      const pdfH = contentHeight * 0.75;
      const pdfDoc = await PDFDocument.create();
      const img = await pdfDoc.embedJpg(ss);
      const pdfPage = pdfDoc.addPage([pdfW, pdfH]);
      // pdf-lib: y=0 是底部，所以图片要从底部放（从下往上画的内容实际在底部）
      // 但 fullPage 截图是整个页面，直接铺满整页即可
      pdfPage.drawImage(img, { x: 0, y: 0, width: pdfW, height: pdfH });

      const buf = await pdfDoc.save();
      console.log(`✅ [截图模式] 单页PDF: ${(buf.length / 1024).toFixed(1)}KB, ${pdfW.toFixed(0)}x${pdfH.toFixed(0)}pt`);
      return { buffer: Buffer.from(buf), pageCount: 1, sizeKB: (buf.length / 1024).toFixed(1), mode: 'screenshot' };
    }

    // ----- 多段截图拼接 -----
    const pdfW = targetWidth * 0.75;
    const pdfH = contentHeight * 0.75;
    const pdfDoc = await PDFDocument.create();
    const pdfPage = pdfDoc.addPage([pdfW, pdfH]);

    // ★★★ 修复Y轴方向：pdf-lib坐标系原点在左下角（y=0），y向上增大
    // 第1段（最顶部，scrollY=0）在PDF中应该在 y = pdfH - segPdfH 处开始
    // 第i段的位置 = pdfH - (i+1)*segPdfH （完整段）或 pdfH - (累加高度+本段高)

    for (let i = 0; i < segCount; i++) {
      const scrollY = i * segH;
      const isLast = i === segCount - 1;
      const thisSegH = isLast ? (contentHeight - scrollY) : segH;
      const segPdfH = thisSegH * 0.75;

      // 调整 viewport 为当前段高度
      await page.setViewport({ width: targetWidth, height: thisSegH, deviceScaleFactor: scale });
      await new Promise(r => setTimeout(r, 80));

      // 滚动到位置
      await page.evaluate((y) => { window.scrollTo(0, y); }, scrollY);
      await new Promise(r => setTimeout(r, 60));

      // 截图
      let segBuffer;
      try {
        segBuffer = await page.screenshot({ type: 'jpeg', quality: 95, clip: { x: 0, y: 0, width: targetWidth, height: thisSegH } });
      } catch (e) {
        segBuffer = await page.screenshot({ type: 'jpeg', quality: 90, fullPage: true });
      }
      if (!segBuffer || segBuffer.length === 0) throw new Error(`段${i+1}截图失败`);

      // ★ 计算Y位置：从顶部往下
      // 第i段的顶部在PDF中的位置 = pdfH - (scrollY + thisSegH) * 0.75
      // = pdfH - (i*segH + thisSegH) * 0.75
      // 这确保第0段在页面最顶部
      const topY = pdfH - (scrollY + thisSegH) * 0.75;

      const img = await pdfDoc.embedJpg(segBuffer);
      pdfPage.drawImage(img, {
        x: 0,
        y: topY,
        width: pdfW,
        height: segPdfH
      });

      console.log(`  📸 段${i+1}/${segCount}: scrollY=${scrollY}, 段高=${thisSegH}, PDF y=${topY.toFixed(1)}..${(topY + segPdfH).toFixed(1)}`);
    }

    const buf = await pdfDoc.save();
    console.log(`✅ [截图模式] 拼接PDF: ${segCount}段, ${(buf.length / 1024).toFixed(1)}KB`);
    return { buffer: Buffer.from(buf), pageCount: 1, sizeKB: (buf.length / 1024).toFixed(1), mode: 'screenshot' };
  } finally {
    await page.close();
  }
}

// ======== API 路由 ========
async function convertHtmlToPdf(htmlContent, options = {}) {
  const mode = options.pdfMode || 'print';

  if (mode === 'screenshot') {
    try { return await convertHtmlToPdfScreenshot(htmlContent, options); }
    catch (err) {
      console.warn(`⚠️ 截图模式失败: ${err.message}，降级到打印模式`);
      return await convertHtmlToPdfPrint(htmlContent, options);
    }
  }
  return await convertHtmlToPdfPrint(htmlContent, options);
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

    console.log(`📄 请求: HTML长度=${html.length}, 宽度=${pdfWidth || 'auto'}, 模式=${pdfMode || 'print'}`);
    const result = await convertHtmlToPdf(html, { pdfWidth: pdfWidth || 'auto', pdfMode: pdfMode || 'print' });
    clearTimeout(requestTimer);

    const pdfName = (filename || 'document').replace(/\.html?$/i, '') + '.pdf';
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename="${encodeURIComponent(pdfName)}"`);
    res.setHeader('X-PDF-Pages', result.pageCount);
    res.setHeader('X-PDF-Size-KB', result.sizeKB);
    res.setHeader('X-PDF-Mode', result.mode);
    res.send(result.buffer);
    console.log(`📤 发送: ${pdfName} (${result.mode}, ${result.pageCount}页, ${result.sizeKB}KB)`);
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
  console.log(`\n🎨 HTML Editor 服务已启动`);
  console.log(`   http://${HOST}:${PORT}`);
  console.log(`   Chromium: ${CHROME_PATH}`);
  console.log(`   默认PDF模式: print (A4分页,文字可选)\n`);
});
