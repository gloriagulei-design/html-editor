import { readFileSync, writeFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

async function testPdfGeneration() {
  const html = readFileSync(join(__dirname, 'test/test_complex.html'), 'utf-8');

  console.log('📄 测试HTML长度:', html.length);
  console.log('📄 包含<meta charset>:', /<meta[^>]+charset/i.test(html));
  console.log('📄 包含@media print:', /@media\s+print/i.test(html));
  console.log('📄 包含 .ani:', /class="[^"]*\bani\b/i.test(html));
  console.log('📄 包含 .slide:', /class="[^"]*slide/i.test(html));

  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), 60000);

  try {
    const response = await fetch('http://0.0.0.0:3100/api/html-to-pdf', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        html,
        filename: 'test_complex.html'
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
    const outputPath = join(__dirname, 'test_output/test_new_server.pdf');
    writeFileSync(outputPath, pdfBuffer);

    console.log('✅ PDF生成成功!');
    console.log('📐 文件大小:', (pdfBuffer.length / 1024).toFixed(1) + 'KB');
    console.log('📐 X-PDF-Width:', response.headers.get('X-PDF-Width'));
    console.log('📐 X-PDF-Height:', response.headers.get('X-PDF-Height'));
    console.log('📐 X-PDF-Mode:', response.headers.get('X-PDF-Mode'));
    console.log('📂 保存位置:', outputPath);

  } catch (err) {
    clearTimeout(timeoutId);
    console.error('❌ 测试失败:', err.message);
  }
}

testPdfGeneration();
