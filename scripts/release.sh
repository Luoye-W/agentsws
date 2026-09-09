#!/usr/bin/env bash
# 发版：对齐版本号 → 生成 CHANGELOG 骨架 → 提交 → 打 tag。**不推**，最后一步永远由人做。
#
#   scripts/release.sh 0.1.0-alpha          正式跑
#   scripts/release.sh 0.1.0-alpha --dry-run  只看会改什么，不写文件、不提交
#
# 没用 changesets：那要多一个未批准依赖，而这个仓所有包都是 private、不发 npm，
# 版本号是「整仓一个」，最小方案就够（34 §1：契约 / 实现 / 模拟一起改版本）。
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

VERSION="${1:-}"
DRY_RUN=0
[ "${2:-}" = "--dry-run" ] && DRY_RUN=1

die() { echo "release: $*" >&2; exit 1; }
step() { echo; echo "== $*"; }

[ -n "$VERSION" ] || die "用法：scripts/release.sh <version> [--dry-run]（例：0.1.0-alpha）"
# semver：主.次.补 + 可选的 -预发布 + 可选的 +构建元数据
echo "$VERSION" | grep -qE '^[0-9]+\.[0-9]+\.[0-9]+(-[0-9A-Za-z.-]+)?(\+[0-9A-Za-z.-]+)?$' \
  || die "不是合法的 semver：$VERSION"

TAG="v$VERSION"
git rev-parse -q --verify "refs/tags/$TAG" >/dev/null && die "tag 已存在：$TAG"

step "前置检查"
BRANCH="$(git rev-parse --abbrev-ref HEAD)"
[ "$BRANCH" = "main" ] || echo "  注意：当前在 $BRANCH，不是 main"
if [ -n "$(git status --porcelain)" ]; then
  [ "$DRY_RUN" = 1 ] || die "工作区不干净，先提交或 stash"
  echo "  工作区不干净（dry-run 忽略）"
fi
echo "  版本 $VERSION  tag $TAG  分支 $BRANCH  @ $(git rev-parse --short HEAD)"

# 与 CI 同样的顺序、同样的命令。发版前再全跑一遍，谁也不例外。
if [ "${SKIP_CHECKS:-0}" != "1" ]; then
  step "install";  pnpm install --frozen-lockfile
  step "tsc";      pnpm exec tsc -b --force
  step "biome";    pnpm exec biome check .
  step "vitest";   pnpm exec vitest run
  step "simulate（合并门禁）"
  pnpm -s simulate --tier fast --pack packs/dtc-3c-3p \
    --scenario 'scenarios/**/*.yml' --seed 42 | tail -3
else
  echo "  SKIP_CHECKS=1，跳过全仓验证（只在已经手动跑过时用）"
fi

step "对齐版本号"
# 根 package.json 与全部工作区包写同一个版本（整仓一个版本号）
MANIFESTS=$(git ls-files 'package.json' 'packages/*/package.json' 'apps/*/package.json' 'role-packs/*/package.json')
for m in $MANIFESTS; do echo "  $m"; done
if [ "$DRY_RUN" = 0 ]; then
  VERSION="$VERSION" node -e '
    const fs = require("node:fs")
    const version = process.env.VERSION
    for (const file of process.argv.slice(1)) {
      const raw = fs.readFileSync(file, "utf8")
      const eol = raw.endsWith("\n") ? "\n" : ""
      const pkg = JSON.parse(raw)
      pkg.version = version
      fs.writeFileSync(file, JSON.stringify(pkg, null, 2) + eol)
    }
  ' $MANIFESTS
fi

step "CHANGELOG"
PREV_TAG="$(git describe --tags --abbrev=0 2>/dev/null || true)"
RANGE="${PREV_TAG:+$PREV_TAG..}HEAD"
echo "  自 ${PREV_TAG:-仓库起点} 起的提交："
git log --no-merges --pretty='  %s' "$RANGE" | head -40

if grep -q "^## $VERSION " CHANGELOG.md 2>/dev/null || grep -q "^## \[\?$VERSION" CHANGELOG.md 2>/dev/null; then
  echo "  CHANGELOG.md 里已有 $VERSION 一节，保持原样（人写的比机器归纳的好）"
else
  echo "  CHANGELOG.md 里没有 $VERSION，插入一节骨架，**发版前请手工整理成人话**"
  if [ "$DRY_RUN" = 0 ]; then
    {
      awk '/^---$/{ if (!done) { print; done=1; exit } } { print }' CHANGELOG.md
      echo
      echo "## $VERSION — $(date +%Y-%m-%d)"
      echo
      echo "<!-- 下面是从 git log 自动列的，发版前请归纳成「新增 / 修复 / 移除 / 已知未做」 -->"
      echo
      git log --no-merges --pretty='- %s' "$RANGE"
      awk 'BEGIN{done=0} /^---$/{ if (!done) { done=1; next } } done { print }' CHANGELOG.md
    } > CHANGELOG.md.new
    mv CHANGELOG.md.new CHANGELOG.md
  fi
fi

if [ "$DRY_RUN" = 1 ]; then
  step "dry-run 结束，什么都没改"
  exit 0
fi

step "提交并打 tag"
git add -A -- CHANGELOG.md $MANIFESTS
git commit -s -m "chore(release): $VERSION"
git tag -a "$TAG" -m "$TAG"

cat <<EOT

发版提交与 tag 已在本地建好：$(git rev-parse --short HEAD)  $TAG

**没有推送**。确认无误后自己推：

    git push origin $BRANCH
    git push origin $TAG

然后在 GitHub 上按 CHANGELOG 的这一节建 release。
EOT
