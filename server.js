#!/usr/bin/env node
/**
 * HTML Editor 后端服务
 * - 提供静态文件服务
 * - 提供 /api/html-to-pdf 接口
 *
 * 【分页PDF生成】每个 .slide 生成一个单独的PDF页面
 * 页面高度 = slide内容实际高度（无空白拉伸！）
 */

import express from 'express';
import cors from 'cors';
import puppeteer from 'puppeteer-core';
import { mkdirSync, existsSync } from 'fs';
import { join } from 'path';

// ======== Express 应用 ========
const app = express();
app.use(cors());
app.use(express.json({ limit: '50mb' }));
app.use(express.static(join(process.cwd())));

const PORT = process.env.PORT || 3100;
const HOST = '0.0.0.0';

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

async function getBrowser() {
  if (browserInstance && browserInstance.isConnected()) {
    const age = Date.now() - browserLaunchTime;
    if (age > BROWSER_MAX_AGE) {
      try { await browserInstance.close(); } catch (_) {}
      browserInstance = null;
    }
  }
  if (!browserInstance || !browserInstance.isConnected()) {
    console.log(`🚀 启动 Chromium: ${CHROME_PATH}`);
    browserLaunchTime = Date.now();
    browserInstance = await puppeteer.launch({
      executablePath: CHROME_PATH,
      headless: 'new',
      args: CHROME_ARGS
    });
    browserInstance.on('disconnected', () => { browserInstance = null; });
  }
  return browserInstance;
}

const TIMEOUTS = {
  pageLoad: 30000,
  fontWait: 3000,
  renderWait: 1000,
  requestTotal: 120000
};

