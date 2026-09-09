# @agentsws/support-core

客服共享包（33 §1）。**纯函数，无 IO，无模型调用**——同一份代码有两种交付形态：
KefuAgent（托管 SaaS，自带界面）与 agentsws 开源中台（本地、统一队列、多职责）。
修一条话术规则、加一条业务边界，两边同时受益。

能力从 KefuAgent 抽出来重写成与我们契约对齐的纯函数。每个文件头注写明抽自哪里。
舍掉的一律是宿主的事：Next / Drizzle / 计费 / 多租户 / i18n 框架 / 并发写。

## 装了什么

| 模块 | 干什么 |
|---|---|
| `classify.ts` | 入站分类：强规则（线程接管）→ 词表 → 可注入的模型结果。意图、语言、紧急度、证据芯片 |
| `entities.ts` | 证据芯片：订单号、金额、期限、承诺、风险词；去标识化自检 |
| `boundaries.ts` | 15 条业务边界注册表、触发匹配、答案校验、答案 → `SupportPolicy` |
| `detect.ts` | 从策略层与知识层的上下文推"这条边界已经答过了吗"（闭集词，宁可漏判不误判） |
| `draft.ts` | 回复起草：模板 + 槽位、退货窗口取值优先级、变更门（没答过的边界挡住那条变更） |
| `knowledge.ts` | 知识候选：空答案过滤、政策敏感与承诺扫描、候选 → 19 §1.1 事实卡草稿 |
| `escalation.ts` | 强制人工复核词面、`shouldEscalate`、去重键 |
| `sla.ts` | 首响 / 解决时限；`always` 全天候（Amazon 口径）与 `business` 工作日历两种 |
| `approvals.ts` | `policy_change`（问句形态）/ `knowledge_update` / `ai_question` 的审批项 payload |
| `prompts/` | 给 dsh 与 direct-llm 路径的提示词组件；静态前缀字节稳定（22 §缓存纪律） |
| `skills/customer-care/` | 客服技能（Agent Skills 格式，24 §1）+ 配套资源 |

## 三条纪律

1. **数字不由模型产生**（29 原则 ③）。起草模板里的金额、天数、订单号全部来自传入的订单事实
   与知识层条款；读不到就说读不到。
2. **围栏不重写**。所有外部文本经 `@agentsws/core` 的 `EXTERNAL_FENCE` 清洗后才参与匹配，
   而且判定只看词面命中，从不解释文本里的祈使句。测试用 6 封陷阱样本钉住：
   去掉陷阱那句，分类与草稿逐字节相同。
3. **时间与随机经注入**。包内不调 `Date.now()` / `Math.random()`，`now` 一律由调用方给。

## 谁在用

- `@agentsws/stand-ins` 的 stub 运行时、`@agentsws/runtime-direct` 的规则脑：
  分类 / 起草 / 边界判定都调这里，回信模板三条路径逐字节相同
- `role-packs/dtc-customer-care`：职责包的技能与能力来源
- KefuAgent（反向）：SaaS 侧改为依赖本包时的接线点见仓库根 `docs/33-SaaS有机融合与许可证选择.md` §1
