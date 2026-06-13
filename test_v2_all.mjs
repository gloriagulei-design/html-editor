import { readFileSync, writeFileSync, mkdirSync } from 'fs';

const API_URL = 'http://localhost:3100/api/html-to-pdf';

async function testPdf(html, name, mode = 'optimize') {
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
    writeFileSync(`/data/gloria-cloud/html-editor/test_output/v2_${name}_${mode}.pdf`, Buffer.from(buf));
    return { ok: true, name, mode: rmode, pages, size, bytes: buf.byteLength, t };
  } catch (e) {
    return { ok: false, name, mode, error: e.message, t: Date.now() - start };
  }
}

try { mkdirSync('/data/gloria-cloud/html-editor/test_output', { recursive: true }); } catch (_) {}

console.log('=== PDF V2.0 全面验证 ===\n');

const tests = [
  {
    name: '短页面渐变',
    html: `<!DOCTYPE html><html><head><meta charset="UTF-8"><style>
body{margin:0;padding:40px;font-family:sans-serif;background:linear-gradient(135deg,#667eea,#764ba2);color:white;min-height:100vh;display:flex;align-items:center;justify-content:center}
h1{font-size:48px}
</style></head><body><h1>短页面测试</h1></body></html>`
  },
  {
    name: 'PPT3屏',
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
    name: '宽内容1360',
    html: `<!DOCTYPE html><html><head><meta charset="UTF-8"><style>
body{margin:0;padding:0;font-family:sans-serif}
.container{width:1360px;margin:0 auto;padding:40px;background:#f0f0f0}
.card{background:white;border-radius:12px;padding:30px;margin-bottom:20px;box-shadow:0 4px 20px rgba(0,0,0,0.1)}
h1{color:#333}p{line-height:1.8;color:#666}
</style></head><body>
<div class="container">
<h1>宽内容测试 (1360px)</h1>
${Array(5).fill(0).map((_,i) => `<div class="card"><h2>卡片 ${i+1}</h2><p>测试内容占位文字，用于验证PDF生成效果。</p></div>`).join('')}
</div>
</body></html>`
  },
  {
    name: '长文50段',
    html: `<!DOCTYPE html><html><head><meta charset="UTF-8"><style>
body{margin:0;padding:60px;font-family:sans-serif;line-height:2;max-width:800px;margin:0 auto}
h1{color:#333;border-bottom:3px solid #667eea;padding-bottom:20px}
p{margin:20px 0;color:#444}
</style></head><body>
<h1>长文文档测试</h1>
${Array(50).fill(0).map((_,i) => `<p>第${i+1}段：这是一段测试文字。Lorem ipsum dolor sit amet, consectetur adipiscing elit. Sed do eiusmod tempor incididunt ut labore et dolore magna aliqua.</p>`).join('')}
</body></html>`
  }
];

async function run() {
  for (const t of tests) {
    console.log(`\n--- ${t.name} ---`);
    for (const mode of ['optimize', 'print', 'simulated', 'continuous']) {
      const r = await testPdf(t.html, t.name, mode);
      console.log(`${r.ok ? '✅' : '❌'} ${r.mode || mode}: ${r.pages || '?'}页, ${r.size || '?'}KB, ${r.t/1000}s${r.error ? ' - ' + r.error : ''}`);
    }
  }
  console.log('\n=== 验证完成 ===');
}
run().catch(console.error);
