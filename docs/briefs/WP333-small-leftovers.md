# WP333 四件小遗留：FAQ 金额不降级（700）、个人微信卡片链接（584）、库存告急数（633）、客服起草用品牌语气

worktree `../agentsws-wt/wp333-leftovers` · 分支 `wp/333-leftovers`。先读 `_common.md`、`docs/briefs/reports/WP322.md`（700）、`docs/briefs/reports/WP311.md`（584）、`docs/briefs/reports/WP319.md`（633）、`packages/support-core/src/draft.ts` 与 `packages/social-core/src/voice.ts`（VoiceCard）。

## 要做（各自独立，分开提交）
1. **700**（Luoye 同意）：从表格导入的 FAQ 知识卡，答案里带金额时不按「状态词」降成历史案例；订单号、物流状态等照旧降。
2. **584**（Luoye 同意）：个人微信卡片里的链接 `/cards/<卡号>` 现在落到首页——补一个能直接定位到那张卡的页面（工作台路由），并带品牌（照 WP311 的 `?brand=`）。
3. **633**（Luoye 同意）：首页 / 独立站「店铺管理」面板的库存告急数，经店铺管理授权读库存（`read_inventory`），读不到照实显示没连、不显示 0。
4. **客服起草用上品牌语气**（10-14 盘点发现的老问题）：客服回信起草带上品牌的 VoiceCard（与社媒一致的 `voicePrompt`），没设置语气卡就照旧。
5. 每件都有测试。

## 纪律
不读 .env*；不碰 key / token；不连真实店铺；不连远程机器；不碰本机 4317；不跑批量清理；不用 pkill。界面少字。不合 main、不打 tag、不发版。测试用 `--maxWorkers=2 --testTimeout=120000`。

## 验证
`scripts/verify-changed.sh`（LC_ALL=en_US.UTF-8）+ 模拟三包 × stub/direct/dsh + gen 检查 + 装包前冒烟；报告 `docs/briefs/reports/WP333.md`（决策号 785–789）。
