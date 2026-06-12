#!/usr/bin/env node
/**
 * HTML Editor 后端服务
 * - 提供静态文件服务（HTML 编辑器前端）
 * - 提供 /api/html-to-pdf 接口，基于 Puppeteer + Chromium 将 HTML 转为 PDF
 *
 * PDF 生成策略：
 * - 截图模式（默认）：全页截图 → 嵌入PDF，像素级精确，100%保留颜色/渐变/阴影
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

  // ── Step 8: 禁用/覆盖 @media print 样式（防止打印时样式变化） ──
  // 将所有 @media print 块替换为空（我们在后面会注入自己的打印覆盖CSS）
  html = html.replace(/@media\s+print\s*\{[\s\S]*?\}/gi, '');

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
  pageLoad: 30000,
  canvasWait: 15000,
  postRender: 2000,
  postExpand: 500,
  postStyle: 300,
  postViewport: 500  // viewport 切换后等待重排
};

// 截图模式：单页最大高度（超过则自动分页）
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
  // ★ 预处理 HTML：规范化各种格式差异
  htmlContent = normalizeHtmlForPdf(htmlContent);

  // ★ 自动检测 HTML 设计宽度：先以宽 viewport 渲染，测量内容实际宽度
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
    console.error('❌ 创建页面失败:', pageErr.message);
    browserInstance = null;
    throw new Error('创建渲染页面失败，请重试: ' + pageErr.message);
  }

  // Step0: 先以默认PC宽度渲染，用于检测实际内容宽度
  await page.setViewport(DEFAULT_VIEWPORT);

  // 写临时文件并用 file:// 加载
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
    try { unlinkSync(tmpHtmlPath); } catch (_) {}
  }

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

  // Step1: 注入背景色和打印颜色保留CSS
  await page.evaluate(() => {
    const style = document.createElement('style');
    style.id = 'pdf-bg-override';
    style.textContent = `
      html, body {
        -webkit-print-color-adjust: exact !important;
        print-color-adjust: exact !important;
        color-adjust: exact !important;
      }
    `;
    document.head.appendChild(style);
    const htmlBg = getComputedStyle(document.documentElement).backgroundColor;
    const bodyBg = getComputedStyle(document.body).backgroundColor;
    if (!htmlBg || htmlBg === 'rgba(0, 0, 0, 0)' || htmlBg === 'transparent') {
      document.documentElement.style.backgroundColor = '#ffffff';
    }
    if (!bodyBg || bodyBg === 'rgba(0, 0, 0, 0)' || bodyBg === 'transparent') {
      document.body.style.backgroundColor = '#ffffff';
    }
  });

  // Step2: ★ 自动检测 HTML 的设计宽度
  let detectedWidth;
  if (userPdfWidth) {
    // 用户指定了宽度，直接使用
    detectedWidth = userPdfWidth;
  } else {
    // 自动检测：智能识别 HTML 的实际设计宽度
    detectedWidth = await page.evaluate(() => {
      // 方法1: 遍历所有可见元素，取最大 right 边界
      let maxRight = 0;
      const allElements = document.querySelectorAll('body *');
      allElements.forEach(el => {
        const cs = getComputedStyle(el);
        if (cs.display === 'none' || cs.visibility === 'hidden' || cs.opacity === '0') return;
        const rect = el.getBoundingClientRect();
        if (rect.right > maxRight) {
          maxRight = rect.right;
        }
      });

      // 方法2: 检查 body 和主要容器的 max-width（识别居中布局的移动端设计）
      // 很多移动端模板使用 max-width: 390px + margin: 0 auto 居中
      let contentMaxWidth = 0;
      const checkElements = [document.body, ...document.querySelectorAll('body > *')];
      checkElements.forEach(el => {
        if (!el) return;
        const cs = getComputedStyle(el);
        // 检查 max-width
        if (cs.maxWidth && cs.maxWidth !== 'none') {
          const mw = parseFloat(cs.maxWidth);
          if (mw > 0 && mw < 800) { // 小于800px的max-width很可能是移动端设计
            contentMaxWidth = Math.max(contentMaxWidth, mw);
          }
        }
        // 检查 width 的固定值
        if (cs.width && cs.width !== 'auto') {
          const w = parseFloat(cs.width);
          if (w > 0 && w < 800) {
            contentMaxWidth = Math.max(contentMaxWidth, w);
          }
        }
      });

      // 方法3: 检查 viewport meta 的 width 声明
      let viewportWidth = 0;
      const viewportMeta = document.querySelector('meta[name="viewport"]');
      if (viewportMeta) {
        const content = viewportMeta.getAttribute('content') || '';
        const widthMatch = content.match(/width\s*=\s*(\d+)/);
        if (widthMatch) {
          viewportWidth = parseInt(widthMatch[1], 10);
        }
      }

      // 综合判断：如果有明显的移动端 max-width 声明，使用它
      if (contentMaxWidth > 300 && contentMaxWidth <= 500) {
        return Math.ceil(contentMaxWidth);
      }
      // 如果有 viewport width 声明且是移动端宽度
      if (viewportWidth > 300 && viewportWidth <= 500) {
        return Math.ceil(viewportWidth);
      }
      // 否则使用元素实际渲染宽度
      const bodyWidth = document.body ? document.body.scrollWidth : 0;
      const htmlWidth = document.documentElement ? document.documentElement.scrollWidth : 0;
      const docWidth = Math.max(bodyWidth, htmlWidth);
      return Math.max(Math.ceil(maxRight), docWidth, 320);
    });
    console.log(`📐 自动检测到内容宽度: ${detectedWidth}px`);
  }

  // ★ 根据检测到的宽度，判断是否为手机端设计
  // 手机端设计：宽度 <= 500px（如375/390/414等），用检测到的宽度
  // PC端设计：宽度 > 500px，用检测到的宽度
  const pdfWidth = detectedWidth;

  // Step3: 设置正确的 viewport 宽度，高度保持足够大（避免100vh问题后面处理）
  const viewport = { width: pdfWidth, height: DEFAULT_VIEWPORT.height };
  await page.setViewport(viewport);
  await new Promise(r => setTimeout(r, TIMEOUTS.postViewport));

  // Step4: 消除 100vh 等导致PDF空白的声明
  await page.evaluate(() => {
    document.querySelectorAll('[style]').forEach(el => {
      const style = el.style;
      ['height', 'minHeight', 'maxHeight'].forEach(prop => {
        const val = style.getPropertyValue(prop);
        if (val && (val.includes('vh') || val.includes('vw'))) {
          style.setProperty(prop, 'auto', 'important');
        }
      });
    });

    try {
      for (const sheet of document.styleSheets) {
        try {
          for (const rule of sheet.cssRules) {
            if (rule.style) {
              ['height', 'min-height', 'max-height'].forEach(prop => {
                const val = rule.style.getPropertyValue(prop);
                if (val && (val.includes('vh') || val.includes('vw'))) {
                  rule.style.setProperty(prop, 'auto', 'important');
                }
              });
            }
            if (rule.cssRules) {
              for (const innerRule of rule.cssRules) {
                if (innerRule.style) {
                  ['height', 'min-height', 'max-height'].forEach(prop => {
                    const val = innerRule.style.getPropertyValue(prop);
                    if (val && (val.includes('vh') || val.includes('vw'))) {
                      innerRule.style.setProperty(prop, 'auto', 'important');
                    }
                  });
                }
              }
            }
          }
        } catch (e) {}
      }
    } catch (e) {}

    document.documentElement.style.setProperty('height', 'auto', 'important');
    document.documentElement.style.setProperty('min-height', 'auto', 'important');
    document.body.style.setProperty('height', 'auto', 'important');
    document.body.style.setProperty('min-height', 'auto', 'important');
    document.body.style.setProperty('overflow', 'visible', 'important');
  });

  await new Promise(r => setTimeout(r, TIMEOUTS.postStyle));

  // 展开隐藏内容
  await page.evaluate(() => {
    document.querySelectorAll('.tc').forEach(t => t.classList.add('act'));
    document.querySelectorAll('.fi').forEach(el => el.classList.add('sho'));
    const sugGrid = document.getElementById('sugGrid');
    if (sugGrid) sugGrid.style.display = '';
  });
  await new Promise(r => setTimeout(r, TIMEOUTS.postExpand));

  // Step5: 精确测量内容高度
  let contentHeight = await page.evaluate(() => {
    let maxBottom = 0;
    const allElements = document.querySelectorAll('body *');
    allElements.forEach(el => {
      const cs = getComputedStyle(el);
      if (cs.display === 'none' || cs.visibility === 'hidden' || cs.opacity === '0') return;
      const rect = el.getBoundingClientRect();
      if (rect.bottom > maxBottom) {
        maxBottom = rect.bottom;
      }
    });

    const scrollH = Math.max(
      document.documentElement.scrollHeight || 0,
      document.body ? document.body.scrollHeight : 0
    );

    const result = Math.min(maxBottom, scrollH);
    return Math.ceil(result + 20);
  });

  contentHeight = Math.max(contentHeight, 100);

  console.log(`📐 PDF渲染参数: 宽度=${pdfWidth}px, 内容高度=${contentHeight}px`);

  return { page, contentHeight, viewport };
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
 *
 * 解决的7个问题：
 * 1. 页面比例 → A4标准纸张 (595.28×841.89pt = 794×1123px)
 * 2. 分页硬切 → 智能断页（检测块级元素边界，避免切断卡片/表格）
 * 3. 宽度适配 → 自动检测设计宽度 + 缩放到A4 / 手机端内容居中
 * 4. 文件过大 → JPEG压缩(quality=92)替代PNG
 * 5. 阅读体验 → A4标准尺寸，PDF阅读器完美显示
 * 6. 底部空白 → 精确测量内容高度，不留多余空白
 * 7. 末页空白 → 末页高度=剩余内容高度
 */
