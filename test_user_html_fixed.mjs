import puppeteer from 'puppeteer-core';
import fs from 'fs';
import { PDFDocument } from 'pdf-lib';

const CHROME = '/usr/bin/ungoogled-chromium';
const DEFAULT_VIEWPORT = { width: 1280, height: 900 };
const TIMEOUTS = { pageLoad: 15000, postRender: 500, postViewport: 150, postStyle: 100 };

const PDF_PRINT_OVERRIDE_CSS = `
  @media print {
    * {
      page-break-inside: avoid !important;
      break-inside: avoid !important;
      page-break-after: avoid !important;
      break-after: avoid !important;
      page-break-before: avoid !important;
      break-before: avoid !important;
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
  }
  *, *::before, *::after {
    -webkit-print-color-adjust: exact !important;
    print-color-adjust: exact !important;
    color-adjust: exact !important;
  }
`;

async function getBrowser() {
  return puppeteer.launch({ executablePath: CHROME, headless: 'new', args: ['--no-sandbox','--disable-gpu'] });
}

async function main() {
  const html = fs.readFileSync('/data/gloria-cloud/html-editor/.tmp/pdf-5f25ce8a-7d45-4442-9db9-68d490c50740.html', 'utf-8');
  console.log('HTML长度:', html.length, '字符');

  const browser = await getBrowser();
  const page = await browser.newPage();

  // Step 1: 默认viewport渲染
  await page.setViewport(DEFAULT_VIEWPORT);
  await page.setContent(html, { waitUntil: 'domcontentloaded', timeout: TIMEOUTS.pageLoad });
  await new Promise(r => setTimeout(r, TIMEOUTS.postRender));

  // Step 2: 宽度检测
  const detected = await page.evaluate(() => {
    let maxRight = 0;
    document.querySelectorAll('body *').forEach(el => {
      const cs = getComputedStyle(el);
      if (cs.display === 'none' || cs.visibility === 'hidden' || cs.opacity === '0') return;
      const rect = el.getBoundingClientRect();
      if (rect.right > maxRight) maxRight = rect.right;
    });
    let contentMaxWidth = 0;
    [document.body, ...document.querySelectorAll('body > *')].forEach(el => {
      if (!el) return;
      const cs = getComputedStyle(el);
      if (cs.maxWidth && cs.maxWidth !== 'none') { const mw = parseFloat(cs.maxWidth); if (mw > 0 && mw < 800) contentMaxWidth = Math.max(contentMaxWidth, mw); }
      if (cs.width && cs.width !== 'auto') { const w = parseFloat(cs.width); if (w > 0 && w < 800) contentMaxWidth = Math.max(contentMaxWidth, w); }
    });
    let finalW = (contentMaxWidth > 300 && contentMaxWidth <= 500) ? contentMaxWidth : Math.max(Math.ceil(maxRight), document.body?.scrollWidth || 0, document.documentElement?.scrollWidth || 0, 320);
    return { finalW, maxRight, contentMaxWidth, scrollW: document.documentElement.scrollWidth };
  });
  console.log('检测宽度:', detected.finalW, 'px (maxRight=', detected.maxRight, ', scrollW=', detected.scrollW, ')');

  const initialHeight = await page.evaluate(() => Math.max(document.documentElement.scrollHeight || 0, document.body ? document.body.scrollHeight : 0));
  console.log('初始高度 (1280px viewport):', initialHeight);

  // Step 3: 切换viewport
  const targetWidth = detected.finalW;
  if (targetWidth !== DEFAULT_VIEWPORT.width) {
    console.log('切换 viewport:', DEFAULT_VIEWPORT.width, '->', targetWidth);
    await page.setViewport({ width: targetWidth, height: DEFAULT_VIEWPORT.height });
    await new Promise(r => setTimeout(r, TIMEOUTS.postViewport));
    await new Promise(r => setTimeout(r, TIMEOUTS.postRender));
  }

  // Step 4: 重新测量高度
  let contentHeight = await page.evaluate(() => Math.max(document.documentElement.scrollHeight || 0, document.body ? document.body.scrollHeight : 0));
  contentHeight = Math.max(contentHeight, 100);
  console.log('最终高度 (', targetWidth, 'px viewport):', contentHeight, '(变化:', contentHeight - initialHeight, ')');

  // Step 5: 注入CSS
  await page.addStyleTag({ content: PDF_PRINT_OVERRIDE_CSS });
  await new Promise(r => setTimeout(r, TIMEOUTS.postStyle));

  // Step 6: 生成PDF（打印模式）
  console.log('\n--- 测试A: 打印模式 ---');
  const printStart = Date.now();
  const printBuf = await page.pdf({
    width: `${targetWidth}px`,
    height: `${contentHeight}px`,
    printBackground: true,
    margin: { top: 0, right: 0, bottom: 0, left: 0 }
  });
  const printDoc = await PDFDocument.load(printBuf);
  const printPageCount = printDoc.getPageCount();
  const printSize = printDoc.getPage(0).getSize();
  console.log('打印模式:', (printBuf.length/1024).toFixed(1), 'KB,', printPageCount, '页,', printSize.width.toFixed(0)+'x'+printSize.height.toFixed(0)+'pt,', Date.now()-printStart, 'ms');
  fs.writeFileSync('/data/gloria-cloud/html-editor/.tmp/pdf_verify2/user_print.pdf', printBuf);

  // Step 7: 测试截图模式
  console.log('\n--- 测试B: 截图模式 ---');
  await page.setViewport({ width: targetWidth, height: Math.min(contentHeight, 8000), deviceScaleFactor: 2 });
  await new Promise(r => setTimeout(r, 200));

  const ssStart = Date.now();
  let ssBuf;
  try {
    ssBuf = await page.screenshot({ type: 'jpeg', quality: 95, fullPage: true });
    console.log('截图返回:', ssBuf.length, 'bytes');
  } catch(e) {
    console.log('截图失败:', e.message);
    ssBuf = null;
  }

  if (ssBuf && ssBuf.length > 0) {
    const ssDoc = await PDFDocument.create();
    const img = await ssDoc.embedJpg(ssBuf);
    ssDoc.addPage([targetWidth * 0.75, contentHeight * 0.75]);
    ssDoc.getPage(0).drawImage(img, { x: 0, y: 0, width: targetWidth * 0.75, height: contentHeight * 0.75 });
    const ssPdf = await ssDoc.save();
    console.log('截图模式:', (ssPdf.length/1024).toFixed(1), 'KB, 1页,', Date.now()-ssStart, 'ms');
    fs.writeFileSync('/data/gloria-cloud/html-editor/.tmp/pdf_verify2/user_screenshot.pdf', ssPdf);
  } else {
    console.log('截图模式: 失败（0字节）');
  }

  await page.close();
  await browser.close();

  console.log('\n📁 文件保存在: /data/gloria-cloud/html-editor/.tmp/pdf_verify2/');
}

main().catch(e => { console.error(e); process.exit(1); });
