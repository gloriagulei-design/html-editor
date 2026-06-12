import { chromium } from 'playwright';

const browser = await chromium.launch();
const page = await browser.newPage({
  viewport: { width: 375, height: 720 },
  deviceScaleFactor: 1,
});

await page.goto('file:///data/gloria-cloud/html-editor/test/test_complex.html', { waitUntil: 'networkidle' });
await page.waitForTimeout(2000);

// 截全屏图
await page.screenshot({
  path: '/data/gloria-cloud/html-editor/test/screenshot_original.png',
  fullPage: true
});
console.log('截图完成: screenshot_original.png');

// 获取页面包围盒
const dim = await page.evaluate(() => ({
  w: document.documentElement.scrollWidth,
  h: document.documentElement.scrollHeight,
}));
console.log('截图尺寸:', dim);

await browser.close();
