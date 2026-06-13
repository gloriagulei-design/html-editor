import puppeteer from 'puppeteer-core';
import fs from 'fs';

const CHROME = '/usr/bin/ungoogled-chromium';

// 测试HTML: 移动端设计，包含明确尺寸的元素用于对比
const html = `<!DOCTYPE html>
<html lang="zh-CN"><head><meta charset="UTF-8">
<style>
* { margin: 0; padding: 0; box-sizing: border-box; }
html, body { overflow: visible; }
.wrap { max-width: 390px; margin: 0 auto; background: #f5f5f5; padding: 20px; min-height: 100vh; }
.card { background: white; border-radius: 12px; padding: 20px; margin-bottom: 20px; box-shadow: 0 2px 8px rgba(0,0,0,0.1); width: 100%; }
.card h2 { font-size: 20px; color: #333; margin-bottom: 10px; }
.card p { font-size: 14px; color: #666; line-height: 1.6; }
.badge { display: inline-block; background: #e3f2fd; color: #1976d2; padding: 4px 12px; border-radius: 12px; font-size: 12px; margin-top: 10px; }
.color-bar { height: 40px; background: linear-gradient(90deg, #ff6b6b, #feca57); border-radius: 8px; margin: 10px 0; }
</style></head>
<body>
<div class="wrap">
  <h1 style="font-size:28px;color:#111;margin-bottom:20px;text-align:center;">移动端测试</h1>
  <div class="card"><h2>卡片1</h2><p>这是测试内容文字</p><div class="color-bar"></div><span class="badge">标签</span></div>
  <div class="card"><h2>卡片2</h2><p>第二段测试内容</p><div class="color-bar"></div></div>
</div>
</body></html>`;

async function getBrowser() {
  return puppeteer.launch({ executablePath: CHROME, headless: 'new', args: ['--no-sandbox','--disable-gpu'] });
}

async function main() {
  const browser = await getBrowser();
  const OUT = '/data/gloria-cloud/html-editor/.tmp/pdf_verify';
  
  // === 先测量布局（1280px viewport下的实际渲染尺寸）===
  const page = await browser.newPage();
  await page.setViewport({ width: 1280, height: 900 });
  await page.setContent(html, { waitUntil: 'domcontentloaded' });
  await new Promise(r => setTimeout(r, 300));
  
  const layout1280 = await page.evaluate(() => {
    const wrap = document.querySelector('.wrap');
    const cards = Array.from(document.querySelectorAll('.card'));
    return {
      viewportW: window.innerWidth,
      viewportH: window.innerHeight,
      wrap: wrap ? { x: wrap.getBoundingClientRect().x, y: wrap.getBoundingClientRect().y, w: wrap.getBoundingClientRect().width, h: wrap.getBoundingClientRect().height } : null,
      cards: cards.map(c => ({ x: c.getBoundingClientRect().x, y: c.getBoundingClientRect().y, w: c.getBoundingClientRect().width, h: c.getBoundingClientRect().height })),
      bodyW: document.body.scrollWidth,
      bodyH: document.body.scrollHeight,
    };
  });
  console.log('=== 布局 (1280px viewport) ===');
  console.log('viewport:', layout1280.viewportW, 'x', layout1280.viewportH);
  console.log('wrap:', JSON.stringify(layout1280.wrap));
  console.log('cards:', JSON.stringify(layout1280.cards));
  console.log('body size:', layout1280.bodyW, 'x', layout1280.bodyH);
  
  // === 检测宽度（与server.js一致）===
  const detected = await page.evaluate(() => {
    let maxRight = 0;
    document.querySelectorAll('body *').forEach(el => {
      const cs = getComputedStyle(el);
      if (cs.display === 'none' || cs.visibility === 'hidden') return;
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
    return { finalW, maxRight, contentMaxWidth };
  });
  console.log('\n检测宽度:', detected.finalW, '(maxRight=', detected.maxRight, ', contentMaxWidth=', detected.contentMaxWidth, ')');
  
  // === 测试1: 打印模式 (page.setViewport 1280，page.pdf width=390px) ===
  const css = '@media print { * { page-break-inside: auto !important; break-inside: auto !important; } } * { -webkit-print-color-adjust: exact !important; print-color-adjust: exact !important; color-adjust: exact !important; } html, body { overflow: visible !important; width: 100% !important; height: auto !important; min-height: auto !important; }';
  await page.addStyleTag({ content: css });
  await new Promise(r => setTimeout(r, 100));
  
  const printBuf = await page.pdf({
    width: `${detected.finalW}px`,
    height: `${layout1280.bodyH}px`,
    printBackground: true,
    margin: { top: 0, right: 0, bottom: 0, left: 0 }
  });
  fs.writeFileSync(`${OUT}/compare_print.pdf`, printBuf);
  console.log('\n[打印模式] PDF:', (printBuf.length/1024).toFixed(1), 'KB');
  
  // === 测试2: 切换viewport后打印 ===
  await page.setViewport({ width: detected.finalW, height: 900 });
  await new Promise(r => setTimeout(r, 200));
  
  const layout390 = await page.evaluate(() => {
    const wrap = document.querySelector('.wrap');
    const cards = Array.from(document.querySelectorAll('.card'));
    return {
      viewportW: window.innerWidth,
      wrap: wrap ? { x: wrap.getBoundingClientRect().x, y: wrap.getBoundingClientRect().y, w: wrap.getBoundingClientRect().width, h: wrap.getBoundingClientRect().height } : null,
      cards: cards.map(c => ({ x: c.getBoundingClientRect().x, y: c.getBoundingClientRect().y, w: c.getBoundingClientRect().width, h: c.getBoundingClientRect().height })),
    };
  });
  console.log('\n=== 布局 (390px viewport) ===');
  console.log('viewport:', layout390.viewportW);
  console.log('wrap:', JSON.stringify(layout390.wrap));
  console.log('cards:', JSON.stringify(layout390.cards));
  
  const printBuf390 = await page.pdf({
    width: `${detected.finalW}px`,
    height: `${layout1280.bodyH}px`,
    printBackground: true,
    margin: { top: 0, right: 0, bottom: 0, left: 0 }
  });
  fs.writeFileSync(`${OUT}/compare_print_v390.pdf`, printBuf390);
  console.log('[打印模式+390viewport] PDF:', (printBuf390.length/1024).toFixed(1), 'KB');
  
  // === 测试3: 截图模式 ===
  const screenshotBuf = await page.screenshot({ type: 'jpeg', quality: 95, fullPage: true });
  fs.writeFileSync(`${OUT}/compare_screenshot.jpg`, screenshotBuf);
  console.log('[截图] JPG:', (screenshotBuf.length/1024).toFixed(1), 'KB, 尺寸:', '需要用pdf-lib查看');
  
  await page.close();
  await browser.close();
  
  console.log('\n📁 文件保存在:', OUT);
}
main().catch(console.error);
