import { chromium } from 'playwright';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const fileUrl = 'file://' + path.resolve('/data/gloria-cloud/html-editor/test/test_complex.html');

console.log('>>> 启动浏览器...');
const browser = await chromium.launch();

console.log('>>> 创建新Page...');
const page = await browser.newPage();

console.log('>>> 加载HTML文件...');
await page.goto(fileUrl, { waitUntil: 'networkidle', timeout: 30000 });

console.log('>>> 获取内容高度...');
const dimensions = await page.evaluate(() => {
  const doc = document.getElementsByTagName('body')[0];
  return {
    width: document.documentElement.scrollWidth,
    height: Math.max(doc.scrollHeight, doc.offsetHeight),
    innerWidth: window.innerWidth,
    innerHeight: window.innerHeight
  };
});
console.log('HTML内容尺寸:', JSON.stringify(dimensions));

console.log('>>> 导出PDF...');
await page.pdf({
  path: '/data/gloria-cloud/html-editor/test/output_direct.pdf',
  width: 375,
  height: dimensions.height,
  printBackground: true,
  preferCSSPageSize: false
});

console.log('>>> 导出完成: test/output_direct.pdf');
console.log('>>> PDF尺寸: 375px x ' + dimensions.height + 'px');

await browser.close();
