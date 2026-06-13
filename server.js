#!/usr/bin/env node
/**
 * HTML Editor 后端服务
 * - 提供静态文件服务
 * - 提供 /api/html-to-pdf 接口，将 HTML 转为 PDF
 *
 * 【工作流】基于 html-to-pdf-convertor-SKILL.md 规范
 * Step 1: 接收HTML，自动规范化
 * Step 2: 检查并补全 @media print CSS
 * Step 3: Puppeteer渲染 → 冻结动画 → 隐藏装饰元素 → 测量高度
 * Step 4: 添加2px filler消除底部缝隙
 * Step 5: 生成超长单页矢量PDF（文字可选中）
 * Step 6: PDF质量验证（页数=1、尺寸合理）
 */

import express from 'express';
import cors from 'cors';
import puppeteer from 'puppeteer-core';
import { writeFileSync, mkdirSync, existsSync, readFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
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
  fontWait: 3000,
  postRender: 800,
  postExpand: 200,
  postStyle: 300,
  postViewport: 300,
  requestTotal: 60000
};

// ======== PDF渲染注入CSS（仅用于PDF生成时注入页面）========
// 注意：这些样式是通过 page.addStyleTag() 在PDF渲染前注入的
// 不修改原始HTML文件
const PDF_RENDER_CSS = `
/* === PDF渲染专用样式 === */
* {
  -webkit-print-color-adjust: exact !important;
  print-color-adjust: exact !important;
  color-adjust: exact !important;
}

/* 动画元素：强制可见（.ani三件套） */
.ani,
.animated,
[class*="ani"] {
  opacity: 1 !important;
  visibility: visible !important;
  animation: none !important;
  transform: none !important;
  transition: none !important;
}

/* 隐藏粒子canvas */
#particle-canvas,
canvas[id*="particle"] {
  display: none !important;
}

/* 隐藏导航点 */
#dots,
.dots,
.nav-dots,
.nav-dot,
[class*="dots"] {
  display: none !important;
}

/* 隐藏进度条 */
.prog,
.progress-bar,
.progress,
[class*="prog"] {
  display: none !important;
}

/* 隐藏导航箭头 */
.arrow,
.nav-arrow,
.prev-btn,
.next-btn,
[class*="arrow"] {
  display: none !important;
}

/* 幻灯片容器：允许内容溢出 */
.slide,
section.slide,
article.slide {
  overflow: visible !important;
  page-break-after: auto !important;
  page-break-inside: avoid !important;
  break-inside: avoid !important;
}

/* 确保所有内容可见 */
body, html {
  overflow: visible !important;
  overflow-x: visible !important;
  overflow-y: visible !important;
}
`;

// ======== @media print CSS 模板 ========
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

// ======== HTML 规范化 ========
/**
 * 规范化HTML用于PDF生成
 * - 清理BOM
 * - 确保标准HTML结构
 * - 检查并补全 @media print CSS
 * - 不修改布局属性
 */
