import { readFileSync, writeFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

async function testPdfGeneration() {
  const html = readFileSync(join(__dirname, 'test_ppt_slides.html'), 'utf-8');

  console.log('📄 测试HTML长度:', html.length);
  console.log('📄 包含 .slide:', /class="[^"]*slide/i.test(html));

  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), 120000);

  try {
    const response = await fetch('http://0.0.0.0:3100/api/html-to-pdf', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        html,
        filename: 'test_ppt_slides.html'
      }),
      signal: controller.signal
    });
    clearTimeout(timeoutId);

    if (!response.ok) {
      const err = await response.text();
      console.error('❌ 请求失败:', response.status, err);
      return;
    }

    const pdfBuffer = Buffer.from(await response.arrayBuffer());
    const outputPath = join(__dirname, 'test_output/test_paged_slides.pdf');
    writeFileSync(outputPath, pdfBuffer);

    console.log('\n✅ PDF生成成功!');
    console.log('📐 文件大小:', (pdfBuffer.length / 1024).toFixed(1) + 'KB');
    console.log('📐 页数:', response.headers.get('X-PDF-Pages'));
    console.log('📐 Slide数量:', response.headers.get('X-PDF-Slide-Count'));
    console.log('📐 各页高度:', response.headers.get('X-PDF-Slide-Heights'));
    console.log('📐 模式:', response.headers.get('X-PDF-Mode'));
    console.log('📂 保存位置:', outputPath);

  } catch (err) {
    clearTimeout(timeoutId);
    console.error('❌ 测试失败:', err.message);
  }
}

testPdfGeneration();
