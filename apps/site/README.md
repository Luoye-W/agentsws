# apps/site · 官网 agentsws.com

Agents 工坊的官网。**只放公开页面**：首页、岗位、价格（公开价目）、下载、教程文档、更新日志、用户条款 / 隐私政策 / 退款政策、404。
登录、账号、充值、用量、运营后台**一律不在这里**——官网上的「登录 / 积分与充值」只是跳 `https://cloud.agentsws.com` 的链接（那边在私有仓）。

- 设计真源：内部设计稿（方向 A「纸与绿」，不在本仓）
- 纯静态：Astro 出 HTML，零后端、零客户端框架；全站只有一段约 2 KB 的内联脚本（明暗切换、标记姿态、「为什么」逐级点亮）
- 中文在 `/`，英文在 `/en/`，同一套路径，**不按浏览器语言自动跳**

## 目录

| 路径 | 是什么 |
|---|---|
| `src/i18n/*.ts` | **全站文案**（中英并排）。换首屏标题只改 `home.ts` 一行 |
| `src/config.ts` | 域名、云端链接、GitHub 链接、运营主体全称、联系邮箱（contact@agentsws.com）、**条款生效日期（占位，上线当天填）** |
| `src/views/*.astro` | 各页；`src/pages/[...locale]/` 里每页一个薄壳（`locale` 为空 = 中文，`en` = 英文） |
| `src/components/Mark.astro` | 品牌标记——一律出自 `@agentsws/brand`（集结 / 一变一队 / 呼吸 / 待机 wave-sheen），站点里不另写几何与参数 |
| `src/lib/markdown.ts` | 安全 markdown → HTML（移植自工作台 `SafeMarkdown`：不解析 HTML、不加载图片、链接只认三种） |
| `src/lib/help.ts` | 文档区：直接读仓库的 `docs/help/*.md`，目录顺序照工作台 `HELP_SLUGS` |
| `src/lib/pricing.ts` · `src/data/pricing-build.ts` | 价目：构建时取 `GET https://cloud.agentsws.com/v1/pricing`，取不到用 `packages/stand-ins` 的样例并标「以控制台为准」 |
| `src/data/downloads.json` | 下载清单的**兜底**那份：版本、平台、链接、sha256、大小（链接为 `null` 时页面显示「即将提供」）。构建时先取 `https://dl.agentsws.com/downloads.json`（发版流水线每次发版更新它，`src/data/downloads-build.ts`），取不到 / 不合格才用这份；首页「下载」按钮对 Windows 访客直接给最新安装包 |
| `src/content/changelog/` | 更新日志，一条一个文件（`<日期>-<名字>.md` + `.en.md`），挑用户感受得到的变化写成人话（不写内部编号、不写客户名） |
| `src/content/legal/` | 条款三页（中英）。源文件顶部的 HTML 注释只给改稿的人看，不上页面 |
| `src/assets/app/` | 首页与岗位页用的工作台截图（`scripts/app-shots.mjs` 从演示世界重拍） |
| `public/og/` | 分享图（`scripts/og.mjs` 用品牌标记生成，签进仓库） |
| `public/_headers` | 响应头（安全头、缓存） |
| `wrangler.jsonc` | Cloudflare 部署配置（见下） |

## 本地

```bash
pnpm --filter @agentsws/site dev        # 开发服务器
pnpm --filter @agentsws/site build      # 出 apps/site/dist（纯静态）
AGENTSWS_SITE_OFFLINE=1 pnpm --filter @agentsws/site build   # 不打网，价目用仓库样例
node apps/site/scripts/serve.mjs        # 本机起 dist（只听 127.0.0.1）
node apps/site/scripts/shots.mjs        # 审稿截图 → docs/assets/wp197/（本地，不进仓库）
node apps/site/scripts/og.mjs           # 重出分享图（改了 OG 标题或标记之后）
node apps/site/scripts/app-shots.mjs    # 重拍工作台截图（官网与 README 共用；先编好 apps/cli 与工作台；本进程里起 demo，默认端口 4861）
pnpm --filter @agentsws/site launch:check   # 上线前：dist 里不许剩占位，条款 / 联系邮箱 / 价格都在
```

Astro 默认的两处出网都关掉了（`scripts/astro.mjs`：匿名遥测 `ASTRO_TELEMETRY_DISABLED=1`、dev 查新版本 `ASTRO_DISABLE_UPDATE_CHECK=true`）。构建的出网只有两次：取一次公开价目、取一次下载清单（`AGENTSWS_SITE_OFFLINE=1` 两样都不取）。

## 部署（Cloudflare Workers 静态资源）

**为什么选 Workers 静态资源，不选 Pages**：Cloudflare 现在给新项目推荐的是 Workers 静态资源，新能力也优先落在 Workers 这边；
我们的云端本来就在 Workers 上，同一套 `wrangler` 与账号；官网是 assets-only 的 Worker，没有脚本、不计请求费，
`_headers`、404 页、结尾斜杠处理都是静态资源原生支持的。

上线步骤（由维护者确认后执行）：

1. `pnpm --filter @agentsws/site build`，看一眼 `dist/`；
2. 校验配置：`pnpm --filter @agentsws/site deploy:check`（`wrangler deploy --dry-run`，不上传）；
3. 上线当天把 `src/config.ts` 的 `LEGAL_EFFECTIVE_DATE` 从 `{{EFFECTIVE_DATE}}` 改成当天日期，重新 build，再跑 `launch:check`（剩占位就红）；条款请律师过一遍；
4. 打开 `wrangler.jsonc` 里 `routes` 那几行（agentsws.com 与 www 走 custom domain——这一步会建 DNS 记录）；
5. `pnpm --filter @agentsws/site exec wrangler deploy`；
6. 打开 https://agentsws.com/ 与 `/en/` 各点一遍，看 404、`/sitemap.xml`、`/robots.txt`。

回滚：`wrangler rollback`（静态资源同样按版本回退）。
