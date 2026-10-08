# WP272 补权限全自动、Shopify 卡不再内嵌工坊账号登录（Luoye 10-08 真机）

worktree `../agentsws-wt/wp272-silent` · 分支 `wp/272-silent`（从 main 新起，含 WP265 / WP267）。先读 `_common.md`、WP265 / WP267 报告（`shopify-connect.ts`、`cloud-account.upgradeScopes`、`/v1/shopify-connect/upgrade`、卡上内嵌的 `CloudAuthForm`、`scope_missing` / `not_linked` / `offline` 三种 blocked）、私有云 WP266 报告（`POST /v1/cloud/links/current/upgrade` 就地补 kol / store）、设置页「账号与积分」。

## 现象（Luoye 10-08 Windows ci.19）
Shopify 店铺卡显示「账号授权要更新一下，重新登录一次就好」并内嵌一个登录框（邮箱验证码 / 密码登录）。Luoye 以为要登录 Shopify，填了 Shopify 后台的 QQ 邮箱和密码，被拒；他的工坊账号是另一个 gmail。Luoye：「为什么工坊账号是在这里填啊，怪怪的～～」

## 要做
1. **补权限全自动、用户无感**：工作台启动时、以及任何调用撞到 `scope_missing`（403 `details.required_scope`）时，后台自动调 `upgradeScopes`（同公司各品牌一起补），成功就继续原操作；卡片上不出现「账号授权要更新」这类字样。只有补签接口确实不可用 / 失败（如被撤销）时，才给一句「工坊账号需要重新登录」+ 按钮跳到 **设置 → 账号** 页（不内嵌表单）。
2. **Shopify 卡不再内嵌登录框**：删除卡内 `CloudAuthForm`；未关联工坊账号（`not_linked`）时只显示一句「先登录 Agents 工坊账号」+「去登录」按钮 → 设置 → 账号（登录完自动回到连接页并继续）。其他用到内嵌登录的连接卡同样处理（全仓查一遍）。
3. **账号页**：明确写「Agents 工坊账号（积分、云端功能都在这个账号上）」，显示当前登录邮箱；登录表单只在这里。
4. **离线误报**：`offline` 只在真的连不上云时出现；补充一次自动重试（短退避）再判离线，并在问号里放原因码（WP242 的 cause.code）。
5. 测试：缺 store 自动补签后连接按钮直接可用（假云端）；补签失败 → 跳账号页的引导；未关联 → 引导；卡内不再渲染登录表单；离线重试。

## 纪律
不读 .env*；不跑批量清理命令；本机 4317 服务别碰；不连远程机器；不调真云端。合并前若 main 有新提交，先合 main、`npx tsc -b` 后再重出 gen-sdk / gen-ontology。

## 验证
`scripts/verify-changed.sh` + 模拟三包 × stub + `gen-sdk` / `gen-ontology --check` + `open-repo-boundary`；Shopify 卡各状态截图；报告 `docs/briefs/reports/WP272.md`。
