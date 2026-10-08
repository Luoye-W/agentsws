---
positions: [dtc-ops, web-ops, customer-care, site]
roles: [dtc.store, dtc.store-config, dtc.catalog, dtc.support, site.shopify-build, site.shopify-theme, site.shopify-apps]
---
# 连 Shopify 店铺

这篇讲怎么把你的 Shopify 店接进 Agents 工坊。

## 一键连接（推荐）

不用建开发者应用、不用填任何密钥。

1. 先登录 Agents 工坊账号——是你在 Agents 工坊注册的账号（积分、云端功能都在上面），**不是 Shopify 后台的账号**。卡上点「去登录」会跳到「设置 → 账号」，登完自动回来。
2. 在连接页的「Shopify 店铺」卡上点 **连接 Shopify**。店铺域名会自动带上（品牌档案、建站岗位找到的店）；没有就填一格 `xxx.myshopify.com`。
3. 浏览器会打开 Shopify 自己的授权页，用店主账号点 **安装**。
4. 回到工坊，卡上变成「已连接」：店名、能管哪些东西。点「测试连接」能确认一下。

店铺的钥匙只存在 Agents 工坊云上，不在这台电脑上；AI 改商品、页面之前都会先出一张卡让你批。

- **账号权限不够新**：不用管，工作台启动时和用到时会在后台自动补上。万一补不上（比如账号在别处被退出了），卡上会说「工坊账号需要重新登录」，点「去重新登录」到「设置 → 账号」用同一个账号登一次。
- **卡上说「连不上 Agents 工坊云」**：已经自动重试过一次；问号里有原因码，开着代理 / VPN 的话换个节点再点「再试一次」。
- **卡上说「这家店暂不支持一键授权」**：一键授权现在只开给内测的店，公开应用过了 Shopify 审核之后任何店都能用。等不及的话用下面「自己建应用」那一路。
- **授权失效 / 还缺某项**：点「重新授权」，再在浏览器里点一次安装。

## Shopify 店铺 · 高级：用自己的 Shopify 应用

卡上「高级：用自己的 Shopify 应用」点开就是这一路。在 Shopify 的 Dev Dashboard 里建一个应用，装到你的店上，再把 Client ID 和密钥填过来就行。Shopify 给的访问令牌 24 小时就过期，我们自己续，你不用管。

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
