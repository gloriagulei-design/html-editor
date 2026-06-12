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

const VIEWPORT = { width: 390, height: 844 };
const TIMEOUTS = {
  pageLoad: 30000,
  canvasWait: 15000,
  postRender: 2000,
  postExpand: 500,
  postStyle: 300
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

  // Step0: 渲染页面（先写临时文件再用 file:// 加载，确保相对资源能正确加载）
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

  // Step1: 注入背景色和打印颜色保留CSS（用CSS注入代替直接修改DOM style，避免颜色格式问题）
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
    // 同时设置 DOM style 确保截图时背景色生效
    const htmlBg = getComputedStyle(document.documentElement).backgroundColor;
    const bodyBg = getComputedStyle(document.body).backgroundColor;
    // 如果 html 或 body 没有背景色，强制设为白色（避免截图时背景透明）
    if (!htmlBg || htmlBg === 'rgba(0, 0, 0, 0)' || htmlBg === 'transparent') {
      document.documentElement.style.backgroundColor = '#ffffff';
    }
    if (!bodyBg || bodyBg === 'rgba(0, 0, 0, 0)' || bodyBg === 'transparent') {
      document.body.style.backgroundColor = '#ffffff';
    }
  });

  // ★ 关键修复：消除 100vh 等导致PDF空白的声明
  // 很多HTML模板使用 height:100vh / min-height:100vh 来撑满屏幕，
  // 但在PDF渲染时这些声明会导致大量空白，因为viewport高度(844px)远大于实际内容高度
  // 策略：将所有使用 vh/vw 的高度声明替换为 auto，保留 px/rem/% 等值
  // 注意：% 单位不处理，因为 html/body 改为 auto 后，子元素的 100% 自然也收缩了
  await page.evaluate(() => {
    // 1. 处理内联样式（style 属性）中的 vh/vw
    document.querySelectorAll('[style]').forEach(el => {
      const style = el.style;
      ['height', 'minHeight', 'maxHeight'].forEach(prop => {
        const val = style.getPropertyValue(prop);
        if (val && (val.includes('vh') || val.includes('vw'))) {
          style.setProperty(prop, 'auto', 'important');
        }
      });
    });

    // 2. 处理 <style> 标签和 <link> 引用的 CSS 中的 vh/vw 规则
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
            // 处理 @media 规则内的规则
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
        } catch (e) {
          // 跨域样式表无法访问，跳过
        }
      }
    } catch (e) {
      // 安全异常，跳过
    }

    // 3. 强制 html/body 高度为 auto
    document.documentElement.style.setProperty('height', 'auto', 'important');
    document.documentElement.style.setProperty('min-height', 'auto', 'important');
    document.body.style.setProperty('height', 'auto', 'important');
    document.body.style.setProperty('min-height', 'auto', 'important');
    document.body.style.setProperty('overflow', 'visible', 'important');
  });

  await new Promise(r => setTimeout(r, TIMEOUTS.postStyle));

  // 展开隐藏内容（如折叠面板等）
  await page.evaluate(() => {
    document.querySelectorAll('.tc').forEach(t => t.classList.add('act'));
    document.querySelectorAll('.fi').forEach(el => el.classList.add('sho'));
    const sugGrid = document.getElementById('sugGrid');
    if (sugGrid) sugGrid.style.display = '';
  });
  await new Promise(r => setTimeout(r, TIMEOUTS.postExpand));

  // Step2: 精确测量内容高度
  // ★ 不使用 scrollHeight（会被 100vh/100%/flex:1 等撑大导致空白）
  // 改用遍历所有可见元素的 getBoundingClientRect().bottom，取最大值
  let contentHeight = await page.evaluate(() => {
    // 方法1: 遍历所有元素，找实际内容底部边界
    let maxBottom = 0;
    const allElements = document.querySelectorAll('body *');
    allElements.forEach(el => {
      // 跳过不可见元素
      const cs = getComputedStyle(el);
      if (cs.display === 'none' || cs.visibility === 'hidden' || cs.opacity === '0') return;
      
      const rect = el.getBoundingClientRect();
      if (rect.bottom > maxBottom) {
        maxBottom = rect.bottom;
      }
    });
    
    // 方法2: 取 scrollHeight 作为参考上限
    const scrollH = Math.max(
      document.documentElement.scrollHeight || 0,
      document.body ? document.body.scrollHeight : 0
    );
    
    // ★ 取两者中较小的值，确保不会因为 100vh 撑出空白
    // 但如果 scrollHeight 比 maxBottom 小很多，说明 maxBottom 可能有问题（如fixed元素），用 scrollHeight
    const result = Math.min(maxBottom, scrollH);
    
    // 加上底部 padding（20px）避免内容被截断
    return Math.ceil(result + 20);
  });
  
  // 如果内容高度小于 viewport 高度，说明内容很短，不需要额外空白
  // 但至少保留 viewport 高度以避免布局问题
  contentHeight = Math.max(contentHeight, 100); // 至少100px

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
 * 核心优化：
 * 1. 使用 deviceScaleFactor: 2 确保高清截图
 * 2. 精确计算PDF尺寸（基于CSS像素 * 0.75转换为pt）
 * 3. 超长内容自动分页截图，避免内存溢出
 * 4. PNG嵌入时确保尺寸精确匹配
 */
