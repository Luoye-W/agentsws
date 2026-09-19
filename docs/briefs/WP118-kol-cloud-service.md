# WP118 付费三块 + 「红人营销增值服务」（云端同步与云端运行的地基）+ 充值四档

worktree：`../agentsws-wt/wp118-kol-cloud`，分支 `wp/118-kol-cloud`。

## Luoye 定（09-19，逐条照办）
- 付费分三块：① **数据接口**（YouTube API、Apify）；② **AI 使用**；③ **红人营销增值服务**。全部用积分。
- 第 ③ 块**不叫云端备份、也不只是备份**：它是为「红人营销以后**不依赖本地 Agents 工坊也能跑起来**」做准备——像 KOLAgents 那样数据在云端，区别只是**本地有一份、云端也有一份**。定价 **30 积分 / 月**（= ¥30 / 月）。
- **「云上没有商家业务内容」不是 Luoye 定的规则，作废**：用户要跑长程任务，数据与上下文不可避免要传到我们的云端。docs/21 等处凡以此为前提的表述一律改掉（改成：默认本地优先；用户开通云端服务后，相关业务数据与上下文会上云，按最小必要、传输与静态加密、可导出可删除来管）。**因此不做端到端加密 / 恢复口令那一套**——云端要能读数据才能替用户跑任务。
- 充值四档：**US$20 → 140 积分、US$50 → 350、US$100 → 700、US$200 → 1400**（1 美元 = 7 积分；1 积分仍 = ¥1）。

## 先读
`docs/49`、`docs/21`、`docs/41` §2（数据三档）、`docs/48` §5、`docs/64`、`docs/65`；`packages/metering/*`（`pricing.json`、`plans.json`、Wallet、WP115 的会员 term / cycle）、`packages/cloud-entry/*`（Stripe 充值）、`packages/kol-core/*`（红人 / 候选池 / 活动 / 合作 / 交付物 / 追踪链接 的存储）、`apps/server/src/{cloud.ts,cloud-account.ts}`、`apps/cloud-worker/*`、`apps/cloud-admin/*`、工作台「账号与积分」相关组件。
只读参考：`/Users/yeluo/Documents/KOLAgents/src/db/influencer.schema.ts`（它在云端存了哪些租户数据）。

## 交付
1. **三块分组**：`pricing.json` 每条能力加 `block: 'data' | 'ai' | 'kol_service'`（只加字段）。工作台「账号与积分」、用量明细、运营后台总览 / 用量页按三块分组（三张小卡：本月各花多少积分 + 次数 / token / 订阅状态）。
2. **充值四档**：价目数据化（`packages/metering/src/topup-tiers.json`：usd / credits），Stripe Checkout 按档创建（没配 Stripe 仍 501 人话）；工作台充值界面四张档位卡；运营后台手动发积分不受档位限制。旧的任意金额充值入口收掉或仅留 admin。
3. **红人营销增值服务（订阅）**：
   - 订阅机制复用 WP115 的 term / cycle：按月从钱包扣 30 积分（能力 `kol.service.monthly`，幂等键 = org + cycleStart）；余额不足 → 不删数据、云端同步暂停、界面与通知说人话，宽限 30 天；可随时取消（当期用完为止）。运营后台可赠送 N 个月。
   - **云端红人库（租户私有）**：每个 org 一个 `KolTenantDO`（`SyncDb`，Compose 形态同一口子落 sqlite），模型与 `packages/kol-core` 本地模型同构（红人、观测快照、候选池、活动、合作线程摘要、交付物、追踪链接、备注）。
   - **双向同步**：本地 ↔ 云端，变更日志 + 每对象版本号 + 最后写入者胜（冲突保留双方版本并在界面上标出，不静默丢）；首次开通全量上行；离线攒队列；接口 `/v1/kol/sync/*`，scope 新增 `kol`（只加）。传输 TLS，云端静态加密沿用平台能力，邮箱字段照旧用 `AGENTSWS_KOL_EMAIL_KEY` 再包一层。
   - **为云端运行留口**：在 `docs/67` 里写清下一步（云端跟进节奏 / 云端收发信 / 云端长程任务）要的接口与数据已经够不够，本轮不实现云端执行器，只保证数据与契约到位。
   - 用户数据权利：一键导出云端这份、一键删除云端这份（本地不动），写审计。
4. 运营后台：组织抽屉加「红人营销增值服务」区（订阅状态、到期、云端对象数、最近同步时间）；「积分与会员」页加订阅列表。
5. 文档：`docs/67-付费三块与红人营销增值服务-v1.md`；改 `docs/21`（见上）、`docs/49`（三块 + 四档）、`docs/65`（后台「不做模拟登录」的理由改为「暂不做」，不再以「云上没有业务内容」为由）。

## 验证
通用项 + `vitest run packages/metering packages/cloud-entry packages/kol-core apps/cloud apps/cloud-worker apps/cloud-admin apps/server apps/workstation packages/contracts`；`wrangler deploy --dry-run` 过。测试钉住：同一 cycle 不重复扣费；余额不足不删数据；同步冲突不丢数据；未订阅的 org 调同步接口回 402 人话。
