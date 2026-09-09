#!/usr/bin/env bash
# 1d 真账号验收：本机起 OpenConnector（加固）+ 服务进程（SQLite 落盘）+ 工作台。
# 凭据在工作台"连接"页的原生表单里自己填，不经 AI、不进日志。
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
DATA_DIR="${AGENTSWS_DATA_DIR:-$HOME/Library/Application Support/agentsws-dev}"
ENV_FILE="$DATA_DIR/.env.local"
PORT="${AGENTSWS_PORT:-4317}"
OC_PORT="${AGENTSWS_CONNECT_PORT:-3000}"
OC_NAME="agentsws-openconnector"
mkdir -p "$DATA_DIR"

# 密钥只生成一次，落在 600 权限文件里；不打印、不进 git
if [ ! -f "$ENV_FILE" ]; then
  umask 077
  cat > "$ENV_FILE" <<EOT
OOMOL_CONNECT_ENCRYPTION_KEY=$(openssl rand -hex 32)
OOMOL_CONNECT_ADMIN_TOKEN=$(openssl rand -hex 24)
AGENTSWS_SECRETS_KEY=$(openssl rand -hex 32)
AGENTSWS_SESSION_KEY=$(openssl rand -hex 32)
EOT
  echo "已生成本机密钥：$ENV_FILE（600 权限）"
fi
set -a; . "$ENV_FILE"; set +a

# OpenConnector：加固三件套；只绑 127.0.0.1
if ! docker ps --format '{{.Names}}' | grep -qx "$OC_NAME"; then
  docker rm -f "$OC_NAME" >/dev/null 2>&1 || true
  docker run -d --name "$OC_NAME" -p "127.0.0.1:${OC_PORT}:3000" \
    -e "OOMOL_CONNECT_ENCRYPTION_KEY=$OOMOL_CONNECT_ENCRYPTION_KEY" \
    -e "OOMOL_CONNECT_ADMIN_TOKEN=$OOMOL_CONNECT_ADMIN_TOKEN" \
    -e "OOMOL_CONNECT_BLOCKED_PROXIES=*" \
    -v "$DATA_DIR/openconnector:/data" \
    ghcr.io/oomol-lab/open-connector:latest >/dev/null
  echo "OpenConnector 已起：http://127.0.0.1:${OC_PORT}"
fi
for i in $(seq 1 30); do
  code=$(curl -s -o /dev/null -w '%{http_code}' -H "Authorization: Bearer $OOMOL_CONNECT_ADMIN_TOKEN" "http://127.0.0.1:${OC_PORT}/api/connections" || true)
  [ "$code" = "200" ] && break; sleep 1
done

# 构建一次（工作台 + 服务进程）
if [ "${SKIP_BUILD:-0}" != "1" ]; then
  (cd "$ROOT" && ./node_modules/.bin/tsc -b && pnpm --filter @agentsws/workstation exec vite build >/dev/null)
fi

echo "工作台：http://127.0.0.1:${PORT}   连接页：http://127.0.0.1:${PORT}/connections"
echo "数据目录：$DATA_DIR   Ctrl-C 退出"
cd "$ROOT"
AGENTSWS_DATA_DIR="$DATA_DIR" \
AGENTSWS_STATIC_DIR="$ROOT/apps/workstation/dist" \
AGENTSWS_CONNECT_URL="http://127.0.0.1:${OC_PORT}" \
OOMOL_CONNECT_BLOCKED_PROXIES="*" \
AGENTSWS_PORT="$PORT" \
AGENTSWS_OWNER_EMAIL="${AGENTSWS_OWNER_EMAIL:-owner@localhost}" \
exec node apps/server/dist/index.js
