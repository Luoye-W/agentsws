# WP258 建站岗位自动获取 Shopify 店铺地址（登录后 `shopify store list`），不再让用户手填

worktree `../agentsws-wt/wp258-store` · 分支 `wp/258-store`（从 main 新起，含 WP253）。先读 `_common.md`、WP253 报告（`site-theme-banner.tsx`、`/v1/site/theme/store`、店铺地址来源：本品牌 Shopify 连接 → 岗位页手填；每品牌独立 CLI 会话目录 `<data>/tools/shopify-cli-sessions/<ws>/`）、WP245 报告（platform-cli-runner、只放行登记过的命令）。

## 背景（Luoye 10-07 真机：「为什么这里还需要手动填店铺地址，不是应该自动获取吗」）
Fable 真机实测：在 Rollout 那份 CLI 会话里 `shopify store list --json` 返回
`{"stores":[{"id":"gid://shopify/Shop/…","store":"6suegp-md.myshopify.com","organizationId":"…","organizationName":"My Store","name":"My Store","plan":"basic"}],"organization":{…}}`；
`shopify organization list --json` 也可用（一个组织）。

## 要做
1. **登录成功后自动取店铺**：在本品牌 CLI 会话里跑 `shopify store list --json`（多组织时先 `organization list --json` 再逐个列，或按 CLI 4.8.5 实际 flag），作为平台工具包登记过的只读命令放行（参数写死）。
   - 只有一家店：自动设为本品牌建站店铺（`store_source: 'cli'`），岗位页那一格不再出现。
   - 多家店：岗位页给一个下拉框选（显示店名 + myshopify 域名 + plan），选了即存。
   - 与品牌档案官网交叉印证：官网页面里的 `Shopify.shop` / myshopify 域名（brand-intake 分析时顺手取下来存进档案）若与某家匹配，就默认选它。
   - 零家：照实说「这个 Shopify 账号下没有店铺，换个账号登录或去 Shopify 开店」。
2. 手填仍保留为兜底（「都不是？手动填」）。已手填过的不被自动覆盖。
3. 测试：假 shopify 脚本覆盖一家 / 多家 / 零家 / 命令失败；官网印证默认选中；不覆盖手填。

## 纪律
不读 .env*；不跑批量清理命令；本机 4317 服务别碰；不连远程机器；不真去 Shopify。

## 验证
`scripts/verify-changed.sh` + 模拟三包 × stub + `gen-sdk` / `gen-ontology --check` + `open-repo-boundary`；岗位页多店下拉出截图；报告 `docs/briefs/reports/WP258.md`。
