# WP170 B2B 岗位的六个技能：cold-email、prospecting、b2b-inquiry、quotation、trade-show、export-docs

worktree `../agentsws-wt/wp170-b2b-skills` · 分支 `wp/170-b2b-skills`（从 main 新起）。先读 `_common.md`、**`docs/84-B2B岗位设计-v1.md`**（整篇，§11 覆盖前文）、`docs/briefs/reports/{WP160,WP162}.md`、`packages/skills/bundled/`（现有技能的写法、授权字样守卫、考题格式）、`packages/skills/src/bundled.ts`。

## 要做
六个中文技能，放 `packages/skills/bundled/<name>/SKILL.md` + `evals/evals.json`（每个 4–7 道静态考题），跨境 B2B 口吻（例子用 3C 工厂 / 外贸公司：充电宝、数据线、TWS 耳机）：
1. `cold-email`：改写自 coreyhaines31/marketingskills 的 `cold-email`（MIT，照 WP160 的改写规矩与出处写法）。**序列改成我们的三封（第 0 / 3 / 7 天）、收尾真停**；写法框架（观察 → 问题 → 证据 → 请求）、主题行规则、禁用写法（假 Re:、"just checking in"）保留；价格 / 交期 / 认证 / MOQ / 独家 / 账期一律不承诺（数字只引事实卡）；退订与公司地址由系统加，技能里不写模板地址。德国、奥地利默认不发并写明原因（docs/84 §11.1 第 6 条）。
2. `prospecting`：改写自 marketingskills 的 `prospecting`（MIT）。ICP 清单、四档评分（Hot / Warm / Cold / Skip）、两个以上独立来源才算高置信；合规八条（不批量爬、不绕验证码、只用公开的商务联系方式、记录来源 URL 与日期……）写进正文；LinkedIn 只出「你本人去发」的任务。
3. `b2b-inquiry`（自写）：询盘分级（真买家信号 vs 比价 / 骗样 / 诈骗信号）、首回写法、需求确认清单（数量、目标价、认证、交期、包装、付款方式）。
4. `quotation`（自写）：报价单结构、价格条款（EXW / FOB / CIF / DDP 的区别与写法）、有效期、MOQ 与阶梯价、**报价永远出卡、超授权转上级再转老板**。
5. `trade-show`（自写，docs/84 §11.2）：选展判断、报名截止与材料清单、展前邀约、现场记录格式（名片 + 一句话笔记 + 意向分级）、会后 48 小时跟进、展会小结。
6. `export-docs`（自写，docs/84 §11.3）：跟单节点、单证清单（商业发票、装箱单、原产地证、提单）、信用证单据逐条核对要点、**改收款账户的邮件一律不采纳、出红卡**（防诈骗）。

- 许可证：改写的两份 `license: MIT` + `THIRD-PARTY-NOTICES`（已有 marketingskills 那段，补上这两个技能的映射）+ `upstreams.yml` 里 marketingskills 的 `watch_paths` / `we_depend_on` 加这两个路径；自写的四份用本仓 Apache-2.0。
- 全部过授权字样守卫与 WP162 的「技能 frontmatter / 正文」测试。
- **只加技能文件与测试，不改职责 YAML**（职责由并行的 WP171 建；它合并时登记这六个名字）。

## 纪律
不连真服务；不跑批量清理命令；不读 .env*；Luoye 的本机服务在 4317 别碰。WP171 并行（它建 B2B 岗位骨架），别动它的地盘。

## 验证（审核方全量用）
`vitest run packages/skills` + `node scripts/check-upstreams.mjs --check` + `vitest run scripts/upstreams.test.mjs`。