async function convertHtmlToPdfScreenshot(htmlContent, options = {}) {
  const { page, contentHeight, viewport } = await createRenderedPage(htmlContent, options);
  const scale = 2; // deviceScaleFactor，2x高清

  try {
    return await _screenshotA4Paged(page, contentHeight, viewport, scale);
  } finally {
    await page.close();
  }
}

// A4 纸张参数 (CSS像素, 96 DPI)
const A4_WIDTH_PX = 794;    // 595.28pt * 96/72
const A4_HEIGHT_PX = 1123;  // 841.89pt * 96/72
const A4_MARGIN_PX = 0;     // 无边距（HTML自带边距）
const A4_CONTENT_W = A4_WIDTH_PX - A4_MARGIN_PX * 2;
const A4_CONTENT_H = A4_HEIGHT_PX - A4_MARGIN_PX * 2;

/**
 * 截图模式 - A4 智能分页版本
 *
 * 流程：
 * 1. 以 HTML 设计宽度渲染截图（全页长图）
 * 2. 计算缩放比例：让内容适配 A4 宽度
 * 3. 智能检测分页点：找到不切断内容的安全断页位置
 * 4. 分段截图 → JPEG 压缩 → 嵌入 A4 页面
 */
async function _screenshotA4Paged(page, contentHeight, viewport, scale) {
  const htmlWidth = viewport.width;

  // ★ Step 1: 计算缩放比例
  // PC端设计(>500px): 缩放到A4宽度，保持比例
  // 手机端设计(≤500px): 居中放在A4页面上，1:1不缩放（或适当放大）
  let renderScale, offsetX, contentRenderW, contentRenderH;

  if (htmlWidth > 500) {
    // PC端设计：缩放到A4内容宽度
    renderScale = A4_CONTENT_W / htmlWidth;
    contentRenderW = A4_CONTENT_W;
    contentRenderH = Math.ceil(contentHeight * renderScale);
    offsetX = A4_MARGIN_PX;
  } else {
    // 手机端设计：居中放置，适当放大让内容更易读
    // 放大到A4宽度的60%左右，保持手机端视觉比例
    renderScale = (A4_CONTENT_W * 0.55) / htmlWidth;
    contentRenderW = Math.ceil(htmlWidth * renderScale);
    contentRenderH = Math.ceil(contentHeight * renderScale);
    offsetX = Math.floor((A4_WIDTH_PX - contentRenderW) / 2); // 居中
  }

  // ★ Step 2: 设置 viewport 为 A4 宽度渲染
  // 先在 A4 宽度下重新渲染，应用缩放
  await page.setViewport({
    width: A4_WIDTH_PX,
    height: Math.max(A4_HEIGHT_PX, contentRenderH + 100),
    deviceScaleFactor: scale
  });
  await new Promise(r => setTimeout(r, TIMEOUTS.postViewport));

  // 注入缩放CSS：将原始内容缩放到目标大小
  await page.evaluate((rs, ox) => {
    // 给 body 添加缩放变换
    const body = document.body;
    body.style.transformOrigin = '0 0';
    body.style.transform = `scale(${rs})`;
    body.style.width = `${100 / rs}%`;
    // 如果需要居中（手机端），添加左边距
    if (ox > 0) {
      body.style.marginLeft = `${ox / rs}px`;
    }
  }, renderScale, offsetX);
  await new Promise(r => setTimeout(r, TIMEOUTS.postStyle));

  // ★ Step 3: 重新测量缩放后的内容高度
  const scaledContentHeight = await page.evaluate(() => {
    let maxBottom = 0;
    const allElements = document.querySelectorAll('body *');
    allElements.forEach(el => {
      const cs = getComputedStyle(el);
      if (cs.display === 'none' || cs.visibility === 'hidden' || cs.opacity === '0') return;
      const rect = el.getBoundingClientRect();
      if (rect.bottom > maxBottom) maxBottom = rect.bottom;
    });
    return Math.ceil(maxBottom + 10);
  });

  console.log(`📐 A4分页参数: HTML宽=${htmlWidth}px, 缩放=${renderScale.toFixed(3)}, 渲染内容高=${scaledContentHeight}px, A4内容高=${A4_CONTENT_H}px`);

  // ★ Step 4: 智能分页 - 检测安全的断页位置
  const pageBreaks = await _findSmartPageBreaks(page, A4_CONTENT_H, scaledContentHeight, scale);

  const totalPages = pageBreaks.length;
  console.log(`📄 A4智能分页: 共${totalPages}页, 断页点=[${pageBreaks.map(b => b.y + 'px(' + b.reason + ')').join(', ')}]`);

  // ★ Step 5: 分段截图 → JPEG → 嵌入PDF
  const pdfDoc = await PDFDocument.create();

  for (let i = 0; i < totalPages; i++) {
    const clipY = pageBreaks[i].y;
    const nextY = i < totalPages - 1 ? pageBreaks[i + 1].y : scaledContentHeight;
    const clipHeight = Math.min(nextY - clipY, A4_CONTENT_H);

    console.log(`  📸 截取第 ${i + 1}/${totalPages} 页: y=${clipY}, height=${clipHeight}`);

    // 滚动到目标位置
    await page.evaluate((y) => window.scrollTo(0, y), clipY);
    await new Promise(r => setTimeout(r, 200));

    // 截图
    const screenshotBuffer = await page.screenshot({
      type: 'jpeg',
      quality: 92,
      clip: {
        x: 0,
        y: clipY,
        width: A4_WIDTH_PX,
        height: clipHeight
      }
    });

    // 嵌入A4页面
    // A4尺寸: 595.28 × 841.89 pt
    const a4W = 595.28;
    const a4H = 841.89;
    const img = await pdfDoc.embedJpg(screenshotBuffer);

    // 页面高度：如果是最后一页且内容不满，按实际内容高度设置
    const isLastPage = (i === totalPages - 1);
    const pageH = isLastPage ? (clipHeight / A4_CONTENT_H * a4H) : a4H;

    const pdfPage = pdfDoc.addPage([a4W, pageH]);
    pdfPage.drawImage(img, {
      x: 0, y: 0,
      width: a4W,
      height: pageH
    });
  }

  const pdfBuffer = await pdfDoc.save();
  const sizeKB = (pdfBuffer.length / 1024).toFixed(1);
  const pageCount = pdfDoc.getPageCount();

  console.log(`✅ [截图模式-A4智能分页] PDF 生成成功: ${pageCount} 页, ${sizeKB} KB, A4尺寸`);

  return {
    buffer: Buffer.from(pdfBuffer),
    pageCount,
    pageSize: { width: 595.28, height: 841.89 },
    sizeKB,
    mode: 'screenshot'
  };
}

