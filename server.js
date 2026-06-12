#!/usr/bin/env node
/**
 * HTML Editor 后端服务
 * - 提供静态文件服务（HTML 编辑器前端）
 * - 提供 /api/html-to-pdf 接口，基于 Puppeteer + Chromium 将 HTML 转为 PDF
 *
 * PDF 生成策略：
 * - 截图模式（默认）：全页截图 → 嵌入PDF（无限长单页，与HTML完全一致，不分页）
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
  pageLoad: 20000,     // 页面加载（从30s缩短）
  canvasWait: 8000,    // Canvas图表等待（从15s缩短）
  postRender: 800,     // 渲染后等待（从2s缩短，大部分页面800ms足够）
  postExpand: 200,     // 展开隐藏内容（从500ms缩短）
  postStyle: 150,      // CSS注入后（从300ms缩短）
  postViewport: 200,   // viewport切换后（从500ms缩短）
  requestTotal: 45000  // ★ 请求级总超时（45秒，防止网关504）
};

// 截图模式：单页最大高度（超过此高度将分段截图后拼接）
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

  // Step3: 设置正确的 viewport 宽度，高度暂用默认值（后续截图函数会精确调整）
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
 * ★ 不做A4分页！生成一张无限长的单页PDF，内容有多长页面就有多长
 *
 * ★★★ 大页面分段截图拼接：
 * Chromium 截图有像素上限（宽×高 × scale² 不得超过 ~16384×16384 像素）
 * PPT 风格的 HTML（如20个min-height:100vh的幻灯片）内容高度可达 18000+px
 * 在 deviceScaleFactor=2 时，实际像素高度 = 18000×2 = 36000px → 超限 → "Page is too large"
 * 解决：将长页面按段分段截图，每段不超过上限，然后用 pdf-lib 拼接为单页 PDF
 *
 * 优势：
 * 1. 像素级精确：100% 保留背景色/渐变/阴影
 * 2. 无分页切断：不会在卡片/表格中间硬切
 * 3. 无多余空白：页面高度 = 内容实际高度
 * 4. 与HTML完全一致：所见即所得
 * 5. 支持任意长度的内容：超长页面自动分段截图拼接
 */
