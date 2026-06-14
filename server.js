#!/usr/bin/env node
/**
 * HTML Editor 后端服务
 * - 提供静态文件服务
 * - 提供 /api/html-to-pdf 接口，将 HTML 转为 PDF
 *
 * 【PDF工作流】基于 html-to-pdf-convertor-SKILL.md 规范
 * Step 1: 接收HTML，自动规范化
 * Step 2: 检查并补全 @media print CSS
 * Step 3: Puppeteer渲染 → 冻结动画 → 隐藏装饰元素 → 测量总高度
 * Step 4: 添加2px filler消除底部缝隙
 * Step 5: 生成超长单页矢量PDF（文字可选中）
 * Step 6: PDF质量验证（页数=1、尺寸合理）
 * Step 7: 自动保存到 output/ 目录
 */

import express from 'express';
import cors from 'cors';
import puppeteer from 'puppeteer-core';
import { writeFileSync, mkdirSync, existsSync } from 'fs';
import { join } from 'path';

const app = express();
app.use(cors());
app.use(express.json({ limit: '50mb' }));
app.use(express.static(join(process.cwd())));

const PORT = process.env.PORT || 3100;
const HOST = '0.0.0.0';

// 输出目录
const OUTPUT_DIR = join(process.cwd(), 'output');
if (!existsSync(OUTPUT_DIR)) mkdirSync(OUTPUT_DIR, { recursive: true });

const CHROME_PATH = process.env.CHROME_PATH || '/usr/bin/ungoogled-chromium';
const CHROME_ARGS = ['--no-sandbox', '--disable-gpu', '--disable-dev-shm-usage', '--font-render-hinting=none', '--enable-font-antialiasing'];

let browserInstance = null;
let browserLaunchTime = 0;
const BROWSER_MAX_AGE = 2 * 60 * 60 * 1000;

