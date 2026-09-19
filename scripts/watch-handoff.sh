#!/usr/bin/env bash
# 盯交接板：发现有「待审」的单（主仓或任一 worktree 的 HANDOFF.md，或分支上出现新的报告文件）就退出并打印，
# 由此唤醒审核方。纯 shell 轮询，不花模型额度。已审过的记在 .git/fable-reviewed（不进库）。
root="$(cd "$(dirname "$0")/.." && pwd)"; seen="$root/.git/fable-reviewed"; touch "$seen"
while :; do
  hits=""
  for f in "$root/docs/briefs/HANDOFF.md" "$root"/../agentsws-wt/*/docs/briefs/HANDOFF.md; do
    [ -f "$f" ] || continue
    while IFS= read -r line; do
      wp="$(echo "$line" | grep -oE 'WP[0-9]+[a-z]?' | head -1)"
      [ -n "$wp" ] && ! grep -qx "$wp" "$seen" && hits="$hits$wp（交接板标了待审）\n"
    done < <(grep -E '\|\s*待审\s*\|' "$f")
  done
  for r in "$root"/../agentsws-wt/*/docs/briefs/reports/WP*.md /Users/yeluo/Documents/agentsws-extension/REPORT*.md; do
    [ -f "$r" ] || continue
    wp="$(basename "$r" .md | grep -oE 'WP[0-9]+[a-z]?' | head -1)"
    [ -n "$wp" ] && ! grep -qx "$wp" "$seen" && ! echo -e "$hits" | grep -q "^$wp" && hits="$hits$wp（出现了报告 $r）\n"
  done
  if [ -n "$hits" ]; then echo -e "待审：\n$hits"; exit 0; fi
  sleep 120
done
