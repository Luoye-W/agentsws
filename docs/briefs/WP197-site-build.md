# WP197 官网实现（开源仓 `apps/site`，方向 A）

worktree `../agentsws-wt/wp197-site` · 分支 `wp/197-site`（从 main 新起）。先读 `_common.md`、`docs/87`（官网设计全文，§3 / §3.1 文案、§5 选型、§6 动效、§8 决定）、`docs/design/site/{home,pricing,download}.html`（A 稿，是视觉真源）、`docs/design/brand-motion.html` 与 `packages/brand`（WP195 待机「波 + 流光」、assemble、split 的参数与 `BRAND_MARK_SVG_IDLE_*`）、`docs/help/*`（中英教程 22 篇）、`docs/42`（引第三方依赖的评估规矩）、docs/35 里 09-29 官网七项决定与「开源范围只含公开页面」那条。

## 定了的（Luoye 09-29）
- 方向 **A**（纸与绿，并入 B 的大号动态标记）；域名 **agentsws.com 根域**；**放开源仓**，但**只放公开页面**：首页、岗位 / 功能、价格（公开价目）、下载、教程文档、更新日志、条款 / 隐私 / 退款政策。**任何登录、账号、充值、用量、后台的页面与代码一律不进**——「登录 / 账号 / 充值」只是链接，跳 `https://cloud.agentsws.com`。
- 浏览器插件**先在官网放下载包**（不上应用店）；**「做这个的人」一屏不做**；条款与隐私 **Fable 起草**（由你按下面写）。
- 首屏标题暂用「面板会吃灰。这队 AI 同事，天天上班。」；「为什么」总括暂用「从给人用的工具，到替公司干活的队伍。」（候选都留在 docs/87，文案集中在一处，换一行就能改）。

## 要做
1. **框架**：按 docs/87 §5 的建议（Astro + Starlight 做文档区；如评估后有更合适的就写理由）——新依赖照 docs/42 写评估（许可证、体积、维护、出网），**不引任何商业模板**。静态产物，零后端；中文在 `/`、英文在 `/en/`，不按浏览器语言自动跳。
2. **页面**：首页（照 A 稿，含「为什么」四级台阶滚动点亮与底座分层图、首屏大号动态标记）、岗位 / 功能、价格（**价目只从云上公开接口 `GET https://cloud.agentsws.com/v1/pricing` 构建时取**，取不到就用仓库里的样例并标「以控制台为准」；不写死单价）、下载（桌面安装包 + 浏览器插件包：读一份 `downloads.json` 清单——版本、平台、链接、sha256、大小——链接这一单先留占位，托管位置上线前 Fable 定）、文档区（直接渲染 `docs/help/*`，不复制一份）、更新日志（从 docs/35 挑对外能说的写成人话，另起 `apps/site/src/content/changelog/`，不自动搬 docs/35）、404。
3. **动效**：品牌标记全部用 `@agentsws/brand` 导出的同一套（待机 wave-sheen、assemble、split），不在站点里另写一套；`prefers-reduced-motion` 一律静态；页面隐藏时暂停。
4. **条款与政策**（中英）：用户条款、隐私政策、退款政策三页。要点：本地优先（业务数据默认在用户电脑里）、上云的部分（账号、积分钱包、用户开启的云功能与长程任务数据）、第三方处理方（模型提供方、支付方 Waffo、Cloudflare 等，写类别与用途）、Cookie（只写实际用到的）、积分规则（1 积分 = ¥1 口径照 docs/49；充值积分不过期、赠送积分按规则过期）、**退款口径照 WP190**（冲回未用部分、部分退款按比例、已用掉的不追；拒付处理）、开源许可证与商标政策的关系、适用法律与联系方式。**运营主体公司全称留占位 `{{OPERATOR_LEGAL_NAME}}`**；每页顶部注「上线前建议律师审阅」只放在仓库的源文件注释里，不出现在页面上。不抄任何模板或别家条款原文。
5. **SEO 与分享**：每页 title / description / OG 图（用品牌标记生成的静态图）、sitemap、robots、canonical、hreflang。
6. **性能**：首屏 JS 尽量少（动效用 CSS），图片走构建优化；Lighthouse 移动端性能 ≥ 90、可访问性 ≥ 95（截图附报告）。
7. **构建与部署准备**：`pnpm --filter @agentsws/site build` 出纯静态目录；写好 Cloudflare（Workers 静态资源或 Pages，二选一写理由）的配置文件与 README 部署步骤，**这一单不部署、不建任何 Cloudflare 资源、不动 DNS**——上线前 Fable 找 Luoye 确认。
8. CI：站点构建加进现有 CI（只构建，不部署）；`open-repo-boundary` 仍过（站点不许 import 云端代码）。

## 纪律
不拷 KOLAgents / MkSaaS 任何代码与样式；不读 .env*；不跑批量清理命令；本机 4317 服务别碰；不部署不发布。

## 验证
`scripts/verify-changed.sh` + 站点构建 + fast 模拟三包 stub 零漂移 + `gen-ontology --check` + `open-repo-boundary`；截图：首页（桌面 / 手机、明 / 暗）、价格、下载、文档区一篇、条款一页；Lighthouse 报告；报告 `docs/briefs/reports/WP197.md`。