// ======== PDF 渲染核心 ========
async function convertHtmlToPptPdf(htmlContent, filename = 'document') {
  const browser = await getBrowser();

  // 第一步：用一个大页面测量每个slide的真实高度
  const measurePage = await browser.newPage();
  let slideMeasurements = [];

  try {
    // 注入测量专用CSS：让内容决定高度
    const measureCss = `
<style id="measure-css">
  * { -webkit-print-color-adjust: exact !important; print-color-adjust: exact !important; }
  html, body { margin: 0 !important; padding: 0 !important; overflow: visible !important; }
  .slide, section.slide, article.slide, div.slide {
    display: block !important;
    width: 100% !important;
    height: auto !important;
    min-height: auto !important;
    max-height: none !important;
    overflow: visible !important;
    margin: 0 !important;
    padding: 0 !important;
  }
  #particle-canvas, .dots, .prog, .arrow { display: none !important; }
  .ani { opacity: 1 !important; animation: none !important; transform: none !important; }
  * { animation: none !important; transition: none !important; }
</style>`;

    // 注入测量CSS
    let measureHtml = htmlContent;
    if (/<\/head>/i.test(measureHtml)) {
      measureHtml = measureHtml.replace(/<\/head>/i, measureCss + '\n</head>');
    } else {
      measureHtml = measureCss + '\n' + measureHtml;
    }

    await measurePage.setViewport({ width: 1920, height: 1080, deviceScaleFactor: 1 });
    await measurePage.setContent(measureHtml, {
      waitUntil: ['networkidle0', 'domcontentloaded'],
      timeout: TIMEOUTS.pageLoad
    });

    // 等待字体
    await measurePage.evaluate(() => {
      if (document.fonts && document.fonts.ready) return document.fonts.ready;
      return Promise.resolve();
    });
    await new Promise(r => setTimeout(r, TIMEOUTS.fontWait));

    // 冻结动画
    await measurePage.evaluate(() => {
      document.querySelectorAll('.ani, .animated, [class*="ani"]').forEach(el => {
        el.style.opacity = '1';
        el.style.visibility = 'visible';
        el.style.animation = 'none';
        el.style.transform = 'none';
        el.style.transition = 'none';
      });
      document.querySelectorAll('*').forEach(el => {
        const cs = getComputedStyle(el);
        if ((cs.opacity === '0' || cs.visibility === 'hidden') &&
            (cs.animationName !== 'none' || cs.transitionDuration !== '0s')) {
          el.style.opacity = '1';
          el.style.visibility = 'visible';
          el.style.animation = 'none';
          el.style.transform = 'none';
        }
      });
    });
    await new Promise(r => setTimeout(r, 500));

    // 测量每个slide
    slideMeasurements = await measurePage.evaluate(() => {
      const slides = document.querySelectorAll('.slide, section.slide, article.slide, div.slide');
      const results = [];
      slides.forEach((slide, index) => {
        let maxBottom = 0;
        let maxRight = 0;
        const slideRect = slide.getBoundingClientRect();
        const allElements = slide.querySelectorAll('*');

        allElements.forEach(el => {
          const cs = getComputedStyle(el);
          if (cs.display === 'none' || cs.visibility === 'hidden' || cs.opacity === '0') return;
          try {
            const rect = el.getBoundingClientRect();
            const relBottom = rect.bottom - slideRect.top;
            const relRight = rect.right - slideRect.left;
            maxBottom = Math.max(maxBottom, relBottom);
            maxRight = Math.max(maxRight, relRight);
          } catch (_) {}
        });

        if (maxBottom === 0) {
          maxBottom = slideRect.height;
          maxRight = slideRect.width;
        }

        maxBottom += 4; // 安全边距
        maxBottom = Math.max(maxBottom, 50);

        results.push({
          index,
          width: Math.max(Math.ceil(maxRight), 320),
          height: Math.ceil(maxBottom)
        });
      });
      return results;
    });

    console.log(`📊 检测到 ${slideMeasurements.length} 个 slide:`);
    slideMeasurements.forEach(s => {
      console.log(`   Slide ${s.index + 1}: ${s.width}x${s.height}px`);
    });

  } finally {
    await measurePage.close();
  }

  if (slideMeasurements.length === 0) {
    throw new Error('未检测到 .slide 元素，请用 <section class="slide"> 包裹每页内容');
  }

  // 第二步：逐页生成PDF
  const allPdfs = [];
  const pageWidth = Math.max(...slideMeasurements.map(s => s.width), 1920);

  for (let i = 0; i < slideMeasurements.length; i++) {
    const slideHeight = slideMeasurements[i].height;
    const page = await browser.newPage();

    try {
      // 为这一页生成专门的HTML：只保留当前slide并设置精确高度
      const singleSlideCss = `
<style id="single-slide-css">
  * { -webkit-print-color-adjust: exact !important; print-color-adjust: exact !important; }
  html, body {
    margin: 0 !important;
    padding: 0 !important;
    overflow: hidden !important;
    width: ${pageWidth}px !important;
    height: ${slideHeight}px !important;
  }
  .slide, section.slide, article.slide, div.slide {
    display: block !important;
    width: 100% !important;
    height: ${slideHeight}px !important;
    min-height: ${slideHeight}px !important;
    max-height: ${slideHeight}px !important;
    overflow: hidden !important;
    margin: 0 !important;
    padding: 0 !important;
    position: relative !important;
    box-sizing: border-box !important;
  }
  /* 隐藏其他slide */
  .slide ~ .slide, section.slide ~ section.slide {
    display: none !important;
  }
  #particle-canvas, .dots, .prog, .arrow { display: none !important; }
  .ani { opacity: 1 !important; animation: none !important; transform: none !important; }
  * { animation: none !important; transition: none !important; }
</style>`;

      let singleHtml = htmlContent;
      if (/<\/head>/i.test(singleHtml)) {
        singleHtml = singleHtml.replace(/<\/head>/i, singleSlideCss + '\n</head>');
      } else {
        singleHtml = singleSlideCss + '\n' + singleHtml;
      }

      await page.setViewport({ width: pageWidth, height: slideHeight, deviceScaleFactor: 1 });
      await page.setContent(singleHtml, {
        waitUntil: ['networkidle0', 'domcontentloaded'],
        timeout: TIMEOUTS.pageLoad
      });

      // 等待字体和渲染
      await page.evaluate(() => {
        if (document.fonts && document.fonts.ready) return document.fonts.ready;
        return Promise.resolve();
      });
      await new Promise(r => setTimeout(r, 1500));

      // 冻结动画
      await page.evaluate(() => {
        document.querySelectorAll('.ani, .animated').forEach(el => {
          el.style.opacity = '1';
          el.style.visibility = 'visible';
          el.style.animation = 'none';
          el.style.transform = 'none';
        });
        document.querySelectorAll('*').forEach(el => {
          const cs = getComputedStyle(el);
          if (cs.opacity === '0' && cs.animationName !== 'none') {
            el.style.opacity = '1';
            el.style.animation = 'none';
          }
        });
      });
      await new Promise(r => setTimeout(r, 500));

      // 生成此slide的PDF
      const pdfBuffer = await page.pdf({
        width: pageWidth,
        height: slideHeight,
        printBackground: true,
        margin: { top: 0, right: 0, bottom: 0, left: 0 },
        preferCSSPageSize: false,
        scale: 1
      });

      allPdfs.push({ buffer: pdfBuffer, width: pageWidth, height: slideHeight });
      console.log(`  ✅ Slide ${i + 1}: ${pageWidth}x${slideHeight}px (${(pdfBuffer.length / 1024).toFixed(1)}KB)`);

    } finally {
      await page.close();
    }
  }

  // 第三步：合并所有PDF
  const mergedPdf = await mergePdfs(allPdfs);

  return {
    buffer: mergedPdf,
    pageCount: allPdfs.length,
    slides: allPdfs.map(s => ({ width: s.width, height: s.height })),
    mode: 'slides-page-by-page'
  };
}

