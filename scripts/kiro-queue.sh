#!/usr/bin/env bash
# 排队跑派工单：同时最多 KIRO_PARALLEL（默认 3）张，跑完一张自动补下一张。
# Kiro 对同一账号的并发会话会限流（并发 6 张时每张 40 分钟断 8–13 次），所以别开多。
# 用法：scripts/kiro-queue.sh <队列文件>    队列文件每行：<brief 路径> <worktree 目录> <分支>
# 注意：有单在跑时不要改 kiro-wp.sh / 本脚本（bash 边读边执行）。
set -uo pipefail
root="$(cd "$(dirname "$0")/.." && pwd)"
cd "$root"
grep -vE '^\s*(#|$)' "$1" | xargs -P "${KIRO_PARALLEL:-3}" -L 1 bash -c '
  echo "[queue] $(date "+%T") 开始 $0"
  scripts/kiro-wp.sh "$0" "$1" "$2" && echo "[queue] $(date "+%T") 完成 $0" || echo "[queue] $(date "+%T") 未完成 $0（续跑次数用尽，看它的 KIRO.log）"
'
echo "[queue] 队列跑完"
