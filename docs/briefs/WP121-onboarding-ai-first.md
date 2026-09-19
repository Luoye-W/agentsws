# WP121 初始化设置重排：先接 AI，再填一个网址自动分析

worktree：`../agentsws-wt/wp121-onboarding`，分支 `wp/121-onboarding`。

## Luoye 定（09-19）
1. 这个产品要跑起来靠 AI，所以**初始化的第一步就让用户接 AI**：要么填自己的模型接口，要么选「**Agents 工坊官方接口**」走注册流程，**注册送 10 积分**，让用户马上能跑起来。
2. 用户进来先填基础信息的方式和 KOLAgents / KefuAgent 一样：**填官网网址或 Amazon listing 链接，我们自动做第一轮基础分析**，把品牌名等一堆东西填好；用户觉得不对再手改。目标是少让人手填。
3. 沿用上一轮的简洁原则（减字、图形化进度条）。

## 先读
`docs/46`、`docs/51`（现有向导四步：公司 / 个人 / 岗位 / 初始配置）、`docs/49`（账号与积分；`granted` 积分 90 天到期）、`docs/52`（公司 = 组织、品牌 = 工作区）、`docs/36`、`docs/64` / `docs/65`（云端两形态、后台）、`docs/briefs/WP120-role-personas.md`（persona 会用到品牌信息）；代码 `apps/workstation/src/pages/onboarding.tsx` 与 `components/onboarding/*`、`components/models/*`、`components/settings/model-cloud-card.tsx`、`apps/server/src/{cloud-account.ts,models.ts,organizations.ts}`、`packages/model-gateway`、`apps/cloud/src`（magic link、`ensureAccount`、admin topup）、`packages/metering`、`packages/knowledge`。
只读参考（不读 `.env*`）：`/Users/yeluo/Documents/KefuAgent/src/lib/support/{site-catalog.ts,site-catalog-parse.ts,branding.ts,amazon-onboarding.ts,amazon-storefront.ts}` 与它的接入向导；`/Users/yeluo/Documents/KOLAgents/src/influencer/{single-brand.ts,core-product.ts,link-brands.ts}` 与它的品牌建档流程。学它们**抽了哪些字段、分几步、怎么让用户确认**，不拷代码。

## 定论
**新的四步**（进度条仍是四格）：**① 接上 AI → ② 你的生意（贴一个网址）→ ③ 选岗位 → ④ 连接与开工**。原来的「公司设置 / 个人设置」并进 ②（分析结果里顺带确认公司名与你的称呼），不再单独占步。

### ① 接上 AI（不能跳过；没接上就不往下走，但给「先逛逛演示数据」的旁路）
两张大卡二选一：
- **用 Agents 工坊官方接口（推荐，送 10 积分）**：输邮箱 → 发登录信 → 点链接回到应用（沿用现有 magic link + 本机回环）→ 自动建云账号与组织、签工作区令牌、把各能力开关切到「用 Agents 工坊的」→ 到账 10 积分。云侧：**首次注册赠 10 `granted` 积分（90 天）**，幂等键 = account id + `signup_bonus`，同一规范化邮箱（WP115 的 `normalizeEmailAlias`）只送一次，黑名单邮箱不送，写计量事件与审计；金额数据化（`packages/metering/src/bonuses.json`），运营后台「积分与会员」里看得到这类发放。两种云形态（Compose / Workers）都要有。
- **用我自己的模型接口**：沿用现有模型表单（密钥只进本机加密库，原生表单填，不经 AI）；填完**当场打一次最小请求验证**，通了才亮「下一步」，不通说人话（密钥错 / 余额不足 / 地址不对 / 网络）。
- 顶栏那条「还没接模型」的黄条在向导期间不出现；向导完成后若仍没接（走了演示旁路）才出现。

### ② 你的生意：贴一个网址，剩下我们填
- 一个输入框：**官网网址或 Amazon 商品 / 店铺链接**（可再加一条）；另有「还没有网站」旁路（沿用 WP79 的 `none`，退回最少的手填）。
- 后台跑**第一轮基础分析**（新包 `packages/brand-intake`，端口化：抓取器 + 解析器 + 模型抽取，测试全用本地 HTML 夹具，不联网）：
  - 官网：取首页 + 关于 / 联系 / 政策页 + sitemap 或商品集合页前 N 个商品。识别建站平台（Shopify / WooCommerce / 其他）、品牌名、logo 与主色、一句话定位、品类、主打商品（名、价、图、卖点）、目标市场与语言、币种、社媒链接、客服邮箱、退换货 / 物流 / 保修政策要点、口吻样例。
  - Amazon：listing 标题、品牌、五点、A+ 要点、价格、评分与评论数、类目、变体；店铺链接则枚举前 N 个商品。**只抓公开页面**，遵守 robots 与合理频率；抓不到就说抓不到，不编。
  - 抽取走模型便宜档；每个字段带**出处（哪个网址哪一段）与把握度**；低把握的标「请确认」。用官方接口时这一步**计入那 10 积分**，开跑前显示预估（上限封顶，比如 ≤ 2 积分），超了就停。
- 结果页 = 一张**可编辑的品牌档案卡**（图形化：logo、色块、商品缩略图、标签），字段旁一个小铅笔即改；「看着没问题」一键确认。确认后写入：组织 / 品牌（工作区）名与基本信息、`packages/knowledge` 里生成首批知识条目（政策要点、商品卡，标来源「自动分析，待核」）、WP120 persona 要用的品牌上下文、各岗位首页数字块的默认币种 / 市场。任何一条之后都能在对应设置页手改；**重新分析**按钮保留（改了网址或换了新品时用），重跑不覆盖用户手改过的字段。
- 分析在后台跑（通常几十秒）：用户可以先去 ③ 选岗位，回来看结果；用呼吸标记表示「Agent 在干活」（docs/36 §12）。

### ③ 选岗位
现有 RolePicker；按 ② 的结果**预勾**（有 Shopify → 网站运营 / 客服；有 Amazon → 客服里的 Amazon 客服；有社媒链接 → 社媒运营对应渠道；都可改）。

### ④ 连接与开工
现有计划清单（按所选岗位列要连的东西，标「可选」），完成屏仍是「一队上岗了」+ 一变一队后接呼吸。

## 交付（每项一个 `git commit -s`，每项有测试）
1. `docs/70-初始化设置：先接AI与网址自动分析-v1.md`（流程、字段表、出处与把握度、隐私与抓取边界、积分封顶）；`docs/46` / `docs/51` / `docs/49` 同步。
2. 云侧注册赠送 10 积分（两形态）+ 后台可见 + 测试（幂等、别名邮箱、黑名单）。
3. `packages/brand-intake`（官网 + Amazon 两个解析器、字段契约 `packages/contracts/src/brand-intake.ts` 只加、夹具测试）+ `/v1/brand-intake/*` 接口（发起、进度、结果、确认、重新分析）。
4. 向导重排四步 + 品牌档案卡 + 官方接口注册流程 + 自有模型即时验证 + 预勾岗位；i18n 中英；截图 `docs/assets/workstation/onboarding-{ai,intake,profile}.png`。
5. 模拟场景：新用户走官方接口拿到 10 积分并完成分析；自有模型验证失败说人话；分析超预算自动停；重新分析不覆盖手改。

## 验证
通用项 + `vitest run packages/brand-intake packages/contracts packages/api packages/metering packages/knowledge apps/cloud apps/cloud-worker apps/cloud-admin apps/server apps/workstation packages/simulation` + 两个模拟包门禁；`wrangler deploy --dry-run` 过。