async function convertHtmlToPdfScreenshot(htmlContent, options = {}) {
  const { page, contentHeight, viewport } = await createRenderedPage(htmlContent, options);
  const scale = 2; // deviceScaleFactor，2x高清

  try {
    // 判断是否需要分页
    const needsPaging = contentHeight > MAX_SINGLE_PAGE_HEIGHT_PX;

    if (needsPaging) {
      console.log(`📄 内容高度 ${contentHeight}px 超过单页上限 ${MAX_SINGLE_PAGE_HEIGHT_PX}px，将分页截图`);
      return await _screenshotPaged(page, contentHeight, viewport, scale);
    } else {
      return await _screenshotSinglePage(page, contentHeight, viewport, scale);
    }
  } finally {
    await page.close();
  }
}

/**
 * 截图模式 - 单页版本
 * 整页截图 → 嵌入单页PDF
 * 
 * 关键：保持 viewport 高度为手机屏高度（不改为 contentHeight），
 * 避免使用 100vh / height:100% 的元素被拉伸变形。
 * fullPage: true 截图会自动滚动页面捕获全部内容。
 * PDF 尺寸从截图 PNG 的实际像素尺寸精确计算。
 */
async function _screenshotSinglePage(page, contentHeight, viewport, scale) {
  // ★ 保持 viewport 为手机屏尺寸，仅设置 deviceScaleFactor 为高清
  // 关键：由于前面已经注入CSS将 100vh/min-height:100vh 改为 auto，
  // 此时的 contentHeight 已经是真实内容高度，不再包含空白
  await page.setViewport({
    width: viewport.width,
    height: viewport.height,  // 保持手机屏高度，避免 100vh 元素被拉伸
    deviceScaleFactor: scale
  });
  await new Promise(r => setTimeout(r, 500)); // 等待重排完成

  // ★ 全页截图：fullPage=true 会自动滚动截取全部内容
  // 由于 100vh 已被改为 auto，scrollHeight 等于真实内容高度，不会有多余空白
  const screenshotBuffer = await page.screenshot({
    type: 'png',
    fullPage: true
  });

  // ★ 从 PNG 实际像素尺寸反算 CSS 像素尺寸（除以 deviceScaleFactor）
  // puppeteer screenshot 的 PNG 宽度 = viewport.width * scale
  // puppeteer screenshot 的 PNG 高度 = contentHeight * scale
  const imgCssWidth = viewport.width;   // CSS 像素宽
  const imgCssHeight = contentHeight;   // CSS 像素高（截图实际捕获的内容高度）

  // CSS像素 → PDF pt (96 DPI → 72 DPI: 1px = 0.75pt)
  const pdfW = imgCssWidth * 0.75;
  const pdfH = imgCssHeight * 0.75;

  const pdfDoc = await PDFDocument.create();
  const img = await pdfDoc.embedPng(screenshotBuffer);
  const pdfPage = pdfDoc.addPage([pdfW, pdfH]);
  pdfPage.drawImage(img, {
    x: 0, y: 0,
    width: pdfW,
    height: pdfH
  });

  const pdfBuffer = await pdfDoc.save();
  const sizeKB = (pdfBuffer.length / 1024).toFixed(1);

  console.log(`✅ [截图模式-单页] PDF 生成成功: 1 页, ${sizeKB} KB, 尺寸: ${pdfW.toFixed(0)}x${pdfH.toFixed(0)}pt (CSS: ${imgCssWidth}x${imgCssHeight}px, scale: ${scale}x)`);

  return {
    buffer: Buffer.from(pdfBuffer),
    pageCount: 1,
    pageSize: { width: pdfW, height: pdfH },
    sizeKB,
    mode: 'screenshot'
  };
}

