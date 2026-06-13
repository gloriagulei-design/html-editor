import { tmpdir } from 'os';

const API_URL = 'http://localhost:3100/api/html-to-pdf';
const TEST_DIR = tmpdir();

async function test(name, html, mode = 'optimize', width = 'auto') {
  const start = Date.now();
  try {
    const resp = await fetch(API_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ html, filename: 'test.pdf', pdfMode: mode, pdfWidth: width }),
      signal: AbortSignal.timeout(60000)
    });
    const t = Date.now() - start;
    if (!resp.ok) return { ok: false, name, status: resp.status, error: await resp.text().slice(0, 200), t };
    const pages = resp.headers.get('X-PDF-Pages');
    const size = resp.headers.get('X-PDF-Size-KB');
    const respMode = resp.headers.get('X-PDF-Mode');
      return { ok: true, name, pages, size, mode: respMode, t };
  } catch(e) {
    return { ok: false, name, error: e.message, t: Date.now()-start };
  }
}

// ============ 测试用例 ============

const tests = [
  // 1. 标准文档测试（长文，文字分页）
  {
    name: '标准文档(30段文字)',
    mode: 'optimize',
    html: `<!DOCTYPE html><html><head><meta charset="UTF-8"><style>
      body{font-family:system-ui;margin:40px;line-height:1.8;max-width:700px}
      h1{color:#2563eb} p{margin:16px 0}
    </style></head><body>
      <h1>项目报告</h1>
      ${Array(30).fill(0).map((_,i) => `<p>第${i+1}段：这是一段测试文字，用于验证文档型PDF生成效果。页面长度适配应该能够正确处理多页内容，确保文字不被切断，分页位置合理。</p>`).join('')}
    </body></html>`
  },

  // 2. PPT垂直布局（3屏，每屏100vh）
  {
    name: 'PPT垂直布局(3屏)',
    mode: 'optimize',
    html: `<!DOCTYPE html><html><head><meta charset="UTF-8"><style>
      body{margin:0;font-family:sans-serif}
      .slide{height:100vh;display:flex;align-items:center;justify-content:center;font-size:48px;color:white}
    </style></head><body>
      <div class="slide" style="background:#667eea">Slide 1</div>
      <div class="slide" style="background:#764ba2">Slide 2</div>
      <div class="slide" style="background:#f093fb">Slide 3</div>
    </body></html>`
  },

  // 3. PPT垂直布局（10屏，大内容）
  {
    name: 'PPT垂直布局(10屏大内容)',
    mode: 'optimize',
    html: `<!DOCTYPE html><html><head><meta charset="UTF-8"><style>
      body{margin:0;font-family:sans-serif}
      .slide{height:100vh;display:flex;flex-direction:column;align-items:center;justify-content:center;font-size:32px;color:white;padding:40px}
      .slide h2{font-size:48px;margin-bottom:20px}
      .slide p{font-size:20px;max-width:600px;text-align:center}
    </style></head><body>
      ${Array(10).fill(0).map((_,i) => `
      <div class="slide" style="background:linear-gradient(135deg,hsl(${i*36},70%,50%),hsl(${i*36+40},70%,50%))">
        <h2>第${i+1}页标题</h2>
        <p>这是第${i+1}页的内容描述文字，用于测试多页PPT布局的PDF生成效果，确保分页位置合理。</p>
      </div>`).join('')}
    </body></html>`
  },

  // 4. 海报/单页长图
  {
    name: '海报/长图(单页不分页)',
    mode: 'continuous',
    html: `<!DOCTYPE html><html><head><meta charset="UTF-8"><style>
      body{margin:0;padding:40px;font-family:sans-serif;background:linear-gradient(135deg,#667eea,#764ba2);color:white;min-height:3000px}
      h1{font-size:64px;text-align:center;margin-bottom:40px}
      .card{background:rgba(255,255,255,0.15);border-radius:16px;padding:30px;margin:20px 0}
    </style></head><body>
      <h1>活动海报</h1>
      ${Array(20).fill(0).map((_,i) => `
      <div class="card">
        <h3>活动项目 ${i+1}</h3>
        <p>详细描述文字内容...</p>
      </div>`).join('')}
    </body></html>`
  },

  // 5. 混合内容（卡片+文字+表格）
  {
    name: '混合内容(卡片/表格)',
    mode: 'optimize',
    html: `<!DOCTYPE html><html><head><meta charset="UTF-8"><style>
      body{font-family:system-ui;margin:40px;line-height:1.6}
      .card{border:1px solid #ddd;border-radius:8px;padding:20px;margin:16px 0;background:#f8fafc}
      table{width:100%;border-collapse:collapse;margin:20px 0}
      th,td{border:1px solid #ddd;padding:12px;text-align:left}
      th{background:#2563eb;color:white}
    </style></head><body>
      <h1>数据报告</h1>
      <p>这是一份包含表格和卡片的综合报告文档。</p>
      <div class="card"><h3>关键指标</h3><p>收入: ¥1,234,567 | 增长: +23%</p></div>
      <table>
        <tr><th>月份</th><th>收入</th><th>支出</th><th>利润</th></tr>
        ${Array(12).fill(0).map((_,i) => `<tr><td>${i+1}月</td><td>${100000+i*5000}</td><td>${80000+i*3000}</td><td>${20000+i*2000}</td></tr>`).join('')}
      </table>
      <div class="card"><h3>总结</h3><p>本季度整体表现良好，各项指标稳步提升。</p></div>
    </body></html>`
  },

  // 6. 用户自定义 @media print
  {
    name: '用户自定义@media print',
    mode: 'print',
    html: `<!DOCTYPE html><html><head><meta charset="UTF-8"><style>
      body{font-family:system-ui;margin:40px}
      @media print {
        h1 { color: red !important; page-break-after: avoid }
        .no-break { page-break-inside: avoid }
      }
    </style></head><body>
      <h1>打印专用样式测试</h1>
      <div class="no-break" style="background:#f0f0f0;padding:20px">
        <p>这个区域设置了 page-break-inside: avoid，不应该被分页切断</p>
        <p>更多内容...</p>
      </div>
      <p>${Array(20).fill('这是一段长文字，用于测试分页效果。').join('')}</p>
    </body></html>`
  },

  // 7. 宽内容（超过A4宽度）
  {
    name: '宽内容(>A4自动缩放)',
    mode: 'optimize',
    html: `<!DOCTYPE html><html><head><meta charset="UTF-8"><style>
      body{font-family:system-ui;margin:20px}
      .wide{width:1200px;background:linear-gradient(90deg,#667eea,#764ba2);padding:40px;color:white}
    </style></head><body>
      <div class="wide">
        <h1>宽内容测试</h1>
        <p>这个div宽度为1200px，超过A4宽度，PDF应该自动缩放适配</p>
      </div>
    </body></html>`
  },

  // 8. 背景图片和颜色
  {
    name: '背景色/渐变保留',
    mode: 'optimize',
    html: `<!DOCTYPE html><html><head><meta charset="UTF-8"><style>
      body{margin:0;font-family:sans-serif}
      .hero{background:linear-gradient(135deg,#667eea,#764ba2);color:white;padding:100px 40px;text-align:center}
      .section1{background:#f0fdf4;padding:60px 40px}
      .section2{background:linear-gradient(45deg,#f093fb,#f5576c);color:white;padding:60px 40px}
      .section3{background:#fef3c7;padding:60px 40px}
    </style></head><body>
      <div class="hero"><h1>背景色测试</h1><p>所有背景色和渐变都应该保留</p></div>
      <div class="section1"><h2>绿色区域</h2><p>内容...</p></div>
      <div class="section2"><h2>渐变区域</h2><p>内容...</p></div>
      <div class="section3"><h2>黄色区域</h2><p>内容...</p></div>
    </body></html>`
  }
];

console.log('📊 HTML to PDF 全面测试 v2.0\n' + '='.repeat(70));
for (const t of tests) {
  const r = await test(t.name, t.html, t.mode);
  const status = r.ok ? '✅' : '❌';
  const info = r.ok ? `${r.mode} | ${r.pages}页 | ${r.size}KB | ${(r.t/1000).toFixed(1)}s` : `错误: ${r.error}`;
  console.log(`${status} ${t.name.padEnd(28)} ${info}`);
}
console.log('='.repeat(70));
console.log('\n🎯 测试完成！');
