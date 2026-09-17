#!/usr/bin/env bash
# 默认值扫描（docs/42 §1 ④bis，WP70 撞出来的那个洞）。
#
#   scripts/scan-default-flips.sh <owner/repo> <旧 ref> <新 ref> [子路径] [输出 md]
#   例：scripts/scan-default-flips.sh deepseek-ai/deepseek-harness dsh-v0.1.6-alpha.1 dsh-v0.1.7-alpha.1 packages
#
# 为什么要有这一步：`.d.ts` 的 diff **看不见默认值**。`enabled?: boolean` 前后一模一样，
# 改的是 `z.boolean().default(false)` → `.default(true)`，而那行在上游的 `src/` 里、
# 不在发布出来的 `lib/types/` 里。WP70 就是这样差点漏掉一条"把整条会话日志上报给模型厂商"
# 的开关（docs/39 §3.3 d）。所以每次升级都要**单独扫一遍源码里的默认值**。
#
# 它只产出事实（哪些 `.default(` / `default:` 的行变了），不判断。
# 红线（docs/42 红线 7）：凡是"默认打开的出网 / 上报 / 遥测"，一律在 profiles/agentsws
# 的 patch 层显式关掉并加一条测试钉住；不许靠"我们的组合里碰巧没装它"当保证。
#
# 克隆不下来（私有仓 / 没 tag / 没网）不算失败：输出里会写明"**没扫成**"，
# 让 issue 上的人知道这一步要人工补，而不是以为扫过了什么都没有。

set -uo pipefail

REPO="${1:?用法: scan-default-flips.sh <owner/repo> <旧 ref> <新 ref> [子路径] [输出 md]}"
OLD_REF="${2:?缺旧 ref}"
NEW_REF="${3:?缺新 ref}"
SUBPATH="${4:-}"
OUT="${5:-/dev/stdout}"

TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

say() { printf '%s\n' "$*" >>"$TMP/report.md"; }

clone_ref() {
  local ref="$1" dest="$2"
  git -c advice.detachedHead=false clone --depth 1 --quiet --branch "$ref" "https://github.com/${REPO}.git" "$dest" 2>"$TMP/err-$ref.log"
}

say "### ④bis 默认值扫描（docs/42）"
say ""
say "\`${REPO}\`：\`${OLD_REF}\` → \`${NEW_REF}\`${SUBPATH:+（只看 \`${SUBPATH}\`）}"
say ""

if ! clone_ref "$OLD_REF" "$TMP/old" || ! clone_ref "$NEW_REF" "$TMP/new"; then
  say "❌ **没扫成**：两个 tag 至少有一个克隆不下来。"
  say ""
  say '```'
  cat "$TMP"/err-*.log 2>/dev/null | head -20 >>"$TMP/report.md"
  say '```'
  say ""
  say "> 这一步**必须有人补做**（docs/42 ④bis），否则这次升级的默认值翻转是盲区："
  say "> \`.d.ts\` 的 diff 看不见 \`.default()\`，测试全绿也照样漏。"
  cat "$TMP/report.md" >"$OUT"
  exit 0
fi

OLD_DIR="$TMP/old${SUBPATH:+/$SUBPATH}"
NEW_DIR="$TMP/new${SUBPATH:+/$SUBPATH}"
if [ ! -d "$OLD_DIR" ] || [ ! -d "$NEW_DIR" ]; then
  say "❌ **没扫成**：子路径 \`${SUBPATH}\` 在其中一个 tag 里不存在（上游改了目录结构？）。"
  cat "$TMP/report.md" >"$OUT"
  exit 0
fi

# 只看默认值那几行。`-r` 递归，`-x` 把编译产物与锁文件挡在外面（lib/ 里的 default
# 是编译出来的同一件事，重复列只会把报告淹掉）。
# 用 `-u -U0` 是为了留住**文件名**：一堆没有出处的 `.default(true)` 没法复核，
# 而 docs/42 红线 6 要求每条判断都有出处。
diff -r -u -U0 \
  -x node_modules -x dist -x lib -x '*.map' -x '*.lock' -x 'pnpm-lock.yaml' -x '.git' \
  "$OLD_DIR" "$NEW_DIR" 2>/dev/null >"$TMP/raw.diff"

awk -v pre="$TMP/new/" '
  /^\+\+\+ / {
    file = $2
    if (index(file, pre) == 1) file = substr(file, length(pre) + 1)
    next
  }
  /^[-+]/ {
    if ($0 ~ /^(\+\+\+|---)/) next
    line = $0
    # schema 的 .default(…) 到处都算；裸 default: 只在源码里算（README 散文里太多）
    if (line ~ /\.default\(/ || (file ~ /\.(ts|tsx|js|mjs|cjs)$/ && line ~ /[^a-zA-Z_]default:/)) {
      gsub(/[ \t]+/, " ", line)
      mark = substr(line, 1, 1)
      rest = substr(line, 2)
      sub(/^ /, "", rest)
      # 排序键放文件名在前：同一处的旧 / 新两行才会挨着
      print file "\t" mark "\t" rest
    }
  }
' "$TMP/raw.diff" \
  | sort -u \
  | awk -F'\t' '{ print $2 " " $1 ": " $3 }' >"$TMP/flips.txt"
# 输出把 -/+ 放回行首：GitHub 的 ```diff 只看行首那个字符才上色，
# 而文件名不能丢（docs/42 红线 6：出处不许空）。

# 整个文件新增 / 消失也要看一眼：新包里一个默认打开的开关，在 diff 里是 "Only in"，不是 +/-
grep -E '^Only in ' "$TMP/raw.diff" \
  | sed -e "s#Only in ${TMP}/old/#只在旧的里有：#" -e "s#Only in ${TMP}/new/#只在新的里有：#" \
  | sort -u >"$TMP/onlyin.txt" || true
ONLY=$(wc -l <"$TMP/onlyin.txt" | tr -d ' ')

COUNT=$(wc -l <"$TMP/flips.txt" | tr -d ' ')

if [ "$COUNT" = "0" ]; then
  say "✅ 两个 tag 的源码里，\`.default(\` / \`default:\` 的行**一条都没变**。"
else
  say "⚠️ **${COUNT} 行默认值有变化**（\`-\` = 旧，\`+\` = 新；冒号前是文件）："
  say ""
  say '```diff'
  head -200 "$TMP/flips.txt" >>"$TMP/report.md"
  say '```'
  if [ "$COUNT" -gt 200 ]; then
    say ""
    say "（只列了前 200 行，全量见 workflow 的 artifact）"
  fi
  say ""
  say "逐条问一遍：**它是不是一个出网 / 上报 / 遥测开关？默认从关翻成开了吗？**"
  say "是的话按 docs/42 红线 7，在 \`profiles/agentsws\` 的 patch 层显式关掉，并加一条测试钉住。"
fi

if [ "$ONLY" != "0" ]; then
  say ""
  say "<details><summary>整个文件新增 / 消失（${ONLY} 处，默认值也可能藏在这里）</summary>"
  say ""
  say '```'
  head -60 "$TMP/onlyin.txt" >>"$TMP/report.md"
  say '```'
  say ""
  say "</details>"
fi

say ""
say "> 扫的是**源码**不是 npm 包：npm 包里只有编译产物，schema 的 default 看不到。"

cat "$TMP/report.md" >"$OUT"
cp "$TMP/flips.txt" "$(dirname "$OUT")/default-flips-raw.txt" 2>/dev/null || true
exit 0
