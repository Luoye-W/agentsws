# WP314 广告上传表生成与校验（docs/101 §5.1②、§5.4；决策 552 / 553）

worktree `../agentsws-wt/wp314-adsheets` · 分支 `wp/314-adsheets`。先读 `_common.md`、`docs/101`（§2、§3、§5）、`docs/57`、`packages/ads-core`（`spec.ts`、`AD_COPY_FORBIDDEN` 等）。

## 要做
1. `ads-core` 新增：Google 批量上传 CSV、Meta 导入表（Excel 与可粘贴文字两种），覆盖新建广告系列 / 广告组 / 广告 / 关键词、改预算、暂停 / 启用。列名、格式照两家官方帮助（docs/101 附链接），写清出处。
2. 本地校验：字数、必填列、文案禁用词、**新建一律写成已暂停**（Google 状态列留空默认是启用，必须写死暂停，553）、预算改动不超 docs/57 额度；一次改 3 条以上走上传表（552）。
3. 改前 / 改后对比（给审批卡用的白话一句话摘要 + 表格预览数据）。
4. 解析两家导出文件（含 Meta 的 `< >` 前缀），为读回核对与看数据（WP315）用；Editor 列名对照表。
5. 纯函数 + 测试（手写最小样例，不放任何真实账户数据）。

## 纪律
不读 .env*；不碰 key / token；不打开真实广告后台；不连远程机器；不跑批量清理。不合 main、不打 tag、不发版。

## 验证
`scripts/verify-changed.sh` + 模拟三包 × stub/direct/dsh + gen 检查 + 装包前冒烟；报告 `docs/briefs/reports/WP314.md`（决策号从 610 起）。
