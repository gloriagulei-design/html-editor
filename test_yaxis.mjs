import { mkdirSync, writeFileSync } from 'fs';

try { mkdirSync('/data/gloria-cloud/html-editor/test_output', { recursive: true }); } catch (_) {}

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
    writeFileSync(`/data/gloria-cloud/html-editor/test_output/${name}_${mode}_v2.pdf`, Buffer.from(buf));
    return { ok: true, name, mode: rmode, pages, size, bytes: buf.byteLength, t };
  } catch (e) {
    return { ok: false, name, mode, error: e.message, t: Date.now() - start };
  }
}

console.log('=== Y轴修复后截图模式测试 ===\n');

const tests = [
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
    name: '超长页面50屏',
    html: `<!DOCTYPE html><html><head><meta charset="UTF-8"><style>
body{margin:0;font-family:sans-serif}
.slide{height:100vh;display:flex;align-items:center;justify-content:center;font-size:40px;color:white}
</style></head><body>
${Array(50).fill(0).map((_,i) => `<div class="slide" style="background:hsl(${i*7},70%,50%)">Slide ${i+1}</div>`).join('')}
</body></html>`
  },
  {
    name: '渐变宽背景',
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
  }
];

async function run() {
  for (const t of tests) {
    console.log(`\n--- ${t.name} ---`);
    for (const mode of ['print', 'screenshot']) {
      const r = await testPdf(t.html, t.name, mode);
      console.log(`${r.ok ? '✅' : '❌'} ${r.mode}: ${r.pages || '?'}页, ${r.size || '?'}KB, ${(r.t/1000).toFixed(1)}s${r.error ? ' - ' + r.error : ''}`);
    }
  }
  console.log('\n=== 测试完成 ===');
}

run().catch(console.error);
