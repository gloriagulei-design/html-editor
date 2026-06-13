#!/usr/bin/env node
/**
 * HTML Editor 后端服务
 * - 提供静态文件服务
 * - 提供 /api/html-to-pdf 接口，将 HTML 转为 PDF
 *
 * ★ PDF 生成策略（基于行业最佳实践和之前验证的成功经验）
 * ┌─────────────────────────────────────────────────────────────────────────┐
 * │  模式          │  原理                  │  适用场景                │
 * ├─────────────────────────────────────────────────────────────────────────┤
 * │  print (默认)   │  page.pdf({width,height}) │  文档、PPT、通用内容    │
 * │                │  单页长PDF，不分页       │  文字可选，速度快       │
 * │  screenshot    │  screenshot→pdf-lib     │  像素级精确还原需求     │
 * │                │  分段截图拼接单页        │  备用方案              │
 * └─────────────────────────────────────────────────────────────────────────┘
 *
 * ★★★ 核心原则（从之前N轮调试中总结的成功经验）：
 * 1. 用 page.pdf({width,height}) 而不是 format:'A4' → 避免打印媒体查询重新布局
 * 2. 不设 viewport 高度为 contentHeight → 避免 100vh 元素被拉伸
 * 3. 内容宽度通过 max-right 检测 → 自适应不同设计宽度
 * 4. 单页长PDF → 内容多长PDF多长，永不切断
 * 5. 注入 overflow:visible 和 print-color-adjust:exact CSS → 确保颜色完整
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
  pageLoad: 20000,
  canvasWait: 8000,
  postRender: 800,
  postExpand: 200,
  postStyle: 150,
  postViewport: 200,
  requestTotal: 45000
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

  // 移除 @media print（避免打印模式下样式突变）和 @page
  html = html.replace(/@media\s+print\s*\{[\s\S]*?\}\s*(?=\s*<\/style>|\s*@media|\s*<\/head>|\s*$)/gi, '');
  html = html.replace(/@page\s*\{[\s\S]*?\}\s*/gi, '');
  html = html.replace(/<!--(?!\[if)[\s\S]*?-->/g, '');
  if (!html.trim().toLowerCase().startsWith('<!doctype')) html = '<!DOCTYPE html>\n' + html;

  return html;
}

// ======== 核心渲染函数 ========
async function createRenderedPage(htmlContent, options = {}) {
  htmlContent = normalizeHtmlForPdf(htmlContent);

  const browser = await getBrowser();
  const page = await browser.newPage();

  // 先用小视口加载，让内容自然展开，避免100vh元素被拉伸
  const vpW = 1280;
  await page.setViewport({ width: vpW, height: 1080, deviceScaleFactor: 1 });

  // 使用 setContent 加载（之前验证稳定的方案）
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

  // 获取内容宽度和高度
  const measurements = await page.evaluate(() => {
    const de = document.documentElement;
    const body = document.body;
    
    // 临时移除body scrollbar以获得准确内容宽度
    const originalOverflow = body?.style.overflow;
    const originalOverflowX = body?.style.overflowX;
    if (body) {
      body.style.overflow = 'visible';
      body.style.overflowX = 'visible';
    }
    
    const scrollW = Math.max(de.scrollWidth, body ? body.scrollWidth : 0);

    // ★★★ 真实内容尺寸：遍历所有可见元素获取最大right和bottom
    // 注意：scrollHeight在overflow:auto/scroll容器中只返回可见区域高度，
    // 不能反映被隐藏的内容。必须使用getBoundingClientRect或递归展开。
    let maxRight = 0;
    let maxBottom = 0;
    document.querySelectorAll('body *').forEach(el => {
      const cs = getComputedStyle(el);
      if (cs.display === 'none' || cs.visibility === 'hidden' || cs.opacity === '0') return;
      const rect = el.getBoundingClientRect();
      maxRight = Math.max(maxRight, rect.right);
      maxBottom = Math.max(maxBottom, rect.bottom);
    });
    // 同时考虑document的scrollHeight作为兜底
    const scrollH = Math.max(de.scrollHeight, body ? body.scrollHeight : 0);
    maxBottom = Math.max(maxBottom, scrollH);

    // 恢复原始overflow
    if (body) {
      body.style.overflow = originalOverflow || '';
      body.style.overflowX = originalOverflowX || '';
    }

    const contentWidth = Math.max(Math.ceil(maxRight), scrollW, 320);
    const contentHeight = Math.max(Math.ceil(maxBottom), 100);
    const bgColor = getComputedStyle(body || de).backgroundColor || '#ffffff';

    return { contentWidth, contentHeight, scrollW, maxRight, maxBottom, bgColor };
  });

  // 底部增加填充条消除白缝
  await page.evaluate((bg) => {
    const filler = document.createElement('div');
    filler.style.cssText = `height:4px;width:100%;background:${bg};flex-shrink:0;`;
    document.body.appendChild(filler);
  }, measurements.bgColor);

  // 重新测量高度
  const finalHeight = await page.evaluate(() =>
    Math.max(document.documentElement.scrollHeight, document.body ? document.body.scrollHeight : 0, 100)
  );

  console.log(`📐 测量: 宽=${measurements.contentWidth}px, 高=${finalHeight}px, maxRight=${measurements.maxRight}`);

  return { page, contentWidth: measurements.contentWidth, contentHeight: finalHeight, bgColor: measurements.bgColor };
}

