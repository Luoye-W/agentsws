# WP119b 浏览器插件：完整版移植进私有仓库 + 开源仓库公开「插件开放接口」

**两个仓库，两块活（Luoye 09-19 定）：**
- **A · 私有仓库 `/Users/yeluo/Documents/agentsws-extension`**（GitHub `Luoye-W/agentsws-extension`，PRIVATE，已建好、已有首个提交；直接在它的 `main` 上分支 `wp/119b-port` 干活，不 push）：完整版插件。旧插件部分代码源自**付费模板**，授权不允许公开分发，所以**移植来的代码只许进这个私有仓库，一个字节都不许进开源仓库 `agentsws`**。在私有仓库里，`_common.md` 那条「模板自带的部分不搬」**不适用**——这里可以整块搬（含模板骨架里确实用得上的部分）；仍要在文件头注明出处。
- **B · 开源仓库 `agentsws`**（worktree `../agentsws-wt/wp119b-open-api`，分支 `wp/119b-open-api`）：把本机那一半整理成**公开的「插件开放接口」**，让任何人都能自己写 Chrome 插件（或别的采集工具）接进来；WP119 那个从零写的 `apps/extension`（没有模板代码）**留下，改定位为「参考实现」**。

## 为什么
Luoye 看了 WP119 的面板截图：「这比 KOLAgents 插件少了好多数据」。属实——旧插件卡片部分约 3500 行界面（`CreatorCaptureCard` 705、`ContactPanel` 833、`ContentCaptureCard` 877、`ValuationSection` 254、`WorkspacePanel` 257、`BioLinkCaptureStrip` 256、`AuthenticityBlock` 151、`SyncStatusPanel` 125），新插件面板只有 650 行、三个数字一个按钮。WP119 的派工单只写了「参考重做」却没把**功能对齐**写成验收，这张单补上。WP119 的架构（本机直连、配对、排队补传、权限最小化、登录即共享公共库并如实告知）**全部保留**，只补信息量与功能。

## 做法改了（Luoye 09-19）：**移植，不是对照复刻**
保留 WP119 的外壳与 `src/lib/{storage,local-client,broker,messages,wire}.ts`；把旧插件的卡片组件（`CreatorCaptureCard` / `AuthenticityBlock` / `ValuationSection` / `ContactPanel` / `WorkspacePanel` / `ContentCaptureCard` / `BioLinkCaptureStrip` / `SyncStatusPanel` / `GatedSection` / `LoginNudge` / `SearchCaptureFab` / `PanelShell` / `panelHost`）与算法（`authenticity` / `valuation` / `valuationConstants` / `localHealth` / `bioLinkCache` / `creatorFields` / `bulkCapture` / `exportRow` / `workspacePayload`，**连同 `__tests__`**）**整块搬进来**，只改：引用路径、`pluginApi` / `influencerApi` 调用换成本机服务客户端、`kolagents.com` 相关的登录与 API Key 逻辑换成配对、品牌样式换 `--ws-*` 令牌与 `@agentsws/brand`、文案里的产品名。WP119 自己重写的 `health.ts` / `counts.ts` / `bulk.ts` / `export-row.ts` 与搬来的重复时，**以搬来的为准**。许可证红线见 `_common.md`：旧插件「Initial import」那一刻就在、之后没被 Luoye 实质改写的模板文件（构建配置、`components/ui/*`、`LanguageProvider` / `LanguageSwitcher`、`GroupedModelSelector`、`useProductDetails` 这类）**不搬**；逐文件用 `git log --follow` 判断，清单写进报告。

## 先读
旧插件（只读，不读 `.env*`）：`/Users/yeluo/Documents/Browser Extension - Influencer Assistant`——`docs/PRD.md`、`docs/TECHNICAL_SPEC.md`、`src/contents/components/*.tsx`（上面八个 + `GatedSection` / `LoginNudge` / `SearchCaptureFab` / `PanelShell`）、`src/lib/{authenticity,valuation,valuationConstants,localHealth,bioLinkCache,creatorFields,bulkCapture,exportRow,workspacePayload}.ts` 及其 `__tests__`。先**装起来看一遍真实效果**不可行时，至少把每个组件渲染出的区块与字段列成一张清单。
本仓：`docs/68`、`apps/extension/**`、`apps/server/src/extension-*.ts`、`packages/api/src/routes/extension*.ts`、`packages/kol-core`（打分 / 体检 / 合并建议）、`packages/kol-public`（reveal 计费）、`docs/48` §5、`docs/36`（减字：信息要全，但靠分区与折叠，不靠堆字）。

