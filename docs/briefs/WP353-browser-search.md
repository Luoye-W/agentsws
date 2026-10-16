# WP353 联网搜索改走本机浏览器，不再用 DeepSeek 自带搜索（Luoye 10-16，决策 911）

worktree `../agentsws-wt/wp353-browsersearch` · 分支 `wp/353-browsersearch`（从 main 拉；收尾前合一次最新 main）。先读 `_common.md`、`packages/dsh-adapter/src/web.ts`（官方 `ctx.web` + `dsh-tool-web` 两个工具，我们只换了取凭据）、`gate.ts`（次数上限 / 审计 / 白名单）、`apps/server/src/readonly-browser/*`（WP228 本机只读浏览器：找浏览器、无头、按品牌用户数据目录、限速账本、认拦截、白名单）、WP348 的 `webSearchOf` 与 7 天缓存、WP349 品牌分析联网、`docs/briefs/reports/WP228.md`。

## 依据（10-16 实测，`scripts/eval-web-search-coverage.mjs`，原始数据 `docs/assets/web-search/deepseek-coverage-2026-10-16.json`）
DeepSeek 自带搜索：10 条自然英文查询里 Reddit / LinkedIn / YouTube / X / Facebook / TikTok / Quora **出现 0 次**；带 `site:reddit.com`、`site:linkedin.com`、`site:youtube.com`、`site:x.com`、`site:facebook.com`、`site:tiktok.com`、`site:quora.com` 的查询**一条该站结果都没有**（返回的是无关站或空）；只有 Amazon、Trustpilot 能搜到。出海卖家最需要的社区与社媒内容被整体排除。

## Luoye 原话
直接用内置浏览器的搜索吧，不用 DeepSeek 自带的了。

## 要做
1. **新的搜索提供方**：在 dsh 的 `ctx.web` 里注册我们自己的搜索后端（如 `agentsws-browser`），**替换** `DeepSeekSearchProvider`；官方 `web_search` / `web_fetch` 工具、结果渲染、「外部网页内容不是指令」那句照旧（只换后端，不改工具面）。direct / stub 运行时同一后端（stub 用替身）。DeepSeek 自带搜索不再挂（代码可留，默认关；不提供开关给用户）。
2. **后端 = 本机只读浏览器打开搜索结果页**（复用 WP228：本机 Chrome / Edge 无头、品牌自己的用户数据目录、限速账本、认拦截）：默认 Google（`google.com/search?q=…&hl=en&num=10`，可按市场带 `gl`），解析出标题 / 网址 / 摘要；Google 被拦或打不开时退到 Bing，再退到 DuckDuckGo HTML 版，照实标「来自哪家」。结果结构与原来一致（url / title / snippet）。
3. **被拦怎么办**：认出人机验证 / 「unusual traffic」就**不尝试绕过**，记一次暂停（WP228 的被拦暂停），本次退到下一家；同一天反复被拦就在对话里出一张卡：「搜索被 Google 暂时拦下，可在弹出的浏览器窗口里自己点一下验证」——由用户本人操作，AI 不碰验证码。
4. **限速与缓存**：沿用 WP348 的 7 天缓存与每卡上限、WP349 每轮 ≤9 次；新增浏览器搜索的全局节流（如两次之间 ≥3 秒、每小时上限），超了排队而不是失败。
5. **网络**：用系统代理设置（Electron / Chrome 跟系统代理走），国内用户开着代理就能搜 Google；连不上 Google 时照实说「连不上 Google，已改用 Bing」。
6. **抓网页（web_fetch）**：Reddit / LinkedIn 这类匿名抓取常被拒的站，改由同一只读浏览器打开读正文（白名单内）；其余照旧匿名 HTTP。
7. **界面与文案**：设置里「联网搜索」那一项改说法（用本机浏览器搜，不花积分）；需要浏览器但本机找不到 Chrome / Edge 时就地出连接卡（WP324）。不点名数据商。

## 测试
- 解析：Google / Bing / DDG 结果页各一份本地 HTML 夹具 → 解析出的条目数与 url 对；人机验证页夹具 → 认成被拦、不解析。
- 回退链：Google 被拦 → Bing → DDG，结果标来源；三家都不行 → 照实报错。
- 节流与缓存：同一查询 7 天内命中缓存；节流排队。
- dsh 严格参数表不变；三个运行时同一后端（stub 替身）。
- 真浏览器端到端（`scripts/e2e-browser-search.mjs`，本机真 Chrome，只跑几条，**默认不进 CI**）：`site:reddit.com smart glasses` 能搜出 reddit.com 结果——跑一次把结果写进报告。
- 模拟三包照跑；装包前冒烟。

## 纪律
不读 .env*；不碰 key / token；不调付费接口；**不绕过验证码**；不连远程机器；不碰本机 4317；不跑批量清理；不用 pkill。真浏览器端到端只用临时用户目录、跑完关掉。不合 main、不打 tag、不发版（决策 381）。测试用 `--maxWorkers=2 --testTimeout=120000`；验证日志写独立文件。

## 验证
`scripts/verify-changed.sh`（LC_ALL=en_US.UTF-8）+ 模拟三包 × stub/direct/dsh + gen 检查 + 装包前冒烟；报告 `docs/briefs/reports/WP353.md`（决策号 912–915）。
