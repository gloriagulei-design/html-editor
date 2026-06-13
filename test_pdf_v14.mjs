import { readFileSync, writeFileSync } from 'fs';

const API_URL = 'http://localhost:3100/api/html-to-pdf';

async function testPdf(html, name, mode = 'print') {
  const start = Date.now();
  try {
    const resp = await fetch(API_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ html, filename: `${name}_${mode}`, pdfMode: mode }),
      signal: AbortSignal.timeout(60000)
    });
    const t = Date.now() - start;
    if (!resp.ok) {
      const err = await resp.text();
      return { ok: false, name, mode, status: resp.status, error: err.slice(0, 200), t };
    }
    const pages = resp.headers.get('X-PDF-Pages');
    const size = resp.headers.get('X-PDF-Size-KB');
    const rmode = resp.headers.get('X-PDF-Mode');
    const buf = await resp.arrayBuffer();
    // 保存到文件
    writeFileSync(`/data/gloria-cloud/html-editor/test_output/${name}_${mode}.pdf`, Buffer.from(buf));
    return { ok: true, name, mode: rmode, pages, size, bytes: buf.byteLength, t };
  } catch (e) {
    return { ok: false, name, mode, error: e.message, t: Date.now() - start };
  }
}

// 确保输出目录存在
import { mkdirSync } from 'fs';
try { mkdirSync('/data/gloria-cloud/html-editor/test_output'); } catch (_) {}

console.log('=== PDF V14 全面测试 ===\n');

// 1. 实际富途报告HTML
let realHtml;
try {
  realHtml = readFileSync('/data/gloria-cloud/html-editor/test_output/saved_html.html', 'utf8');
  console.log(`📄 加载实际报告HTML: ${realHtml.length} 字符`);
} catch (e) {
  console.log('⚠️ 没有找到保存的HTML，使用测试HTML');
  realHtml = null;
}

// 2. 测试用例
const tests = [
  {
    name: '短页面渐变背景',
    html: `<!DOCTYPE html><html><head><meta charset="UTF-8"><style>
body{margin:0;padding:40px;font-family:sans-serif;background:linear-gradient(135deg,#667eea,#764ba2);color:white;min-height:100vh;display:flex;align-items:center;justify-content:center}
h1{font-size:48px}
</style></head><body><h1>短页面测试</h1></body></html>`
  },
  {
    name: 'PPT风格3屏',
    html: `<!DOCTYPE html><html><head><meta charset="UTF-8"><style>
body{margin:0;font-family:sans-serif}
.slide{height:100vh;display:flex;align-items:center;justify-content:center;font-size:72px;color:white}
</style></head><body>
<div class="slide" style="background:linear-gradient(135deg,#667eea,#764ba2)">Slide 1</div>
<div class="slide" style="background:linear-gradient(135deg,#f093fb,#f5576c)">Slide 2</div>
<div class="slide" style="background:linear-gradient(135deg,#4facfe,#00f2fe)">Slide 3</div>
</body></html>`
  },
  {
    name: '宽内容1360px',
    html: `<!DOCTYPE html><html><head><meta charset="UTF-8"><style>
body{margin:0;padding:0;font-family:sans-serif}
.container{width:1360px;margin:0 auto;padding:40px;background:#f0f0f0}
.card{background:white;border-radius:12px;padding:30px;margin-bottom:20px;box-shadow:0 4px 20px rgba(0,0,0,0.1)}
h1{color:#333}p{line-height:1.8;color:#666}
</style></head><body>
<div class="container">
<h1>宽内容测试 (1360px)</h1>
${Array(5).fill(0).map((_,i) => `<div class="card"><h2>卡片 ${i+1}</h2><p>这是一段测试文字。页面宽度设置为1360px，用于测试PDF生成时是否正确缩放适配A4纸张。如果内容太宽，应该自动缩放而不是被截断。</p></div>`).join('')}
</div>
</body></html>`
  },
  {
    name: '超长页面50屏',
    html: `<!DOCTYPE html><html><head><meta charset="UTF-8"><style>
body{margin:0;font-family:sans-serif}
.slide{height:100vh;display:flex;align-items:center;justify-content:center;font-size:40px;color:white}
</style></head><body>
${Array(50).fill(0).map((_,i) => `<div class="slide" style="background:hsl(${i*7},70%,50%)">Slide ${i+1}</div>`).join('')}
</body></html>`
  },
  {
    name: '渐变宽背景1200px',
    html: `<!DOCTYPE html><html><head><meta charset="UTF-8"><style>
body{margin:0;font-family:sans-serif;background:linear-gradient(135deg,#667eea,#764ba2);min-height:100vh}
.container{width:1200px;margin:0 auto;padding:60px;color:white}
h1{font-size:56px;margin-bottom:30px}
.grid{display:grid;grid-template-columns:repeat(3,1fr);gap:30px;margin-top:40px}
.item{background:rgba(255,255,255,0.2);border-radius:16px;padding:30px;backdrop-filter:blur(10px)}
</style></head><body>
<div class="container">
<h1>渐变背景宽页面</h1>
<p>页面宽度1200px，有渐变背景。测试背景色是否在PDF中完整保留。</p>
<div class="grid">
${Array(6).fill(0).map((_,i) => `<div class="item"><h3>项目 ${i+1}</h3><p>测试内容占位</p></div>`).join('')}
</div>
</div>
</body></html>`
  },
  {
    name: '连续长文不分页',
    html: `<!DOCTYPE html><html><head><meta charset="UTF-8"><style>
body{margin:0;padding:60px;font-family:sans-serif;line-height:2;max-width:800px;margin:0 auto}
h1{color:#333;border-bottom:3px solid #667eea;padding-bottom:20px}
p{margin:20px 0;color:#444}
</style></head><body>
<h1>长文文档测试</h1>
<p>这是一篇测试文档，用于验证PDF生成时连续文字是否正确分页。文字应该在合理位置分页，不应在段落中间切断。</p>
${Array(50).fill(0).map((_,i) => `<p>第${i+1}段：这是一段测试文字。Lorem ipsum dolor sit amet, consectetur adipiscing elit. Sed do eiusmod tempor incididunt ut labore et dolore magna aliqua. Ut enim ad minim veniam, quis nostrud exercitation ullamco laboris nisi ut aliquip ex ea commodo consequat.</p>`).join('')}
</body></html>`
  }
];

// 运行测试
async function runTests() {
  // 1. 实际报告（如果存在）
  if (realHtml) {
    console.log('\n--- 实际富途报告 ---');
    for (const mode of ['print', 'screenshot']) {
      const r = await testPdf(realHtml, '实际报告', mode);
      console.log(`${r.ok ? '✅' : '❌'} ${r.mode}: ${r.pages || '?'}页, ${r.size || '?'}KB, ${r.t/1000}s${r.error ? ' - ' + r.error : ''}`);
    }
  }

  // 2. 测试用例
  for (const t of tests) {
    console.log(`\n--- ${t.name} ---`);
    for (const mode of ['print', 'screenshot']) {
      const r = await testPdf(t.html, t.name, mode);
      console.log(`${r.ok ? '✅' : '❌'} ${r.mode}: ${r.pages || '?'}页, ${r.size || '?'}KB, ${r.t/1000}s${r.error ? ' - ' + r.error : ''}`);
    }
  }

  console.log('\n=== 测试完成 ===');
  console.log('输出文件在: /data/gloria-cloud/html-editor/test_output/');
}

runTests().catch(console.error);
