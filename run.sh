#!/usr/bin/env bash
# 本地一键启动：首次运行会自动建虚拟环境并安装依赖。
set -euo pipefail
cd "$(dirname "$0")"

if [ ! -d .venv ]; then
  echo "==> 创建虚拟环境并安装依赖"
  uv venv --python 3.13 .venv
  uv pip install --python .venv/bin/python -r requirements.txt
fi

exec .venv/bin/python -m uvicorn app.main:app \
  --host 0.0.0.0 \
  --port "${PORT:-8000}" \
  --workers 1
