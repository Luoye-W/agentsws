# WP193 Agents 工坊官网：先出设计（参考 KOLAgents 官网）

worktree `../agentsws-wt/wp193-site-design` · 分支 `wp/193-site-design`（从 main 新起）。先读 `_common.md`、`docs/36`（界面规矩与少字）、`docs/03` 末尾与 `docs/32`（产品定位）、`README.md`、WP112 品牌（`BrandMark` 六块标记、品牌色与字体 token，`apps/workstation` 的 tokens）、`docs/49`（账号与积分）、`docs/83`（云端、充值档位）、`docs/help/*`（教程文章，将来官网文档区的内容来源）。

## 背景（Luoye 09-29）
「Agents 工坊的官网也还没做，我们可以参考 KOLAgents 官网来做。可以先出设计。」

## 参考对象
KOLAgents 官网：线上 `https://kolagents.com`（只看公开页面，不登录、不注册），本机源码 `~/Documents/KOLAgents`（`src/app/[locale]`、`src/components/blocks/*`：hero-split、product-tabs、flow-rail、compare-grid、extension-section、mcp-terminal、stance-dial、trust-grid、founder-note、pricing-section、faq-section、final-cta、announcement-bar 等；文案在 `messages/`）。
**许可证红线**：KOLAgents 基于 MkSaaS 商业模板——**不许拷它的任何代码、组件、样式文件进本仓**；只学页面结构、叙事顺序、信息密度与 Luoye 自己写的文案思路。本仓产出的一切是原创设计。

## 要做（这一单只出设计，不写官网代码）
1. `docs/87-官网设计-v1.md`：
   - KOLAgents 官网拆解（每一屏讲什么、为什么有效、哪些适合 Agents 工坊、哪些不适合）；
   - 站点地图（首页、岗位 / 功能、价格与积分、下载、文档 / 教程、博客 / 更新日志、开源与 GitHub、登录 / 控制台入口）、中英双语；
   - 首页逐屏的文案（中文为主，给英文），讲清：本地优先、跨境电商岗位（客服、红人、社媒、B2B、投放、建站……）、「岗位 + 出卡审批」、DeepSeek Harness 底座、开源 Apache-2.0、Agents 工坊（用积分）；少字、不堆术语；
   - 技术选型建议（放哪个仓：官网是不是开源、用什么框架、部署在 Cloudflare 还是别处、与 `cloud.agentsws.com` 的登录 / 充值怎么衔接、文档区怎么复用 `docs/help`），列要 Luoye 定的事（域名、放不放开源仓等）。
2. **可看的设计稿**：`docs/design/site/` 下的静态 HTML（单文件、内联样式、不引外部脚本；字体只用 Google Fonts），至少：首页（桌面 1440 宽与手机 390 宽两版）、价格页、下载页；配色 / 字体 / 标记全部用 WP112 已定的品牌 token，明暗两套；插图用产品真截图（`docs/assets/**` 已有的）或纯 CSS 示意，不用来路不明的图。再给首页出一个**风格对比的第二方向**（同内容、不同视觉），供 Luoye 挑。
3. 每张稿截图（`docs/design/site/shots/*.png`，用 Playwright 或仓库已有的截图工具）。

## 纪律
不写官网实现代码；不拷 KOLAgents / MkSaaS 的代码与样式；不读 .env*；不跑批量清理命令；本机 4317 的服务别碰。

## 验证
`scripts/open-repo-boundary.test.mjs`（vitest）过；biome 不查 html 就不用管；报告 `docs/briefs/reports/WP193.md`。
