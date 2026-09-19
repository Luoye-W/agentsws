#!/usr/bin/env bash
# 用 Qwen Code（百炼模型）无人值守跑交接板上的一条。用法：scripts/qwen-wp.sh <WP编号> <brief路径或"-"> <worktree目录> <分支>
# 完成标志：分支上出现 docs/briefs/reports/<WP>.md。断了自动续（新会话，靠 git 状态接着干）；额度 / 鉴权类错误立刻停。
#   QWEN_MODEL（默认 qwen3.8-max）  QWEN_APPROVAL（默认 auto：分类器放行安全动作、拦危险动作；Luoye 明确同意后可设 yolo）
#   QWEN_MAX_ROUNDS（默认 25）
set -uo pipefail
wp="$1"; brief="$2"; wt="$3"; branch="$4"
root="$(cd "$(dirname "$0")/.." && pwd)"
[ -d "$wt" ] || git -C "$root" worktree add "$wt" -b "$branch" main
wt="$(cd "$wt" && pwd)"; log="$wt/QWEN.log"; report="$wt/docs/briefs/reports/$wp.md"
prompt="$(cat "$root/docs/briefs/_common.md"; echo; echo '---'; echo "你负责交接板上的 $wp。先读 $root/docs/briefs/HANDOFF.md（规矩与该条的补充要求），"; [ "$brief" != "-" ] && echo "再读派工单 $root/$brief 并逐条照办。"; echo "你已经在它的 worktree（$wt，分支 $branch）里。先 git status / git log --oneline main..HEAD 看做到哪了（可能有上一位留下的 wip 半成品，未验证），git merge main，pnpm install，scripts/verify-changed.sh 看红在哪，然后接着干到完。勤提交。做完写报告 docs/briefs/reports/$wp.md 并提交，再把主仓 HANDOFF.md 里这一条的状态改成「待审」。不要提问。")"
cd "$wt"; : > "$log"; n=0
while [ ! -f "$report" ] && [ "$n" -lt "${QWEN_MAX_ROUNDS:-40}" ]; do
  n=$((n+1)); echo "=== [qwen-wp] 第 $n 轮 $(date '+%F %T') ===" >> "$log"
  qwen --approval-mode "${QWEN_APPROVAL:-yolo}" -m "${QWEN_MODEL:-qwen3.8-max}" "$prompt" < /dev/null >> "$log" 2>&1 || true
  if tail -n 15 "$log" | grep -qiE "invalid.?api.?key|unauthorized|not authenticated"; then
    echo "=== [qwen-wp] 鉴权问题，停 ===" >> "$log"; exit 3; fi
  # 额度用完：不退出，每 10 分钟探一次；Luoye 一点「重置」就自己接着干（这一轮不计入轮数）
  if tail -n 15 "$log" | grep -qiE "quota|insufficient|arrearage|limit reached|rate.?limit|429"; then
    echo "=== [qwen-wp] 额度 / 限流，10 分钟后再试 $(date '+%T') ===" >> "$log"; n=$((n-1)); sleep 600; continue; fi
  # 空转保险：连续两轮既没有新提交、也没有新改动，就停（别空烧额度）
  sig="$(git rev-parse HEAD 2>/dev/null)-$(git status --short | grep -v 'QWEN.log' | shasum | cut -c1-12)"
  if [ "$sig" = "${last_sig:-}" ]; then idle=$(( ${idle:-0} + 1 )); else idle=0; fi; last_sig="$sig"
  if [ "${idle:-0}" -ge 2 ]; then echo "=== [qwen-wp] 连续两轮没有任何产出，停 ===" >> "$log"; exit 4; fi
  sleep 15
done
[ -f "$report" ]
