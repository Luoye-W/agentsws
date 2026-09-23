#!/usr/bin/env bash
# 只验证「这次改动影响到的部分」。给并行干活的实现代理用：快、限流、不抢 CPU。
# 全量验证（tsc --force + 全部测试 + 模拟门禁）只在合并关口由审核方串行跑一次。
#
# 用法：scripts/verify-changed.sh [对比基准，默认 main]
#   VERIFY_WORKERS=2   vitest 并发进程上限（默认 2）
set -uo pipefail
base="${1:-main}"
workers="${VERIFY_WORKERS:-2}"
cd "$(git rev-parse --show-toplevel)"
fail=0
step() { echo; echo "=== $1"; shift; nice -n 10 "$@" || { echo "✗ 失败：$*"; fail=1; }; }

# 1. 类型检查：增量（不带 --force），只重编受影响的工程
step "tsc（增量）" npx tsc -b

# 1bis. 依赖升级时的补丁（WP132 撞出来的洞）：增量 `tsc -b` 只看**源码**有没有变，
#   node_modules 里上游 `.d.ts` 变了它照样判"最新"——dsh 0.1.7 那次 dsh-adapter 实际有 14 处
#   类型错误，`tsc -b` 退出码却是 0。所以锁文件一动，就对"package.json 也动了"的那几个工程
#   单独做一次全量类型检查（`-p … --noEmit` 不产物、不连带 references，比 `--force` 便宜得多）。
changed_all="$( { git diff --name-only "$base"...HEAD; git diff --name-only; } | sort -u )"
if echo "$changed_all" | grep -qx 'pnpm-lock.yaml'; then
  for d in $(echo "$changed_all" | grep -E '^(packages|apps|profiles)/[^/]+/package\.json$' | xargs -n1 dirname 2>/dev/null); do
    [ -f "$d/tsconfig.json" ] && step "tsc（依赖变了，全量查 $d）" npx tsc -p "$d" --noEmit
  done
fi

# 2. 代码规范：只查相对基准改过的文件
step "biome（只查改动）" npx biome check --changed --since="$base" --no-errors-on-unmatched .

# 3. 测试：只跑「改过的包」自己的测试，并限制并发。
#    （vitest --changed 在本仓会因为某个包按目录路径引用资源而建图失败，所以按包选。
#     依赖它的下游包靠上面的增量 tsc 兜类型；行为回归留给合并关口的全量。）
pkgs="$( { git diff --name-only "$base"...HEAD; git diff --name-only; git ls-files --others --exclude-standard; } \
  | grep -E '^(packages|apps)/[^/]+/' | cut -d/ -f1-2 | sort -u \
  | while read -r d; do [ -d "$d/test" ] || ls "$d"/src/**/*.test.* >/dev/null 2>&1 && echo "$d"; done )"
if [ -z "$pkgs" ]; then
  echo; echo "=== vitest：没有改到带测试的包，跳过"
else
  # shellcheck disable=SC2086
  step "vitest（只跑改过的包：$(echo $pkgs | tr '\n' ' ')；并发 ≤ ${workers}）" \
    npx vitest run $pkgs --maxWorkers="$workers" --minWorkers=1 --testTimeout=120000 --passWithNoTests
fi

echo
[ "$fail" -eq 0 ] && echo "✓ 改动范围内全部通过（全量验证留给合并关口）" || echo "✗ 有失败，见上"
exit "$fail"
