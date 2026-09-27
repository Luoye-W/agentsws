# WP158 接 Search Console 与 Google Analytics 4 的真实读数

worktree `../agentsws-wt/wp158-gsc-ga4` · 分支 `wp/158-gsc-ga4`（从 main 新起）。先读 `_common.md`、`docs/briefs/reports/WP154.md`（「要 Luoye 定」第 1 条：现在连上只显示「读数那一步还没接」）、
`packages/seo-core`、`apps/server/src` 里 WP154 的 SEO 服务（每日 08:00 读 GSC）、`packages/connect-adapter`（OpenConnector 适配器，provider 目录与 action 调用）、`packages/contracts/src/connection-directory.ts`（`gsc` / `search_console`、`ga4`）、`packages/deck/src/blocks.ts`（`GSC_BLOCKS` / `GA4_BLOCKS`、`sources.ts`）、WP46 的 live-data（上游出问题保留上一份缓存那套）。

## Luoye 09-27 定
Search Console 和 Google Analytics 要接。

## 要做
1. **查清 OpenConnector 上这两家的 provider 与 action**（v1.6.5，本机 Docker 有镜像；用官方文档 / 镜像里的 provider 定义，**不连真 Google**）：授权方式（OAuth，哪几个 scope，只要只读）、有哪些读 action、参数与返回形状、配额与限流。写进 `docs/82-GSC与GA4读数-v1.md`。
2. **GSC 读数**：`searchAnalytics.query` 这一类——按日期 / 查询 / 页面 / 国家 / 设备取点击、曝光、点击率、平均排名；站点列表（让用户选哪个站点属性，域名属性与网址前缀属性都支持）；可选：网址检查（收录状态，给「没被收录」那条信号用）。WP154 的六个信号改从真数据算（上周 vs 前一周、近 28 天等窗口照 seo-core 现有定义）。
3. **GA4 读数**：Data API `runReport`——按落地页取会话、转化（购买 / 关键事件）、收入；属性列表让用户选。WP154 的「按页面点击 / 订单 / 收入」在接了 GA4 时补上转化率与 GA4 口径收入（Shopify `landing_site` 那条照旧是主口径，两者并排、写明口径）。
4. **缓存与失败**：照 WP46——按天缓存；上游失败保留上一份 + 一条人话事件；配额用尽说人话；**OAuth token 只在连接器里，不进我们的库、日志、事件、模型**。
5. **面板与卡**：连上但没选站点 / 属性时出一张「选一下哪个站点」的小卡（一句话 + 下拉），选了立刻刷新；报表块 GSC / GA4 数字变真。
6. **测试**（全替身、不联网）：用照官方文档示例截的响应做替身；六个信号在真形状数据上的计算；窗口与时区；失败保留缓存；token 守卫。

## 纪律
不连真 Google、不用真账号；不跑批量清理命令；不读 .env*；不部署。本机常驻连接器容器（agentsws-openconnector，端口 3000）**别动**；要起 runtime 看 provider 就另起一个自己命名的容器、用完只删它自己。截图 demo 端口 4448。Luoye 的本机服务在 4317，别碰。

## 验证（审核方全量用）
`vitest run packages/connect-adapter packages/seo-core packages/deck apps/server apps/workstation` + fast 模拟两个包三个运行时。
