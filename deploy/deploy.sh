#!/usr/bin/env bash
# ECS 上的一键部署脚本（幂等，可反复执行）
#
#   sudo bash deploy/deploy.sh
#
# 可选环境变量：
#   STOCK_TOOL_TOKEN=xxx       指定访问口令，未设置则首次运行时自动生成
#   ALLOW_INSTALL_DOCKER=1     未安装 Docker 时自动安装（默认只提示后退出）
set -euo pipefail

REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
COMPOSE_FILE="$REPO_DIR/deploy/docker-compose.yml"
ENV_FILE="$REPO_DIR/deploy/.env"

log() { printf '\n=== %s ===\n' "$*"; }

[ "$(id -u)" -eq 0 ] || { echo "请用 root 或 sudo 运行本脚本"; exit 1; }
[ -f "$COMPOSE_FILE" ] || { echo "找不到 $COMPOSE_FILE"; exit 1; }

log "检查 Docker"
if ! command -v docker >/dev/null 2>&1; then
  if [ "${ALLOW_INSTALL_DOCKER:-0}" != "1" ]; then
    cat <<'EOF'
未安装 Docker。确认后可用下面任一方式安装，再重新运行本脚本：

  # 官方脚本 + 阿里云镜像源（ECS 上更快）
  curl -fsSL https://get.docker.com | bash -s -- --mirror Aliyun
  systemctl enable --now docker

或设置 ALLOW_INSTALL_DOCKER=1 让本脚本自动完成安装。
EOF
    exit 1
  fi
  log "安装 Docker（阿里云镜像源）"
  curl -fsSL https://get.docker.com | bash -s -- --mirror Aliyun
  systemctl enable --now docker
fi
docker compose version >/dev/null 2>&1 || {
  echo "缺少 docker compose 插件（需要 docker-compose-plugin）"; exit 1; }

log "准备访问口令"
if [ ! -f "$ENV_FILE" ]; then
  TOKEN="${STOCK_TOOL_TOKEN:-$(head -c 18 /dev/urandom | base64 | tr -d '/+=' | head -c 24)}"
  printf 'STOCK_TOOL_TOKEN=%s\n' "$TOKEN" > "$ENV_FILE"
  chmod 600 "$ENV_FILE"
  echo "已写入 $ENV_FILE（口令请自行留存）"
fi
TOKEN="$(grep -E '^STOCK_TOOL_TOKEN=' "$ENV_FILE" | cut -d= -f2- || true)"

log "构建并启动容器"
docker compose -f "$COMPOSE_FILE" up -d --build

log "等待健康检查"
for i in $(seq 1 45); do
  if curl -fsS -m 5 http://127.0.0.1:8000/api/health >/dev/null 2>&1; then
    echo "服务已就绪（第 ${i} 次探测）"
    break
  fi
  if [ "$i" -eq 45 ]; then
    echo "健康检查超时，查看日志：docker compose -f $COMPOSE_FILE logs --tail 80"
    exit 1
  fi
  sleep 2
done

log "完成"
cat <<EOF
容器状态：  docker compose -f $COMPOSE_FILE ps
实时日志：  docker compose -f $COMPOSE_FILE logs -f
访问口令：  ${TOKEN:-（空，表示不校验）}

接下来把下面两段并入 dodomogu.com 的 server 块（若已有该 server 块，切勿整段覆盖）：
    location = /stock { return 301 /stock/; }
    location /stock/ {
        proxy_pass http://127.0.0.1:8000/;
        proxy_set_header Host \$host;
        proxy_set_header X-Real-IP \$remote_addr;
        proxy_set_header X-Forwarded-Proto \$scheme;
    }

然后：sudo nginx -t && sudo systemctl reload nginx
访问：https://dodomogu.com/stock/?token=${TOKEN:-}
EOF
