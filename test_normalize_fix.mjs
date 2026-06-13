import { readFileSync } from 'fs';

const html = readFileSync('/data/gloria-cloud/html-editor/.tmp/pdf-5f25ce8a-7d45-4442-9db9-68d490c50740.html', 'utf-8');

console.log('原始HTML中 @media print 存在:', html.includes('@media print'));
console.log('原始HTML中 @page 存在:', html.includes('@page'));

// 模拟normalizeHtmlForPdf的关键步骤
let processed = html;

// Step 8: 移除 @media print
processed = processed.replace(/@media\s+print\s*\{[\s\S]*?\}\s*(?=\s*<\/style>|\s*@media|\s*<\/head>|\s*$)/gi, '');
processed = processed.replace(/@page\s*\{[\s\S]*?\}\s*/gi, '');

console.log('处理后 @media print 存在:', processed.includes('@media print'));
console.log('处理后 @page 存在:', processed.includes('@page'));

// 检查是否还有body background: transparent
console.log('处理后 body background:transparent 存在:', /body\s*\{[^}]*background\s*:\s*transparent/i.test(processed));

// 保存处理后的HTML供进一步测试
// 查找<style>标签并检查
const styleMatches = processed.match(/<style[^>]*>[\s\S]*?<\/style>/gi) || [];
console.log('\\n剩余<style>标签数量:', styleMatches.length);

// 检查.background相关CSS变量是否保留
const hasGradient = processed.includes('linear-gradient') || processed.includes('radial-gradient');
console.log('渐变样式保留:', hasGradient);

// 检查.slide样式是否保留（不被@media print覆盖）
const slideMinHeight = processed.match(/\.slide\s*\{[^}]*min-height[^}]*\}/gi);
console.log('.slide min-height 规则:', slideMinHeight ? slideMinHeight[0] : '未找到');
