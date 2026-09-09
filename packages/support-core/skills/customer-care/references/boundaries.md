# 业务边界速查（customer-care 配套资源）

权威定义在 `@agentsws/support-core` 的 `SUPPORT_BOUNDARIES`（`src/boundaries.ts`）。
这份表是给人看的：知道有哪些问题、每个问题有哪几个答案、什么时候会被问到。

顺序即 prompt 注入顺序与卡片列出顺序，不要重排。

| id | 问什么 | 选项 | 什么时候问 |
|---|---|---|---|
| `policy.refund_window` | 退款/退货窗口多少天 | 7 / 14 / 30 / 60 天 | 退换退款意图、风险词 `refund`、提出 `refund` 变更 |
| `policy.return_shipping_payer` | 退货运费谁承担 | 我们出预付标签 / 客户自付 / 按原因分 | 同上 |
| `policy.replacement_first` | 缺件破损优先补发还是退款 | 优先补发 / 一律退款 / 客户二选一 | 退换退款意图、风险词 `damaged` `broken` `replace`、提出 `reship` |
| `policy.compensation_cap` | 单笔补偿上限 | $5 / $15 / $30 / 订单 30% | 提出 `discount_code`、风险词 `chargeback` |
| `policy.cancel_change_window` | 什么阶段还能取消/改地址 | 未发货都行 / 一律不改 / 平台单去平台改 | 取消改单意图、物流意图、提出 `address_change` |
| `policy.logistics_anomaly_days` | 发货后多少天不更新算异常 | 7 / 10 / 15 / 20 天 | 物流意图、风险词 `tracking` |
| `policy.customs_duty_payer` | 关税清关谁承担 | 我们包税 / 客户自理 / 分地区 | 物流意图、风险词 `customs` |
| `policy.warranty_period` | 保修期多久 | 6 / 12 / 24 个月 / 无保修 | 保修意图、产品咨询意图 |
| `policy.presale_discount` | 售前能给什么优惠 | 不给 / 5% 通用码 / 人工决定 | **declared**，本版不发卡 |
| `policy.vip_threshold` | 多大金额算 VIP | $200 / $500 / 不区分 | **declared**，本版不发卡 |
| `policy.lost_package_liability` | 显示已签收但没收到怎么办 | 免费补发 / 全额退款 / 先查件 / 人工决定 | 物流意图、风险词 `tracking`；来信同时出现"显示已送达"与"没收到"时，它会挡住退款 |
| `policy.wrong_address_liability` | 客户填错地址寄丢谁承担 | 客户承担 / 首次我们承担 / 只补运费 | 取消改单意图、提出 `address_change` |
| `policy.goodwill_coupon` | 什么情况能补发优惠券 | 一律不补 / 只在我们出错时 / 客户不满就可以 | 投诉意图、提出 `discount_code` |
| `policy.negative_review_response` | 差评威胁怎么应对 | 不拿补偿换评价 / 一律转人工 / 给政策内补救 | 投诉意图、风险词 `review` `lawsuit` |
| `policy.escalation_trigger` | 什么情况必须转人工 | 涉钱涉法涉差评 / 只有法律 / 所有回复都要人看 | 投诉意图、风险词 `lawsuit` `chargeback` |

## 三条纪律

1. **不预收集**。开箱不问，遇到才问，一条只问一次（去重键 = `<workspace>:policy_change:<boundary_id>`）。
2. **答案是快照**。答的那一刻把选项的值抄下来；以后改注册表不回写已答的行。
3. **只有管着这次动作的那几条会拦**。相关但不管这次动作的边界只产生一张卡，不拦回信、不拦别的变更。
