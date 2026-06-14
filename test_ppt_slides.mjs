import { readFileSync, writeFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { PDFDocument } from 'pdf-lib';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

async function testPdfGeneration() {
  const html = readFileSync(join(__dirname, 'test_ppt_slides.html'), 'utf-8');

  console.log('📄 测试HTML长度:', html.length);
  console.log('📄 包含<meta charset>:', /<meta[^>]+charset/i.test(html));
  console.log('📄 包含@media print:', /@media\s+print/i.test(html));
  console.log('📄 包含 .ani:', /class="[^"]*\bani\b/i.test(html));
  console.log('📄 包含 .slide:', /class="[^"]*slide/i.test(html));
  console.log('📄 包含 particle-canvas:', /id="particle-canvas"/i.test(html));

  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), 60000);

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
    const outputPath = join(__dirname, 'test_output/test_ppt_slides.pdf');
    writeFileSync(outputPath, pdfBuffer);

    // 验证PDF
    const pdfDoc = await PDFDocument.load(pdfBuffer);
    const pageCount = pdfDoc.getPageCount();
    const pages = pdfDoc.getPages();
    const firstPage = pages[0];
    const { width, height } = firstPage.getSize();

    console.log('\n✅ PDF生成成功!');
    console.log('📐 文件大小:', (pdfBuffer.length / 1024).toFixed(1) + 'KB');
    console.log('📐 页数:', pageCount);
    console.log('📐 尺寸:', width.toFixed(1), 'x', height.toFixed(1), 'pt');
    console.log('📐 X-PDF-Mode:', response.headers.get('X-PDF-Mode'));
    console.log('📂 保存位置:', outputPath);

    const mode = response.headers.get('X-PDF-Mode');

    if (mode === 'slides-dynamic-height' && pageCount > 1) {
      console.log('\n🎉 PDF验证通过：多页模式，共', pageCount, '页，每页高度自适应！');
    } else if (pageCount === 1 && height > 500) {
      console.log('\n🎉 PDF验证通过：页数=1，高度合理！');
    } else {
      console.warn('\n⚠️ PDF验证警告: 页数或高度异常');
    }

  } catch (err) {
    clearTimeout(timeoutId);
    console.error('❌ 测试失败:', err.message);
  }
}

testPdfGeneration();
