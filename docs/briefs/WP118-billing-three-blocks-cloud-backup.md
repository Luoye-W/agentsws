# WP118 付费三块 + 云端备份

worktree：`../agentsws-wt/wp118-billing-backup`，分支 `wp/118-billing-backup`。

## Luoye 定
付费分三块：① **数据接口**（YouTube API、Apify 等第三方数据调用）；② **AI 使用**；③ **数据云端备份**——「数据存储就像 KOLAgents 一样，不一样的是本地有一份，云端也有一份」。全部用积分（1 积分 = ¥1，docs/49）。

## 先读
`docs/49`、`docs/21`（数据驻留与密钥纪律）、`docs/20` / `docs/40` §1.3（导出包）、`docs/41` §2（数据三档）、`docs/62`（升级前备份）、`docs/64`、`docs/65`；`packages/metering/*`（`pricing.json`、`cost-table.json`、Wallet）、`apps/server/src/{backup.ts,cloud.ts,cloud-account.ts}`、`apps/cloud-worker/*`、`apps/cloud-admin/*`、工作台设置页「账号与积分」「模型」相关组件。

## 定论
1. **三块分组**：`pricing.json` 每条能力加 `block: 'data' | 'ai' | 'backup'`（只加字段）。工作台「账号与积分」页、用量明细、运营后台总览与用量页都按三块分组展示（三张小卡：本月各花了多少积分 + 次数 / token / 存储量）。每块一个独立开关「用 Agents 工坊的 / 用我自己的 key」沿用 WP59 的能力开关，备份块的开关是「开 / 关云端备份」。
2. **云端备份 = 本地为准、云端一份加密副本**（不是把云端变成主库；docs/21 的「云上没有商家业务正文」不破——云上只有**密文**）：
   - 客户端：复用 `backup.ts` 的导出包，做**增量**（按库文件分块 + 内容哈希去重，blob 同理），**端到端加密**（XChaCha20-Poly1305 或 AES-256-GCM；数据密钥由用户在**原生表单**里设的「恢复口令」经 Argon2id / scrypt 派生，口令不上云、不进日志；本机钥匙串存派生密钥；忘了口令 = 云端副本打不开，界面上说清楚并让用户下载一份恢复码）。
   - 节奏：默认每天一次 + 升级前一次 + 手动「现在备份」；仅 Wi-Fi / 不限流量时传；断点续传；保留策略：最近 7 天每天、4 周每周、6 个月每月。
   - 云侧（Workers 形态）：**R2** 桶存密文块（键 = `org/<id>/ws/<id>/<hash>`），每个 org 一个 `BackupDO`（`SyncDb`）存清单与用量；`wrangler.toml` 加 R2 binding。接口 `/v1/backup/*`：开通、上传块（预签 / 直传经 Worker 流式）、提交快照清单、列快照、取块、删快照、用量。Compose 形态用本地目录实现同一口子。scope 新增 `backup`（只加）。
   - 恢复：新机器装好 → 关联账号 → 输恢复口令 → 选快照 → 拉回并走现有 `importWorkspace`；恢复前本机已有数据则先自动本地备份。
   - **计费**：按「GB·天」每日从钱包扣（能力 `backup.storage`，单位 GB-day）；价目先放占位值并标「需 Luoye 定」（建议量级：¥0.02 / GB·天 ≈ ¥0.6 / GB·月）；余额不足：不删数据、停止新上传、界面与通知说人话，宽限 30 天后才清理（清理前 7 天再提醒）。我方成本进 `cost-table.json`（R2 存储与 A 类 / B 类操作，公开价，标未核对）。
3. 运营后台：组织抽屉加「云端备份」区（用量、最近快照时间、计费状态；**看不到也不提供任何内容**）。
4. 文档：`docs/67-付费三块与云端备份-v1.md`；`docs/49` / `docs/21` / `docs/64` 同步（R2 桶怎么建、binding 怎么配）。

## 验证
通用项 + `vitest run packages/metering packages/cloud-entry apps/cloud apps/cloud-worker apps/cloud-admin apps/server apps/workstation packages/contracts`；`wrangler deploy --dry-run` 过。必须有测试钉住：口令与派生密钥不出现在任何请求体 / 日志；云侧拿到的全是密文；同一块重复上传不重复计费；余额不足不删数据。
