#!/usr/bin/env node
/**
 * HTML Editor 后端服务
 * - 提供静态文件服务（HTML 编辑器前端）
 * - 提供 /api/html-to-pdf 接口，基于 Puppeteer + Chromium 将 HTML 转为 PDF
 * 核心转换逻辑参考 fanhi-html-to-pdf v1.0.4 skill
 */

import express from 'express';
import cors from 'cors';
import puppeteer from 'puppeteer-core';
import { writeFileSync, mkdirSync, existsSync, readFileSync } from 'fs';
import { join, resolve } from 'path';
import { randomUUID } from 'crypto';
import { PDFDocument } from 'pdf-lib';

// ====== 配置 ======
const PORT = process.env.PORT || 3100;
const HOST = '0.0.0.0';
const TMP_DIR = join(process.cwd(), '.tmp');

const CHROME_PATH = process.env.CHROME_PATH ||
  (process.platform === 'darwin'
    ? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'
    : '/usr/bin/ungoogled-chromium');

const CHROME_ARGS = [
  '--no-sandbox', '--disable-gpu', '--disable-dev-shm-usage',
  '--font-render-hinting=none', '--enable-font-antialiasing',
  '--disable-software-rasterizer',
  '--disable-features=PaintHolding',           // 防止字体延迟渲染
  '--font-cache-shared-handle'                  // 共享字体缓存
];

const VIEWPORT = { width: 1400, height: 900 };
const TIMEOUTS = {
  pageLoad: 30000,
  canvasWait: 15000,
  postRender: 2000,
  postExpand: 500
};

// ====== Express 应用 ======
const app = express();
app.use(cors());
app.use(express.json({ limit: '50mb' }));
app.use(express.static(join(process.cwd())));

// 确保 tmp 目录存在
if (!existsSync(TMP_DIR)) mkdirSync(TMP_DIR, { recursive: true });

// ====== Puppeteer 浏览器池 ======
let browserInstance = null;

async function getBrowser() {
  if (browserInstance && browserInstance.isConnected()) {
    return browserInstance;
  }
  console.log(`🚀 启动 Chromium: ${CHROME_PATH}`);
  browserInstance = await puppeteer.launch({
    executablePath: CHROME_PATH,
    headless: 'new',
    args: CHROME_ARGS
  });
  // 浏览器断开时清除引用
  browserInstance.on('disconnected', () => {
    console.log('⚠️ Chromium 浏览器已断开');
    browserInstance = null;
  });
  return browserInstance;
}

/**
 * 公共：创建 Puppeteer 页面，渲染 HTML，返回 page 和测量信息
 */
async function createRenderedPage(htmlContent, options = {}) {
  const pdfWidth = options.pdfWidth && options.pdfWidth !== 'auto'
    ? parseInt(options.pdfWidth, 10)
    : VIEWPORT.width;
  const viewport = { width: pdfWidth, height: VIEWPORT.height };

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
    console.error('❌ 创建页面失败:', pageErr.message);
    browserInstance = null;
    throw new Error('创建渲染页面失败，请重试: ' + pageErr.message);
  }

  await page.setViewport(viewport);

  // Step0: 渲染页面（先写临时文件再用 file:// 加载）
  const tmpHtmlPath = join(TMP_DIR, `pdf-${randomUUID()}.html`);
  writeFileSync(tmpHtmlPath, htmlContent, 'utf-8');

  try {
    await page.goto(`file://${tmpHtmlPath}`, {
      waitUntil: 'networkidle0',
      timeout: TIMEOUTS.pageLoad
    });
  } catch (loadErr) {
    console.warn('⚠️ networkidle0 超时，降级为 domcontentloaded:', loadErr.message);
    try {
      await page.goto(`file://${tmpHtmlPath}`, {
        waitUntil: 'domcontentloaded',
        timeout: TIMEOUTS.pageLoad
      });
    } catch (fallbackErr) {
      throw new Error('页面渲染超时，请检查 HTML 内容是否包含无法加载的资源');
    }
  } finally {
    try { require('fs').unlinkSync(tmpHtmlPath); } catch (_) {}
  }

  // 等 canvas 图表完成
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

  // 多页 PDF 背景修复
  await page.evaluate((bg) => {
    document.documentElement.style.backgroundColor = bg;
    document.documentElement.style.webkitPrintColorAdjust = 'exact';
    document.documentElement.style.printColorAdjust = 'exact';
    document.body.style.backgroundColor = bg;
    document.body.style.webkitPrintColorAdjust = 'exact';
    document.body.style.printColorAdjust = 'exact';
  }, bgColor);

  await page.evaluate(() => {
    document.querySelectorAll('.tc').forEach(t => t.classList.add('act'));
    document.querySelectorAll('.fi').forEach(el => el.classList.add('sho'));
    const sugGrid = document.getElementById('sugGrid');
    if (sugGrid) sugGrid.style.display = '';
  });
  await new Promise(r => setTimeout(r, TIMEOUTS.postExpand));

  // Step2: 测量内容高度 + 底部 filler
  let contentHeight = await page.evaluate(() => Math.max(
    document.documentElement.scrollHeight,
    document.body ? document.body.scrollHeight : 0
  ));

  await page.evaluate((bg, vpWidth) => {
    const filler = document.createElement('div');
    filler.style.cssText = `height:2px;width:${vpWidth}px;background:${bg};`;
    document.body.appendChild(filler);
  }, bgColor, viewport.width);

  contentHeight = await page.evaluate(() => Math.max(
    document.documentElement.scrollHeight,
    document.body ? document.body.scrollHeight : 0
  ));

  return { page, contentHeight, bgColor, viewport };
}

