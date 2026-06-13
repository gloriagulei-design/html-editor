import puppeteer from 'puppeteer-core';
import fs from 'fs';
import { PDFDocument } from 'pdf-lib';

const CHROME = '/usr/bin/ungoogled-chromium';
const OUT = '/data/gloria-cloud/html-editor/.tmp/pdf_verify2';
if (!fs.existsSync(OUT)) fs.mkdirSync(OUT, { recursive: true });

const DEFAULT_VIEWPORT = { width: 1280, height: 900 };
const TIMEOUTS = { postRender: 500, postViewport: 150, postStyle: 100 };

const PDF_PRINT_OVERRIDE_CSS = `
  @media print { * { page-break-inside: auto !important; break-inside: auto !important; page-break-after: auto !important; break-after: auto !important; page-break-before: auto !important; break-before: auto !important; }}
  * { -webkit-print-color-adjust: exact !important; print-color-adjust: exact !important; color-adjust: exact !important; }
  html, body { overflow: visible !important; width: 100% !important; height: auto !important; min-height: auto !important; float: none !important; position: relative !important; }
  *, *::before, *::after { -webkit-print-color-adjust: exact !important; print-color-adjust: exact !important; color-adjust: exact !important; }
`;

// 测试用例
const testCases = [
  {
    name: 'mobile_390',
    desc: '移动端设计 (max-width:390px)',
    html: `<div style="max-width:390px;margin:0 auto;background:#f5f5f5;padding:20px;min-height:100vh;"><h1 style="font-size:28px;text-align:center;margin-bottom:20px;">移动端测试</h1><div style="background:white;border-radius:12px;padding:20px;margin-bottom:20px;box-shadow:0 2px 8px rgba(0,0,0,0.1);"><h2 style="font-size:20px;margin-bottom:10px;">卡片1</h2><p style="font-size:14px;color:#666;line-height:1.6;">这是一段很长的测试文字，用于检查在390px宽度下是否会正确换行，以及高度是否被正确计算。如果不正确，PDF会出现截断或者大量空白。</p><div style="height:40px;background:linear-gradient(90deg,#ff6b6b,#feca57);border-radius:8px;margin:10px 0;"></div></div><div style="background:white;border-radius:12px;padding:20px;margin-bottom:20px;box-shadow:0 2px 8px rgba(0,0,0,0.1);"><h2 style="font-size:20px;margin-bottom:10px;">卡片2</h2><p style="font-size:14px;color:#666;line-height:1.6;">第二段测试内容，继续检查长文本的换行和高度计算。</p></div></div>`
  },
  {
    name: 'pc_fullwidth',
    desc: 'PC全宽设计',
    html: `<div style="background:linear-gradient(90deg,#667eea,#764ba2);padding:60px 40px;text-align:center;color:white;"><h1 style="font-size:48px;margin-bottom:20px;">PC端全宽设计</h1><p style="font-size:20px;max-width:800px;margin:0 auto;">检查全宽布局是否被压缩或变形，背景渐变是否保留。</p></div><div style="display:flex;gap:30px;padding:40px;justify-content:center;"><div style="flex:1;max-width:300px;background:white;padding:30px;border-radius:16px;box-shadow:0 4px 20px rgba(0,0,0,0.1);"><h3>特性1</h3><p>描述</p></div><div style="flex:1;max-width:300px;background:white;padding:30px;border-radius:16px;box-shadow:0 4px 20px rgba(0,0,0,0.1);"><h3>特性2</h3><p>描述</p></div><div style="flex:1;max-width:300px;background:white;padding:30px;border-radius:16px;box-shadow:0 4px 20px rgba(0,0,0,0.1);"><h3>特性3</h3><p>描述</p></div></div>`
  },
  {
    name: 'gradient_bg',
    desc: '渐变背景+居中内容',
    html: `<div style="background:linear-gradient(135deg,#667eea 0%,#764ba2 100%);min-height:100vh;display:flex;align-items:center;justify-content:center;padding:40px;"><div style="background:rgba(255,255,255,0.95);border-radius:20px;padding:40px;max-width:500px;width:100%;"><h1>渐变背景测试</h1><p>检查背景色是否保留，内容是否居中、无变形。</p></div></div>`
  },
  {
    name: 'ppt_5slides',
    desc: '5页PPT (100vh)',
    html: [1,2,3,4,5].map(i => `<div style="min-height:100vh;width:100%;padding:40px;display:flex;flex-direction:column;justify-content:center;align-items:center;font-family:sans-serif;${i%2===1?'background:linear-gradient(135deg,#667eea,#764ba2);color:white;':'background:#f8f9fa;color:#333;'}"><h1 style="font-size:48px;margin-bottom:20px;">第${i}页</h1><p style="font-size:20px;max-width:600px;text-align:center;">这是第${i}页幻灯片的内容，检查是否跨页切割正确、无变形、无拉伸。</p></div>`).join('')
  },
  {
    name: 'wide_1400',
    desc: '1400px宽内容',
    html: `<div style="width:1400px;margin:0 auto;background:#e3f2fd;padding:40px;"><h1>宽内容测试 (1400px)</h1><p>容器宽度1400px，检查PDF是否完整包含所有元素，无截断。</p>${Array(8).fill(0).map((_,i) => `<div style="display:inline-block;width:300px;height:200px;background:#2196f3;margin:10px;border-radius:8px;color:white;text-align:center;line-height:200px;font-size:24px;">${i+1}</div>`).join('')}</div>`
  }
];

