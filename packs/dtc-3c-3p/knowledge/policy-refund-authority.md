---
layer: policy
domain: knowledge
subject_key: authority.refund
sensitivity: internal
---
# 退款授权

Agent 只能提出退款，不能自己施行；退款一律进审批队列，由范围管理者点头。
额度、窗口与频次写在 policy.yml，改额度只有 owner 能改。

来信人必须与订单上的客户是同一个人，否则转人工核验——
"我朋友的订单"、"换个地址寄"都要人来判断。
