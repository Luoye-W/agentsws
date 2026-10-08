# WP267 Shopify 收尾小单：一点补签、订单 / 客服走云端、店铺与官网不符不自动定、CLI 不自动升级、图片来源（决策 164 / 198 / 208 / 209）

worktree `../agentsws-wt/wp267-shopfollow` · 分支 `wp/267-shopfollow`（从 main 新起，含 WP261 / WP264 / WP265）。先读 `_common.md`、WP258 / WP261 / WP265 报告、私有云 WP266 报告（`/Users/yeluo/Documents/agentsws-cloud/docs/briefs/reports/WP266.md`，只读：补签接口、GraphQL 回包 `{data: <Shopify 原样>}`、非 2xx 错误信封 `details.errors`、403 `details.required_scope`、409 `details.reason: 'reauth_required'`）。

## 要做
1. **（208）一点就补签**：卡上「账号授权要更新一下」不再要求重新登录，改成调 `POST /v1/cloud/links/current/upgrade`（工作区令牌）→ 成功即继续原操作；接口不在 / 失败才退回「重新登录」。
2. **错误区分**：本机 `errorOf` 把「我们云令牌缺 store 的 403」与「Shopify 那头的 403 / 权限不足」分开说人话；按 WP266 的新回包形状解析（成功取 `data`，失败读 `details.errors` 原话）。契约 `AuditAction` 加 `link.scope_upgrade`（与私有仓对齐，只加）。
3. **（209）订单 / 客服走云端**：客服回信、订单查询那一路的店铺数据（订单详情、物流、退换状态等原先靠本机连接器的 Shopify 连接）在本品牌云端已连时改走 `ShopifyAdmin` 云端代发；没连再回退老连接器。只读不变；任何改动照旧出卡。
4. **（164）只有一家店但与官网不符**：WP258 自动定店时，账号下唯一那家店的域名与品牌档案 `shopify_domain` 不一致 → 不自动定，岗位页提示「官网那家店不在这个账号下，要换个账号登录吗」（换账号 / 就用这家 两个按钮）。
5. **Shopify CLI 不自动升级**：替用户跑任何 shopify 命令都关掉 CLI 的自动升级（查清 4.8.x 的开关：环境变量或 `config autoupgrade`，写进子进程环境白名单），避免在用户电脑上 `npm install -g`；我们的私有安装由一键安装管版本。
6. **（198）图片来源**：运营工具「传商品图」除本品牌文件夹外，接受事项里拖进来的图片与设计岗素材库里的图（仍只在人批卡后上传）。
7. 每条测试。

## 纪律
不读 .env*；不跑批量清理命令；本机 4317 服务别碰；不连远程机器；不真去 Shopify / 不调真云端；不碰私有仓。

## 验证
`scripts/verify-changed.sh` + 模拟三包 × stub + `gen-sdk` / `gen-ontology --check` + `gen-cloud-contract --check` + `open-repo-boundary`；报告 `docs/briefs/reports/WP267.md`（要 Luoye 定的事单列）。
