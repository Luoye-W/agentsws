#!/usr/bin/env bash
# 审核一个任务包分支：在其 worktree 里跑构建 / lint / 测试 / 覆盖率，并列出改动范围与越界文件。
# 用法：scripts/review-wp.sh <worktree-dir> <package-dir>   例：scripts/review-wp.sh ../agentsws-wt/wp1-kernel packages/kernel
set -uo pipefail
WT="$1"; PKG="$2"
cd "$WT"
echo "== branch: $(git rev-parse --abbrev-ref HEAD) @ $(git rev-parse --short HEAD)"
echo "== commits since main:"; git log --oneline main..HEAD | head -20
echo "== changed files outside $PKG (should be only pnpm-lock.yaml):"
git diff --name-only main..HEAD | grep -vE "^$PKG/" || echo "  (none)"
echo "== diff stat:"; git diff --stat main..HEAD | tail -3
echo "== install"; pnpm install --silent 2>&1 | grep -vE '^\s*$' | tail -2
echo "== tsc"; ./node_modules/.bin/tsc -b --force 2>&1 | tail -5; echo "tsc exit=$?"
echo "== biome"; ./node_modules/.bin/biome check "$PKG" 2>&1 | grep -E 'Checked|Found|×' | head -5
echo "== vitest"; ./node_modules/.bin/vitest run "$PKG" --coverage.enabled --coverage.include="$PKG/src/**" --coverage.reporter=text 2>&1 | grep -E 'Test Files|Tests |All files|FAIL|×|src/' | head -40