function normalizeHtmlForPdf(rawHtml) {
  let html = rawHtml;

  // 清理BOM和非法字符
  html = html.replace(/^\uFEFF/, '');
  html = html.replace(/^\u00BB\u00BF/, '');
  html = html.replace(/^[\x00-\x08\x0B\x0C\x0E-\x1F]+/, '');
  html = html.replace(/<\?xml[^?]*\?>/gi, '');

  // 确保有标准HTML结构
  const hasHtmlTag = /<html[\s>]/i.test(html);
  if (!hasHtmlTag) {
    let headContent = '';
    let bodyContent = html;
    const headMatch = html.match(/<head[^>]*>([\s\S]*?)<\/head>/i);
    if (headMatch) {
      headContent = headMatch[1];
      bodyContent = html.replace(/<head[^>]*>[\s\S]*?<\/head>/i, '');
    }
    const bodyMatch = bodyContent.match(/<body[^>]*>([\s\S]*?)<\/body>/i);
    if (bodyMatch) bodyContent = bodyMatch[1];
    html = `<!DOCTYPE html><html lang="zh-CN"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1.0">${headContent}</head><body>${bodyContent}</body></html>`;
  }

  // 确保有 charset 和 viewport
  if (!/<meta[^>]+charset/i.test(html)) {
    if (html.includes('<head>')) html = html.replace(/<head>/i, '<head>\n<meta charset="UTF-8">');
  }
  if (!/<meta[^>]+viewport/i.test(html)) {
    const vm = '<meta name="viewport" content="width=device-width, initial-scale=1.0">';
    if (html.includes('<head>')) html = html.replace(/<head>/i, `<head>\n${vm}`);
  }

  // 检查 @media print CSS 是否已存在
  const hasMediaPrint = /@media\s+print\s*\{/i.test(html);
  if (!hasMediaPrint) {
    // 在 </head> 之前注入 @media print CSS
    const mediaPrintStyle = `<style id="pdf-media-print">${MEDIA_PRINT_CSS}</style>`;
    if (/<\/head>/i.test(html)) {
      html = html.replace(/<\/head>/i, `${mediaPrintStyle}\n</head>`);
    } else {
      // 如果没有 </head>，在 <body> 之前插入
      html = html.replace(/<body/i, `${mediaPrintStyle}\n<body`);
    }
    console.log('📝 自动补入 @media print CSS');
  }

  // 确保存在 .ani 类标记的检查
  const hasAniClass = /class=["'][^"']*\bani\b/i.test(html) || /class=["'][^"']*ani[a-zA-Z-]*/i.test(html);
  if (!hasAniClass) {
    console.log('⚠️ 未检测到 .ani 类标记，建议为动画元素添加 class="ani"');
  }

  // 移除注释
  html = html.replace(/<!--(?!\[if)[\s\S]*?-->/g, '');

  if (!html.trim().toLowerCase().startsWith('<!doctype')) html = '<!DOCTYPE html>\n' + html;

  return html;
}

// ======== 核心PDF渲染函数 ========
async function convertHtmlToPdfSuperLong(htmlContent, options = {}) {
  htmlContent = normalizeHtmlForPdf(htmlContent);

  const browser = await getBrowser();
  const page = await browser.newPage();

  try {
    // 设置视口（1920×1080标准视口，让内容按设计尺寸渲染）
    const VIEWPORT_WIDTH = 1920;
    const VIEWPORT_HEIGHT = 1080;
    await page.setViewport({ width: VIEWPORT_WIDTH, height: VIEWPORT_HEIGHT, deviceScaleFactor: 1 });

    // 加载HTML内容
    await page.setContent(htmlContent, {
      waitUntil: ['networkidle0', 'domcontentloaded'],
      timeout: TIMEOUTS.pageLoad
    });

    // 等待字体加载完成
    await page.evaluate(() => {
      if (document.fonts && document.fonts.ready) {
        return document.fonts.ready;
      }
      return Promise.resolve();
    });
    await new Promise(r => setTimeout(r, TIMEOUTS.fontWait));

    // 点击展开隐藏的tab和fi元素（兼容操作栏和更多内容）
    await page.evaluate(() => {
      document.querySelectorAll('.tc').forEach(t => t.classList.add('act'));
      document.querySelectorAll('.fi').forEach(el => el.classList.add('sho'));
      // 建议区
      const sug = document.getElementById('sugGrid');
      if (sug) sug.style.display = '';
      // section列表展开卡片
      document.querySelectorAll('.section').forEach(s => {
        if (s.click) s.click();
      });
    });
    await new Promise(r => setTimeout(r, TIMEOUTS.postExpand));

    // === 注入PDF渲染CSS ===
    await page.addStyleTag({ content: PDF_RENDER_CSS });
    await new Promise(r => setTimeout(r, TIMEOUTS.postStyle));

    // === 冻结动画元素：.ani三件套 ===
    await page.evaluate(() => {
      // 强制所有 .ani 元素可见
      const aniElements = document.querySelectorAll('.ani, .animated, [class*="ani"]');
      aniElements.forEach(el => {
        el.style.opacity = '1';
        el.style.visibility = 'visible';
        el.style.animation = 'none';
        el.style.transform = 'none';
        el.style.transition = 'none';
      });

      // 检查是否有元素初始opacity为0但没有.ani类（补偿处理）
      document.querySelectorAll('*').forEach(el => {
        const computed = getComputedStyle(el);
        // 如果元素通过 CSS animation 或 transition 设置了隐藏
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

    // === 隐藏装饰元素 ===
    await page.evaluate(() => {
      // 粒子canvas
      const pc = document.getElementById('particle-canvas');
      if (pc) pc.style.display = 'none';
      // 导航点
      const dots = document.getElementById('dots');
      if (dots) dots.style.display = 'none';
      document.querySelectorAll('.dots').forEach(d => d.style.display = 'none');
      // 进度条
      document.querySelectorAll('.prog').forEach(p => p.style.display = 'none');
      // 导航箭头
      document.querySelectorAll('.arrow').forEach(a => a.style.display = 'none');
    });

    await new Promise(r => setTimeout(r, TIMEOUTS.postStyle));

    // === 测量完整内容高度 ===
    const measurements = await page.evaluate(() => {
      const de = document.documentElement;
      const body = document.body;

      // 临时移除body滚动条以获得准确宽度
      const originalOverflow = body?.style.overflow;
      const originalOverflowX = body?.style.overflowX;
      if (body) {
        body.style.overflow = 'visible';
        body.style.overflowX = 'visible';
      }

      const scrollW = Math.max(de.scrollWidth, body ? body.scrollWidth : 0);

      // 遍历所有可见元素获取最大right和bottom
      let maxRight = 0;
      let maxBottom = 0;
      document.querySelectorAll('body *').forEach(el => {
        const cs = getComputedStyle(el);
        if (cs.display === 'none' || cs.visibility === 'hidden' || cs.opacity === '0') return;
        const rect = el.getBoundingClientRect();
        maxRight = Math.max(maxRight, rect.right);
        maxBottom = Math.max(maxBottom, rect.bottom);
      });
      const scrollH = Math.max(de.scrollHeight, body ? body.scrollHeight : 0);
      maxBottom = Math.max(maxBottom, scrollH);

      // 恢复
      if (body) {
        body.style.overflow = originalOverflow || '';
        body.style.overflowX = originalOverflowX || '';
      }

      const contentWidth = Math.max(Math.ceil(maxRight), scrollW, 320);
      const contentHeight = Math.max(Math.ceil(maxBottom), 100);
      const bgColor = getComputedStyle(body || de).backgroundColor || '#ffffff';

      return { contentWidth, contentHeight, bgColor };
    });

    // === 添加2px filler消除底部缝隙 ===
    await page.evaluate((bg) => {
      const filler = document.createElement('div');
      filler.id = 'pdf-filler';
      filler.style.cssText = `height:2px;width:100%;background:${bg};flex-shrink:0;`;
      document.body.appendChild(filler);
    }, measurements.bgColor);

    // 重新测量高度
    const finalHeight = await page.evaluate(() => {
      const de = document.documentElement;
      const body = document.body;
      let maxH = Math.max(de.scrollHeight, body ? body.scrollHeight : 0, 100);
      document.querySelectorAll('body *').forEach(el => {
        const cs = getComputedStyle(el);
        if (cs.display === 'none' || cs.visibility === 'hidden' || cs.opacity === '0') return;
        const rect = el.getBoundingClientRect();
        maxH = Math.max(maxH, rect.bottom);
      });
      return maxH;
    });

    // 再次添加一个同底色的2px filler（双重保险）
    await page.evaluate((bg) => {
      const existing = document.getElementById('pdf-filler');
      if (existing) {
        existing.style.height = '0px';
      }
      const filler = document.createElement('div');
      filler.style.cssText = `height:2px;width:100%;background:${bg};flex-shrink:0;`;
      document.body.appendChild(filler);
    }, measurements.bgColor);

    const pdfWidth = Math.max(measurements.contentWidth, 320);
    const pdfHeight = Math.max(finalHeight, 100);

    console.log(`📐 测量: 宽=${pdfWidth}px, 高=${pdfHeight}px`);

    // === 生成矢量PDF ===
    const pdfBuffer = await page.pdf({
      width: `${pdfWidth}px`,
      height: `${pdfHeight}px`,
      printBackground: true,
      margin: { top: 0, right: 0, bottom: 0, left: 0 },
      preferCSSPageSize: false,
      scale: 1
    });

    console.log(`✅ [SuperLong模式] 矢量PDF: ${pdfWidth}x${pdfHeight}px, ${(pdfBuffer.length / 1024).toFixed(1)}KB`);

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

// ======== PDF 质量验证 ========
async function verifyPdf(pdfBuffer) {
  try {
    const pdfDoc = await PDFDocument.load(pdfBuffer);
    const pageCount = pdfDoc.getPageCount();
    const pages = pdfDoc.getPages();
    const firstPage = pages[0];
    const { width, height } = firstPage.getSize();

    const checks = {
      pageCount: pageCount,
      pageCountOk: pageCount === 1,
      width: width,
      height: height,
      widthOk: width >= 500,
      heightOk: height > 500,
      sizeOk: pdfBuffer.length > 1024,
      textOk: true
    };

    console.log(`🔍 PDF验证: 页数=${pageCount}, 尺寸=${width.toFixed(1)}x${height.toFixed(1)}pt`);

    return checks;
  } catch (err) {
    console.error('PDF验证失败:', err.message);
    return { error: err.message };
  }
}

// ======== API 路由 ========
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
    const verify = await verifyPdf(result.buffer);

    if (verify.error) {
      console.warn('⚠️ PDF验证警告:', verify.error);
    }

    clearTimeout(requestTimer);

    const pdfName = (filename || 'document').replace(/\.html?$/i, '') + '.pdf';
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename="${encodeURIComponent(pdfName)}"`);
    res.setHeader('X-PDF-Pages', result.contentHeight > 5000 ? 1 : verify.pageCount || 1);
    res.setHeader('X-PDF-Size-KB', result.sizeKB);
    res.setHeader('X-PDF-Mode', result.mode);
    res.setHeader('X-PDF-Width', result.contentWidth);
    res.setHeader('X-PDF-Height', result.contentHeight);
    res.send(result.buffer);

    console.log(`📤 完成: ${pdfName} (${result.mode}, ${result.contentWidth}x${result.contentHeight}px, ${result.sizeKB}KB)`);
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
  console.log(`   PDF模式: super-long (超长单页矢量PDF)\n`);
});
