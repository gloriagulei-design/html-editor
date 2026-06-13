---
name: html-to-pdf-converter
description: "将HTML报告定稿转换为超长单页矢量PDF。基于super-long-pdf.mjs（Puppeteer），自动展开动画元素、隐藏导航装饰、输出1页矢量PDF。触发词：'转PDF'、'生成PDF'、'导出PDF'、'HTML转PDF'。"
version: 2.0.0
metadata:
  hermes:
    tags: [pdf, html2pdf, 超长单页, 矢量PDF, puppeteer, 诊断报告, 交付]
    related_skills: [html-report-builder, report-quality-checker, report-workflow-orchestrator]
---

# HTML to PDF Converter — 超长单页PDF生成器

将HTML报告定稿转换为**超长单页矢量PDF**（文字可选中/可搜索）。

## 适用Phase

**Phase 7：HTML→PDF交付**

## 触发条件

当用户说：
- "转PDF"
- "生成PDF"
- "导出PDF"
- "HTML转PDF"
- "帮我把xxx.html转成PDF"
- 或Phase 6质量验证已通过，用户要求生成PDF

## 输入

| 参数 | 类型 | 必需 | 说明 |
|------|------|------|------|
| `report_html` | file | 是 | HTML报告定稿文件（Phase 6验证通过） |
| `output_pdf` | string | 否 | 输出PDF路径（默认与HTML同目录同名.pdf） |
| `bg_color` | string | 否 | 底部filler颜色（默认`rgb(10,3,26)`，封面深蓝色） |

## 输出

- 矢量PDF文件（1页超长单页，文字可选中/可搜索）
- PDF元数据验证报告（页数、尺寸、文字可选中确认）

## 核心工具

### super-long-pdf.mjs（首选工具 ⭐⭐⭐）

- **路径**：`/projects/super-long-pdf.mjs`
- **用法**：`node /projects/super-long-pdf.mjs "输入.html" "输出.pdf"`
- **原理**：Puppeteer渲染→测量高度→`page.pdf()`生成矢量PDF
- **输出特征**：

| 特征 | 值 | 说明 |
|------|-----|------|
| 页数 | 1页 | 超长单页（所有slide拼接） |
| 宽度 | 1920px | 对应1920px视口 |
| 高度 | 动态计算 | = 所有slide高度之和 |
| 文字 | 可选中/可搜索 | 矢量PDF（非图片级） |
| 背景色 | 完整保留 | -webkit-print-color-adjust:exact |

### fanhi-html-to-pdf（备选工具 ⭐⭐）

- **路径**：`/projects/scripts/html-to-pdf.mjs`
- **用法**：`node /projects/scripts/html-to-pdf.mjs "输入.html" "输出.pdf"`
- **注意**：输出**图片级PDF**（文字不可选中），仅特定场景使用

## 工作流

### Step 1：前置检查（3项必须全部通过）

```
✅ 检查1: HTML文件存在且可读
✅ 检查2: HTML包含@media print CSS
✅ 检查3: HTML包含.ani类标记（动画元素）
```

**检查@media print CSS**：
- 读取HTML文件，搜索`@media print`
- 若缺失，**自动注入标准@media print CSS**后再生成PDF
- 标准模板见下方"必须包含的@media print CSS"

**检查.ani类**：
- 读取HTML文件，搜索`class=.*ani`
- 若有动画元素未标记.ani，列出清单提醒用户

### Step 2：确认Chromium环境

```
Chrome路径: /root/.cache/puppeteer/chrome/linux-127.0.6533.88/chrome-linux64/chrome
中文字体: Noto Sans CJK（需yum安装google-noto-sans-cjk-ttc-fonts）
```

若Chrome不存在，需先安装puppeteer：
```bash
cd /projects && npm install puppeteer-core
```

### Step 3：执行PDF生成

```bash
node /projects/super-long-pdf.mjs "输入.html" "输出.pdf"
```

**执行过程中的关键步骤**（super-long-pdf.mjs内部自动完成）：

1. Puppeteer启动Chrome（1920×1080视口）
2. 打开HTML文件（file://协议，确保字体加载完整）
3. 等待3秒（字体+canvas加载完成）
4. 注入JS：强制所有`.ani`元素 → `opacity:1 + animation:none + transform:none`
5. 注入JS：隐藏粒子canvas / 导航点 / 进度条
6. 测量完整内容高度（scrollHeight）
7. 添加2px filler消除底部白色缝隙
8. 调用`page.pdf()`生成矢量PDF
9. pdf-lib验证页数=1

### Step 4：PDF质量验证

生成后自动进行以下验证：

