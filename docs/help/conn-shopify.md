# 连 Shopify 店铺

这篇讲怎么把你的 Shopify 店接进 Agents 工坊：订单、退货、客户、商品都从这条连接读。

## Shopify 店铺

在 Shopify 的 Dev Dashboard 里建一个应用，装到你的店上，再把 Client ID 和密钥填过来就行。Shopify 给的访问令牌 24 小时就过期，我们自己续，你不用管。

**怎么做**

1. 打开 [Shopify Dev Dashboard](https://dev.shopify.com/dashboard)（partners 后台里的 Apps），点 Create app，分发方式选「自定义」。
2. 在应用的版本配置里勾上这几项权限：订单读写（`read_orders` / `write_orders`）、退货读写（`read_returns` / `write_returns`）、客户读取（`read_customers`）、商品读取（`read_products`）。
3. 同一页再申请「受保护客户数据」（Protected customer data access），勾上姓名、邮箱、地址。**不申请的话，订单和客户读出来是空的，而且不报错。**
4. 点 Install app，选中你要接的那家店。店必须和应用在同一个组织下。
5. 回到应用的 Settings 页，抄下 Client ID 与 Client secret。
6. 把店铺域名和这两个值填进表单。密钥只存在这台电脑上。

**链接**

- [Shopify Dev Dashboard](https://dev.shopify.com/dashboard)
- [Shopify 客户端凭据换令牌（官方文档）](https://shopify.dev/docs/apps/build/authentication-authorization/client-credentials)

## 常见问题

- **订单、客户读出来是空的，也没报错**：多半是漏了第 3 步「受保护客户数据」。回 Dev Dashboard 补上申请（姓名 / 邮箱 / 地址）。
- **令牌过期了要不要重填**：不用。访问令牌 24 小时过期，我们会用你填的 Client ID 与密钥自己续。
- **装不上我的店**：应用只能装到同一个组织下的店，先确认店和应用在一个组织里。
- **想让 AI 收发客户邮件**：那是另一条连接，看 [连邮箱](help:conn-email)。