/**
 * 智能分页：找到不切断内容的安全断页位置
 *
 * 策略：
 * 1. 从每页底部向上搜索，找到最近的块级元素边界作为断页点
 * 2. 块级元素包括：卡片(.card)、标题(h1-h6)、表格(table)、分割线(hr)、section
 * 3. 如果找不到合适的块级边界，则在页面底部留出少量安全边距后截断
 * 4. 避免在文字段落中间断开
 */
async function _findSmartPageBreaks(page, pageHeight, totalHeight, scale) {
  // 在页面中执行分页点检测
  const breaks = await page.evaluate((pH, tH) => {
    const result = [{ y: 0, reason: '页首' }];

    let currentY = pH;
    while (currentY < tH) {
      // 在当前分页线附近搜索最佳断点
      // 搜索范围：从分页线向上200px到分页线下方50px
      const searchTop = Math.max(currentY - 300, result[result.length - 1].y + 200);
      const searchBottom = currentY + 50;

      // 收集搜索范围内所有块级元素的边界位置
      const blockElements = document.querySelectorAll(
        'h1, h2, h3, h4, h5, h6, ' +
        '.card, .section, .container, .page, .slide, ' +
        'table, thead, hr, ' +
        '.divider, .separator, .spacer, ' +
        '[class*="card"], [class*="section"], [class*="block"], ' +
        'section, article, aside, main, header, footer, nav'
      );

      let bestBreak = null;
      let bestScore = -1;

      blockElements.forEach(el => {
        const rect = el.getBoundingClientRect();
        const top = Math.round(rect.top);
        const bottom = Math.round(rect.bottom);

        // 元素顶部作为断点（新元素从新一页开始）
        if (top >= searchTop && top <= searchBottom) {
          // 评分：越接近理想分页线越好，且大元素优先
          const distance = Math.abs(top - currentY);
          const sizeBonus = rect.height > 50 ? 10 : 0;
          const score = 1000 - distance + sizeBonus;
          if (score > bestScore) {
            bestScore = score;
            bestBreak = { y: top, reason: el.tagName + (el.className ? '.' + el.className.split(' ')[0] : '') + '-top' };
          }
        }

        // 元素底部作为断点（元素完整显示在当前页）
        if (bottom >= searchTop && bottom <= searchBottom) {
          const distance = Math.abs(bottom - currentY);
          const sizeBonus = rect.height > 50 ? 10 : 0;
          const score = 1000 - distance + sizeBonus + 5; // 底部断点略优先
          if (score > bestScore) {
            bestScore = score;
            bestBreak = { y: bottom, reason: el.tagName + (el.className ? '.' + el.className.split(' ')[0] : '') + '-bottom' };
          }
        }
      });

      if (bestBreak && bestBreak.y > result[result.length - 1].y) {
        result.push(bestBreak);
        currentY = bestBreak.y + pH;
      } else {
        // 没找到合适的块级边界，直接在页面高度处截断
        const fallback = { y: currentY, reason: 'fallback' };
        if (fallback.y > result[result.length - 1].y) {
          result.push(fallback);
        }
        currentY += pH;
      }
    }

    return result;
  }, pageHeight, totalHeight);

  return breaks;
}

/**
 * 核心：HTML → PDF 转换（自动根据模式分发）
 */
async function convertHtmlToPdf(htmlContent, options = {}) {
  const mode = options.pdfMode || 'screenshot';
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

    console.log(`📄 收到 PDF 转换请求，HTML 长度: ${html.length} 字符, PDF宽度: ${pdfWidth || 'auto'}, 模式: ${pdfMode || 'screenshot'}`);

    const result = await convertHtmlToPdf(html, { pdfWidth: pdfWidth || 'auto', pdfMode: pdfMode || 'screenshot' });

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
    console.error('❌ PDF 转换失败:', err.message);
    res.status(500).json({ error: 'PDF 转换失败: ' + err.message });
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