async function convertHtmlToPdfScreenshot(htmlContent, options = {}) {
  const { page, contentHeight, viewport } = await createRenderedPage(htmlContent, options);
  const scale = 2; // deviceScaleFactor，2x高清

  try {
    // ★ 计算分段策略：Chromium 截图像素上限（宽和高各自不能超过 MAX_SCREENSHOT_DIM）
    // 在 deviceScaleFactor=2 时，CSS 像素上限 = MAX_SCREENSHOT_DIM / 2
    const MAX_SCREENSHOT_DIM = 16384;
    const maxCssHeight = Math.floor(MAX_SCREENSHOT_DIM / scale) - 100; // 留100px安全余量

    // 宽度也需要检查
    const maxCssWidth = Math.floor(MAX_SCREENSHOT_DIM / scale) - 100;
    const effectiveWidth = Math.min(viewport.width, maxCssWidth);

    const needsSegmenting = contentHeight > maxCssHeight;
    const segmentHeight = needsSegmenting ? maxCssHeight : contentHeight;
    const segmentCount = needsSegmenting ? Math.ceil(contentHeight / segmentHeight) : 1;

    console.log(`📐 截图策略: 内容=${viewport.width}x${contentHeight}px, scale=${scale}x, ` +
      `像素上限=${MAX_SCREENSHOT_DIM}px, CSS高度上限=${maxCssHeight}px, ` +
      `需要分段=${needsSegmenting}, 段数=${segmentCount}, 段高=${segmentHeight}px`);

    // ★ 设置 viewport（使用有效宽度，防止宽度也超限）
    await page.setViewport({
      width: effectiveWidth,
      height: needsSegmenting ? segmentHeight : contentHeight,
      deviceScaleFactor: scale
    });
    await new Promise(r => setTimeout(r, TIMEOUTS.postViewport));

    if (!needsSegmenting) {
      // ── 小页面：直接全页截图，简单高效 ──
      const screenshotBuffer = await page.screenshot({
        type: 'jpeg',
        quality: 95,
        fullPage: true
      });

      const pdfW = effectiveWidth * 0.75;
      const pdfH = contentHeight * 0.75;

      const pdfDoc = await PDFDocument.create();
      const img = await pdfDoc.embedJpg(screenshotBuffer);
      const pdfPage = pdfDoc.addPage([pdfW, pdfH]);
      pdfPage.drawImage(img, { x: 0, y: 0, width: pdfW, height: pdfH });

      const pdfBuffer = await pdfDoc.save();
      const sizeKB = (pdfBuffer.length / 1024).toFixed(1);

      console.log(`✅ [截图模式-单段] PDF 生成成功: 1 页, ${sizeKB} KB, 尺寸: ${pdfW.toFixed(0)}x${pdfH.toFixed(0)}pt`);

      return {
        buffer: Buffer.from(pdfBuffer),
        pageCount: 1,
        pageSize: { width: pdfW, height: pdfH },
        sizeKB,
        mode: 'screenshot'
      };
    }

    // ── 大页面：分段截图 + 拼接到单页 PDF ──
    const pdfW = effectiveWidth * 0.75;
    const pdfH = contentHeight * 0.75;
    const pdfDoc = await PDFDocument.create();
    const pdfPage = pdfDoc.addPage([pdfW, pdfH]);

    // 从底部往上画（pdf-lib 的 y 轴从底部开始）
    let currentY = pdfH; // PDF坐标系中当前段的底部位置

    for (let i = 0; i < segmentCount; i++) {
      const scrollY = i * segmentHeight;
      const isLast = i === segmentCount - 1;
      // 最后一段可能不满 segmentHeight
      const thisSegmentCssHeight = isLast
        ? (contentHeight - scrollY)
        : segmentHeight;

      // ★ 滚动页面到对应位置
      await page.evaluate((y) => {
        window.scrollTo(0, y);
      }, scrollY);
      // 短暂等待滚动完成和渲染
      await new Promise(r => setTimeout(r, 100));

      // ★ 如果段高度与 viewport 高度差异大，调整 viewport 以避免多余空白
      if (thisSegmentCssHeight !== segmentHeight) {
        await page.setViewport({
          width: effectiveWidth,
          height: thisSegmentCssHeight,
          deviceScaleFactor: scale
        });
        await new Promise(r => setTimeout(r, 100));
        // 滚动可能被重置，重新设置
        await page.evaluate((y) => {
          window.scrollTo(0, y);
        }, scrollY);
        await new Promise(r => setTimeout(r, 50));
      }

      // 截取当前可视区域
      const clipRect = {
        x: 0,
        y: 0,
        width: effectiveWidth,
        height: thisSegmentCssHeight
      };

      let segBuffer;
      try {
        segBuffer = await page.screenshot({
          type: 'jpeg',
          quality: 95,
          clip: clipRect
        });
      } catch (clipErr) {
        // clip截图失败时尝试fullPage截图（降级方案）
        console.warn(`⚠️ 段 ${i + 1} clip截图失败，尝试fullPage:`, clipErr.message);
        segBuffer = await page.screenshot({
          type: 'jpeg',
          quality: 90,
          fullPage: true
        });
      }

      // ★ 计算本段在 PDF 中的位置（从底部往上排列）
      const segPdfHeight = thisSegmentCssHeight * 0.75;
      currentY -= segPdfHeight;

      const img = await pdfDoc.embedJpg(segBuffer);
      pdfPage.drawImage(img, {
        x: 0,
        y: currentY,
        width: pdfW,
        height: segPdfHeight
      });

      console.log(`  📸 段 ${i + 1}/${segmentCount}: scrollY=${scrollY}px, 高度=${thisSegmentCssHeight}px, PDF位置 y=${currentY.toFixed(0)}pt`);
    }

    const pdfBuffer = await pdfDoc.save();
    const sizeKB = (pdfBuffer.length / 1024).toFixed(1);

    console.log(`✅ [截图模式-分段拼接] PDF 生成成功: 1 页, ${sizeKB} KB, 尺寸: ${pdfW.toFixed(0)}x${pdfH.toFixed(0)}pt (${segmentCount}段拼接)`);

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
  // ★ 请求级总超时保护：45秒后自动终止，防止网关504
  const requestTimer = setTimeout(() => {
    if (!res.headersSent) {
      res.status(504).json({ error: 'PDF 生成超时（45秒），内容可能过大，请尝试使用浏览器"打印→另存为PDF"' });
    }
  }, TIMEOUTS.requestTotal);

  try {
    const { html, filename, pdfWidth, pdfMode } = req.body;

    if (!html || typeof html !== 'string') {
      clearTimeout(requestTimer);
      return res.status(400).json({ error: '缺少 html 字段' });
    }

    console.log(`📄 收到 PDF 转换请求，HTML 长度: ${html.length} 字符, PDF宽度: ${pdfWidth || 'auto'}, 模式: ${pdfMode || 'screenshot'}`);

    const result = await convertHtmlToPdf(html, { pdfWidth: pdfWidth || 'auto', pdfMode: pdfMode || 'screenshot' });

    clearTimeout(requestTimer);

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
    clearTimeout(requestTimer);
    console.error('❌ PDF 转换失败:', err.message);
    if (!res.headersSent) {
      res.status(500).json({ error: 'PDF 转换失败: ' + err.message });
    }
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
