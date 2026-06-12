# HTML可视化编辑器 - 生产环境
# 基于 Node.js + Chromium 提供 HTML 编辑和 PDF 导出服务

# ====== 依赖安装阶段 ======
FROM node:20-alpine AS deps

WORKDIR /app

# 复制包文件
COPY package.json package-lock.json* ./

# 安装生产依赖
RUN npm ci --only=production 2>/dev/null || npm install --only=production

# ====== 生产运行阶段 ======
FROM node:20-alpine AS runner

# 安装 Chromium 及中文字体依赖
RUN apk add --no-cache \
    chromium \
    nss \
    freetype \
    harfbuzz \
    ca-certificates \
    ttf-freefont \
    wqy-zenhei \
    font-noto-cjk \
    && rm -rf /var/cache/apk/*

# 设置 Chromium 路径环境变量（Alpine chromium 包路径）
ENV CHROME_PATH=/usr/bin/chromium-browser
ENV CHROMIUM_FLAGS="--no-sandbox --disable-gpu --disable-dev-shm-usage --font-render-hinting=none"

# 创建非 root 用户
RUN addgroup --system --gid 1001 nodejs && \
    adduser --system --uid 1001 appuser

WORKDIR /app

# 复制依赖
COPY --from=deps --chown=appuser:nodejs /app/node_modules ./node_modules

# 复制应用代码
COPY --chown=appuser:nodejs package.json ./
COPY --chown=appuser:nodejs server.js ./
COPY --chown=appuser:nodejs index.html ./
COPY --chown=appuser:nodejs app.js ./
COPY --chown=appuser:nodejs styles.css ./
COPY --chown=appuser:nodejs install.sh ./

# 创建临时目录
RUN mkdir -p /app/.tmp && chown appuser:nodejs /app/.tmp

# 切换到非 root 用户
USER appuser

# 暴露端口
EXPOSE 8000

# 设置环境变量
ENV NODE_ENV=production
ENV PORT=8000
ENV HOST=0.0.0.0

# 启动服务
CMD ["node", "server.js"]
