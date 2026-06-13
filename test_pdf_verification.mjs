import puppeteer from 'puppeteer-core';
import fs from 'fs';
import { PDFDocument } from 'pdf-lib';

const CHROME = '/usr/bin/ungoogled-chromium';
const OUTPUT_DIR = '/data/gloria-cloud/html-editor/.tmp/pdf_verify';
if (!fs.existsSync(OUTPUT_DIR)) fs.mkdirSync(OUTPUT_DIR, { recursive: true });

async function getBrowser() {
  return puppeteer.launch({ executablePath: CHROME, headless: 'new', args: ['--no-sandbox','--disable-gpu'] });
}

function writeHtml(path, content) {
  fs.writeFileSync(path, `<!DOCTYPE html>
<html lang="zh-CN">
<head><meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1.0">
<style>*{margin:0;padding:0;box-sizing:border-box;} html,body{overflow:visible;}</style>
${content.head || ''}</head>
<body>${content.body}</body></html>`, 'utf-8');
}

// === 测试用例 ===

// 1. 移动端设计 (390px居中)
const testMobile = {
  name: '01_mobile_390px',
  head: '<style>.wrap{max-width:390px;margin:0 auto;background:#f5f5f5;padding:20px;}.card{background:white;border-radius:12px;padding:20px;margin-bottom:20px;box-shadow:0 2px 8px rgba(0,0,0,0.1);}h1{font-size:24px;color:#333;}p{font-size:14px;color:#666;line-height:1.6;}</style>',
  body: '<div class="wrap"><h1>移动端设计</h1><div class="card"><h2>卡片1</h2><p>这是一段测试文字，检查移动端设计宽度是否正确渲染。</p></div><div class="card"><h2>卡片2</h2><p>第二段内容，确保不会被拉伸或压缩。</p></div></div>'
};

// 2. 渐变背景+居中内容
const testGradient = {
  name: '02_gradient_bg',
  head: '<style>body{background:linear-gradient(135deg,#667eea 0%,#764ba2 100%);min-height:100vh;display:flex;align-items:center;justify-content:center;padding:40px;}.card{background:rgba(255,255,255,0.95);border-radius:20px;padding:40px;max-width:500px;width:100%;}</style>',
  body: '<div class="card"><h1>渐变背景测试</h1><p>检查背景色是否保留，内容是否居中、无变形。</p></div>'
};

// 3. 多页PPT风格 (100vh slides)
const testPPT = {
  name: '03_ppt_5slides',
  head: '<style>.slide{min-height:100vh;width:100%;padding:40px;display:flex;flex-direction:column;justify-content:center;align-items:center;font-family:sans-serif;}.slide:nth-child(odd){background:linear-gradient(135deg,#667eea,#764ba2);color:white;}.slide:nth-child(even){background:#f8f9fa;color:#333;}h1{font-size:48px;margin-bottom:20px;}p{font-size:20px;max-width:600px;text-align:center;}</style>',
  body: [1,2,3,4,5].map(i => `<div class="slide"><h1>第${i}页</h1><p>这是第${i}页幻灯片的内容，检查是否跨页切正确、无变形、无拉伸。</p></div>`).join('')
};

// 4. 宽内容 (超过1280px)
const testWide = {
  name: '04_wide_content',
  head: '<style>.container{width:1400px;margin:0 auto;background:#e3f2fd;padding:40px;}.item{display:inline-block;width:300px;height:200px;background:#2196f3;margin:10px;border-radius:8px;}</style>',
  body: '<div class="container"><h1>宽内容测试 (1400px)</h1><p>容器宽度1400px，检查PDF是否完整包含所有元素，无截断。</p>' + Array(8).fill(0).map((_,i) => `<div class="item">${i+1}</div>`).join('') + '</div>'
};

// 5. PC端全宽设计
const testPC = {
  name: '05_pc_fullwidth',
  head: '<style>.hero{background:linear-gradient(90deg,#ff6b6b,#feca57);padding:80px 40px;text-align:center;color:white;}.features{display:flex;gap:30px;padding:40px;justify-content:center;}.feature{flex:1;max-width:300px;background:white;padding:30px;border-radius:16px;box-shadow:0 4px 20px rgba(0,0,0,0.1);}</style>',
  body: '<div class="hero"><h1>PC端全宽设计</h1><p>检查全宽布局是否被压缩或变形。</p></div><div class="features"><div class="feature"><h3>特性1</h3><p>描述文字</p></div><div class="feature"><h3>特性2</h3><p>描述文字</p></div><div class="feature"><h3>特性3</h3><p>描述文字</p></div></div>'
};

const tests = [testMobile, testGradient, testPPT, testWide, testPC];

