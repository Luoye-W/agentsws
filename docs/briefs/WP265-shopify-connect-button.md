# WP265 工作台「连接 Shopify」一键授权（接云端 WP263），老的客户端 ID 表单收进高级；账号令牌加 store 权限（决策 146 / 176 / 186）

worktree `../agentsws-wt/wp265-shopconnect` · 分支 `wp/265-shopconnect`（从 main 新起）。先读 `_common.md`、`docs/92-Shopify应用注册操作清单.md`、私有云 WP263 已上线的接口（下面列出）、工作台连接页 Shopify 店铺卡（现在点「连接」出 店铺域名 / 客户端 ID / 客户端密钥 表单）、云账号关联与云令牌（`cloud-account.ts`、`CloudScope` 契约、WP231 账号登录、`kol` 权限加进默认集的先例）、WP252（连接按品牌隔开）、WP258（建站店铺自动获取，`shopify_domain`）、WP261（运营工具与 `ShopifyAdmin` 接口，可能尚未合并——本单不改运营工具，只做连接）。

## 背景（Luoye 10-08 真机）
「这里这个『连接』点了之后还是原先的要填客户端 ID 和客户端密钥啊」。云端一键授权已上线（cloud.agentsws.com，应用 B「Agents Workshop Rollout」只装 6suegp-md.myshopify.com；公开应用 A 待建），工作台还没接。

## 云端接口（WP263，已部署；鉴权用云账号令牌）
- `POST /v1/shopify/oauth/start` `{shop, brand?, return_to?}` → 201 `{attempt_id, authorize_url, app, scopes, expires_at}`（应用没配齐回 501 人话）
- `GET /v1/shopify/oauth/attempts/{id}` → `{status: pending|connected|failed|expired, …}`
- `GET /v1/shopify/connections` → 每条 `{shop, app, brand, status: connected|reauth_required, reauth_reason, scopes, missing_scopes, expires…}`
- `DELETE /v1/shopify/connections/{shop}`（最后一个工作区断开会卸载应用）
- `POST /v1/shopify/graphql` `{shop, query, variables?, allow_mutations?}`（云端代发；本单只用于「测试连接」的一次只读查询 `shop { name myshopifyDomain }`）

## 要做
1. **Shopify 店铺卡默认一键授权**：已关联 Agents 工坊账号时，卡上主按钮「连接 Shopify」→ 店铺域名自动带（品牌档案 `shopify_domain` / 建站自动获取的店 / CLI store list；都没有才让填一格域名）→ `oauth/start` → 用系统浏览器打开 `authorize_url` → 卡上显示「在浏览器里点『安装』，回来就好」+ 取消，轮询 `attempts/{id}` → 连好后卡片进「已连接」：店名、域名、权限摘要、「测试连接」（一次只读查询）、「断开」。`reauth_required` / 缺权限时显示「重新授权」与缺哪项。
2. **未关联账号 / 云端 501**：照实说一句（「先登录 Agents 工坊账号」/「这家店暂不支持一键授权，等公开应用上线」）；老的「店铺域名 / 客户端 ID / 客户端密钥」表单收进卡内「高级：用自己的 Shopify 应用」折叠，普通用户默认看不到。
3. **（186）账号令牌加 `store` 权限**：开源契约 `CloudScope` 加 `store`，放进默认权限集（同 `kol` 的理由），工作台调 `/v1/shopify/*` 时用；老令牌缺这项时照实提示并引导一键重新签发（若 WP263 云端尚未校验该 scope，报告里写清，云端下一单补校验）。
4. **按品牌**：连接记在当前品牌（WP252 的归属规则）；INMO 与 Rollout 各连各的；`brand` 字段传给云端。
5. 测试：假云端（本地 http）覆盖 start → pending → connected、失败 / 过期 / 取消、reauth、未关联、501、断开；卡片各状态组件测试；截图（demo 别碰 4317）。

## 纪律
不读 .env*；不跑批量清理命令；本机 4317 服务别碰；不连远程机器；不真去 Shopify / 不调真云端（假服务）；不碰私有仓。

## 验证
`scripts/verify-changed.sh` + 模拟三包 × stub + `gen-sdk` / `gen-ontology --check` + `gen-cloud-contract --check` + `open-repo-boundary`；卡片各状态截图；报告 `docs/briefs/reports/WP265.md`（给 Fable 的真机首测步骤、云端需要配合的改动、要 Luoye 定的事单列）。
