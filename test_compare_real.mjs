import puppeteer from 'puppeteer-core';
import { readFileSync, writeFileSync } from 'fs';

const CHROME = '/usr/bin/ungoogled-chromium';
const HTML = '/data/gloria-cloud/html-editor/.tmp/pdf-5f25ce8a-7d45-4442-9db9-68d490c50740.html';

(async () => {
  const html = readFileSync(HTML, 'utf-8');
  const browser = await puppeteer.launch({ executablePath: CHROME, headless: 'new', args: ['--no-sandbox','--disable-gpu'] });
  const page = await browser.newPage();

  // 模拟server.js流程
  await page.setViewport({ width: 1280, height: 900 });
  writeFileSync('.tmp/test_real_for_compare.html', html, 'utf-8');
  await page.goto('file:///data/gloria-cloud/html-editor/.tmp/test_real_for_compare.html', { waitUntil: 'domcontentloaded', timeout: 15000 });
  await new Promise(r => setTimeout(r, 800));

  // 检测宽度
  const detectedWidth = await page.evaluate(() => {
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
    let viewportWidth = 0;
    const vm = document.querySelector('meta[name="viewport"]');
    if (vm) { const c = vm.getAttribute('content') || ''; const m = c.match(/width\s*=\s*(\d+)/); if (m) viewportWidth = parseInt(m[1], 10); }
    if (contentMaxWidth > 300 && contentMaxWidth <= 500) return Math.ceil(contentMaxWidth);
    if (viewportWidth > 300 && viewportWidth <= 500) return Math.ceil(viewportWidth);
    return Math.max(Math.ceil(maxRight), document.body?.scrollWidth || 0, document.documentElement?.scrollWidth || 0, 320);
  });

  console.log('检测宽度:', detectedWidth);

  if (detectedWidth !== 1280) {
    await page.setViewport({ width: detectedWidth, height: 900 });
    await new Promise(r => setTimeout(r, 200));
  }

  const contentHeight = await page.evaluate(() => Math.max(
    document.documentElement.scrollHeight || 0,
    document.body ? document.body.scrollHeight : 0
  ));
  console.log('内容高度:', contentHeight);

  // 截图顶部800px用于对比
  await page.setViewport({ width: detectedWidth, height: 900 });
  await page.screenshot({
    path: '/data/gloria-cloud/html-editor/.tmp/real_browser_top.png',
    clip: { x: 0, y: 0, width: detectedWidth, height: Math.min(contentHeight, 900) },
    type: 'png'
  });
  console.log('浏览器截图已保存');

  // 同时生成打印PDF
  const pdfBuf = await page.pdf({
    width: `${detectedWidth}px`,
    height: `${contentHeight}px`,
    printBackground: true,
    margin: { top: 0, right: 0, bottom: 0, left: 0 }
  });
  writeFileSync('/data/gloria-cloud/html-editor/.tmp/real_browser_print.pdf', pdfBuf);
  console.log('打印PDF已保存, 大小:', pdfBuf.length);

  await browser.close();
})();