// ======== 基础CSS注入 ========
// ★★★ 仅注入颜色保留，不修改布局属性。
// 布局已在测量阶段确定，此处修改会破坏100vh、flex等布局。
const BASE_CSS = `
* {
  -webkit-print-color-adjust: exact !important;
  print-color-adjust: exact !important;
  color-adjust: exact !important;
}
`;

// ======== 模式A：打印模式（默认，单页长PDF）========
async function convertHtmlToPdfPrint(htmlContent, options = {}) {
  const { page, contentWidth, contentHeight } = await createRenderedPage(htmlContent);
  const userPdfWidth = options.pdfWidth && options.pdfWidth !== 'auto'
    ? parseInt(options.pdfWidth, 10) : null;

  try {
    const targetWidth = userPdfWidth || contentWidth;
    // ★★★ 成功经验：不设viewport高度为contentHeight，保持固定高度避免100vh元素拉伸
    await page.setViewport({
      width: Math.max(Math.round(targetWidth), 800),
      height: 1080,
      deviceScaleFactor: 1
    });
    await new Promise(r => setTimeout(r, TIMEOUTS.postViewport));

    // ★ 展开已在createRenderedPage中完成，无需重复
    // 直接注入颜色保留CSS
    await page.addStyleTag({ content: BASE_CSS });
    await new Promise(r => setTimeout(r, TIMEOUTS.postStyle));

    // 重新测量最终尺寸（同样使用max-bottom逻辑）
    const finalMeasurements = await page.evaluate(() => {
      const de = document.documentElement;
      const body = document.body;
      let maxW = Math.max(de.scrollWidth, body ? body.scrollWidth : 0);
      let maxH = Math.max(de.scrollHeight, body ? body.scrollHeight : 0);
      document.querySelectorAll('body *').forEach(el => {
        const cs = getComputedStyle(el);
        if (cs.display === 'none' || cs.visibility === 'hidden' || cs.opacity === '0') return;
        const rect = el.getBoundingClientRect();
        maxW = Math.max(maxW, rect.right);
        maxH = Math.max(maxH, rect.bottom);
      });
      return { w: maxW, h: maxH };
    });

    const pdfW = Math.max(finalMeasurements.w, 320);
    const pdfH = Math.max(finalMeasurements.h, 100);

    // ★★★ 成功经验：用 page.pdf({width, height}) 生成单页长PDF，不用 format:'A4'
    // Puppeteer width/height 需带单位，px 表示 CSS 像素 (1px = 1/96 inch)
    const pdfBuffer = await page.pdf({
      width: `${pdfW}px`,
      height: `${pdfH}px`,
      printBackground: true,
      margin: { top: 0, right: 0, bottom: 0, left: 0 },
      preferCSSPageSize: false
    });

    console.log(`✅ [打印模式] 单页PDF: ${pdfW}x${pdfH}px, ${(pdfBuffer.length / 1024).toFixed(1)}KB`);

    return {
      buffer: pdfBuffer,
      pageCount: 1,
      sizeKB: (pdfBuffer.length / 1024).toFixed(1),
      mode: 'print'
    };
  } finally {
    await page.close();
  }
}