async function testPrintMode(browser, testCase) {
  const htmlPath = `${OUTPUT_DIR}/${testCase.name}.html`;
  writeHtml(htmlPath, testCase);
  
  const page = await browser.newPage();
  await page.setViewport({ width: 1280, height: 900 });
  await page.goto(`file://${htmlPath}`, { waitUntil: 'domcontentloaded', timeout: 15000 });
  await new Promise(r => setTimeout(r, 500));
  
  // 测量宽度
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
      if (cs.maxWidth && cs.maxWidth !== 'none') { const mw = parseFloat(cs.maxWidth); if (mw>0&&mw<800) contentMaxWidth=Math.max(contentMaxWidth,mw); }
      if (cs.width && cs.width !== 'auto') { const w = parseFloat(cs.width); if (w>0&&w<800) contentMaxWidth=Math.max(contentMaxWidth,w); }
    });
    let finalW;
    if (contentMaxWidth > 300 && contentMaxWidth <= 500) finalW = Math.ceil(contentMaxWidth);
    else finalW = Math.max(Math.ceil(maxRight), document.body?.scrollWidth || 0, document.documentElement?.scrollWidth || 0, 320);
    return { finalW, maxRight, contentMaxWidth, scrollW: document.documentElement.scrollWidth, bodyScrollW: document.body?.scrollWidth || 0 };
  });
  
  const contentHeight = await page.evaluate(() => Math.max(
    document.documentElement.scrollHeight || 0,
    document.body ? document.body.scrollHeight : 0
  ));
  
  console.log(`\n📄 ${testCase.name}`);
  console.log(`   检测宽度: ${detected.finalW}px (maxRight=${detected.maxRight}, contentMaxWidth=${detected.contentMaxWidth}, scrollW=${detected.scrollW})`);
  console.log(`   内容高度: ${contentHeight}px`);
  
  // === 打印模式 ===
  const css = `
    @media print { * { page-break-inside: auto !important; break-inside: auto !important; page-break-after: auto !important; break-after: auto !important; page-break-before: auto !important; break-before: auto !important; }}
    * { -webkit-print-color-adjust: exact !important; print-color-adjust: exact !important; color-adjust: exact !important; }
    html, body { overflow: visible !important; width: 100% !important; height: auto !important; min-height: auto !important; }
    *, *::before, *::after { -webkit-print-color-adjust: exact !important; print-color-adjust: exact !important; color-adjust: exact !important; }
  `;
  await page.addStyleTag({ content: css });
  await new Promise(r => setTimeout(r, 100));
  
  const pdfBuf = await page.pdf({
    width: `${detected.finalW}px`,
    height: `${contentHeight}px`,
    printBackground: true,
    margin: { top: 0, right: 0, bottom: 0, left: 0 }
  });
  
  const doc = await PDFDocument.load(pdfBuf);
  const pageSize = doc.getPage(0).getSize();
  
  fs.writeFileSync(`${OUTPUT_DIR}/${testCase.name}_print.pdf`, pdfBuf);
  console.log(`   [打印模式] PDF: ${(pdfBuf.length/1024).toFixed(1)}KB, 尺寸: ${pageSize.width.toFixed(0)}x${pageSize.height.toFixed(0)}pt`);
  
  // === 截图模式 ===
  const screenshotBuf = await page.screenshot({ type: 'jpeg', quality: 95, fullPage: true });
  const pdfDoc = await PDFDocument.create();
  const img = await pdfDoc.embedJpg(screenshotBuf);
  const pdfPage = pdfDoc.addPage([detected.finalW * 0.75, contentHeight * 0.75]);
  pdfPage.drawImage(img, { x: 0, y: 0, width: detected.finalW * 0.75, height: contentHeight * 0.75 });
  const screenshotPdfBuf = await pdfDoc.save();
  fs.writeFileSync(`${OUTPUT_DIR}/${testCase.name}_screenshot.pdf`, screenshotPdfBuf);
  console.log(`   [截图模式] PDF: ${(screenshotPdfBuf.length/1024).toFixed(1)}KB, 尺寸: ${(detected.finalW*0.75).toFixed(0)}x${(contentHeight*0.75).toFixed(0)}pt`);
  
  // 检查是否有变形：比较元素位置
  const layoutCheck = await page.evaluate(() => {
    const cards = Array.from(document.querySelectorAll('.card, .feature, .slide, .item'));
    return cards.map((el, i) => {
      const rect = el.getBoundingClientRect();
      return { idx: i, tag: el.tagName, class: el.className, x: rect.x, y: rect.y, w: rect.width, h: rect.height };
    });
  });
  
  await page.close();
  return { name: testCase.name, detected, contentHeight, pageSize, layoutCheck };
}

async function main() {
  console.log('=== PDF效果对比测试 ===');
  const browser = await getBrowser();
  const results = [];
  for (const test of tests) {
    try {
      const r = await testPrintMode(browser, test);
      results.push(r);
    } catch(e) {
      console.error(`❌ ${test.name} 失败:`, e.message);
      results.push({ name: test.name, error: e.message });
    }
  }
  await browser.close();
  
  console.log('\n=== 汇总 ===');
  for (const r of results) {
    if (r.error) { console.log(`❌ ${r.name}: ${r.error}`); continue; }
    console.log(`${r.name}: 打印=${r.pageSize.width.toFixed(0)}x${r.pageSize.height.toFixed(0)}pt, 宽度检测=${r.detected.finalW}px`);
    // 检查布局是否有明显异常 (0尺寸或极小尺寸元素)
    const badEls = r.layoutCheck.filter(el => el.w < 10 || el.h < 10);
    if (badEls.length > 0) {
      console.log(`   ⚠️ 发现 ${badEls.length} 个尺寸异常元素`);
    }
  }
  
  console.log(`\n📁 PDF文件已保存到: ${OUTPUT_DIR}`);
}

main().catch(console.error);
