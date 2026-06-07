#!/bin/bash
# ============================================
# HTML Editor - 一键安装部署脚本
# 在 Mac 上运行此脚本即可完成安装
# ============================================

set -e

INSTALL_DIR="$HOME/html-editor"
REPO_URL="https://github.com/gloriagulei-design/html-editor"

echo "=========================================="
echo "  🚀 HTML 编辑器安装程序"
echo "=========================================="
echo ""

# 1. 检查 git
if ! command -v git &> /dev/null; then
    echo "⚠️ 未检测到 git，正在安装..."
    if command -v brew &> /dev/null; then
        brew install git
    else
        echo "❌ 请先安装 Homebrew: https://brew.sh"
        exit 1
    fi
fi

# 2. 创建安装目录
echo "📁 创建安装目录: $INSTALL_DIR"
mkdir -p "$INSTALL_DIR"
cd "$INSTALL_DIR"

# 3. 克隆或更新仓库
if [ -d "$INSTALL_DIR/.git" ]; then
    echo "🔄 更新现有仓库..."
    git pull origin main || true
else
    echo "📥 从 GitHub 克隆代码..."
    echo "提示: 需要输入您的 GitHub Personal Access Token 作为密码"
    git clone "$REPO_URL" . || {
        echo ""
        echo "⚠️ 克隆失败，尝试创建本地仓库..."
        git init
        git remote add origin "$REPO_URL"
    }
fi

# 4. 检查文件是否存在
if [ ! -f "index.html" ]; then
    echo ""
    echo "⚠️ 未检测到网页文件，请手动下载："
    echo "   访问 $REPO_URL"
    echo "   下载 index.html, styles.css, app.js 到 $INSTALL_DIR"
    echo ""
fi

# 5. 创建一键推送脚本
cat > "$INSTALL_DIR/push.sh" << 'EOF'
#!/bin/bash
# HTML Editor - 一键推送到 GitHub
cd "$(dirname "$0")"

echo "=========================================="
echo "  📤 推送到 GitHub"
echo "=========================================="

# 检查修改
if git diff --quiet && git diff --cached --quiet; then
    echo "ℹ️ 没有检测到修改"
    read -p "是否强制提交？ (y/N): " force
    if [[ ! "$force" =~ ^[Yy]$ ]]; then
        echo "取消推送"
        exit 0
    fi
fi

# 添加、提交、推送
git add -A
echo ""
echo "💾 修改的文件:"
git status --short
echo ""

read -p "输入提交信息 (直接回车使用默认): " msg
msg=${msg:-"更新: $(date '+%Y-%m-%d %H:%M:%S')"}

git commit -m "$msg" || true
echo ""
echo "📤 推送到 GitHub..."
git push origin main
echo ""
echo "✅ 推送完成！"
echo "📍 部署地址: https://gloriagulei-design.github.io/html-editor"
echo "⏱️  大约 1-2 分钟后生效"
EOF

chmod +x "$INSTALL_DIR/push.sh"

# 6. 创建本地启动脚本
cat > "$INSTALL_DIR/start.sh" << 'EOF'
#!/bin/bash
# HTML Editor - 本地启动脚本
cd "$(dirname "$0")"

echo "🚀 启动 HTML 编辑器..."
echo "📂 目录: $(pwd)"
echo ""

# 尝试用 python3 启动
if command -v python3 &> /dev/null; then
    PORT=${1:-8080}
    echo "🌐 打开浏览器访问: http://localhost:$PORT"
    echo "按 Ctrl+C 停止服务"
    echo ""
    python3 -m http.server $PORT
# 尝试用 php
elif command -v php &> /dev/null; then
    PORT=${1:-8080}
    echo "🌐 打开浏览器访问: http://localhost:$PORT"
    echo "按 Ctrl+C 停止服务"
    echo ""
    php -S localhost:$PORT
else
    echo "⚠️ 未找到本地服务器工具"
    echo "请直接用浏览器打开文件: $(pwd)/index.html"
fi
EOF

chmod +x "$INSTALL_DIR/start.sh"

# 7. 完成
echo ""
echo "=========================================="
echo "  ✅ 安装完成！"
echo "=========================================="
echo ""
echo "📂 安装目录: $INSTALL_DIR"
echo ""
echo "📋 可用命令:"
echo ""
echo "  1️⃣  本地预览:"
echo "      cd ~/html-editor"
echo "      ./start.sh"
echo ""
echo "  2️⃣  一键推送到 GitHub (自动部署):"
echo "      cd ~/html-editor"
echo "      ./push.sh"
echo ""
echo "  3️⃣  手动编辑文件:"
echo "      用任意文本编辑器打开 ~/html-editor/ 下的文件"
echo ""
echo "🔗 GitHub 仓库: $REPO_URL"
echo "🌐 在线地址: https://gloriagulei-design.github.io/html-editor"
echo ""
echo "=========================================="
