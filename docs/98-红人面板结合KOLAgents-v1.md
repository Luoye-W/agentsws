# 98 · 红人面板怎么结合 KOLAgents v1（方案稿，等 Luoye 定）

| 项 | 值 |
|---|---|
| 起因 | 10-13 Luoye：「红人的面板重点可能得看 KOLAgents 那个项目，那个是我们经过好几轮迭代出来的，看看怎么结合进现在的项目里比较合适」 |
| 调研 | 只读看了 `~/Documents/KOLAgents`（Next.js 16 + shadcn + recharts 2.15 + react-query 5，基于 MkSaaS 模板；红人业务从 `d422d377` 起都是 Luoye 写的）。迭代最多的：控制中心壳 66 次提交、达人详情抽屉 40、红人池 32、找红人作战室 17、仪表盘 v2 |
| 约束 | docs/96：**要人拍板的只在卡片流，其余是组件，组件有出现 / 不出现规则，同一屏不说两遍，界面少字**；docs/48 与「移植优先于复刻」：Luoye 写的业务代码整块搬、改引用；**MkSaaS 模板自带的一律不搬** |

## 0 一句话

**搬组件和纯逻辑，不搬那个 2152 行的控制中心壳。** KOLAgents 的面板是「看板 + 达人卡 + 详情抽屉 + 会话收件箱」四件套；工坊里按 docs/96 拆开：要人拍板的（回信、建合作、寄样、付款、验收）走卡片流，其余每一块变成组件目录里的一个组件，放进岗位页的数据看板与红人工作台，各自写清什么时候出、什么时候不出。

技术上可行：两边都是 React + shadcn + recharts 2.15 + react-query 5，组件能整块搬；要换的只有 Next.js 那一层（服务端组件 → 普通组件 + 我们的接口；`nuqs` 存 URL → react-router 的 searchParams）和 `@/components/ui/*` 的引用（换成工坊自己的 shadcn 与 `--ws-*` 令牌）。

## 1 对照：KOLAgents 的每一块 → 工坊现在 → 怎么结合

| KOLAgents（文件） | 工坊现在 | 怎么结合（组件 / 卡家族 · 出现规则） |
|---|---|---|
| **分段进度条 + 停留超 7 天标黄**（`influencer/pipeline-progress.ts`、`components/influencer/pipeline-progress.tsx`；红人卡、抽屉、Campaign 侧栏、交付四处共用） | 阶段只有一行字「现在到哪一步：已建联」 | **整块搬**：逻辑进 `kol-core`，组件进工作台。候选卡、合作线程、卡片「依据」三处共用。卡住超 7 天的标黄——这正是「谁该催」的那个信号 |
| **五档紧急度色阶**（`cards/status-tier.ts`：红 要处理 / 蓝 已排期 / 黄 等对方 / 绿 进行中 / 灰 无事） | 合作线程列表每行一样的样子 | **只搬色阶**，给合作线程列表分组上色。`card-shell.tsx` 不搬——卡片流已经有自己的卡家族 |
| **会话状态由消息推导、按「需要处理」分组的收件箱**（`influencer/conversation-state.ts`、`views/conversations/*`） | 合作线程列表按阶段筛；回信在线程里、消息页另有一个文件夹 | **纯逻辑整块搬**进 `kol-core`；合作线程列表改成四组（要处理 / 等对方 / 进行中 / 其他）。「要处理」那一组每条**都对应卡片流里的一张卡**（回信草稿 = 「发出去」家族），列表上只显示状态、点了跳到卡（P1：列表上不另设回复按钮） |
| **仪表盘 v2**（`components/dashboard/v2/*`：URL 筛选条、8 个 KPI、漏斗、交付阶段条、建联 / 发布趋势、平台 / 类目 / 量级 / 邮箱健康分布、逾期临期排期 + 月历、Top 达人 CPE 表、归因三态卡、动态流） | 数据看板一行 4 个数 + 「看图表」六张表 | **搬组件，挑着放**（P2 一行 3–4 个数）：一行数保留 4 个（在谈 / 等回信 / 待审交付 / 带来收入，必要时换成「回复率」）；「看图表」里换上：漏斗卡（「处于或已越过该阶段」口径，比现在的按阶段计数好懂）、交付阶段条、**排期卡（只有逾期 / 临期才出）**、Top 达人 CPE 表、**归因三态卡**（未连接 → 顶部提醒条、等同步 → 一行、有数据 → ROI 明细）、筛选条（Campaign / 平台 / 7·30·90 天）。**动态流不搬**——和卡片流、简报重复（P5 一个数一个地方） |
| **状态条**（`dashboard/pipeline-status-strip.tsx`：「已发现 · 已联系 · 合作中 · N 条告警」，全 0 不渲染） | 没有 | **搬**，当岗位页顶上「简报」那一行的红人版（docs/96 §4.2 简报还没做成组件，先用它） |
| **红人池卡片网格**（`views/creators-view.tsx`：评分环、粉丝 / 均播 / 互动率三个「判断」色块、按阶段变的主按钮、Campaign 槽位、邮箱三态、批量评分 / 起草 / 取邮箱） | 候选池是一行一行的列表（名字 · 粉丝 · 分） | **搬达人卡**换掉列表（24 张一页、按评分分组的页签、筛选与排序）。主按钮「下一步」点了是**出卡**（起草开发信 → 开发信卡），不在卡上直接替人做决定。批量操作照搬，执行前确认框 → 结果是一批卡 |
| **达人详情抽屉**（`creator-info-card.tsx`，19 个区块） | 资料快照、联系方式、起草、合作历史 | **搬，但收字**（P6）：默认展开 评分拆解 / 账号质量估算（标「估算，非官方」）/ 阶段进度 / 联系方式三态 / 合作条款；其余（市场报价参考、受众地域、近期内容、追踪链接、折扣码……）折叠，有数据才出 |
| **Campaign 详情 + 右侧完成度与预算测算**（`views/campaigns/summary-rail.tsx`：ok / gap / review 三态、可签人数、保本单数） | 活动子视图只有向导与清单 | **搬 summary-rail**（组件）。预算测算的数字照 docs/29 走确定性规则 |
| **访谈式向导 + 七张确认卡 + 区间系数表**（`campaign-wizard/*`、`influencer/campaign-benchmarks.ts`：数字全来自系数表，AI 只写字） | 四格向导 | **系数表整块搬**进 `kol-core`（纯数据、正合 docs/29）。访谈本身改成工坊的样子：AI 在事项里一题一题问，选项用「选一个」家族卡，七张确认卡 = 「改东西」家族卡——不另造一套向导页面 |
| **找红人作战室 + 采集收件箱「重复即信号」**（`discovery-view.tsx`、`discovery-inbox-view.tsx`、`discovery/word-table.tsx`） | 插件采集有「这一批」视图，没有收件箱 | **搬收件箱逻辑**（`influencer/discovery-inbox.ts`）进候选池「插件收进来的」；词表（词 · 为什么搜 · 带回多少 · 平台搜索链接）作为找人时的一个组件 |
| 合作条款（置换 / 付费 / 佣金 / 混合 · 寄样件数）、市场报价参考 | 合作上只有预算；WP299 刚加了寄样与付款 | 条款搬成合作线程里的一块（谈成之前出）；市场报价参考要数据来源，排后 |
| 内容池、监控（话题 / 竞品 / 战略达人） | 没有 | **排后**：监控要云端数据供给（docs/48 §1.3） |

