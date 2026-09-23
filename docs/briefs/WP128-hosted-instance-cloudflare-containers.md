# WP128 客服增值服务的托管实例：Cloudflare Containers（不买机器）

worktree：`../agentsws-wt/wp128-hosted` · 分支 `wp/128-hosted`（从 main 新起）。

## Luoye 定（09-23）
托管实例**用 Cloudflare 或 Vercel**，他只想管这两个平台。常驻进程 + 长连接 + 本地库这三样 Workers / Vercel 都跑不了，所以落 **Cloudflare Containers**（同一个 Cloudflare 账号、同一份账单）。WP124 报告否掉它的理由是冷启动对聊天窗不可接受——解法：**订阅了客服增值服务的工作区，容器常驻不休眠**（每工作区约 $4–6 / 月固定成本，30 积分月费覆盖），未订阅的不起容器。

## 先读
`docs/74`（三条路；「收费在线档 = 转发器切对端 + 托管同一份 apps/server」）、`docs/64`、`docs/67`、`packages/standby/**`（现有值守子进程与 `/w/:ws/*` 代理——它要 `child_process`，在 Containers 里可以用）、`packages/chat-relay`、`apps/cloud-worker/src/{chat-relay-do,worker}.ts`、`deploy/Dockerfile.cloud`（WP110 的多阶段镜像可复用）、Cloudflare Containers 官方文档（先 WebFetch 读现行 API：`Container` 类、`wrangler.toml` 的 `[[containers]]`、`sleepAfter`、`maxInstances`、镜像大小上限、计费；按 docs/42 记一条上游评估，**文档查到什么写什么**）。

## 补充（Luoye 09-23 问「是不是每个客户单开一个」）
本轮就是**每个订阅工作区一个容器**（最快、隔离最干净；内测阶段客户数少）。但要**给以后改共享容器留好口子**：容器镜像与启动参数里工作区 id 只出现在一处（环境变量），`HostedInstanceDO` 与容器之间的协议按「一个容器可承载 N 个工作区」设计接口形状（本轮 N=1）；报告里写清「客户超过多少个时该切共享版、切换要改哪几处」。费用估算按每客户一个容器写。

## 交付
1. `apps/cloud-worker` 加 `HostedInstanceDO`（每工作区一个，继承 Cloudflare 的 `Container` 类）：镜像 = `apps/server` 的容器版（复用 `deploy/Dockerfile.cloud` 的构建方式，数据卷在容器内 + 定时把工作区数据同步回本机 / R2 快照，按 WP118 的同步机制）；订阅生效 → 起容器并设常驻（`sleepAfter` 极长或心跳保活）；取消 / 欠费宽限到期 → 停容器、保留快照 30 天。
2. 转发器切对端：`ChatRelayDO` 按订阅状态把访客消息转给 `HostedInstanceDO`（容器内的 `apps/server`）而不是商家本机；本机上线时两边按现有同步对齐；托管实例的 AI 调用走 `/v1/ai/*` 计积分（块 = `ai`）。
3. `wrangler.toml`：`[[containers]]` + binding + 迁移 tag；`wrangler deploy --dry-run` 过；镜像构建脚本与大小写进报告。
4. 后台：组织抽屉「客服增值服务」区显示容器状态（运行 / 休眠 / 停止、最近心跳、本月费用估算）；健康页一格。
5. 工作台：聊天窗设置页「转发方式」第三项接真；订阅后显示「云端替你值守中」。
6. 测试全替身（假 Container 运行时，照 `test/helpers.ts` 的假 DO 做法）：订阅起容器、取消停容器、切对端、本机上线对齐、欠费宽限。docs/74 / 64 / 67 同步；docs/35 记。

验证：`scripts/verify-changed.sh` + `wrangler deploy --dry-run`。
