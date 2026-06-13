import puppeteer from 'puppeteer-core';
import fs from 'fs';
import { PDFDocument } from 'pdf-lib';

const CHROME_PATH = '/usr/bin/ungoogled-chromium';

// 打印测试
async function testScreenshot(htmlFile, label) {
  console.log(`\n========== ${label} ==========`);
  const html = fs.readFileSync(htmlFile, 'utf-8');
  console.log(`HTML: ${html.length} chars`);

  const browser = await puppeteer.launch({ executablePath: CHROME_PATH, headless: 'new', args: ['--no-sandbox','--disable-gpu'] });
  const page = await browser.newPage();
  await page.setViewport({ width: 1280, height: 900 });

  try {
    await page.setContent(html, { waitUntil: 'networkidle0', timeout: 15000 });
  } catch(e) {
    await page.setContent(html, { waitUntil: 'domcontentloaded', timeout: 15000 });
  }
  await new Promise(r => setTimeout(r, 500));

  const h = await page.evaluate(() => Math.max(document.documentElement.scrollHeight||0, document.body?document.body.scrollHeight:0));
  console.log(`Content height: ${h}px`);

  // 尝试截图
  let buf;
  try {
    buf = await page.screenshot({ type: 'jpeg', quality: 95, fullPage: true });
    console.log(`Screenshot: ${buf.length} bytes`);
    if (buf.length === 0) {
      console.log('❌ 截图返回0字节！');
    } else {
      // 测试能否嵌入PDF
      const pdfDoc = await PDFDocument.create();
      const img = await pdfDoc.embedJpg(buf);
      console.log(`JPG embedded: ${img.width}x${img.height}`);
      pdfDoc.addPage([img.width, img.height]).drawImage(img, {x:0,y:0,width:img.width,height:img.height});
      const pdfBuf = await pdfDoc.save();
      console.log(`✅ PDF OK: ${(pdfBuf.length/1024).toFixed(1)} KB`);
    }
  } catch(e) {
    console.log(`❌ Screenshot error: ${e.message}`);
  }

  // 尝试 print 模式作为对比
  try {
    const pBuf = await page.pdf({ width: '1280px', height: `${h}px`, printBackground: true, margin: {top:0,right:0,bottom:0,left:0} });
    const doc = await PDFDocument.load(pBuf);
    const sz = doc.getPage(0).getSize();
    console.log(`Print mode: ${(pBuf.length/1024).toFixed(1)} KB, size=${sz.width.toFixed(0)}x${sz.height.toFixed(0)}pt`);
  } catch(e) {
    console.log(`❌ Print error: ${e.message}`);
  }

  await page.close();
  await browser.close();
}

async function main() {
  await testScreenshot('/data/gloria-cloud/html-editor/.tmp/test_ppt_20slides.html', 'Test1: 20页PPT');
  await testScreenshot('/data/gloria-cloud/html-editor/.tmp/pdf-5f25ce8a-7d45-4442-9db9-68d490c50740.html', 'Test2: 用户实际HTML');
}

main().catch(e => console.error(e));
