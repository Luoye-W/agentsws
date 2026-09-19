#!/usr/bin/env bash
# 用 Kiro CLI 无人值守跑一张派工单。用法：scripts/kiro-wp.sh docs/briefs/WP116-xxx.md <worktree-dir> <branch>
set -euo pipefail
export PATH="$HOME/.local/bin:$PATH"
brief="$1"; wt="$2"; branch="$3"
root="$(cd "$(dirname "$0")/.." && pwd)"
[ -d "$wt" ] || git -C "$root" worktree add "$wt" -b "$branch" main
prompt="$(cat "$root/docs/briefs/_common.md"; echo; echo '---'; echo; cat "$root/$brief")"
cd "$wt"
exec kiro-cli chat --no-interactive --trust-all-tools ${KIRO_MODEL:+--model "$KIRO_MODEL"} "$prompt" > "$wt/KIRO.log" 2>&1
