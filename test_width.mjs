const resp = await fetch('http://localhost:3100/api/html-to-pdf', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ 
    html: `<!DOCTYPE html><html><head><meta charset="UTF-8"><style>
body{margin:0;padding:0;font-family:sans-serif}
.container{width:1360px;margin:0 auto;padding:40px;background:#f0f0f0}
.card{background:white;border-radius:12px;padding:30px;margin-bottom:20px;box-shadow:0 4px 20px rgba(0,0,0,0.1)}
</style></head><body>
<div class="container">
<h1>宽内容测试 (1360px)</h1>
${Array(5).fill(0).map((_,i) => `<div class="card"><h2>卡片 ${i+1}</h2><p>测试内容占位文字。</p></div>`).join('')}
</div>
</body></html>`, 
    filename: 'width_test', 
    pdfMode: 'print'
  }),
  signal: AbortSignal.timeout(60000)
});
const buf = await resp.arrayBuffer();
console.log('Status:', resp.status, 'Mode:', resp.headers.get('X-PDF-Mode'), 'Pages:', resp.headers.get('X-PDF-Pages'), 'Size:', (buf.byteLength/1024).toFixed(1) + 'KB');
