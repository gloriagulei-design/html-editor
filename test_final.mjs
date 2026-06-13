import { mkdirSync } from 'fs';

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
    
    const fs = await import('fs');
    fs.writeFileSync(`/data/gloria-cloud/html-editor/test_output/${name}_${mode}.pdf`, Buffer.from(buf));
    
    return { ok: true, name, mode: rmode, pages, size, bytes: buf.byteLength, t };
  } catch (e) {
    return { ok: false, name, mode, error: e.message, t: Date.now() - start };
  }
}

console.log('=== 最终测试：成功方案恢复 ===\n');

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
${Array(5).fill(0).map((_,i) => `<div class="card"><h2>卡片 ${i+1}</h2><p>测试宽内容1360px的PDF导出适配情况。</p></div>`).join('')}
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
  },
  {
    name: '富途报告样式',
    html: `<!DOCTYPE html><html><head><meta charset="UTF-8"><style>
body{margin:0;font-family:-apple-system,BlinkMacSystemFont,sans-serif;background:#f5f5f5}
.header{background:linear-gradient(135deg,#1a73e8,#4285f4);color:white;padding:60px 40px}
.header h1{margin:0;font-size:42px}
.header p{margin:20px 0 0;opacity:0.9;font-size:16px}
.container{max-width:1200px;margin:0 auto;padding:40px}
.card{background:white;border-radius:12px;padding:40px;margin-bottom:30px;box-shadow:0 2px 12px rgba(0,0,0,0.08)}
.card h2{margin:0 0 20px;color:#1a73e8;font-size:24px}
.table{width:100%;border-collapse:collapse;margin-top:20px}
.table th{background:#f8f9fa;padding:16px;text-align:left;font-weight:600;color:#333}
.table td{padding:16px;border-bottom:1px solid #eee;color:#555}
.highlight{background:#e8f0fe;padding:20px;border-radius:8px;margin:20px 0;color:#1a73e8}
.footer{text-align:center;padding:40px;color:#999;font-size:14px}
</style></head><body>
<div class="header"><h1>富途证券研究报告</h1><p>分析师：张三 | 日期：2026-06-13 | 评级：买入</p></div>
<div class="container">
<div class="card"><h2>核心观点</h2><p>本报告分析了公司经营状况，预计未来三年营收复合增长率达25%，净利润有望翻倍。</p><div class="highlight">目标价：HK$128.50 | 当前价：HK$98.20 | 上涨空间：30.9%</div></div>
<div class="card"><h2>财务摘要</h2>
<table class="table"><tr><th>指标</th><th>2023A</th><th>2024A</th><th>2025E</th><th>2026E</th></tr>
<tr><td>营业收入(亿元)</td><td>120.5</td><td>158.3</td><td>205.8</td><td>267.5</td></tr>
<tr><td>净利润(亿元)</td><td>18.2</td><td>26.8</td><td>38.5</td><td>52.1</td></tr>
<tr><td>EPS(元)</td><td>2.15</td><td>3.18</td><td>4.56</td><td>6.18</td></tr>
<tr><td>ROE(%)</td><td>12.5</td><td>15.8</td><td>18.2</td><td>20.5</td></tr>
</table></div>
<div class="card"><h2>业务分析</h2><p>公司核心业务保持稳健增长，新业务板块快速发展。数字化转型成效显著，运营效率持续提升。</p></div>
<div class="card"><h2>风险提示</h2><p>宏观经济波动、行业竞争加剧、政策变化等因素可能对公司业绩产生影响。</p></div>
</div>
<div class="footer">本报告仅供参考，不构成投资建议</div>
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
