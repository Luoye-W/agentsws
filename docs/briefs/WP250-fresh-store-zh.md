# WP250 空 Shopify 店识别支持中文（简体 / 繁体）及其他常见语言（决策 95）

worktree `../agentsws-wt/wp250-freshzh` · 分支 `wp/250-freshzh`（从 main 新起，含 WP244）。先读 `_common.md`、WP244 报告、`packages/brand-intake/src/site.ts`（`SHOPIFY_PLACEHOLDER_NAMES`、`SHOPIFY_PLACEHOLDER_TEXT`、`fresh_store` 判定「店名占位 或 对上两句以上默认文字」）。

## 背景（Luoye 10-07）
「很多用户肯定会输入中文的，所以一开始就要把中文」支持上。现在占位店名只认 My Store / My store / My Shop，默认首页文字只认英文。

## 要做
1. **默认首页文字按 Shopify 官方本地化文案认**：以 Shopify 默认主题 Dawn 公开仓库（github.com/Shopify/dawn，MIT）的 `locales/*.schema.json` 里各区块 `default` 文案为准，对现有英文那 8 句找到同一个 key 的 zh-CN、zh-TW 版本（例：「欢迎访问我们的商店」/「歡迎來到我們的商店」、「与客户分享有关您品牌的信息……」），一并收进去；再补 ja、ko、de、fr、es 这几种常见语言（同样取官方文案）。把这些文案整理成一个数据文件（注明来源仓库、提交号、MIT），不要手编翻译。HTML 里可能带 `<p>` 等标签与全角标点，比对前先归一。
2. **占位店名**：核实 Shopify 中文 / 繁体后台新店的默认店名（查官方帮助中心 / 公开资料；查不到就写进报告并按候选「我的商店」「我的店铺」「我的商店名称」处理），收进 `SHOPIFY_PLACEHOLDER_NAMES`，比对时忽略大小写与首尾空白。
3. 「对上两句以上才算」的规则不变；中英混排页面也算（各语言命中合并计数）。
4. 测试：简体 / 繁体 / 日文默认店夹具各一（店名 + 首页 + 自动生成政策），以及一个写了「欢迎访问我们的商店」一句但其他都是真内容的正式店（不能误判）。

## 纪律
不读 .env*；不跑批量清理命令；本机 4317 服务别碰；不连远程机器；读 GitHub 公开仓库 / Shopify 公开帮助文档可以，不登录任何网站。

## 验证
`scripts/verify-changed.sh` + 模拟三包 × stub + `gen-ontology --check` + `open-repo-boundary`；报告 `docs/briefs/reports/WP250.md`（文案来源与提交号、占位店名核实结论、要 Luoye 定的事单列）。