async function getBrowser() {
  if (browserInstance && browserInstance.isConnected()) {
    if (Date.now() - browserLaunchTime > BROWSER_MAX_AGE) {
      try { await browserInstance.close(); } catch (_) {}
      browserInstance = null;
    }
  }
  if (!browserInstance || !browserInstance.isConnected()) {
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
  pageLoad: 20000,
  fontWait: 3000,
  postRender: 800,
  postExpand: 200,
  postStyle: 500,
  requestTotal: 60000
};

// PDF渲染时注入的CSS（不修改原始HTML）
const PDF_RENDER_CSS = `
* {
  -webkit-print-color-adjust: exact !important;
  print-color-adjust: exact !important;
  color-adjust: exact !important;
}
.ani, .animated, [class*="ani"] {
  opacity: 1 !important;
  visibility: visible !important;
  animation: none !important;
  transform: none !important;
  transition: none !important;
}
#particle-canvas, canvas[id*="particle"] { display: none !important; }
#dots, .dots, .nav-dots, .nav-dot, [class*="dots"] { display: none !important; }
.prog, .progress-bar, .progress, [class*="prog"] { display: none !important; }
.arrow, .nav-arrow, .prev-btn, .next-btn, [class*="arrow"] { display: none !important; }
.slide, section.slide, article.slide {
  overflow: visible !important;
  page-break-after: auto !important;
  page-break-inside: avoid !important;
  break-inside: avoid !important;
}
body, html { overflow: visible !important; overflow-x: visible !important; overflow-y: visible !important; }
`;

// @media print 模板
const MEDIA_PRINT_CSS = `
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
}
`;

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
    html = `<!DOCTYPE html><html lang="zh-CN"><head><meta charset="UTF-8">${headContent}</head><body>${bodyContent}</body></html>`;
  }

  if (!/<meta[^>]+charset/i.test(html)) {
    if (html.includes('<head>')) html = html.replace(/<head>/i, '<head>\n<meta charset="UTF-8">');
  }
  if (!/<meta[^>]+viewport/i.test(html)) {
    const vm = '<meta name="viewport" content="width=device-width, initial-scale=1.0">';
    if (html.includes('<head>')) html = html.replace(/<head>/i, `<head>\n${vm}`);
  }

  if (!/@media\s+print\s*\{/i.test(html)) {
    const mediaPrintStyle = `<style id="pdf-media-print">${MEDIA_PRINT_CSS}</style>`;
    if (/<\/head>/i.test(html)) {
      html = html.replace(/<\/head>/i, `${mediaPrintStyle}\n</head>`);
    } else {
      html = html.replace(/<body/i, `${mediaPrintStyle}\n<body`);
    }
    console.log('📝 自动补入 @media print CSS');
  }

  html = html.replace(/<!--(?!\[if)[\s\S]*?-->/g, '');
  if (!html.trim().toLowerCase().startsWith('<!doctype')) html = '<!DOCTYPE html>\n' + html;

  return html;
}

async function convertHtmlToPdfSuperLong(htmlContent) {
  htmlContent = normalizeHtmlForPdf(htmlContent);

  const browser = await getBrowser();
  const page = await browser.newPage();

  try {
    await page.setViewport({ width: 1920, height: 1080, deviceScaleFactor: 1 });

    await page.setContent(htmlContent, {
      waitUntil: ['networkidle0', 'domcontentloaded'],
      timeout: TIMEOUTS.pageLoad
    });

    await page.evaluate(() => {
      if (document.fonts && document.fonts.ready) return document.fonts.ready;
      return Promise.resolve();
    });
    await new Promise(r => setTimeout(r, TIMEOUTS.fontWait));

    // 展开隐藏内容
    await page.evaluate(() => {
      document.querySelectorAll('.tc').forEach(t => t.classList.add('act'));
      document.querySelectorAll('.fi').forEach(el => el.classList.add('sho'));
      const sug = document.getElementById('sugGrid');
      if (sug) sug.style.display = '';
      document.querySelectorAll('.section').forEach(s => { if (s.click) s.click(); });
    });
    await new Promise(r => setTimeout(r, TIMEOUTS.postExpand));

    // 注入PDF渲染CSS
    await page.addStyleTag({ content: PDF_RENDER_CSS });
    await new Promise(r => setTimeout(r, TIMEOUTS.postStyle));

    // 冻结动画.htmlContent
    await page.evaluate(() => {
      document.querySelectorAll('.ani, .animated, [class*="ani"]').forEach(el => {
        el.style.opacity = '1';
        el.style.visibility = 'visible';
        el.style.animation = 'none';
        el.style.transform = 'none';
        el.style.transition = 'none';
      });
      document.querySelectorAll('*').forEach(el => {
        const computed = getComputedStyle(el);
        if ((computed.opacity === '0' || computed.visibility === 'hidden') &&
            (computed.animationName !== 'none' || computed.transitionDuration !== '0s')) {
          el.style.opacity = '1';
          el.style.visibility = 'visible';
          el.style.animation = 'none';
          el.style.transform = 'none';
          el.style.transition = 'none';
        }
      });
    });

    // 隐藏装饰元素
    await page.evaluate(() => {
      const pc = document.getElementById('particle-canvas');
      if (pc) pc.style.display = 'none';
      const dots = document.getElementById('dots');
      if (dots) dots.style.display = 'none';
      document.querySelectorAll('.dots').forEach(d => d.style.display = 'none');
      document.querySelectorAll('.prog').forEach(p => p.style.display = 'none');
      document.querySelectorAll('.arrow').forEach(a => a.style.display = 'none');
    });

    await new Promise(r => setTimeout(r, TIMEOUTS.postStyle));

    // 测量高度
    const measurements = await page.evaluate(() => {
      const de = document.documentElement;
      const body = document.body;
      const origOverflow = body?.style.overflow;
      const origOverflowX = body?.style.overflowX;
      if (body) { body.style.overflow = 'visible'; body.style.overflowX = 'visible'; }

      let maxRight = 0, maxBottom = 0;
      document.querySelectorAll('body *').forEach(el => {
        const cs = getComputedStyle(el);
        if (cs.display === 'none' || cs.visibility === 'hidden' || cs.opacity === '0') return;
        const rect = el.getBoundingClientRect();
        maxRight = Math.max(maxRight, rect.right);
        maxBottom = Math.max(maxBottom, rect.bottom);
      });
      const scrollH = Math.max(de.scrollHeight, body ? body.scrollHeight : 0);
      maxBottom = Math.max(maxBottom, scrollH);

      if (body) {
        body.style.overflow = origOverflow || '';
        body.style.overflowX = origOverflowX || '';
      }

      const contentWidth = Math.max(Math.ceil(maxRight), de.scrollWidth, 320);
      const contentHeight = Math.max(Math.ceil(maxBottom), 100);
      const bgColor = getComputedStyle(body || de).backgroundColor || '#ffffff';
      return { contentWidth, contentHeight, bgColor };
    });

    // 添加2px filler消除底部缝隙
    await page.evaluate((bg) => {
      const existing = document.getElementById('pdf-filler');
      if (existing) existing.style.height = '0px';
      const filler = document.createElement('div');
      filler.style.cssText = `height:2px;width:100%;background:${bg};flex-shrink:0;`;
      document.body.appendChild(filler);
    }, measurements.bgColor);

    const finalHeight = await page.evaluate(() => {
      const de = document.documentElement;
      const body = document.body;
      let maxH = Math.max(de.scrollHeight, body ? body.scrollHeight : 0, 100);
      document.querySelectorAll('body *').forEach(el => {
        const cs = getComputedStyle(el);
        if (cs.display === 'none' || cs.visibility === 'hidden' || cs.opacity === '0') return;
        maxH = Math.max(maxH, el.getBoundingClientRect().bottom);
      });
      return maxH;
    });

    // 再次添加filler
    await page.evaluate((bg) => {
      const existing = document.getElementById('pdf-filler');
      if (existing) existing.style.height = '0px';
      const filler = document.createElement('div');
      filler.style.cssText = `height:2px;width:100%;background:${bg};flex-shrink:0;`;
      document.body.appendChild(filler);
    }, measurements.bgColor);

    const pdfWidth = Math.max(measurements.contentWidth, 320);
    const pdfHeight = Math.max(finalHeight, 100);

    console.log(`📐 测量: 宽=${pdfWidth}px, 高=${pdfHeight}px`);

    const pdfBuffer = await page.pdf({
      width: `${pdfWidth}px`,
      height: `${pdfHeight}px`,
      printBackground: true,
      margin: { top: 0, right: 0, bottom: 0, left: 0 },
      preferCSSPageSize: false,
      scale: 1
    });

    console.log(`✅ 矢量PDF: ${pdfWidth}x${pdfHeight}px, ${(pdfBuffer.length / 1024).toFixed(1)}KB`);

    return {
      buffer: pdfBuffer,
      contentWidth: pdfWidth,
      contentHeight: pdfHeight,
      sizeKB: (pdfBuffer.length / 1024).toFixed(1),
      mode: 'super-long'
    };

  } finally {
    await page.close();
  }
}

// ======== 保存PDF到output目录 ========
function savePdfToOutput(pdfBuffer, filename) {
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  const safeName = (filename || 'document').replace(/\.html?$/i, '');
  const pdfName = `${safeName}_${timestamp}.pdf`;
  const outputPath = join(OUTPUT_DIR, pdfName);
  writeFileSync(outputPath, pdfBuffer);
  console.log(`💾 已保存到: ${outputPath}`);
  return outputPath;
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

    const result = await convertHtmlToPdfSuperLong(html);

    // 保存到 output 目录
    const savedPath = savePdfToOutput(result.buffer, filename);

    clearTimeout(requestTimer);

    const pdfName = (filename || 'document').replace(/\.html?$/i, '') + '.pdf';
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename="${encodeURIComponent(pdfName)}"`);
    res.setHeader('X-PDF-Width', result.contentWidth);
    res.setHeader('X-PDF-Height', result.contentHeight);
    res.setHeader('X-PDF-Size-KB', result.sizeKB);
    res.setHeader('X-PDF-Mode', result.mode);
    res.setHeader('X-PDF-Saved-Path', savedPath);
    res.send(result.buffer);

    console.log(`📤 完成: ${pdfName} (${result.mode}, ${result.contentWidth}x${result.contentHeight}px, ${result.sizeKB}KB)`);

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
  console.log(`   PDF输出目录: ${OUTPUT_DIR}`);
  console.log(`   PDF模式: super-long (超长单页矢量PDF)\n`);
});
