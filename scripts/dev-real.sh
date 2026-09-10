#!/usr/bin/env bash
# 1d 真账号验收：本机起 OpenConnector（加固）+ 服务进程（SQLite 落盘）+ 工作台。
# 凭据在工作台"连接"页的原生表单里自己填，不经 AI、不进日志。
#
# 两种起法：
#   scripts/dev-real.sh                      本机档：node 直接跑服务进程（改代码即时生效）
#   scripts/dev-real.sh --compose            公司档：docker compose 起同一套（验镜像与部署）
#   scripts/dev-real.sh --compose postgres s3  再换上 Postgres 与 MinIO（验双方言与对象存储）
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
DATA_DIR="${AGENTSWS_DATA_DIR:-$HOME/Library/Application Support/agentsws-dev}"
ENV_FILE="$DATA_DIR/.env.local"
PORT="${AGENTSWS_PORT:-4317}"
OC_PORT="${AGENTSWS_CONNECT_PORT:-3000}"
OC_NAME="agentsws-openconnector"

# --compose：走 docker-compose.yml 那一档（40 §1.3 公司 Docker 档 / 41 §2.1）。
# 与默认的本机档跑的是**同一个服务进程**，差别只在谁来起它、数据落在哪。
# 后面可以再跟 profile：`--compose postgres`、`--compose postgres s3`。
COMPOSE=0
PROFILES=""
if [ "${1:-}" = "--compose" ]; then
  COMPOSE=1
  shift
  for p in "$@"; do PROFILES="$PROFILES --profile $p"; done
fi

if [ "$COMPOSE" = "1" ]; then
  cd "$ROOT"
  if [ ! -f .env ]; then
    cp deploy/nas/env.example .env
    sh deploy/nas/gen-keys.sh >> .env
    chmod 600 .env
    echo "已生成 .env（600 权限）：$ROOT/.env —— 密钥只生成这一次，别再跑第二遍"
  fi
  # shellcheck disable=SC2086
  docker compose $PROFILES up -d --build
  echo "等服务进程起来…"
  for _ in $(seq 1 90); do
    code=$(curl -s -o /dev/null -w '%{http_code}' "http://127.0.0.1:${PORT}/v1/health" || true)
    [ "$code" = "200" ] && break
    sleep 2
  done
  if [ "${code:-}" != "200" ]; then
    echo "起不来，看日志：docker compose logs --tail=200 server" >&2
    docker compose ps >&2
    exit 1
  fi
  echo "工作台：http://127.0.0.1:${PORT}   连接页：http://127.0.0.1:${PORT}/connections"
  echo "数据目录（宿主）：$(grep -E '^AGENTSWS_HOST_DATA_DIR=' .env | cut -d= -f2-)"
  echo "停：docker compose $PROFILES down"
  exit 0
fi

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

# 代理 fake-IP 模式（Clash / Surge 的 198.18.0.0/15）会把外网域名解析成保留段地址，
# OpenConnector 的出站防护会把它当内网拦下（"must not resolve to private or reserved IP"）。
# 实测容器加 --dns 也绕不开（代理在系统层劫持了 DNS），所以检测到就给一份常见 SaaS 域名白名单；
# 可用 AGENTSWS_CONNECT_TRUSTED_HOSTS 覆盖（逗号分隔，前导点表示整个子域，如 .myshopify.com）。
FAKE_IP_TRUSTED=".myshopify.com,.shopify.com,api.deepseek.com,.openai.com,.anthropic.com,.zoho.com,.google.com,.googleapis.com,.qq.com,.163.com,.126.com,.aliyun.com,.mxhichina.com,.outlook.com,.office365.com,.microsoft.com,.feishu.cn,.larksuite.com,.dingtalk.com"
OC_TRUST_ARGS=""
if getent hosts api.deepseek.com 2>/dev/null | grep -qE '^198\.1[89]\.' || dscacheutil -q host -a name api.deepseek.com 2>/dev/null | grep -qE 'ip_address: 198\.1[89]\.'; then
  : "${AGENTSWS_CONNECT_TRUSTED_HOSTS:=$FAKE_IP_TRUSTED}"
  echo "检测到代理 fake-IP：连接器出站白名单 = $AGENTSWS_CONNECT_TRUSTED_HOSTS"
fi
[ -n "${AGENTSWS_CONNECT_TRUSTED_HOSTS:-}" ] && OC_TRUST_ARGS="-e OOMOL_CONNECT_EGRESS_TRUSTED_HOSTS=${AGENTSWS_CONNECT_TRUSTED_HOSTS}"
# 服务进程也要看得到这份名单（连接页 runtime 状态里的 egress.trusted_hosts）
export AGENTSWS_CONNECT_TRUSTED_HOSTS

# 真账号环境打开 Shopify 官方 Dev MCP（npx 拉 @shopify/dev-mcp，版本钉在服务进程里）；默认服务进程不起它
export AGENTSWS_SHOPIFY_DEVMCP="${AGENTSWS_SHOPIFY_DEVMCP:-1}"

# OpenConnector：加固三件套；只绑 127.0.0.1
if ! docker ps --format '{{.Names}}' | grep -qx "$OC_NAME" || [ "${AGENTSWS_CONNECT_RECREATE:-0}" = "1" ]; then
  docker rm -f "$OC_NAME" >/dev/null 2>&1 || true
  # shellcheck disable=SC2086
  docker run -d --name "$OC_NAME" -p "127.0.0.1:${OC_PORT}:3000" $OC_TRUST_ARGS \
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