| 验证项 | 方法 | 通过标准 |
|--------|------|---------|
| 页数=1 | pdf-lib读取 | getPageCount() === 1 |
| 宽度≈1440pt | pdf-lib读取 | 1440±10pt |
| 高度合理 | pdf-lib读取 | > 500pt（至少1个slide高度） |
| 文件非空 | 文件大小 | > 10KB |

### Step 5：人工确认

**铁律：必须经人工确认才能交付！**

1. 向用户报告PDF生成结果（页数、尺寸、文件大小）
2. 等待用户预览确认
3. 用户明确回复"确认交付"→流程结束
4. 用户指出问题→返回Phase 5/6修复→重新生成PDF

## 必须包含的@media print CSS

> ⚠️ HTML生成阶段（Phase 5）就必须按此规范编写！
> 若Phase 7发现缺失，自动补入后再生成。

```css
@media print {
  @page { margin: 0; }
  body {
    background: transparent;
    -webkit-print-color-adjust: exact;
    print-color-adjust: exact;
    overflow: visible !important;
  }
  html { overflow: visible !important; }
  .slide {
    page-break-after: auto;       /* 不强制分页（超长单页核心） */
    page-break-inside: avoid;     /* slide内不分页 */
    break-inside: avoid;
    width: 100% !important;       /* 宽度自适应 */
    min-height: auto !important;  /* 高度由内容撑开 */
    height: auto !important;
    overflow: visible !important;  /* 内容溢出可见 */
    box-sizing: border-box !important;
  }
  #particle-canvas, .dots, .prog { display: none !important; }
  .ani {
    opacity: 1 !important;
    animation: none !important;
    transform: none !important;
  }
}
```

**关键原则解释**：
- `page-break-after: auto` — 不强制分页，让所有slide连续排列（超长单页核心）
- `break-inside: avoid` — 单个slide内部不被切断
- `overflow: visible` — 让内容完全展开，不被截断
- `.ani`三件套 — `opacity:1 + animation:none + transform:none` 缺一不可

## 已知问题与解决方案（经验沉淀）

| # | 问题 | 根因 | 解决方案 | 状态 |
|---|------|------|---------|------|
| 1 | 页面方向竖版→横版 | PDF默认A4竖版 | 设置width/height为内容实际尺寸 | ✅ |
| 2 | 上下空白过多 | 固定页面尺寸与内容不匹配 | 动态计算contentHeight | ✅ |
| 3 | 蓝底黄条截断条纹 | scrollIntoView对齐不精确 | page.pdf()原生渲染（无截图拼接） | ✅ |
| 4 | 浅色背景标题不显示 | scrollIntoView参数问题 | page.pdf()方案规避 | ✅ |
| 5 | 动画元素PDF不可见 | .ani初始opacity:0 | 强制opacity:1+animation:none+transform:none | ✅ |
| 6 | 内容不一致 | 跳过HTML重新绘制 | 必须基于HTML原版渲染（铁律） | ✅ |
| 7 | 漏页 | 截图拼接时slide遗漏 | page.pdf()一次渲染全部内容 | ✅ |
| 8 | 图片级PDF文字不可选 | fanhi-html-to-pdf输出图片 | super-long-pdf.mjs输出矢量PDF | ✅ |
| 9 | 底部白色缝隙 | Chromium渲染器bug | 2px filler技巧 | ✅ |
| 10 | 字体未加载 | Web字体异步加载 | 等待3秒+document.fonts.ready | ✅ |

## 铁律

1. **必须基于HTML原版渲染** — 绝不跳过HTML重新绘制PDF（内容一致性铁律）
2. **PDF是超长单页** — 不是16:9分页模式，所有slide连续拼接
3. **动画元素必须强制可见** — .ani三件套缺一不可
4. **@media print CSS必须存在** — 缺失则自动补入
5. **必须人工确认** — AI不能自行判断PDF效果合格
6. **矢量PDF优先** — 文字可选中/可搜索，优先使用super-long-pdf.mjs

## 依赖

- 工具: `/projects/super-long-pdf.mjs`（Puppeteer超长单页PDF生成器）
- 工具: `/projects/scripts/html-to-pdf.mjs`（备选，图片级PDF）
- 依赖: `puppeteer-core` + `pdf-lib`
- 依赖: Chrome/Chromium（`/root/.cache/puppeteer/chrome/...`）
- 依赖: 中文字体（`google-noto-sans-cjk-ttc-fonts`）
- 输入: `report.html`（来自Phase 6验证通过版）
- 知识库: `topic/report-workflow.md`
- 知识库: `topic/html-to-pdf.md`