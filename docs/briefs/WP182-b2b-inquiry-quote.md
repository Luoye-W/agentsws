# WP182 B2B 询盘与报价：询盘接客服那条管线、B2B 六类事实卡、报价卡与报价单 PDF、样品跟踪、离职交接卡

worktree `../agentsws-wt/wp182-b2b-sales` · 分支 `wp/182-b2b-sales`（从 main 新起）。先读 `_common.md`、**`docs/84-B2B岗位设计-v1.md` §3（询盘与报价）与 §11（覆盖前文：报价超授权转上级、岗位名 B2B）**、`docs/briefs/reports/{WP171,WP172,WP173,WP174,WP176}.md`、`packages/b2b-core`（授权、证据、`buildTransferPlan`、行业识别、知识六类）、`apps/server/src/{b2b-store,b2b-service,b2b-mail,supervisor}.ts`、`packages/support-core`（分类、起草、防泄露）、`packages/knowledge`（事实卡）、`packages/skills/bundled/{b2b-inquiry,quotation}`、`packages/brand-design`（品牌设计：色与字）、`packages/deck` 与现有 PDF 产出（如有）。

## 要做
1. **询盘接客服那条管线**（复用 `support-core` 的分类、起草、防泄露，不另写）：WP172 分拣落成的 B2B 询盘 → 持「业务」职责的人名下开事项 → 模型按 `b2b-inquiry` 技能分级（真买家 / 在比价 / 骗样嫌疑 / 诈骗嫌疑，诈骗嫌疑出红卡）并起草首回；回复里碰价格 / 交期 / 认证 / MOQ / 独家 / 账期一律出卡（WP171 的 B2B 承诺词表已接 guardrail）。WhatsApp 来的询盘同一条路（沿用 opt-in 与 24 小时窗口三道闸）。
2. **B2B 六类事实卡**：知识库里加产品线、价格与 MOQ、认证清单、交付能力、样品政策、售后规则六类模板（`b2b-core` 知识六类），首次设置按官网推荐的行业预填认证清单（3C → CE / FCC / RoHS / UKCA / PSE，智能家居加 Matter……）；起草只引这些卡里的数，没有卡就说「这个我去确认一下」。
3. **报价**：报价卡（永远出卡，最高 L2）；授权内业务员自己批，超授权按 WP174 转上级、没有上级转老板；报价一律新建版本、不改旧版本（WP172 的触发器已挡）；**报价单 PDF**——信头用品牌设计的色与字，条款（EXW / FOB / CIF / DDP、有效期、MOQ 与阶梯价、付款方式）来自卡与事实卡，发给客户也要出卡；本机生成，照「不打包重型本机方案」选轻量做法（说明选型）。
4. **样品**：WP171 的样品对象接上界面与流程——待寄 → 已寄（必须带单号）→ 已签收 → 已反馈；超期不寄、超期没反馈出提醒；寄样通知出卡。
5. **离职交接卡**：业务员离职 / 被移出时，他的客户、商机、未回询盘按 `buildTransferPlan`（地区 / 产品线）分给接手的人，出一张卡给老板批（和 WP174 上级离职那套事件接上）。
6. 面板：「业务」职责页的待回询盘、报价待审、样品在途、该唤醒的老客户四块从真数据来（照少字规矩）。
7. 模拟：`b2b-3c-3p` 加场景——真买家询盘首回出卡、诈骗嫌疑红卡、报价超授权转上级并生成新版本、样品超期提醒、业务员离职交接卡；三运行时 fast 过，其余包零漂移。

## 纪律
契约只加不改；不连真邮箱 / WhatsApp；不跑批量清理命令；不读 .env*；**Luoye 的本机服务在 4317 别碰也别重启**；测试 `--maxWorkers=2`，起服务钩子超时的文件串行重跑确认。

## 验证（审核方全量用）
`scripts/verify-changed.sh` + fast 模拟三个包三个运行时 + `gen-sdk` / `gen-ontology --check` / `gen-cloud-contract --check` + `scripts/open-repo-boundary.test.mjs`（用 vitest 跑）；截图：询盘首回卡、报价卡与报价单 PDF 预览、样品面板、离职交接卡。
