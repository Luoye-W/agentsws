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
if [ -z "${KIRO_TRUST:-}" ]; then
  exec kiro-cli "${args[@]}" "$prompt"
fi
# 无人值守：Kiro 服务端偶尔断线（dispatch failure），断了就接着同一个会话续跑；
# 以 worktree 根出现 REPORT.md 为完成标志，最多续 ${KIRO_MAX_RESUMES:-60} 次。
# KIRO_CONTINUE=1：这个 worktree 里已有一轮中断的会话，别从头开始，直接续。
if [ -z "${KIRO_CONTINUE:-}" ]; then
  : > "$wt/KIRO.log"
  kiro-cli "${args[@]}" "$prompt" >> "$wt/KIRO.log" 2>&1 || true
fi
n=0
while [ ! -f "$wt/REPORT.md" ] && [ "$n" -lt "${KIRO_MAX_RESUMES:-60}" ]; do
  # 额度用尽 / 未登录这类重试也没用的错，立刻停，别空转
  if tail -n 12 "$wt/KIRO.log" | grep -qE "Monthly request limit reached|Not logged in|limits reset on"; then
    echo "=== [kiro-wp] Kiro 额度用尽或未登录，停止续跑 ===" >> "$wt/KIRO.log"; exit 3
  fi
  n=$((n+1)); sleep 20
  echo "=== [kiro-wp] 第 $n 次续跑 $(date '+%F %T') ===" >> "$wt/KIRO.log"
  kiro-cli "${args[@]}" --resume "上一轮因为网络中断停了。接着干：先 git status / git log 看自己做到哪了，再按派工单继续，直到写出 REPORT.md。" >> "$wt/KIRO.log" 2>&1 || true
done
[ -f "$wt/REPORT.md" ]
