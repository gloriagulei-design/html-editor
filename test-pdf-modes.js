/**
 * 测试两种 PDF 生成模式的背景色保留情况
 */
import fs from 'fs';

const testHtml = `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="UTF-8">
<style>
  body { margin:0; padding:40px; background: linear-gradient(135deg, #1a1a2e 0%, #16213e 100%); color:#fff; font-family:sans-serif; }
  .card { background: #2d2d44; border-radius:16px; padding:24px; margin:16px 0; box-shadow: 0 4px 20px rgba(0,0,0,0.3); }
  .highlight { background: #6366f1; padding: 8px 16px; border-radius: 8px; display: inline-block; }
  .gradient-box { background: linear-gradient(90deg, #ef4444, #f97316); padding: 20px; border-radius: 12px; }
  table { width:100%; border-collapse: collapse; margin:16px 0; }
  th, td { border:1px solid #444; padding:12px; }
  th { background: #3a3a55; }
  tr:nth-child(even) { background: #262636; }
</style>
</head>
<body>
  <h1>🎨 PDF 背景色测试</h1>
  <div class="card">
    <h2>深色卡片</h2>
    <p>这段文字在深色背景上，卡片也有独立背景色。</p>
    <span class="highlight">高亮标签</span>
  </div>
  <div class="gradient-box">
    <strong>渐变背景区域</strong>
  </div>
  <table>
    <tr><th>项目</th><th>数值</th></tr>
    <tr><td>背景保留</td><td>测试</td></tr>
    <tr><td>渐变效果</td><td>测试</td></tr>
  </table>
  <p style="background:#065f46; padding:12px; border-radius:8px;">绿色背景段落</p>
</body>
</html>`;

async function test() {
  // 启动服务
  const { default: app } = await import('./server.js');
  
  // 等待服务启动
  await new Promise(r => setTimeout(r, 2000));
  
  const baseUrl = 'http://127.0.0.1:3100';
  
  for (const mode of ['print', 'screenshot']) {
    console.log(`\n🧪 测试模式: ${mode}`);
    const res = await fetch(`${baseUrl}/api/html-to-pdf`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ html: testHtml, filename: `test-${mode}.pdf`, pdfMode: mode })
    });
    
    if (!res.ok) {
      console.error(`❌ ${mode} 模式失败:`, res.status);
      const err = await res.json().catch(() => ({}));
      console.error(err.error || '未知错误');
      continue;
    }
    
    const buf = Buffer.from(await res.arrayBuffer());
    fs.writeFileSync(`/data/gloria-cloud/html-editor/test-${mode}.pdf`, buf);
    
    const pages = res.headers.get('X-PDF-Pages');
    const size = res.headers.get('X-PDF-Size-KB');
    console.log(`✅ ${mode} 模式成功: ${pages}页, ${size}KB, 文件: test-${mode}.pdf`);
  }
  
  console.log('\n📂 测试完成，文件保存在当前目录');
  process.exit(0);
}

test().catch(e => { console.error(e); process.exit(1); });