## 交付
1. **对齐清单** `docs/68` 新增一节：旧插件每个区块 / 字段 / 动作 → 新插件状态（有 / 补 / 不做及理由）。「不做」必须有理由，默认是补。
2. **频道页面板补齐**（分区、可折叠、首屏先给结论）：红人体检（结论 + 依据）；**受众真实性**（假粉判断，算法与旧 `authenticity.ts` 同输入同输出）；**频道价值**（估值 / 合作报价参考区间，`valuation.ts` 同输入同输出，标「估算」）；指标：粉丝、均播、播放 / 粉丝、上传频率、最近 N 条视频表现（小条形图）、**粉丝趋势**（本地有历史观测就画，没有就说「再来几次就有趋势了」）；国家 / 语言 / 类目；**其他平台与外链**（从简介抓 IG / TikTok / 个人站 / Linktree，串成同一人，喂给 `kol-core` 的合并建议）。
3. **联系方式面板**：页面上找到的邮箱（用户显式点了才采）；已登录时「查看红人邮箱 · N 积分」经本机服务走云端公共库 reveal（价格取 `pricing.json`，余额不足说人话）；贡献联系方式换免费额度；本地已有联系方式的直接显示脱敏形态。
4. **视频页**：本条内容数据（播放、点赞、评论、时长、发布时间、是否带货 / 有无广告标识）、内容体检、作者速览、「存入内容库」。
5. **存入时选品牌与活动**：「收进红人库」旁可选品牌（工作区）与活动 / 候选池（从本机服务拉），记住上次选择；已在库里则显示「已在红人池 · 上次更新 X」+「更新红人数据」；「去工作台看」跳到该红人的合作线程。
6. **同步状态条**：已存入 / 已排队（应用没开）/ 已共享到公共库 / 失败原因，一行说清。
7. 搜索结果页批量采集保持现状并补：每行结果旁的小体检徽标、阈值筛选记忆。
8. 本机服务与 API 按需**只加不改**（新字段进 `extra` 或新可选字段）；送往公共库的仍是窄行（WP119 的定论不变）。
9. 测试：体检 / 真实性 / 估值三套算法与旧插件逐例对拍（把旧 `__tests__` 的用例搬成我们的夹具，数值一致）；面板各分区的渲染测试；reveal 计费与余额不足。
10. **验收证据**：同一个 YouTube 频道夹具，旧插件面板的字段清单 vs 新面板截图并排放进 `docs/68`（`docs/assets/extension/parity-*.png`）；面板首屏不超过一屏高，其余折叠。

验证：`scripts/verify-changed.sh` + `pnpm -F @agentsws/extension build`。并行提醒：WP117b 在改工作台红人界面与 `kol-core` 工具层——对 `kol-core` 只做最小追加。


## A · 私有仓库怎么起
1. 把开源仓库 `apps/extension`（WP119，我们自己的代码）整个拷进私有仓库作外壳：WXT 配置、`src/lib/{storage,local-client,broker,messages,wire}.ts`、`src/entrypoints/*`、测试与 `STORE.md`；它依赖的 `@agentsws/brand`（几何与 SVG 常量）与 `--ws-*` 令牌把用到的那几个文件拷一份进来（都是我们自己的代码）。私有仓库是独立的 pnpm 工程（不是 monorepo 的一部分），`pnpm build` 出 zip，`pnpm test` 跑 vitest。
2. 再按上面「移植」一节把旧插件的组件、算法与测试搬进来，做交付 1–7、9、10（交付 8 属于 B）。
3. 私有仓库加 `.github/workflows/release.yml`：打 tag 出 zip 挂到**私有** Release；不要任何会把源码或 sourcemap 公开的步骤；构建产物不带 sourcemap。
4. `README.md` 写清：为什么私有、与开源仓库的接口版本对应关系、怎么本地加载、怎么发版。

## B · 开源仓库：插件开放接口
1. `docs/76-插件开放接口-v1.md`：配对流程、令牌与 scope（`kol.observe` / `kol.capture` / `kol.read`）、每个端点的请求 / 返回、观测与联系方式的数据格式、幂等与排队补传语义、限流、错误码人话表、版本协商（`/v1/extension/hello` 回接口版本）、隐私规则（登录云账号即共享公开数据到公共红人库，送出去的是窄行）、一个 30 行的最小示例（配对 + 上报一条观测）。`packages/contracts/src/extension.ts`（只加）补齐 JSON Schema 并进 `openapi.json`。
2. **配对改为「配对时绑定」**：现在对 `chrome-extension://<id>` 的来源校验要让**任何**扩展都能配对——用户在工作台拿 6 位码、在哪个插件里输入，就把那个插件的 Origin 与令牌绑死；之后 Origin 与令牌必须同时对得上。工作台「浏览器插件」一节列出已配对的每个插件（名字由插件在 hello 里自报 + 扩展 id 前几位 + 配对时间 + 最近使用），逐个可吊销；非 `chrome-extension://` / `moz-extension://` 的来源一律拒（不开通配 CORS 的纪律不变）。配对表落 SQLite（WP119 留尾：内存档重启要重配）。
3. `apps/extension` 改定位：`README.md` 写明「这是开放接口的**参考实现**，功能精简；官方完整版不开源」；`docs/68` 同步（内测用户装的是官方完整版的 zip，从私有 Release 拿）；`release.yml` 里挂 zip 的那一步保留但改名为 reference。
4. 守卫测试：开源仓库里出现旧插件 / 模板特有的文件名或标识（如 `plasmo`、`CreatorCaptureCard`、`GroupedModelSelector`）即失败——防止以后有人手滑把移植代码提交到这边。
5. 交付 8（本机服务与 API 只加不改，给完整版面板要的新字段）在这边做。

两边各自 `git commit -s`、各自写报告；最终回复里分 A / B 两节。验证：B 用 `scripts/verify-changed.sh`；A 用私有仓库自己的 `pnpm test` 与 `pnpm build`。