## 2 搬的办法

1. **纯逻辑**（`stages` / `pipeline-progress` / `conversation-state` / `discovery-inbox` / `campaign-benchmarks` 及其测试）→ `packages/kol-core`，文件头写出处（仓库 + 路径 + 提交）。阶段名要先对齐（见第 3 节第 2 条）。
2. **组件**（`components/influencer/**`、`components/dashboard/v2/**` 里挑中的）→ `apps/workstation/src/components/kol/`：`@/components/ui/*` 换成工坊的；颜色换 `--ws-*` 令牌；Next.js 服务端组件拆成「组件 + 我们的接口」；`nuqs` 换 react-router。
3. **数据**：不搬它的 API 与 drizzle 表。看板要的新字段（播放、CPE、逾期节点、回复率序列）加到 `KolDeckData` / `KolPort`（契约只加），数字照旧在服务端算、不经模型手。
4. **许可证红线**：只搬 Luoye 写的（`components/influencer/**`、`components/dashboard/v2/**`、`dashboard/pipeline-status-strip.tsx`、`src/influencer/*.ts`）。**不搬**：`components/ui`、`data-table`、`magicui`、`tailark`、`animate-ui`、`diceui`、`premium`、`layout`、`auth`、`settings`、`pricing`、`dashboard/{dashboard-header,dashboard-sidebar,sidebar-main,sidebar-user,upgrade-card}`、`config/sidebar-config.tsx`。**`kpi-cards.tsx` 照搬了模板 section-cards 的写法**，这一个按工坊的数字块重写。

## 3 要 Luoye 定

1. **原则：搬组件和纯逻辑、不搬控制中心壳；决定一律进卡片流**？建议同意——整页搬过来等于在工坊里再开一个 KOLAgents，和 docs/96 正面冲突。
2. **阶段名用哪一套**？KOLAgents 十段（saved → discovered → vetted → outreach_drafted → contacted → replied → negotiating → collaborating → done / rejected），工坊十段（找到 → 建联 → 回复 → 谈条件 → 谈成 → 已寄样 → 交付中 → 已交付 → 结案 / 谢绝）。建议：**合作阶段机以工坊为准**（后半段更细，和寄样 / 付款 / 验收卡对得上）；KOLAgents 前半段的「已发现 / 已通过（人工审核，淘汰要写原因）」做成**候选池里的状态**，不进合作阶段机。
3. **打分**：KOLAgents 六维（受众匹配 / 内容质量 / 品牌契合 / 互动质量 / 商业契合 / 风险，含模型）vs 工坊五项启发式（粉丝 / 互动 / 品类 / 地区 / 活跃，纯规则）。建议：**五项确定性保留为底**，「品牌契合 / 内容质量」作为可选的模型补充、标「估算」，卡上分开显示，不混成一个数。
4. **第一期范围**（建议派一单，约 WP300）：分段进度 + 停留标黄；合作线程按五档色分四组；看板换上漏斗（越过口径）/ 排期（逾期临期才出）/ Top 达人 CPE / 归因三态卡；候选池换成达人卡网格（评分环、判断色块、下一步按钮）。第二期：详情抽屉重排、条款块、summary-rail、系数表；第三期：访谈式向导（卡片化）、采集收件箱、监控与内容池。
5. **「动态流」不搬**？建议不搬——卡片流与简报已经在说同一件事。
