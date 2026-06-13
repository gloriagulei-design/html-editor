import puppeteer from 'puppeteer-core';
import fs from 'fs';
import { PDFDocument } from 'pdf-lib';

const CHROME_PATH = '/usr/bin/ungoogled-chromium';
const html = fs.readFileSync('/data/gloria-cloud/html-editor/.tmp/pdf-5f25ce8a-7d45-4442-9db9-68d490c50740.html', 'utf-8');

async function step(name, fn) {
  console.log(`\n=== ${name} ===`);
  try {
    const r = await fn();
    console.log('Result:', r);
    return r;
  } catch(e) {
    console.log('ERROR:', e.message);
    throw e;
  }
}

(async () => {
  const browser = await puppeteer.launch({ executablePath: CHROME_PATH, headless: 'new', args: ['--no-sandbox','--disable-gpu'] });
  const page = await browser.newPage();

  // Step 0: 初始viewport
  await page.setViewport({ width: 1280, height: 900 });

  // Step 1: setContent
  await step('setContent', async () => {
    await page.setContent(html, { waitUntil: 'networkidle0', timeout: 15000 });
    return 'OK';
  });

  // Step 2: postRender wait
  await step('postRender 500ms', async () => {
    await new Promise(r => setTimeout(r, 500));
    return 'OK';
  });

  // Step 3: 展开隐藏内容
  await step('expand hidden', async () => {
    await page.evaluate(() => {
      document.querySelectorAll('.tc').forEach(t => t.classList.add('act'));
      document.querySelectorAll('.fi').forEach(el => el.classList.add('sho'));
      const sug = document.getElementById('sugGrid');
      if (sug) sug.style.display = '';
    });
    return 'OK';
  });

  // Step 4: postExpand wait
  await step('postExpand 150ms', async () => {
    await new Promise(r => setTimeout(r, 150));
    return 'OK';
  });

  // Step 5: 宽度检测
  const detectedWidth = await step('width detection', async () => {
    return await page.evaluate(() => {
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
      return {
        maxRight, contentMaxWidth, viewportWidth,
        result: (contentMaxWidth > 300 && contentMaxWidth <= 500) ? Math.ceil(contentMaxWidth) :
                (viewportWidth > 300 && viewportWidth <= 500) ? Math.ceil(viewportWidth) :
                Math.max(Math.ceil(maxRight), document.body?.scrollWidth || 0, document.documentElement?.scrollWidth || 0, 320)
      };
    });
  });
  console.log('Detected width:', detectedWidth);

  // Step 6: 如果宽度不同，切换viewport
  if (detectedWidth.result !== 1280) {
    await step(`setViewport(${detectedWidth.result}x900)`, async () => {
      await page.setViewport({ width: detectedWidth.result, height: 900 });
      await new Promise(r => setTimeout(r, 150));
      return 'OK';
    });
  }

  // Step 7: 测量高度
  const contentHeight = await step('measure height', async () => {
    return await page.evaluate(() => Math.max(
      document.documentElement.scrollHeight || 0,
      document.body ? document.body.scrollHeight : 0
    ));
  });

  // Step 8: 注入filler
  await step('inject filler', async () => {
    const bgColor = await page.evaluate(() => {
      const cssVar = getComputedStyle(document.documentElement).getPropertyValue('--bg').trim();
      return cssVar || getComputedStyle(document.body || document.documentElement).backgroundColor || '#ffffff';
    });
    await page.evaluate((bg) => {
      const filler = document.createElement('div');
      filler.style.cssText = `height:2px;width:100%;background:${bg};`;
      document.body.appendChild(filler);
    }, bgColor);
    return 'OK';
  });

  // Step 9: 最终高度测量
  const finalHeight = await step('final height', async () => {
    return await page.evaluate(() => Math.max(
      document.documentElement.scrollHeight || 0,
      document.body ? document.body.scrollHeight : 0
    ));
  });

  // Step 10: 截图前设置viewport（关键！与服务端一致）
  const scale = 2;
  const MAX_SCREENSHOT_DIM = 16384;
  const maxCssHeight = Math.floor(MAX_SCREENSHOT_DIM / scale) - 100;
  const maxCssWidth = Math.floor(MAX_SCREENSHOT_DIM / scale) - 100;
  const effectiveWidth = Math.min(detectedWidth.result, maxCssWidth);
  const needsSegmenting = finalHeight > maxCssHeight;
  const segmentHeight = needsSegmenting ? maxCssHeight : finalHeight;

  console.log(`\n📐 截图参数: effectiveWidth=${effectiveWidth}, finalHeight=${finalHeight}, scale=${scale}`);
  console.log(`   needsSegmenting=${needsSegmenting}, segmentHeight=${segmentHeight}, maxCssHeight=${maxCssHeight}`);

  await step('set final viewport', async () => {
    await page.setViewport({
      width: effectiveWidth,
      height: needsSegmenting ? segmentHeight : finalHeight,
      deviceScaleFactor: scale
    });
    await new Promise(r => setTimeout(r, 150));
    return 'OK';
  });

  // Step 11: 尝试截图
  if (!needsSegmenting) {
    await step('fullPage screenshot', async () => {
      const buf = await page.screenshot({ type: 'jpeg', quality: 95, fullPage: true });
      console.log('Buffer length:', buf.length);
      if (buf.length === 0) throw new Error('0 bytes');
      const pdfDoc = await PDFDocument.create();
      const img = await pdfDoc.embedJpg(buf);
      pdfDoc.addPage([effectiveWidth*0.75, finalHeight*0.75]).drawImage(img, {x:0,y:0,width:effectiveWidth*0.75,height:finalHeight*0.75});
      const pdfBuf = await pdfDoc.save();
      return `${(pdfBuf.length/1024).toFixed(1)}KB`;
    });
  } else {
    console.log('需要分段截图...');
  }

  await page.close();
  await browser.close();
})();
