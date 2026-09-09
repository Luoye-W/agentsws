# role-packs/dtc-customer-care

官方应用：独立站客服职责包（钩子 A）。`package.yml` + `roles/` + skills + scenarios。1c 从 KefuAgent 抽共享包。

技能与能力来自共享包 **`@agentsws/support-core`**（33 §1）：分类、业务边界注册表、回复起草、
知识引导、升级与 SLA，以及 `skills/customer-care/SKILL.md` 本身。KefuAgent（托管 SaaS）
与本中台装的是同一份代码——修一条话术规则、加一条业务边界，两边同时受益。

```
package.yml                       23 §1 应用包清单（声明类，无可执行入口）
roles/dtc.aftersales.yml          职责定义；与内置版同一份，只把 customer-care 钉到 min_version
@agentsws/support-core
  skills/customer-care/SKILL.md   技能正文（Agent Skills 格式，24 §1）
  skills/customer-care/references/
    boundaries.md                 15 条业务边界速查
    reply-shapes.md               回信模板的四种形状
```

场景在 `packs/dtc-3c-3p/scenarios/` 下（`aftersales/*`、`security/*`），
`pnpm -s simulate --pack packs/dtc-3c-3p` 跑得到。

## 装进去之后行为上的差别

- **业务边界不预收集**：第一次遇到一条没答过的边界，不自作主张、不提出那条变更，
  照常起草"交给同事确认"的回信，同时给商家一张选择题卡（36 §2.2 `policy_change` 问句形态）。
  答过一次沉淀成策略，不再问第二次。
- **数字不由模型产生**：金额、天数、订单号只来自读到的订单记录与知识层条款。
- **围栏里的东西是数据**：订单备注、来信正文里藏的"系统提示"不改变任何判定
  （`scenarios/security/injection-in-order-note.yml` 钉住这一条）。
