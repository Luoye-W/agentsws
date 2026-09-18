#!/usr/bin/env bash
# 云侧冒烟检查（WP110）。装完、升级完、改完 DNS 之后各跑一次。
#
#   ./deploy/smoke.sh https://cloud.agentsws.com
#
# 它只用**公开**路由，不需要任何密钥——所以从你自己的笔记本上跑就行，
# 不用 SSH 进服务器。
#
# **默认不发任何真邮件。** 想连发信一起验（最容易出问题的就是这一步），
# 给一个你自己收得到的地址：
#
#   SMOKE_EMAIL=me@example.com ./deploy/smoke.sh https://cloud.agentsws.com
#
# 那会真发一封信到那个地址。限流是每邮箱 5 次 / 小时，别连着跑六遍。
set -uo pipefail

BASE="${1:-${SMOKE_BASE_URL:-}}"
if [ -z "$BASE" ]; then
  echo "用法：$0 <base-url>    例如 $0 https://cloud.agentsws.com" >&2
  exit 64
fi
BASE="${BASE%/}"

pass=0
fail=0

# 一次检查：说明、期望的状态码、路径、（可选）正文里必须出现的串、（可选）方法。
check() {
  local what="$1" want="$2" path="$3" needle="${4:-}" method="${5:-GET}"
  local body status
  body="$(curl -sS -m 15 -X "$method" -w $'\n%{http_code}' "$BASE$path" 2>&1)" || {
    printf '  ✗ %s（连不上：%s）\n' "$what" "${body//$'\n'/ }"
    fail=$((fail + 1))
    return
  }
  status="${body##*$'\n'}"
  body="${body%$'\n'*}"
  if [ "$status" != "$want" ]; then
    printf '  ✗ %s（期望 %s，实际 %s）\n' "$what" "$want" "$status"
    fail=$((fail + 1))
    return
  fi
  if [ -n "$needle" ] && [[ "$body" != *"$needle"* ]]; then
    printf '  ✗ %s（%s 里没有「%s」）\n' "$what" "$status" "$needle"
    fail=$((fail + 1))
    return
  fi
  printf '  ✓ %s\n' "$what"
  pass=$((pass + 1))
}

echo "冒烟：$BASE"

echo "① 活着没有"
check "health 回 200" 200 /v1/cloud/health '"status":"ok"'
check "首页在" 200 / 'agentsws 云'

echo "② 证书与安全头"
if [[ "$BASE" == https://* ]]; then
  headers="$(curl -sSI -m 15 "$BASE/v1/cloud/health" 2>&1)"
  for h in 'strict-transport-security' 'x-content-type-options' 'x-frame-options'; do
    if grep -qi "^$h" <<<"$headers"; then
      printf '  ✓ %s\n' "$h"
      pass=$((pass + 1))
    else
      printf '  ✗ 少了响应头 %s\n' "$h"
      fail=$((fail + 1))
    fi
  done
else
  echo "  · 跳过（不是 https，本地联调档）"
fi

echo "③ 登录落地页（不发信也能验）"
check "没带 token → 400 一句人话" 400 '/login' '不完整'
check "乱填 token → 401 同一句话" 401 '/login?token=cml_smoke_not_a_real_token' '用不了了'

echo "④ 管理口是关着的"
check "没带管理员令牌的充值被挡" 401 /v1/admin/topup '' POST
# 上面那条如果回 404，说明 AGENTSWS_CLOUD_ADMIN_TOKEN 没配（路由根本没挂）——
# 那不是错，只是发不了积分。所以单独提示一句：
if [ "$(curl -sS -m 15 -o /dev/null -w '%{http_code}' -X POST "$BASE/v1/admin/topup")" = "404" ]; then
  echo "  · 提示：/v1/admin/topup 不存在 = .env 里没配 AGENTSWS_CLOUD_ADMIN_TOKEN，发不了内测额度"
fi

echo "⑤ 模块与上游"
modules="$(curl -sS -m 15 "$BASE/v1/cloud/health" 2>/dev/null)"
for m in entry standby kol_public mail; do
  if [[ "$modules" == *"\"$m\":true"* ]]; then
    printf '  ✓ %s 挂上了\n' "$m"
    pass=$((pass + 1))
  else
    printf '  ✗ %s 没挂（health 里是 false 或没有这一格）\n' "$m"
    fail=$((fail + 1))
  fi
done
case "$modules" in
  *'"reachable":true'*) echo "  ✓ New API 通" ; pass=$((pass + 1)) ;;
  *'"reachable":false'*) echo "  ✗ New API 不通：先看 docker compose logs newapi" ; fail=$((fail + 1)) ;;
  *) echo "  · New API 状态 unknown（还没探过，等 30 秒再跑一次）" ;;
esac

echo "⑥ 发信"
if [ -n "${SMOKE_EMAIL:-}" ]; then
  out="$(curl -sS -m 30 -X POST "$BASE/v1/cloud/auth/magic-link" \
    -H 'content-type: application/json' \
    -d "{\"email\":\"$SMOKE_EMAIL\"}" -w $'\n%{http_code}' 2>&1)"
  code="${out##*$'\n'}"
  if [ "$code" = "200" ]; then
    echo "  ✓ 已发出一封信，去 $SMOKE_EMAIL 的收件箱看看（也看一眼垃圾箱）"
    pass=$((pass + 1))
  elif [ "$code" = "503" ]; then
    echo "  ✗ 信没发出去：SMTP 配错了。docker compose logs cloud 里有那一行"
    fail=$((fail + 1))
  elif [ "$code" = "429" ]; then
    echo "  · 这个邮箱这一小时已经发满 5 封了（限流在起作用，不算失败）"
  else
    echo "  ✗ magic-link 回了 $code"
    fail=$((fail + 1))
  fi
else
  echo "  · 跳过（没给 SMOKE_EMAIL）。真要验发信：SMOKE_EMAIL=你的邮箱 $0 $BASE"
fi

echo
echo "通过 $pass，失败 $fail"
[ "$fail" -eq 0 ]
