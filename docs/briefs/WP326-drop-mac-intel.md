# WP326 Mac 只出 Apple 芯片版，去掉 Intel（决策 731）

worktree `../agentsws-wt/wp326-nointel` · 分支 `wp/326-nointel`。先读 `_common.md`、WP292 发版流水线（`.github/workflows/release.yml`、`scripts/release-manifest.mjs`、`scripts/release-upload-r2.mjs` 及其测试）、官网下载页（`apps/site/src/lib/downloads.ts`、`apps/site/src/i18n/download.ts`、`apps/site/src/scripts/site.ts`、`apps/site/src/data/downloads.json`）、`docs/help/install-update*.md`、`apps/desktop/electron-builder.yml`。

## 要做
1. release.yml 去掉 macOS x64 作业；收拢步骤、`latest-mac.yml` 合并、`downloads.json` 生成只认 arm64；Intel 相关的自检不再要求。
2. 官网下载页、站内数据、教程（中英）不再列 Intel；用 Intel Mac 的访问者给一句「目前只支持 Apple 芯片的 Mac」。
3. 自动更新：已经装了 Intel 版的（只有测试机，无真实用户）不用迁移；`latest-mac.yml` 只含 arm64 时 Intel 客户端看到的是「没有适合你的更新」而不是报错——核对 electron-updater 行为并写进报告。
4. 测试跟着改（release-upload-r2、manifest、站点）。
5. 用 `gh workflow run release.yml` 的 dry-run 方式（若 workflow 支持 dry_run 输入）在**你的分支**上演练一次（本单允许 push 这个分支，不碰 main、不打 tag）。

## 纪律
不读 .env*；不碰 key / token；不上传 R2；不连远程机器；不碰本机 4317；不跑批量清理。不合 main、不打 tag、不发版（决策 381）。测试用 `--maxWorkers=2 --testTimeout=120000`。

## 验证
`scripts/verify-changed.sh`（LC_ALL=en_US.UTF-8）+ gen 检查 + 发版演练结果；报告 `docs/briefs/reports/WP326.md`（决策号 740–744）。