// ======== 合并PDF ========
async function mergePdfs(pdfList) {
  const { PDFDocument } = await import('pdf-lib');
  const mergedDoc = await PDFDocument.create();

  for (const item of pdfList) {
    const srcDoc = await PDFDocument.load(item.buffer);
    const pages = await mergedDoc.copyPages(srcDoc, srcDoc.getPageIndices());
    pages.forEach(p => mergedDoc.addPage(p));
  }

  return Buffer.from(await mergedDoc.save());
}

// ======== HTML规范化 ========
function normalizeHtmlForPdf(rawHtml) {
  let html = rawHtml;
  html = html.replace(/^\uFEFF/, '').replace(/^\u00BB\u00BF/, '');
  html = html.replace(/^[\x00-\x08\x0B\x0C\x0E-\x1F]+/, '');
  html = html.replace(/<\?xml[^?]*\?>/gi, '');

  if (!/<html[\s>]/i.test(html)) {
    html = `<!DOCTYPE html><html lang="zh-CN"><head><meta charset="UTF-8"></head><body>${html}</body></html>`;
  }
  if (!/<meta[^>]+charset/i.test(html)) {
    if (html.includes('<head>')) html = html.replace(/<head>/i, '<head>\n<meta charset="UTF-8">');
  }
  if (!/<meta[^>]+viewport/i.test(html)) {
    const vm = '<meta name="viewport" content="width=device-width, initial-scale=1.0">';
    if (html.includes('<head>')) html = html.replace(/<head>/i, `<head>\n${vm}`);
  }
  html = html.replace(/<!--(?!\[if)[\s\S]*?-->/g, '');
  if (!html.trim().toLowerCase().startsWith('<!doctype')) html = '<!DOCTYPE html>\n' + html;

  return html;
}

// ======== API路由 ========
app.post('/api/html-to-pdf', async (req, res) => {
  const requestTimer = setTimeout(() => {
    if (!res.headersSent) res.status(504).json({ error: 'PDF生成超时' });
  }, TIMEOUTS.requestTotal);

  try {
    const { html, filename } = req.body;
    if (!html || typeof html !== 'string') {
      clearTimeout(requestTimer);
      return res.status(400).json({ error: '缺少html字段' });
    }

    console.log(`\n📄 PDF生成请求: HTML长度=${html.length}`);

    const normalizedHtml = normalizeHtmlForPdf(html);
    const result = await convertHtmlToPptPdf(normalizedHtml, filename);

    clearTimeout(requestTimer);

    const pdfName = (filename || 'document').replace(/\.html?$/i, '') + '.pdf';
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename="${encodeURIComponent(pdfName)}"`);
    res.setHeader('X-PDF-Pages', result.pageCount);
    res.setHeader('X-PDF-Mode', result.mode);
    res.setHeader('X-PDF-Slide-Count', result.slides.length);
    res.setHeader('X-PDF-Slide-Heights', result.slides.map(s => s.height).join(','));
    res.send(result.buffer);

    console.log(`\n📤 完成: ${pdfName}`);
    console.log(`   共 ${result.pageCount} 页，${(result.buffer.length / 1024).toFixed(1)}KB`);

  } catch (err) {
    clearTimeout(requestTimer);
    console.error('❌ PDF转换失败:', err.message);
    if (!res.headersSent) res.status(500).json({ error: 'PDF转换失败: ' + err.message });
  }
});

app.get('/health', (req, res) => res.json({ status: 'ok', chromePath: CHROME_PATH, uptime: process.uptime() }));
app.get('/api/health', (req, res) => res.json({ status: 'ok', chromePath: CHROME_PATH, uptime: process.uptime() }));

app.listen(PORT, HOST, () => {
  console.log(`\n🎨 HTML Editor 服务已启动`);
  console.log(`   http://${HOST}:${PORT}`);
  console.log(`   Chromium: ${CHROME_PATH}`);
  console.log(`   PDF模式: 分页模式（每slide一页，高度自适应）\n`);
});