/**
 * 模式 A：传统打印模式 HTML → PDF（单页长 PDF，保持文字可选）
 */
async function convertHtmlToPdfPrint(htmlContent, options = {}) {
  const { page, contentHeight, viewport } = await createRenderedPage(htmlContent, options);

  try {
    await page.addStyleTag({
      content: `
        html, body { overflow: hidden !important; }
        * {
          page-break-inside: auto !important;
          break-inside: auto !important;
          page-break-after: auto !important;
          break-after: auto !important;
          page-break-before: auto !important;
          break-before: auto !important;
          -webkit-print-color-adjust: exact !important;
          print-color-adjust: exact !important;
        }
      `
    });
    await new Promise(r => setTimeout(r, 200));

    const pdfBuffer = await page.pdf({
      width: `${viewport.width}px`,
      height: `${contentHeight}px`,
      printBackground: true
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
 * 先 screenshot 全页为 PNG，再用 pdf-lib 嵌入单页 PDF。
 * 文字不可选，但颜色/样式零丢失。
 */
async function convertHtmlToPdfScreenshot(htmlContent, options = {}) {
  const { page, contentHeight, viewport } = await createRenderedPage(htmlContent, options);

  try {
    // 设置视口为内容完整高度，确保一屏截全
    await page.setViewport({
      width: viewport.width,
      height: contentHeight,
      deviceScaleFactor: 2 // 2x 高清截图
    });
    await new Promise(r => setTimeout(r, 500)); // 等待重排

    // 全页截图
    const screenshotBuffer = await page.screenshot({
      type: 'png',
      fullPage: true
    });

    // 用 pdf-lib 将 PNG 嵌入 PDF
    const pdfDoc = await PDFDocument.create();

    // PNG 尺寸是 CSS px * deviceScaleFactor = 物理像素
    // PDF 使用 72 DPI，1 pt = 1/72 inch。
    // CSS 96 DPI → 1px = 72/96 = 0.75pt。
    // 2x 高清截图对应的实际显示尺寸仍为 viewport.width px
    const pdfW = viewport.width * 0.75;          // pt
    const pdfH = contentHeight * 0.75;           // pt

    const img = await pdfDoc.embedPng(screenshotBuffer);
    const pdfPage = pdfDoc.addPage([pdfW, pdfH]);
    pdfPage.drawImage(img, {
      x: 0,
      y: 0,
      width: pdfW,
      height: pdfH
    });

    const pdfBuffer = await pdfDoc.save();
    const sizeKB = (pdfBuffer.length / 1024).toFixed(1);

    console.log(`✅ [截图模式] PDF 生成成功: 1 页(截图), ${sizeKB} KB, 尺寸: ${pdfW.toFixed(0)}x${pdfH.toFixed(0)}pt`);

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
  const mode = options.pdfMode || 'print';
  if (mode === 'screenshot') {
    return convertHtmlToPdfScreenshot(htmlContent, options);
  }
  return convertHtmlToPdfPrint(htmlContent, options);
}

// ====== API 路由 ======

/**
 * POST /api/html-to-pdf
 * 接收 HTML 内容，返回 PDF 文件
 */
app.post('/api/html-to-pdf', async (req, res) => {
  try {
    const { html, filename, pdfWidth, pdfMode } = req.body;

    if (!html || typeof html !== 'string') {
      return res.status(400).json({ error: '缺少 html 字段' });
    }

    console.log(`📄 收到 PDF 转换请求，HTML 长度: ${html.length} 字符, PDF宽度: ${pdfWidth || 'auto'}, 模式: ${pdfMode || 'print'}`);

    const result = await convertHtmlToPdf(html, { pdfWidth: pdfWidth || 'auto', pdfMode: pdfMode || 'print' });

    // 设置响应头，返回 PDF 文件
    const pdfFilename = (filename || 'document').replace(/\.html?$/i, '') + '.pdf';
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename="${encodeURIComponent(pdfFilename)}"`);
    res.setHeader('X-PDF-Pages', result.pageCount);
    res.setHeader('X-PDF-Size-KB', result.sizeKB);
    res.send(result.buffer);

    console.log(`📤 PDF 已发送: ${pdfFilename}`);
  } catch (err) {
    console.error('❌ PDF 转换失败:', err.message);
    res.status(500).json({ error: 'PDF 转换失败: ' + err.message });
  }
});

/**
 * GET /api/health
 * 健康检查
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
  console.log(`   PDF 转换: POST /api/html-to-pdf\n`);
});
