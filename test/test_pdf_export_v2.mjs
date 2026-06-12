import { chromium } from 'playwright';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const fileUrl = 'file://' + path.resolve('/data/gloria-cloud/html-editor/test/test_complex.html');

const browser = await chromium.launch();

// 创建 page 并设置 viewport 为 375px 宽
const page = await browser.newPage({
  viewport: { width: 375, height: 720 }, // 设置窄viewport模拟手机
  deviceScaleFactor: 1,
});

await page.goto(fileUrl, { waitUntil: 'networkidle', timeout: 30000 });

// 等待所有网络请求完成，图片加载完成
await page.waitForTimeout(2000);

// 注入CSS让内容不溢出续页
await page.addStyleTag({
  content: `
    @page { margin: 0; }
    body { overflow: hidden; }
  `
});

const dimensions = await page.evaluate(() => {
  const el = document.querySelector('.container') || document.body;
  const rect = el.getBoundingClientRect();
  const bodyStyle = window.getComputedStyle(document.body);
  const bodyPaddingTop = parseFloat(bodyStyle.paddingTop) || 0;
  const bodyPaddingBottom = parseFloat(bodyStyle.paddingBottom) || 0;
  return {
    scrollWidth: document.documentElement.scrollWidth,
    scrollHeight: document.documentElement.scrollHeight,
    bodyHeight: document.body.scrollHeight,
    containerHeight: rect.height,
    containerTop: rect.top,
    bodyPaddingTop,
    bodyPaddingBottom
  };
});
console.log('HTML测量结果:', JSON.stringify(dimensions));

// 方案1: 用正确的尺寸渲染一页PDF (Playwright page.pdf会分页，需要设置合适高度)
// 375px宽页面：要防止分页，高度必须 >= 实际内容高度
// 但实际内容可能很大，所以用一个大高度值
const totalHeight = dimensions.scrollHeight + 50; // 加像素余地
console.log('>>> 方案1: 使用超大单页' );

await page.pdf({
  path: '/data/gloria-cloud/html-editor/test/output_v1.pdf',
  width: '375px',
  height: totalHeight,
  printBackground: true,
  preferCSSPageSize: false,
  margin: { top: 0, right: 0, bottom: 0, left: 0 },
  scale: 1,
});
console.log('  导出完成: output_v1.pdf');

// 方案2: 用 fixed 高度 = 内容高度，强制单页
await page.pdf({
  path: '/data/gloria-cloud/html-editor/test/output_v2.pdf',
  width: '375px',
  height: totalHeight,
  printBackground: true,
  preferCSSPageSize: false,
  margin: { top: 0, right: 0, bottom: 0, left: 0 },
  scale: 96 / 72, // 尝试调整scale
});
console.log('  导出完成: output_v2.pdf (scale=96/72)');

await browser.close();
console.log('测试完成');
