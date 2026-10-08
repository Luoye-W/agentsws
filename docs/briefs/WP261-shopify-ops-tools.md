# WP261 独立站运营工具：经 Shopify CLI `store auth` + `store execute` 管商品 / 合集 / 页面 / 菜单 / 折扣（决策 175 第 1 步）

worktree `../agentsws-wt/wp261-ops` · 分支 `wp/261-ops`（从 main 新起，含 WP245 / WP253 / WP258 / WP260）。先读 `_common.md`、WP245 / WP253 / WP258 报告（平台工具包只放行登记命令、每品牌独立 CLI 会话目录、`site-theme.ts`、店铺自动获取）、WP260 报告（主题运行预算 / 压缩 / 续跑）、`packages/roles/roles/dtc/*.yml`（店铺管理 `dtc.store` 等运营职责）与 `site/shopify-build.yml`、现有订单 / 商品工具（`get_product` 等走店铺连接的那组）、审批卡 / 变更账本 / 执行器（写操作一律事前出卡）、DECISIONS 146 / 175、memory 原则「用户零开发者配置」。

## 背景（Luoye 10-08）
CLI 只是开发向；运营要能上传 / 修改商品与页面。Fable 真机核对 Shopify CLI 4.8.5：
- `shopify store auth -s <shop> --scopes read_products,write_products[,…] [--json]`：「Authenticate an app against a store for store commands and stores an online access token for later reuse. Re-run if the token is missing, expires, or no longer has the scopes」——浏览器授权，**无需用户自建开发者应用**。
- `shopify store execute -s <shop> -q <graphql> [-v <json>] [--version <api>] [--allow-mutations] [--json]`：执行 Admin GraphQL；不带 `--allow-mutations` 只能查询。

## 要做
1. **摸清 CLI 行为并写进报告**（`npm pack @shopify/cli@4.8.5` 到临时目录读源码，不全局安装）：`store auth` 的授权流程（是否也是设备码 / 浏览器回调、非交互下要什么）、令牌存哪（必须落在本品牌的 CLI 会话目录里，WP253 那套 HOME / APPDATA 隔离）、在线令牌有效期与过期表现、`store execute` 的输出 / 错误形状、`--allow-mutations` 的边界。
2. **授权**：岗位页（店铺管理 / 整站搭建等运营职责所在岗位）出一行「授权管理商品和页面」→ 一键起 `store auth`（scopes 按本岗位职责需要的最小集合：read/write_products、read/write_content（页面 / 博客）、read/write_online_store_navigation（菜单）、read/write_discounts、read_orders 等，写进工具包登记），确认码 / 网址照 WP245 醒目显示；授权成功后记「已授权 + 有哪些权限 + 何时过期」；过期 / 缺权限时那一行回到「重新授权」并说清缺哪项。作为平台工具包登记的命令放行，参数写死、scopes 只能取登记表里的。
3. **运营工具（AI 侧，受限、不给任意 GraphQL）**：一组固定的查询与改动工具，内部拼 Admin GraphQL：
   - 读：商品列表 / 详情（含变体、库存、图片）、合集、页面、菜单、折扣、最近订单（只读）。
   - 写（**一律先出审批卡**，人批了由服务端带 `--allow-mutations` 执行，记变更账本，读回确认）：建 / 改商品（标题、描述、价格、变体、标签、状态草稿 / 上架）、上传商品图（URL 或本地文件——查清 CLI / staged uploads 路线）、建 / 改合集并加商品、建 / 改页面、改菜单、建折扣。删除类先不做（只给「下架 / 归档」）。
   - 工具接口与底层分开：定义一个 `ShopifyAdmin` 接口，这一单实现「CLI store execute」版；以后 146 的自家应用 / OpenConnector 版只是另一种实现，工具和卡片不用改。
4. **接到职责**：店铺管理（`dtc.store`）、整站搭建（`site.shopify-build`）、网页模板需要选合集 / 挂商品时也可用读工具（WP260 去掉的商品工具，在已授权时按条件给回）。未授权时工具面里不出现这组工具，岗位页引导授权。
5. **测试**：假 shopify 脚本覆盖 auth（成功 / 拒绝 / 过期 / 缺权限）、execute（查询 / 改动 / GraphQL userErrors / 网络失败）；写操作未批不执行、批后执行并读回；每品牌会话隔离；工具面按授权状态出现 / 隐藏。

## 纪律
不读 .env*；不跑批量清理命令；本机 4317 服务别碰；不连远程机器；不登录任何网站；不真去 Shopify（假 CLI）；写操作在任何路径上都不能绕过审批卡。

## 验证
`scripts/verify-changed.sh` + 模拟三包 × stub/direct/dsh + `gen-sdk` / `gen-ontology --check` + `open-repo-boundary`；授权行与商品改动审批卡出截图；报告 `docs/briefs/reports/WP261.md`（CLI 行为摸底、令牌有效期结论、给 Fable 的真机首测步骤、要 Luoye 定的事单列）。
