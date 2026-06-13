import { readFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { PDFDocument } from 'pdf-lib';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

async function deepInspectPdf() {
  const pdfBuffer = readFileSync(join(__dirname, 'test_output/test_ppt_slides.pdf'));
  const pdfDoc = await PDFDocument.load(pdfBuffer, { updateMetadata: false });

  console.log('=== PDF 深度检查 ===\n');

  const pages = pdfDoc.getPages();
  console.log('总页数:', pages.length);

  for (let i = 0; i < pages.length; i++) {
    const page = pages[i];
    const size = page.getSize();
    console.log(`\n--- 第 ${i + 1} 页 ---`);
    console.log('尺寸 (pt):', size.width.toFixed(2), 'x', size.height.toFixed(2));
    console.log('尺寸 (px):', (size.width * 96 / 72).toFixed(0), 'x', (size.height * 96 / 72).toFixed(0));
    console.log('尺寸 (mm):', (size.width * 25.4 / 72).toFixed(2), 'x', (size.height * 25.4 / 72).toFixed(2));

    // 检查资源（图片等）
    const resources = page.node.Resources();
    if (resources) {
      const xObjects = resources.lookupMaybe('XObject');
      const fonts = resources.lookupMaybe('Font');
      console.log('图片资源 (XObject):', xObjects ? Object.keys(xObjects.dict).length : 0);
      console.log('字体资源 (Font):', fonts ? Object.keys(fonts.dict).length : 0);
    }

    // 获取页面内容流
    const contents = page.node.Contents();
    if (contents) {
      const contentData = contents.asArray ? contents.asArray() : [contents];
      let totalLength = 0;
      contentData.forEach(c => {
        if (c.encoded) totalLength += c.encoded.length;
      });
      console.log('内容流大小:', totalLength, 'bytes');

      // 尝试查找文字标记
      const contentStr = contents.encoded ? contents.encoded.toString('latin1') : '';
      const hasTextOps = contentStr.includes('/T');
      const hasColorOps = contentStr.includes('rg') || contentStr.includes('RG');
      const hasDrawOps = contentStr.includes('re') || contentStr.includes('m');
      console.log('包含文本操作:', hasTextOps);
      console.log('包含颜色操作:', hasColorOps);
      console.log('包含绘制操作:', hasDrawOps);
    }
  }

  console.log('\n\n=== 验证结论 ===');
  const size = pages[0].getSize();
  if (pages.length === 1 && size.height > 500) {
    console.log('✅ 页数 = 1（超长单页模式正确）');
  } else {
    console.log('⚠️ 页数或高度异常');
  }

  if (size.width >= 1400) {
    console.log('✅ 宽度', (size.width * 96 / 72).toFixed(0), 'px ≈ 1920px 正确');
  }

  // 3个slide的大致高度
  // slide1: 100vh ≈ 1080px
  // slide2: ~400px
  // slide3: ~400px
  // total: ~1880px
  const expectedHeight = 1900;
  if (Math.abs(size.height * 96 / 72 - expectedHeight) < 500) {
    console.log('✅ 高度合理（三页slide拼接）');
  }

  console.log('\n📂 文件:', join(__dirname, 'test_output/test_ppt_slides.pdf'));
}

deepInspectPdf().catch(err => console.error('检查失败:', err.message));
