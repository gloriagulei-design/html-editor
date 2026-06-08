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
import { writeFileSync, mkdirSync, existsSync } from 'fs';
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
  '--disable-software-rasterizer'
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
    headless: true,
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
 * 核心：HTML → PDF 转换
 * 基于 fanhi-html-to-pdf v1.0.4 的完整流程
 * Step0: 渲染 + 等 JS 图表完成
 * Step1: 展开隐藏内容
 * Step2: 测高度 + 底部 2px 实体 DOM（底色自动检测）
 * Step3: overflow:hidden 防分页 → PDF 生成
 * Step4: pdf-lib 验证页数
 */
async function convertHtmlToPdf(htmlContent) {
  const browser = await getBrowser();
  const page = await browser.newPage();

  try {
    await page.setViewport(VIEWPORT);

    // Step0: 渲染页面
    await page.setContent(htmlContent, {
      waitUntil: 'networkidle0',
      timeout: TIMEOUTS.pageLoad
    });

    // 等 canvas 图表完成（ECharts 等）
    const hasCanvas = await page.evaluate(() =>
      document.querySelectorAll('canvas').length
    );
    if (hasCanvas > 0) {
      await page.waitForFunction(
        () => Array.from(document.querySelectorAll('canvas')).every(c => c.width > 0),
        { timeout: TIMEOUTS.canvasWait }
      );
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
      // 展开 Tab 内容
      document.querySelectorAll('.tc').forEach(t => t.classList.add('act'));
      // 展开淡入动画
      document.querySelectorAll('.fi').forEach(el => el.classList.add('sho'));
      // 展开折叠面板
      const sugGrid = document.getElementById('sugGrid');
      if (sugGrid) sugGrid.style.display = '';
    });
    await new Promise(r => setTimeout(r, TIMEOUTS.postExpand));

    // Step2: 测量内容高度 + 底部 filler（消除 PDF 白色画布缝隙）
    let contentHeight = await page.evaluate(() => Math.max(
      document.documentElement.scrollHeight,
      document.body ? document.body.scrollHeight : 0
    ));

    // 注入底部 filler div
    await page.evaluate((bg) => {
      const filler = document.createElement('div');
      filler.style.cssText = `height:2px;width:100%;background:${bg};`;
      document.body.appendChild(filler);
    }, bgColor);

    contentHeight = await page.evaluate(() => Math.max(
      document.documentElement.scrollHeight,
      document.body ? document.body.scrollHeight : 0
    ));

    // Step3: 防分页 + 生成 PDF
    await page.addStyleTag({
      content: 'body, html { overflow: hidden !important; }'
    });
    await new Promise(r => setTimeout(r, 200));

    const pdfBuffer = await page.pdf({
      width: `${VIEWPORT.width}px`,
      height: `${contentHeight}px`,
      printBackground: true
    });

    // Step4: 验证 PDF 页数
    const doc = await PDFDocument.load(pdfBuffer);
    const pageCount = doc.getPageCount();
    const pageSize = pageCount > 0 ? doc.getPage(0).getSize() : { width: 0, height: 0 };

    console.log(`✅ PDF 生成成功: ${pageCount} 页, ${(pdfBuffer.length / 1024).toFixed(1)} KB, 尺寸: ${pageSize.width.toFixed(0)}x${pageSize.height.toFixed(0)}pt`);

    return {
      buffer: pdfBuffer,
      pageCount,
      pageSize,
      sizeKB: (pdfBuffer.length / 1024).toFixed(1)
    };
  } finally {
    await page.close();
  }
}

// ====== API 路由 ======

/**
 * POST /api/html-to-pdf
 * 接收 HTML 内容，返回 PDF 文件
 */
app.post('/api/html-to-pdf', async (req, res) => {
  try {
    const { html, filename } = req.body;

    if (!html || typeof html !== 'string') {
      return res.status(400).json({ error: '缺少 html 字段' });
    }

    console.log(`📄 收到 PDF 转换请求，HTML 长度: ${html.length} 字符`);

    const result = await convertHtmlToPdf(html);

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
