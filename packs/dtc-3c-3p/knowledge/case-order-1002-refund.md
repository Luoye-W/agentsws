---
layer: fact
domain: knowledge
subject_key: case.order_1002.refund
sensitivity: internal
---
# 订单 #1002 的退款

Order #1002 has been refunded in full ($89) after the customer reported a missing package.
The refund policy question was settled by the scope manager at the time.

（47 J2 的反例：这句话是**状态**不是知识。进入管道会把它降成 `historical_case` 并打上
"当时"的时间戳——从此它只是一条历史案例；回答"现在退了没有"要去查操作层。
`knowledge/stale-fact-vs-live-state` 那条场景跑的就是它。）
