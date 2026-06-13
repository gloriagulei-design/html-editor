import puppeteer from 'puppeteer-core';
import { writeFileSync } from 'fs';

const CHROME = '/usr/bin/ungoogled-chromium';

const html = `
<!DOCTYPE html>
<html><head><meta charset="UTF-8">
<style>
body { margin: 0; }
.slide { min-height: 100vh; background: #e0e0e0; border: 2px solid red; margin-bottom: 10px; }
</style>
</head>
<body>
<div class="slide" id="s1">Slide 1</div>
<div class="slide" id="s2">Slide 2</div>
<div class="slide" id="s3">Slide 3</div>
<script>
window.vhInfo = {
  viewportH: window.innerHeight,
  slide1H: document.getElementById('s1').offsetHeight,
  slide2H: document.getElementById('s2').offsetHeight,
  slide3H: document.getElementById('s3').offsetHeight,
  bodyScrollH: document.body.scrollHeight,
  docScrollH: document.documentElement.scrollHeight
};
</script>
</body></html>`;

(async () => {
  const browser = await puppeteer.launch({ executablePath: CHROME, headless: 'new', args: ['--no-sandbox'] });
  const page = await browser.newPage();

  writeFileSync('.tmp/test_vh.html', html);
  await page.goto('file:///data/gloria-cloud/html-editor/.tmp/test_vh.html', { waitUntil: 'networkidle0' });

  // 设置viewport
  await page.setViewport({ width: 1280, height: 900 });
  await new Promise(r => setTimeout(r, 500));

  // 屏幕环境下测量
  const screenInfo = await page.evaluate(() => window.vhInfo);
  console.log('屏幕环境 viewport=1280x900:');
  console.log('  100vh值 (window.innerHeight):', screenInfo.viewportH);
  console.log('  slide1高度:', screenInfo.slide1H);
  console.log('  slide2高度:', screenInfo.slide2H);
  console.log('  slide3高度:', screenInfo.slide3H);
  console.log('  body scrollHeight:', screenInfo.bodyScrollH);
  console.log('  doc scrollHeight:', screenInfo.docScrollH);

  // 生成PDF并重新测量
  await page.pdf({ width: '1280px', height: '4000px', printBackground: true, margin: {top:0,right:0,bottom:0,left:0} });

  // PDF生成后再测量（ viewport没变，但可能触发了print media query ）
  // 实际上page.pdf()不会触发media query改变，除非有matchMedia监听器
  // 但page.pdf()内部使用的是print renderer

  // 关键测试：在print媒体查询下100vh的值
  const printVH = await page.evaluate(() => {
    // 创建一个临时元素来测量100vh
    const div = document.createElement('div');
    div.style.cssText = 'position:absolute;top:0;left:0;height:100vh;width:1px;';
    document.body.appendChild(div);
    const h = div.offsetHeight;
    document.body.removeChild(div);
    return h;
  });
  console.log('\nScreen环境下100vh实际像素值:', printVH);

  // 再检查page.pdf之后（在同一个page上）
  const afterPdf = await page.evaluate(() => ({
    slide1H: document.getElementById('s1').offsetHeight,
    bodyH: document.body.scrollHeight,
    vh100: (() => { const d=document.createElement('div'); d.style.height='100vh'; document.body.appendChild(d); const h=d.offsetHeight; document.body.removeChild(d); return h; })()
  }));
  console.log('\nPDF生成后重新测量:');
  console.log('  slide1高度:', afterPdf.slide1H);
  console.log('  body scrollHeight:', afterPdf.bodyH);
  console.log('  100vh值:', afterPdf.vh100);

  await browser.close();
})();
