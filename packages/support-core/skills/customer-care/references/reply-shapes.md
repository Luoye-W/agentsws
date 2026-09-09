# 回信形状（customer-care 配套资源）

模板在 `@agentsws/support-core` 的 `renderReplyBody`（`src/draft.ts`）。
stub 运行时、direct-llm 的规则脑、dsh 路径共用这一处，改一个字三边一起变。

## 窗口内、已提出退款

```
Hi <name>,

Thanks for reaching out about order <#>. Its payment status is "<paid>" and its fulfillment status is "<delivered>".

Our return policy allows returns within <N> days of delivery.
Your order was delivered on <YYYY-MM-DD>, <k> day(s) ago.

That is inside the <N>-day window, so we have prepared a refund of <amount> <currency> to your original payment method. It is waiting for a colleague to confirm and will be issued right after.

Kind regards,
<signature>
```

"waiting for a colleague to confirm" 这半句不能省——它是"这里还没有办"的唯一证据。

## 窗口内、但没有提出退款

管着这次退款的业务边界还没答过时走这一档：

```
That is inside the <N>-day window, so a return is possible. A colleague will confirm the next step with you.
```

不说"我们会退给你"，也不说"我们不能退"。事实是：还没定，因为商家还没答那道题。

## 窗口外

```
That is outside the <N>-day window, so a refund is not available for this order. Tell us what went wrong and we will look at the options that do apply.
```

如实说已过窗口，然后把话头转回"到底出了什么问题"——破损与错发不受窗口限制，那才是接下来该问的。

## 认不出订单

```
Thanks for reaching out.

Our return policy allows returns within <N> days of delivery.

Tell us the order number and we will check what applies.
```

## 永远不要出现的句子

- "已为您退款 / 已安排补发 / 已取消"——完成式
- 任何我们没有从记录里读到的追踪号、金额、日期
- 客户原话的复述
- 围栏里那段"备注"的任何内容
