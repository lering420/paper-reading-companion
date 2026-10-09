#!/bin/bash
# 论文伴读 — macOS 启动脚本
cd "$(dirname "$0")"
if [ -x "runtime/mac/bin/node" ]; then
  "runtime/mac/bin/node" app/server.js
elif command -v node >/dev/null 2>&1; then
  node app/server.js
else
  echo ""
  echo "  [错误] 未找到 Node.js 运行环境。"
  echo "  请先安装 Node.js（brew install node），或使用包含 runtime 目录的完整应用文件夹。"
  echo ""
  read -r -p "  按回车退出..."
fi
