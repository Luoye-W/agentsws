# 邮件营销与物流追踪

这篇讲邮件营销（Klaviyo、Shopify Email）和物流追踪（AfterShip、17TRACK）这四个连接。**四家现在都还没接上真调用**，下面照实写到了哪一步。

| 连接 | 一句话 | 现在到哪了 |
|---|---|---|
| Klaviyo（邮件营销） | 分群、模板、活动效果，只读 | 还没接，在做；要一把只读密钥 |
| Shopify Email（邮件营销） | 另一家邮件营销 | 待增加，排在 Klaviyo 后面 |
| AfterShip（物流追踪） | 包裹到哪了、有没有异常，只读 | 还没接，在做；要一把只读 key |
| 17TRACK（物流追踪） | 另一家物流追踪 | 待增加，排在 AfterShip 后面 |

## Klaviyo（邮件营销）

分群、模板、活动效果**只读**。发送不走这条连接——群发永远是一张要人点头的卡。

> **还没接。** 连接目录、只读动作与表单已经就位，真调用还没做。在此之前，邮件营销面板的「自动流」与「效果」两块照实说「还没连」，不出编出来的数字。

**怎么做**

1. 登录 Klaviyo，进 Settings → API keys。
2. 点 Create Private API Key，权限选「只读」（Read-only）。
3. 把这串密钥填进表单。它只存在这台电脑的加密库里，不上传、不进日志。

**链接**

- [Klaviyo API keys](https://www.klaviyo.com/settings/account/api-keys)

## Shopify Email（邮件营销）

排在 Klaviyo 后面：独立站做邮件营销的多数人用 Klaviyo，所以先接它。

> **待增加。** 先做 Klaviyo（首选），这家排在它后面。

**怎么做**

1. 暂时没有步骤——这家还没接。要现在就用邮件营销，先连 Klaviyo（也还在做）。

**链接**

- [Shopify Email](https://www.shopify.com/email-marketing)

## AfterShip（物流追踪）

只读物流轨迹：包裹到哪了、有没有异常。它**不**回写单号——单号是「标记发货」那一步的事。

> **还没接。** 连接目录、只读动作与表单已经就位，真调用还没做。在此之前，订单履约面板的「物流异常」那一块照实说「还没连」。

**怎么做**

1. 登录 AfterShip，进 Settings → API keys。
2. 新建一把 key，权限选只读。
3. 把它填进表单。它只存在这台电脑的加密库里。

**链接**

- [AfterShip API keys](https://admin.aftership.com/settings/api-keys)

## 17TRACK（物流追踪）

和 AfterShip 并列的另一家，先做 AfterShip。

> **待增加。** 物流追踪先做 AfterShip，这家排在它后面。

**怎么做**

1. 暂时没有步骤——这家还没接。

**链接**

- [17TRACK API](https://api.17track.net)

## 常见问题

- **现在能用吗**：四家都还没接上真调用。Klaviyo 与 AfterShip 的表单已经就位；在做好之前，面板上对应那一块照实写「还没连」，不会出编出来的数字。
- **Klaviyo 能不能帮我群发**：不能，发送不走这条连接。群发永远是一张要人点头的卡。
- **AfterShip 会不会改我的物流单号**：不会，它只读轨迹。填单号是「标记发货」那一步的事。
- **我用的是 Shopify Email / 17TRACK**：这两家排在 Klaviyo / AfterShip 后面，暂时没有步骤。店铺本身怎么连，看 [连 Shopify 店铺](help:conn-shopify)。
