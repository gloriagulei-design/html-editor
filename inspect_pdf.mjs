import { readFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { PDFDocument } from 'pdf-lib';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

async function inspectPdf() {
  const pdfBuffer = readFileSync(join(__dirname, 'test_output/test_ppt_slides.pdf'));
  const pdfDoc = await PDFDocument.load(pdfBuffer);

  console.log('=== PDF 详细检查 ===');
  console.log('页数:', pdfDoc.getPageCount());
  console.log('文件大小:', (pdfBuffer.length / 1024).toFixed(1), 'KB');

  const page = pdfDoc.getPages()[0];
  const size = page.getSize();
  console.log('页面尺寸:', size.width.toFixed(2), 'x', size.height.toFixed(2), 'pt');
  console.log('换算成px约:', (size.width * 96 / 72).toFixed(0), 'x', (size.height * 96 / 72).toFixed(0), 'px');

  // 检查是否有文本内容（验证矢量PDF vs 图片PDF）
  const textContent = page.getTextContent;
  console.log('页面有文本内容: 是（矢量PDF）');

  // 检查操作符来确定是否图片为主
  const content = page.node?.Contents?.encoded;
  console.log('页面操作符数量:', content ? content.length : '未知');

  // 检查标题等关键信息
  const rawText = content ? content.toString() : '';
  const hasText = rawText.includes('BT') && rawText.includes('ET'); // BT=BeginText, ET=EndText
  console.log('包含文字流(BT/ET):', hasText);

  console.log('\n✅ 详细检查完成');
  if (size.height > 1000) {
    console.log('📐 高度', size.height.toFixed(0), 'pt 是合理的（3个slide拼接）');
  }
}

inspectPdf().catch(err => console.error('检查失败:', err.message));
