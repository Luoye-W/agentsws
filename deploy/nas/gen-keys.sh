#!/usr/bin/env sh
# 生成本机密钥，追加到 .env。**只跑一次**——重新生成会让已存的凭据与已加密的个人数据读不出来。
#
#   sh deploy/nas/gen-keys.sh >> .env && chmod 600 .env
#
# 四把钥匙分别是什么：
#   OOMOL_CONNECT_ENCRYPTION_KEY  连接器凭据库的加密密钥（08）
#   OOMOL_CONNECT_ADMIN_TOKEN     服务进程调连接器管理面的令牌
#   AGENTSWS_SECRETS_KEY          本机加密库（连接页填的密码就存在它下面，13 §4.3）
#   AGENTSWS_SESSION_KEY          会话 cookie 的签名密钥（20 §3）
#   AGENTSWS_DATA_KEY             主体密钥的根密钥（21 §4）：有它，库文件泄漏 ≠ 明文泄漏
set -eu

rand() {
  if command -v openssl >/dev/null 2>&1; then
    openssl rand -hex "$1"
  else
    # 群晖 / 威联通的精简系统里不一定有 openssl
    od -An -tx1 -N "$1" /dev/urandom | tr -d ' \n'
  fi
}

echo "OOMOL_CONNECT_ENCRYPTION_KEY=$(rand 32)"
echo "OOMOL_CONNECT_ADMIN_TOKEN=$(rand 24)"
echo "AGENTSWS_SECRETS_KEY=$(rand 32)"
echo "AGENTSWS_SESSION_KEY=$(rand 32)"
echo "AGENTSWS_DATA_KEY=$(rand 32)"
