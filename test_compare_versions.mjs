import puppeteer from 'puppeteer-core';
import { writeFileSync, readFileSync } from 'fs';
import { PDFDocument } from 'pdf-lib';

const CHROME_PATH = '/usr/bin/ungoogled-chromium';
const HTML = readFileSync('/data/gloria-cloud/html-editor/.tmp/pdf-5f25ce8a-7d45-4442-9db9-68d490c50740.html', 'utf-8');

// ========== V12 方法 ==========
async function v12Method() {
  const browser = await puppeteer.launch({ executablePath: CHROME_PATH, headless: true, args: ['--no-sandbox','--disable-gpu','--disable-dev-shm-usage','--font-render-hinting=none','--enable-font-antialiasing'] });
  const page = await browser.newPage();
  await page.setViewport({ width: 1400, height: 900 });
  
  await page.setContent(HTML, { waitUntil: 'networkidle0', timeout: 30000 });
  
  const hasCanvas = await page.evaluate(() => document.querySelectorAll('canvas').length);
  if (hasCanvas > 0) {
    await page.waitForFunction(() => Array.from(document.querySelectorAll('canvas')).every(c => c.width > 0), { timeout: 15000 });
  }
  await new Promise(r => setTimeout(r, 2000));
  
  const bgColor = await page.evaluate(() => {
    const cssVar = getComputedStyle(document.documentElement).getPropertyValue('--bg').trim();
    return cssVar || getComputedStyle(document.body || document.documentElement).backgroundColor || '#ffffff';
  });
  
  await page.evaluate(() => {
    document.querySelectorAll('.tc').forEach(t => t.classList.add('act'));
    document.querySelectorAll('.fi').forEach(el => el.classList.add('sho'));
    const sug = document.getElementById('sugGrid');
    if (sug) sug.style.display = '';
  });
  await new Promise(r => setTimeout(r, 500));
  
  let contentHeight = await page.evaluate(() => Math.max(
    document.documentElement.scrollHeight, document.body ? document.body.scrollHeight : 0
  ));
  
  await page.evaluate((bg) => {
    const f = document.createElement('div');
    f.style.cssText = `height:2px;width:100%;background:${bg};`;
    document.body.appendChild(f);
  }, bgColor);
  
  contentHeight = await page.evaluate(() => Math.max(
    document.documentElement.scrollHeight, document.body ? document.body.scrollHeight : 0
  ));
  
  await page.addStyleTag({ content: 'body, html { overflow: hidden !important; }' });
  await new Promise(r => setTimeout(r, 200));
  
  const buf = await page.pdf({ width: '1400px', height: `${contentHeight}px`, printBackground: true });
  
  const doc = await PDFDocument.load(buf);
  const size = doc.getPage(0).getSize();
  
  // 截图对比
  const img = await page.screenshot({ type: 'jpeg', quality: 90, fullPage: true });
  writeFileSync('/tmp/v12_screenshot.jpg', img);
  
  await page.close();
  await browser.close();
  
  return { name: 'V12', pdfSize: buf.length, height: contentHeight, pdfW: size.width, pdfH: size.height, ssSize: img.length };
}