async function getBrowser() {
  return puppeteer.launch({ executablePath: CHROME, headless: 'new', args: ['--no-sandbox','--disable-gpu'] });
}

async function testFixedPrint(browser, testCase) {
  const page = await browser.newPage();
  const fullHtml = `<!DOCTYPE html><html lang="zh-CN"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1.0"><style>*{margin:0;padding:0;box-sizing:border-box;}html,body{overflow:visible;}</style></head><body>${testCase.html}</body></html>`;

  // Step 1: 在默认viewport下渲染
  await page.setViewport(DEFAULT_VIEWPORT);
  await page.setContent(fullHtml, { waitUntil: 'domcontentloaded', timeout: 15000 });
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
    return { finalW, maxRight, contentMaxWidth };
  });

  const initialHeight = await page.evaluate(() => Math.max(document.documentElement.scrollHeight || 0, document.body ? document.body.scrollHeight : 0));

  // Step 3: 切换viewport到目标宽度（修复后的逻辑）
  const targetWidth = detected.finalW;
  if (targetWidth !== DEFAULT_VIEWPORT.width) {
    await page.setViewport({ width: targetWidth, height: DEFAULT_VIEWPORT.height });
    await new Promise(r => setTimeout(r, TIMEOUTS.postViewport));
    await new Promise(r => setTimeout(r, TIMEOUTS.postRender));
  }

  // Step 4: 重新测量高度
  let contentHeight = await page.evaluate(() => Math.max(document.documentElement.scrollHeight || 0, document.body ? document.body.scrollHeight : 0));
  contentHeight = Math.max(contentHeight, 100);

  // Step 5: 注入CSS并生成PDF
  await page.addStyleTag({ content: PDF_PRINT_OVERRIDE_CSS });
  await new Promise(r => setTimeout(r, TIMEOUTS.postStyle));

  const pdfBuf = await page.pdf({
    width: `${targetWidth}px`,
    height: `${contentHeight}px`,
    printBackground: true,
    margin: { top: 0, right: 0, bottom: 0, left: 0 }
  });

  const pdfDoc = await PDFDocument.load(pdfBuf);
  const pageSize = pdfDoc.getPage(0).getSize();

  fs.writeFileSync(`${OUT}/${testCase.name}_fixed_print.pdf`, pdfBuf);

  await page.close();

  return {
    name: testCase.name,
    desc: testCase.desc,
    targetWidth,
    initialHeight,
    contentHeight,
    pdfSize: { w: pageSize.width, h: pageSize.height },
    fileKB: (pdfBuf.length / 1024).toFixed(1)
  };
}

async function main() {
  console.log('=== 修复后打印模式验证 ===\n');
  const browser = await getBrowser();
  const results = [];

  for (const test of testCases) {
    try {
      const r = await testFixedPrint(browser, test);
      results.push(r);
    } catch (e) {
      console.error(`❌ ${test.name}: ${e.message}`);
      results.push({ name: test.name, desc: test.desc, error: e.message });
    }
  }

  await browser.close();

  console.log('\n=== 结果汇总 ===');
  console.log('名称                | 目标宽度 | 初始高度 | 最终高度 | PDF尺寸(WxH)     | 文件');
  console.log('-------------------|----------|----------|----------|------------------|------');
  for (const r of results) {
    if (r.error) {
      console.log(`${r.name.padEnd(18)} | ❌ ${r.error}`);
      continue;
    }
    const hDiff = r.contentHeight - r.initialHeight;
    const hDiffStr = hDiff === 0 ? '=' : (hDiff > 0 ? `+${hDiff}` : `${hDiff}`);
    console.log(`${r.name.padEnd(18)} | ${r.targetWidth.toString().padStart(8)} | ${r.initialHeight.toString().padStart(8)} | ${r.contentHeight.toString().padStart(8)} | ${r.pdfSize.w.toFixed(0)}x${r.pdfSize.h.toFixed(0)} | ${r.fileKB}KB`);
  }

  console.log(`\n📁 文件保存在: ${OUT}`);
}

main().catch(console.error);