/**
 * 截图模式 - 分页版本
 * 将超长内容分段截图 → 每段嵌入PDF的一页
 * 
 * 关键：保持 viewport 高度为手机屏高度，通过 scroll + clip 分段截取，
 * 避免改变 viewport 高度导致 100vh / height:100% 元素变形。
 */
async function _screenshotPaged(page, contentHeight, viewport, scale) {
  const phoneScreenH = viewport.height; // 手机屏高度（如 844px）
  // 每段截图高度：以手机屏高度为单位，但不超过 Chromium 截图安全上限
  const SEGMENT_HEIGHT = Math.min(phoneScreenH * 4, MAX_SINGLE_PAGE_HEIGHT_PX);
  const totalPages = Math.ceil(contentHeight / SEGMENT_HEIGHT);

  console.log(`📄 分页截图: 总高度 ${contentHeight}px, 每段 ${SEGMENT_HEIGHT}px, 共 ${totalPages} 页`);

  // ★ 保持 viewport 为手机屏尺寸（不改变高度！）
  await page.setViewport({
    width: viewport.width,
    height: phoneScreenH,
    deviceScaleFactor: scale
  });
  await new Promise(r => setTimeout(r, 500));

  const pdfDoc = await PDFDocument.create();

  for (let i = 0; i < totalPages; i++) {
    const clipY = i * SEGMENT_HEIGHT;
    const clipHeight = Math.min(SEGMENT_HEIGHT, contentHeight - clipY);

    console.log(`  📸 截取第 ${i + 1}/${totalPages} 页: y=${clipY}, height=${clipHeight}`);

    // ★ 滚动到目标位置（某些固定定位元素需要看到正确状态）
    await page.evaluate((y) => {
      window.scrollTo(0, y);
    }, clipY);
    await new Promise(r => setTimeout(r, 200)); // 等待滚动动画完成

    // 分段截图（clip 不受 viewport 高度限制，可截取视口外内容）
    const screenshotBuffer = await page.screenshot({
      type: 'png',
      clip: {
        x: 0,
        y: clipY,
        width: viewport.width,
        height: clipHeight
      }
    });

    // 嵌入PDF页面：CSS像素 → pt
    const pdfW = viewport.width * 0.75;
    const pdfH = clipHeight * 0.75;

    const img = await pdfDoc.embedPng(screenshotBuffer);
    const pdfPage = pdfDoc.addPage([pdfW, pdfH]);
    pdfPage.drawImage(img, {
      x: 0, y: 0,
      width: pdfW,
      height: pdfH
    });
  }

  const pdfBuffer = await pdfDoc.save();
  const sizeKB = (pdfBuffer.length / 1024).toFixed(1);
  const pageCount = pdfDoc.getPageCount();

  console.log(`✅ [截图模式-分页] PDF 生成成功: ${pageCount} 页, ${sizeKB} KB`);

  return {
    buffer: Buffer.from(pdfBuffer),
    pageCount,
    pageSize: { width: viewport.width * 0.75, height: contentHeight * 0.75 },
    sizeKB,
    mode: 'screenshot'
  };
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
  console.log(`   PDF 转换: POST /api/html-to-pdf`);
  console.log(`   默认模式: 截图模式 (像素级精确)\n`);
});
