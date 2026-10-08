# Shopify 应用注册操作清单（决策 146 / 176，Luoye 本人操作）

> 目的：让 Agents 工坊像 Claude / ChatGPT 一样，用户只点一次「授权」就能管理自己的 Shopify 店铺；**用户永远不用自己建应用**。应用由我们（Luoye 的 Shopify Partner 账号）注册一次。
> 依据：Shopify 官方文档（2026-10 查）——应用管理已从 Partner 后台挪到 **Dev Dashboard**（dev.shopify.com，用 Partner 账号登录）；分发方式**选定后不能改**；2026-04-01 起新的公开应用必须用「会过期的离线令牌」（1 小时过期 + 刷新令牌，云端自动续，用户无感）。

## 为什么建两个应用

| | A：Agents Workshop（公开分发） | B：Agents Workshop · Rollout（指定店铺分发） |
|---|---|---|
| 给谁用 | 所有用户、任何店铺 | 只装 Rollout 正式店 `6suegp-md.myshopify.com` |
| 审核 | 要上 Shopify 应用商店、过审核（几天到几周） | **免审核，建好就能装** |
| 用途 | 正式产品 | 审核期间先在 Rollout 上把一键授权跑通 |

分发方式选了不能改，所以分两个应用建。INMO 的店以后用 A（或再建一个指定店铺应用）。

## 第一步：B（Rollout 内测应用，先做）

1. 打开 https://dev.shopify.com ，用你的 Shopify Partner 账号登录（没有就在 https://www.shopify.com/partners 免费注册）。
2. **Create app** → 名字填 `Agents Workshop · Rollout`。
3. 进 **Versions → Create version**，填：
   - **App URL**：`https://agentsws.com`（我们不嵌进 Shopify 后台，用默认 / 官网即可）
   - **Embed app in Shopify admin**：**关**（不勾）
   - **Redirect URLs**（授权回调）：`https://cloud.agentsws.com/v1/shopify/oauth/callback`
   - **Webhooks API version**：选最新的
   - **Scopes**（权限，勾这些）：
     - `read_products`, `write_products`（商品、变体、商品图）
     - `read_inventory`, `write_inventory`（库存）
     - `read_content`, `write_content`（页面、博客）
     - `read_online_store_navigation`, `write_online_store_navigation`（菜单）
     - `read_discounts`, `write_discounts`（折扣）
     - `read_orders`（订单，只读）
     - `read_themes`（读主题信息；改主题仍走 Shopify CLI）
   - 点 **Release**。
4. 回到应用首页 **Distribution** 卡 → **Select distribution method** → 选 **Custom distribution** → 店铺域名填 `6suegp-md.myshopify.com` → 取消勾选「Allow multi-store installs」→ **Generate link**。**这个安装链接先别点**，等我们云端做好再装（装了也没坏处，只是暂时用不上）。
5. 进 **Settings**：
   - **Client ID**：复制发给我（可以公开，放在对话里没问题）。
   - **Client secret**：**不要发给我**。你自己在 Mac 终端运行下面这条，粘贴进去回车：

```bash
cd ~/Documents/agentsws-cloud/apps/cloud-worker && env -u CLOUDFLARE_API_TOKEN pnpm exec wrangler secret put SHOPIFY_APP_ROLLOUT_SECRET
```

## 第二步：A（公开应用，建好先不提交审核）

1. Dev Dashboard → **Create app** → 名字 `Agents Workshop`。
2. **Versions → Create version**：App URL、Embed（关）、Redirect URLs、Webhooks 版本、Scopes **与上面 B 完全相同**；**Release**。
3. **Distribution** → 选 **Public distribution**。（应用商店的介绍页、截图、隐私政策链接等**先不填、先不提交审核**——等 B 在 Rollout 上跑顺，我把要填的内容逐条写好给你。）
4. **Settings**：Client ID 发我；Client secret 用同一种方式存进云端：

```bash
cd ~/Documents/agentsws-cloud/apps/cloud-worker && env -u CLOUDFLARE_API_TOKEN pnpm exec wrangler secret put SHOPIFY_APP_PUBLIC_SECRET
```

5. 读订单里的顾客姓名 / 地址 / 邮箱属于「受保护的顾客数据」，公开应用要单独申请（Dev Dashboard / Partner 后台 → 应用 → **API access requests → Protected customer data access**）。这一步也等提交审核时一起做，理由我来写。

## 我们这边同时做的（不用你管）

- 云端：授权回调 `/v1/shopify/oauth/callback`、令牌加密存储与每小时自动续期、Shopify 要求的三个合规 webhook（顾客数据查询 / 删除、店铺删除）。
- 工作台：连接页「连接 Shopify」一个按钮 → 浏览器里 Shopify 授权页 → 点「安装」→ 回来就连好；替换掉现在那张要填客户端 ID 的卡。
- 运营工具（WP261）的底层从「Shopify CLI 授权」换成「我们的应用」，界面和用法不变。

## 你做完告诉我

两个 Client ID（B 的、A 的），以及「两个 secret 已存好」。
