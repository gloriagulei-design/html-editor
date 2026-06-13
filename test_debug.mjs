const resp = await fetch('http://localhost:3100/api/html-to-pdf', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ 
    html: '<!DOCTYPE html><html><head><meta charset="UTF-8"><style>body{margin:0;height:3000px;background:linear-gradient(red,blue)}</style></head><body></body></html>', 
    filename: 'debug_simulated', 
    pdfMode: 'simulated',
    pdfWidth: 'auto'
  }),
  signal: AbortSignal.timeout(60000)
});
console.log('Status:', resp.status);
console.log('Mode:', resp.headers.get('X-PDF-Mode'));
console.log('Pages:', resp.headers.get('X-PDF-Pages'));
const buf = await resp.arrayBuffer();
console.log('Size:', buf.byteLength);