// ========== 当前版本方法 ==========
async function currentMethod() {
  const browser = await puppeteer.launch({ executablePath: CHROME_PATH, headless: 'new', args: ['--no-sandbox','--disable-gpu','--disable-dev-shm-usage','--font-render-hinting=none','--enable-font-antialiasing'] });
  const page = await browser.newPage();
  await page.setViewport({ width: 1280, height: 900 });
  
  const tmp = '/tmp/test_cur.html';
  writeFileSync(tmp, HTML, 'utf-8');
  await page.goto(`file://${tmp}`, { waitUntil: 'domcontentloaded', timeout: 15000 });
  await new Promise(r => setTimeout(r, 500));
  
  // 注入背景
  await page.evaluate(() => {
    const s = document.createElement('style');
    s.id = 'pdf-bg-override';
    s.textContent = 'html, body { -webkit-print-color-adjust: exact !important; print-color-adjust: exact !important; }';
    document.head.appendChild(s);
    const h = getComputedStyle(document.documentElement).backgroundColor;
    const b = getComputedStyle(document.body).backgroundColor;
    if (!h || h === 'rgba(0, 0, 0, 0)' || h === 'transparent') document.documentElement.style.backgroundColor = '#ffffff';
    if (!b || b === 'rgba(0, 0, 0, 0)' || b === 'transparent') document.body.style.backgroundColor = '#ffffff';
  });
  
  // 宽度检测
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
    const bw = document.body ? document.body.scrollWidth : 0;
    const hw = document.documentElement ? document.documentElement.scrollWidth : 0;
    return Math.max(Math.ceil(maxRight), Math.max(bw, hw), 320);
  });
  
  const pdfWidth = detectedWidth;
  await page.setViewport({ width: pdfWidth, height: 900 });
  await new Promise(r => setTimeout(r, 150));
  
  // 消除vh
  await page.evaluate(() => {
    document.querySelectorAll('[style]').forEach(el => {
      ['height','minHeight','maxHeight'].forEach(p => {
        const v = el.style.getPropertyValue(p);
        if (v && (v.includes('vh') || v.includes('vw'))) el.style.setProperty(p, 'auto', 'important');
      });
    });
    for (const s of document.styleSheets) { try { for (const r of s.cssRules || []) { if (r.style) { ['height','minHeight','maxHeight'].forEach(p => { const v = r.style[p]; if (v && (v.includes('vh') || v.includes('vw'))) r.style.setProperty(p.replace(/[A-Z]/g, m => '-' + m.toLowerCase()), 'auto', 'important'); }); } } } catch(e) {} }
    document.documentElement.style.setProperty('height', 'auto', 'important');
    document.documentElement.style.setProperty('min-height', 'auto', 'important');
    document.body.style.setProperty('height', 'auto', 'important');
    document.body.style.setProperty('min-height', 'auto', 'important');
    document.body.style.setProperty('overflow', 'visible', 'important');
  });
  await new Promise(r => setTimeout(r, 100));
  
  // 展开隐藏
  await page.evaluate(() => {
    document.querySelectorAll('.tc').forEach(t => t.classList.add('act'));
    document.querySelectorAll('.fi').forEach(el => el.classList.add('sho'));
    const sug = document.getElementById('sugGrid');
    if (sug) sug.style.display = '';
  });
  await new Promise(r => setTimeout(r, 150));
  
  // 精确测量
  let contentHeight = await page.evaluate(() => {
    let maxBottom = 0;
    document.querySelectorAll('body *').forEach(el => {
      const cs = getComputedStyle(el);
      if (cs.display === 'none' || cs.visibility === 'hidden' || cs.opacity === '0') return;
      const rect = el.getBoundingClientRect();
      if (rect.bottom > maxBottom) maxBottom = rect.bottom;
    });
    const scrollH = Math.max(document.documentElement.scrollHeight || 0, document.body ? document.body.scrollHeight : 0);
    return Math.ceil(Math.min(maxBottom, scrollH) + 20);
  });
  contentHeight = Math.max(contentHeight, 100);
  
  // 注入覆盖CSS
  const css = `@media print { * { page-break-inside: auto !important; break-inside: auto !important; page-break-after: auto !important; break-after: auto !important; page-break-before: auto !important; break-before: auto !important; } } * { -webkit-print-color-adjust: exact !important; print-color-adjust: exact !important; color-adjust: exact !important; } html, body { overflow: visible !important; width: 100% !important; height: auto !important; min-height: auto !important; float: none !important; position: relative !important; }`;
  await page.addStyleTag({ content: css });
  await new Promise(r => setTimeout(r, 100));
  
  const buf = await page.pdf({ width: `${pdfWidth}px`, height: `${contentHeight}px`, printBackground: true, margin: { top: 0, right: 0, bottom: 0, left: 0 }, preferCSSPageSize: false, displayHeaderFooter: false });
  
  const doc = await PDFDocument.load(buf);
  const size = doc.getPage(0).getSize();
  
  // 截图
  const img = await page.screenshot({ type: 'jpeg', quality: 90, fullPage: true });
  writeFileSync('/tmp/current_screenshot.jpg', img);
  
  await page.close();
  await browser.close();
  
  return { name: 'Current', pdfSize: buf.length, height: contentHeight, pdfW: size.width, pdfH: size.height, pdfWidth, ssSize: img.length };
}

async function main() {
  console.log('对比测试: V12方法 vs 当前方法\\n');
  const r1 = await v12Method();
  console.log('V12结果:', JSON.stringify(r1, null, 2));
  const r2 = await currentMethod();
  console.log('\\n当前结果:', JSON.stringify(r2, null, 2));
  console.log('\\n差异:');
  console.log(`  PDF大小: V12=${(r1.pdfSize/1024/1024).toFixed(2)}MB vs 当前=${(r2.pdfSize/1024/1024).toFixed(2)}MB`);
  console.log(`  内容高度: V12=${r1.height}px vs 当前=${r2.height}px`);
  console.log(`  PDF宽度: V12=${r1.pdfW.toFixed(0)}pt vs 当前=${r2.pdfW.toFixed(0)}pt`);
  console.log(`  PDF高度: V12=${r1.pdfH.toFixed(0)}pt vs 当前=${r2.pdfH.toFixed(0)}pt`);
  console.log(`  截图大小: V12=${(r1.ssSize/1024).toFixed(1)}KB vs 当前=${(r2.ssSize/1024).toFixed(1)}KB`);
}

main().catch(e => console.error(e));
