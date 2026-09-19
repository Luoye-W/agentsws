#!/usr/bin/env bash
# 用 Kiro CLI 跑一张派工单。用法：scripts/kiro-wp.sh docs/briefs/WP116-xxx.md <worktree-dir> <branch>
#
# 工具信任档由环境变量 KIRO_TRUST 决定，**没有默认的"全部免确认"**：
#   KIRO_TRUST=all            → --trust-all-tools（无人值守，Kiro 可不经确认执行任何命令；须由 Luoye 明确同意）
#   KIRO_TRUST=<工具名,逗号分隔> → --trust-tools=…（只信这几样）
#   不设                       → 交互模式，Kiro 每次用工具都问人（须在真终端里跑）
set -euo pipefail
export PATH="$HOME/.local/bin:$PATH"
brief="$1"; wt="$2"; branch="$3"
root="$(cd "$(dirname "$0")/.." && pwd)"
[ -d "$wt" ] || git -C "$root" worktree add "$wt" -b "$branch" main
wt="$(cd "$wt" && pwd)"   # 转绝对路径：下面要 cd，相对路径会失效
prompt="$(cat "$root/docs/briefs/_common.md"; echo; echo '---'; echo; cat "$root/$brief")"
cd "$wt"
args=(chat)
[ -n "${KIRO_MODEL:-}" ] && args+=(--model "$KIRO_MODEL")
case "${KIRO_TRUST:-}" in
  all) args+=(--no-interactive --trust-all-tools) ;;
  "")  ;;
  *)   args+=(--no-interactive "--trust-tools=${KIRO_TRUST}") ;;
esac
if [ -n "${KIRO_TRUST:-}" ]; then
  exec kiro-cli "${args[@]}" "$prompt" > "$wt/KIRO.log" 2>&1
else
  exec kiro-cli "${args[@]}" "$prompt"
fi
