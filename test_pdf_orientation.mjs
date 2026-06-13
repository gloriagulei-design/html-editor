import puppeteer from 'puppeteer-core';
import { writeFileSync } from 'fs';

const CHROME = '/usr/bin/ungoogled-chromium';

const html = `
<!DOCTYPE html>
<html><head><meta charset="UTF-8">
<style>
body { margin:0; background:linear-gradient(180deg, #667eea, #764ba2); color:white; font-family: sans-serif; }
.box { width: 500px; height: 2000px; display:flex; flex-direction:column; justify-content:space-between; padding: 20px; }
</style>
</head>
<body>
<div class="box">
  <h1>顶部</h1>
  <h1>底部</h1>
</div>
</body></html>`;

(async () => {
  const browser = await puppeteer.launch({ executablePath: CHROME, headless: 'new', args: ['--no-sandbox'] });
  const page = await browser.newPage();

  writeFileSync('.tmp/test_orientation.html', html);
  await page.goto('file:///data/gloria-cloud/html-editor/.tmp/test_orientation.html', { waitUntil: 'networkidle0' });

  // 测试1: 不设置viewport，直接指定width/height
  console.log('\n=== 测试1: 不设置大viewport ===');
  await page.setViewport({ width: 1280, height: 900 });
  const h1 = await page.evaluate(() => document.body.scrollHeight);
  console.log('body高度:', h1);

  const pdf1 = await page.pdf({ width: '500px', height: h1 + 'px', printBackground: true, margin: {top:0,right:0,bottom:0,left:0} });
  writeFileSync('.tmp/test1_direct.pdf', pdf1);

  // 测试2: 设置viewport为内容尺寸后再pdf
  console.log('\n=== 测试2: 先设置viewport为内容尺寸 ===');
  await page.setViewport({ width: 500, height: h1 });
  await new Promise(r => setTimeout(r, 500));
  const pdf2 = await page.pdf({ width: '500px', height: h1 + 'px', printBackground: true, margin: {top:0,right:0,bottom:0,left:0} });
  writeFileSync('.tmp/test2_viewport_set.pdf', pdf2);

  // 测试3: 只设置viewport宽度，高度保持900
  console.log('\n=== 测试3: 只设置viewport宽度，高度保持900 ===');
  await page.setViewport({ width: 500, height: 900 });
  await new Promise(r => setTimeout(r, 500));
  const pdf3 = await page.pdf({ width: '500px', height: h1 + 'px', printBackground: true, margin: {top:0,right:0,bottom:0,left:0} });
  writeFileSync('.tmp/test3_width_only.pdf', pdf3);

  // 测试4: 使用format + width （另一种参数方式）
  console.log('\n=== 测试4: 使用format Letter + width ===');
  await page.setViewport({ width: 500, height: 900 });
  const pdf4 = await page.pdf({ format: 'Letter', width: '500px', printBackground: true, margin: {top:0,right:0,bottom:0,left:0} });
  writeFileSync('.tmp/test4_format.pdf', pdf4);

  await browser.close();
  console.log('\n所有PDF已保存到 .tmp/');
})();