// ======== 模式B：截图模式（像素级精确，分段拼接单页）========
async function convertHtmlToPdfScreenshot(htmlContent, options = {}) {
  const { page, contentWidth, contentHeight } = await createRenderedPage(htmlContent);
  const userPdfWidth = options.pdfWidth && options.pdfWidth !== 'auto'
    ? parseInt(options.pdfWidth, 10) : null;

  const scale = 2;
  const targetWidth = userPdfWidth || contentWidth;
  const MAX_DIM = 16384;
  const maxCssH = Math.floor(MAX_DIM / scale) - 50;

  const needsSeg = contentHeight > maxCssH;
  const segH = needsSeg ? maxCssH : contentHeight;
  const segCount = needsSeg ? Math.ceil(contentHeight / segH) : 1;

  console.log(`📐 [截图模式] 内容=${targetWidth}x${contentHeight}px, 分段=${needsSeg}, 段数=${segCount}`);

  try {
    // 基础CSS（颜色保留），展开已在createRenderedPage中完成
    await page.addStyleTag({ content: BASE_CSS });
    await new Promise(r => setTimeout(r, TIMEOUTS.postStyle));

    await page.setViewport({
      width: targetWidth,
      height: needsSeg ? segH : contentHeight,
      deviceScaleFactor: scale
    });
    await new Promise(r => setTimeout(r, TIMEOUTS.postViewport));

    // PDF尺寸：CSS像素 * 0.75 = pt（points）
    const pdfW = targetWidth * 0.75;
    const pdfH = contentHeight * 0.75;

    // ----- 单段：直接截图嵌入 -----
    if (!needsSeg) {
      // ★ fullPage截图会截取整个页面内容，即使viewport高度小于内容高度
      const ss = await page.screenshot({ type: 'jpeg', quality: 95, fullPage: true });
      if (!ss || ss.length === 0) throw new Error('截图返回空数据');

      const pdfDoc = await PDFDocument.create();
      const pdfPage = pdfDoc.addPage([pdfW, pdfH]);
      const img = await pdfDoc.embedJpg(ss);
      // ★★★ pdf-lib y=0是左下角，fullPage截图高度=contentHeight，所以直接铺满
      pdfPage.drawImage(img, { x: 0, y: 0, width: pdfW, height: pdfH });

      const buf = await pdfDoc.save();
      console.log(`✅ [截图模式] 单页PDF: ${(buf.length / 1024).toFixed(1)}KB`);
      return { buffer: Buffer.from(buf), pageCount: 1, sizeKB: (buf.length / 1024).toFixed(1), mode: 'screenshot' };
    }

    // ----- 多段：拼接单页PDF -----
    const pdfDoc = await PDFDocument.create();
    const pdfPage = pdfDoc.addPage([pdfW, pdfH]);

    for (let i = 0; i < segCount; i++) {
      const scrollY = i * segH;
      const isLast = i === segCount - 1;
      const thisSegH = isLast ? (contentHeight - scrollY) : segH;
      const segPdfH = thisSegH * 0.75;

      await page.setViewport({ width: targetWidth, height: thisSegH, deviceScaleFactor: scale });
      await new Promise(r => setTimeout(r, 100));
      await page.evaluate((y) => { window.scrollTo(0, y); }, scrollY);
      await new Promise(r => setTimeout(r, 80));

      let segBuffer = await page.screenshot({ type: 'jpeg', quality: 95, clip: { x: 0, y: 0, width: targetWidth, height: thisSegH } });
      if (!segBuffer || segBuffer.length === 0) {
        segBuffer = await page.screenshot({ type: 'jpeg', quality: 90, fullPage: true });
      }
      if (!segBuffer || segBuffer.length === 0) throw new Error(`段${i + 1}截图失败`);

      // ★★★ Y轴定位修正：pdf-lib 原点在左下角(y=0)，y向上增大
      // scrollY=0 (HTML顶部) → y = pdfH - segPdfH (PDF顶部)
      // scrollY=最大 (HTML底部) → y = 0 (PDF底部)
      const topY = pdfH - ((scrollY + thisSegH) / contentHeight) * pdfH;
      const bottomY = pdfH - (scrollY / contentHeight) * pdfH;
      const thisPdfH_seg = bottomY - topY;

      const img = await pdfDoc.embedJpg(segBuffer);
      pdfPage.drawImage(img, {
        x: 0,
        y: topY,
        width: pdfW,
        height: thisPdfH_seg
      });

      console.log(`  📸 段${i + 1}/${segCount}: scrollY=${scrollY}, y=${topY.toFixed(1)}..${bottomY.toFixed(1)}`);
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

    console.log(`\n📄 请求: HTML长度=${html.length}, 宽度=${pdfWidth || 'auto'}, 模式=${pdfMode || 'print'}`);
    const result = await convertHtmlToPdf(html, { pdfWidth: pdfWidth || 'auto', pdfMode: pdfMode || 'print' });
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
  console.log(`\n🎨 HTML Editor 服务已启动`);
  console.log(`   http://${HOST}:${PORT}`);
  console.log(`   Chromium: ${CHROME_PATH}`);
  console.log(`   默认PDF模式: print (单页长PDF)\n`);
});
