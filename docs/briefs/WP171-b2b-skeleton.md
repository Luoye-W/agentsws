# WP171 B2B 岗位骨架：契约对象、五条职责、岗位模板、b2b-core（移植 BtoBAgents 判断逻辑）、面板骨架、模拟包

worktree `../agentsws-wt/wp171-b2b-skeleton` · 分支 `wp/171-b2b-skeleton`（从 main 新起）。先读 `_common.md`、**`docs/84-B2B岗位设计-v1.md`**（整篇，**§11 覆盖前文**：岗位名「B2B」、五条职责、报价转上级、发信域名不强制）、`docs/50`（§0 按人切、职责是积木）、`docs/briefs/reports/WP162.md`（登记即有正文的测试）、现有职责 YAML 写法（`packages/roles/roles/`、`kol/*.yml`、`dtc/*.yml`）、`packages/contracts/src/{roles,approval,work}.ts`、模拟包 `packs/dtc-3c-3p` 的结构。

## 要做
1. **契约只加不改**：B2B 客户（公司）、联系人（带来源 URL 与日期）、商机、报价与不可改的报价版本、样品、名单、展会与展会线索、出运单（跟单）这些对象的类型；新 ChangeKind / ApprovalKind（报价、寄样、展会报名缴费、单证发送、放单等）。本体登记跟上（`gen-ontology`）。
2. **五条职责 YAML + 岗位模板「B2B」**（id `b2b`）：`b2b.sales`、`b2b.outbound`、`b2b.exhibition`、`b2b.fulfillment`、`b2b.marketplace`（**第二批**：YAML 先建、`status` 标未启用或等价方式，向导里不默认勾）。每条写 scopes、connectors（邮件已有；日历 / 名片识别 / 海关数据标「待增加」）、必须出卡的动作、自动化级别（发信 / 报价 / 缴费 / 放单 / 付款一律 L1 起步）、面板 home_blocks（照 docs/84 各节的少字面板）。
   - **技能登记**：六个 B2B 技能（`cold-email` / `prospecting` / `b2b-inquiry` / `quotation` / `trade-show` / `export-docs`）由并行的 **WP170** 写正文。WP162 的测试要求「登记即有正文」——你**先不登记这六个**，在报告里列出每条职责该挂哪几个，Fable 合并 WP170 后补登记；`brand-voice` 照常登记。
   - **报价超授权转上级**：审批路由先 `scope_manager`，没有再 `owner`（docs/84 §11.1 第 3 条）；授权四个数（单笔 1 万美元 / 毛利 20% / 折扣 5% / 账期 30 天）写成职责阈值，首次设置可改。
3. **新包 `packages/b2b-core`（移植）**：从 `~/Documents/BtoBAgents` **只搬 Luoye 自己的业务纯函数与它们的测试**（docs/84 §7 列的：`domain/policy.ts` 的授权判断、`domain/evidence.ts` 的 `decideEvidence`、`domain/ownership.ts` 的 `buildTransferPlan`、`imports/csv.ts` 的表头别名、`runtime-v2/onboarding.ts` 的行业规则、Company Brain 六类），每个文件头注明出处（仓库 + 文件 + 提交）。**MkSaaS 模板红线**：任何与 KOLAgents 纯模板提交 `cb506142` 逐字节相同的文件、`src/payment|credits|mail|components/ui…` 这类模板目录一律不看不搬；混在模板文件里的业务文案只摘文字。两套不一致的授权阈值统一成上面四个数。改成 agentsws 的写法（契约类型、无 Postgres、无 MkSaaS 依赖）。
4. **B2B 承诺词表**进 `packages/core`（价格 / 交期 / 认证 / MOQ / 独家 / 账期），接进 guardrail 的承诺扫描；**改收款账户**的话术识别（docs/84 §11.3 防诈骗）也放这里，命中出红卡。
5. **面板骨架**：五条职责各自的面板块（空态 + 演示数据），照 docs/36 §7 少字；岗位页「B2B」能在向导第 ③ 步勾选（B2B 那一项加进「这次主要想让它干什么」）。
6. **模拟包 `packs/b2b-3c-3p`**：由 BtoBAgents 的演示数据改写（去掉写死的 ElectroMart 页面），合成一家 3C 工厂：询盘、报价超授权转上级、寄样、展会线索跟进、出运单证核对、改收款账户诈骗信被拦——每个场景有断言；三运行时 fast 过、写基线。
7. 登记 `upstreams.yml`：BtoBAgents 作为 `kind: ported`（Luoye 自己的私有仓库，只登记来源与提交，不 watch 公网）。

## 纪律
契约只加不改；不连真服务、不连真邮箱；不跑批量清理命令；不读 .env*（BtoBAgents 仓库里的 `.env*` 与 secrets 文档同样不读）；Luoye 的本机服务在 4317 别碰。WP170 并行（它只加技能文件），别动它的地盘。

## 验证（审核方全量用）
`scripts/verify-changed.sh` + fast 模拟三个包（含新 `b2b-3c-3p`）三个运行时 + `gen-sdk` / `gen-ontology --check` / `gen-cloud-contract --check` + `scripts/open-repo-boundary.test.mjs`；截图：向导勾 B2B、B2B 岗位页五条职责、各面板空态。
