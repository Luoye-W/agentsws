# 交接板：Fable（派活 + 终审）⇄ 实现方（现在是 Proma）

**实现方只要读这一个文件就能开工。** Fable 的额度很紧，所以交接全部走文件，不走对话。

## 你（实现方）怎么干
1. 读 `docs/briefs/_common.md`（通用约定，必须全部遵守；其中「小步输出」那条可忽略）。
2. 在下面「队列」里从上往下找第一条状态是 **待做** 或 **续做** 的，读它的派工单，把状态改成 **进行中**。
3. 在它指定的 worktree / 分支里干活（**续做**的 worktree 已存在，里面最后一个 `wip:` 提交是上一位的半成品，未验证——先 `git merge main`、`pnpm install`、跑 `scripts/verify-changed.sh` 看红在哪，能用的接着用；**待做**的自己建：`git worktree add <目录> -b <分支> main`）。**绝不在主仓目录 `/Users/yeluo/Documents/agentsws` 里改代码、绝不 push、绝不打 tag、绝不部署。**
4. 验证只用 `scripts/verify-changed.sh`（+ 派工单点名的门禁）；全量测试由 Fable 在合并关口跑。
5. 做完：`git merge main` → 在**分支上**写 `docs/briefs/reports/<WP编号>.md`（八节：实现清单 / 自主决定 / 需要 Luoye 定的事 / 测试结果 / 偏离 / 未完成 / 分支与提交 / 截图路径）并提交 → 回到这个文件把状态改成 **待审**（这一处改动直接改主仓的这个文件即可，这是唯一允许碰主仓的地方，改完不用提交）。
6. 接着做下一条。一次只做一条；每条之间不用等 Fable。
7. 拿不准的事：按派工单与 `_common.md` 自己判断，写进报告的「偏离」；真正要 Luoye 拍板的写进「需要 Luoye 定的事」，别停下来等。

## Luoye 怎么用
- 对 Proma 说一句：**「读 `~/Documents/agentsws/docs/briefs/HANDOFF.md`，照它做。」** 之后不用传话。
- Fable 那边有一个后台脚本（`scripts/watch-handoff.sh`，纯 shell、不花额度）每 2 分钟看一次这张表：某条变成 **待审**（或分支上出现了它的报告）就自动开始终审——读报告 → 查改动 → 跑全量 → 合并 → 把状态改成 **已合并** 或 **退回**（退回原因写在这张表下面的「退回」一节，实现方看到后接着改）。
- 只有需要 Luoye 拍板的事，Fable 才会找他。

## 分工（09-19 晚，Luoye 定）
- 09-23 起实现方回到 **Claude 子代理（Opus）**，由 Fable 直接派；Proma 不再需要领活。
- 百炼额度已用尽（09-19 夜），Qwen 停了。**队列里所有「续做 / 待做」的条目，任何实现方都可以按顺序接**；WP119b 的 A 部分在私有仓库 `~/Documents/agentsws-extension` 的 `wp/119b-port` 分支上已有 6 个提交。

## 队列（从上往下做；「依赖」没合并的先跳过）
| 顺序 | WP | 派工单 | worktree（都在 `/Users/yeluo/Documents/agentsws-wt/` 下）· 分支 | 依赖 | 状态 |
|---|---|---|---|---|---|
| 1 | WP117b 红人主线在界面上走通 + 点击级证据 | `docs/66` 末尾「复测」#15–#20 + `WP117-kol-e2e-sandbox.md` | `wp117b-kol-mainline` · `wp/117b-kol-mainline` | — | 已合并（09-19，Fable 终审：全量过 + e2e 在 main 上重跑 19 步全过） |
| 2 | WP121b 初始化向导重排 | `WP121b-onboarding-wizard.md` | `wp121b-wizard` · `wp/121b-wizard` | — | 已合并（09-19 夜，Fable 终审：全量过） |
| 3 | WP120 岗位与职责的角色定位 | `WP120-role-personas.md` | `wp120-personas` · `wp/120-personas` | — | 已合并（09-20，Fable 终审：全量过） |
| 4 | WP118 红人营销增值服务 + 充值四档（订阅引擎做成通用的，客服增值服务只登记） | `WP118-kol-cloud-service.md` | `wp118-kol-cloud` · `wp/118-kol-cloud` | — | 已合并（09-20，Fable 终审：全量过） |
| 5 | WP122 品牌设计规范 DESIGN.md | `WP122-brand-design-md.md` | `wp122-design-md` · `wp/122-design-md` | — | 已合并（09-20，Fable 终审：地基；后半见 WP122b） |
| 6 | WP119b 插件：A 私有仓库移植 + B 开源仓库插件开放接口 | `WP119b-extension-parity.md` | A：`/Users/yeluo/Documents/agentsws-extension`（分支 `wp/119b-port`）；B：`wp119b-open-api` · `wp/119b-open-api` | — | 已合并（09-21，Fable 终审：B 开放接口全量过；A 私有仓库 337 测试过、已并入其 main） |
| 7 | WP126 数据接口路由 + 自带数据接口 + 官方接口命中也收费 | `WP126-data-routing-byo-source.md` | `wp126-data-routing` · `wp/126-data-routing` | WP117b 已合并 ✓ | 已合并（09-23，Fable 终审：全量过） |
| 8 | WP124 在线聊天三条路 | `WP124-live-chat-three-ways.md`（以文件里「修订」一节为准） | `wp124-live-chat` · `wp/124-live-chat` | WP118 已合并 ✓ | 已合并（09-23，Fable 终审：全量过；合并时补了 tsconfig 引用与 CHAT_RELAY 绑定） |
| 9 | WP122b 设计规范：三个注入口通电 + 岗位只读 + 小铅笔 + 成文接模型 + 视觉档 | `WP122b-design-md-wire-up.md` | `wp122b-design-wire` · `wp/122b-design-wire` | — | 已合并（09-23，Fable 终审：全量过） |
| 10 | WP119c 插件完整版要的本机接口 + 面板接线（没有它完整版面板大半是空壳） | `WP119c-extension-endpoints.md` | 开源 `wp119c-ext-endpoints` · `wp/119c-ext-endpoints`；私有仓库分支 `wp/119c-wire` | — | 已合并（09-23，Fable 终审：开源全量过；私有仓库 350 测试过、已并入其 main） |
| 11 | WP127 模型必须多模态（能看图）+ 生图单独一档 | `WP127-vision-required-and-image-model.md` | `wp127-vision` · `wp/127-vision` | — | 已合并（09-23，Fable 终审：全量过；合并时把各模型卡默认型号换成能看图的） |
| 12 | WP128 客服增值服务托管实例 = Cloudflare Containers | `WP128-hosted-instance-cloudflare-containers.md` | `wp128-hosted` · `wp/128-hosted` | — | 已合并（09-23，Fable 终审：全量过；真部署未跑） |
| 13 | WP129 内容观测上云 + 体检样本不够不收钱 | `WP129-content-observations-cloud.md` | `wp129-content-cloud` · `wp/129-content-cloud` | — | 已合并（09-23，Fable 终审：全量过） |
| 14 | WP130 插件采集范围补齐：YouTube 搜索页 / 相关视频栏、IG 与 TikTok 搜索列表与 hashtag（移植） | `WP130-extension-capture-parity.md` | 私有仓库 `wp/130-capture`；开源 `wp130-ext-capture` · `wp/130-ext-capture` | — | 已合并（09-23，Fable 终审：开源全量过；私有仓库 390 测试 + 新旧对拍过，已并入其 main） |
| 15 | WP131 插件收尾六条（标题可选 / 列表页换算上云 / 自动评分接上 / 深链回本地页）+ 积分价目重算表 docs/77 | `WP131-plugin-followups-and-repricing.md` | 开源 `wp131-repricing` · `wp/131-repricing`；私有 `wp/131-plugin` | — | 已合并（09-23，Fable 终审：开源全量过；私有 416 测试 + 对拍过，已并入其 main） |
| 16 | WP132 dsh 升级 0.1.6-alpha.2 → 0.1.7-rc.1（照 docs/42 七步；附「0.1.7 官方化了我们哪些自研」清单） | `WP132-dsh-0.1.7.md` | `wp132-dsh` · `wp/132-dsh` | — | 已合并（09-24，Fable 终审：全量过，dsh 运行时两包门禁过，指标零漂移） |
| 17 | WP133 dsh 两条小收尾：profile 锁定可校验（--dump-config-schema）+ session.eventAt() → read() | `WP133-dsh-followups.md` | `wp133-dsh-follow` · `wp/133-dsh-follow` | — | 已合并（09-24，Fable 终审：全量过，dsh 两包门禁过，指纹零漂移） |
| 18 | WP134 第三种模型来源：用 DeepSeek 账号登录（dsh 官方模块；默认关、选中才开） | `WP134-deepseek-account-login.md` | `wp134-deepseek-login` · `wp/134-deepseek-login` | — | 已合并（09-24，Fable 终审：全量 250 文件 4021 条过，六组模拟门禁过，没选时零漂移；凭据目录与 WP136 统一见下条） |
| 19 | WP135 内测前客服线与红人线全流程走查（只出 docs/78 差距清单与可重跑脚本） | `WP135-beta-walkthrough.md` | `wp135-walkthrough` · `wp/135-walkthrough` | — | 已合并（09-24，Fable 终审：只加文档 / 脚本 / 截图；阻断 7 条拆成 WP138–142） |
| 20 | WP136 在 Agents 工坊里切换 dsh 场景（Profile）：列表 / 启动官方与自建场景 / 私有 DSH_HOME / 边界说明 | `WP136-dsh-scene-switcher.md` | `wp136-dsh-scenes` · `wp/136-dsh-scenes` | — | 已合并（09-24，Fable 终审：全量 254 文件 4058 条过，六组模拟门禁过；合并时把 WP134 的 DeepSeek 凭据库并到同一个 DSH_HOME） |
| 21 | **WP137（P0 安全）聊天转发三种形态的密钥兜底改成没有真密钥就拒绝** | `WP137-relay-secret-fail-closed.md` | `wp137-relay-secret` · `wp/137-relay-secret` | — | 已合并并上线（09-24，生产 health 两项 true、冒烟 11/0） |
| 22 | WP138 向导建出来的职责有范围；空范围不再挡红人工作台与聊天入口（docs/78 #1） | `WP138-scope-for-wizard-positions.md` | `wp138-scope` · `wp/138-scope` | — | 已合并（09-24，Fable 终审：新范围「整个品牌」判权与 workspace 档同句、只许挂本工作区；243 文件 3133 条过，六组模拟门禁过；走查 12/41/42/43 通） |
| 23 | WP139 独立页面按能力挑分配、403 / 501 分开说、聊天窗常驻入口、整页报错留左栏（#2） | `WP139-standalone-pages-identity.md` | `wp139-identity` · `wp/139-identity` | — | 已合并（09-24，Fable 终审：只动工作台与走查脚本；tsc / biome / 生成物零漂移，工作台 + server + api 193 文件 2489 条过；走查 32/33/42/43 通） |
| 24 | WP140 demo：限流走墙钟、云账号替身、种子对齐、藏四个没做的面板、走查一次跑完（#3、#6 demo 部分） | `WP140-demo-fixes.md` | `wp140-demo` · `wp/140-demo` | — | 已合并（09-24，Fable 终审：200 文件 2553 条过，六组模拟门禁过；走查一个 demo 跑完 通 33 / 部分 18 / 不通 0） |
| 25 | WP141 牌堆能直接找到后面的卡 + 屏幕裸值与卡数口径（#4、§2） | `WP141-deck-and-copy.md` | `wp141-deck` · `wp/141-deck` | — | 已合并（09-24，Fable 终审：240 文件 3083 条过，六组模拟门禁过；走查一个 demo 通 38 / 部分 13 / 不通 0） |
| 26 | WP142 红人为主的第一步：按主要目的预勾、第 ④ 步只列必需、找人回话、云账号反馈、没关联也看得到价（#5–#7） | `WP142-kol-first-steps.md` | `wp142-kol-first` · `wp/142-kol-first` | WP138 | 已合并（09-24，Fable 终审：206 文件过（rail-registry 一条满负载偶发，单跑与整组重跑均过），六组模拟门禁过；走查 通 49 / 部分 2 / 不通 0） |
| 27 | WP143 DeepSeek 图片走 Files API 复用 + 推理内容回传（移植官方 dsh-llm-deepseek）；评估 API key 那一路改走 Messages | `WP143-deepseek-files-api.md` | `wp143-ds-files` · `wp/143-ds-files` | — | 已合并（09-24，Fable 终审：167 文件 2768 条过，六组模拟门禁过；API key 走 Messages 默认关） |
| 28 | WP144 电脑操控：官方 dsh-computer-use + Cua Driver MCP 提供方，默认关、按职责开、每次运行先授权，跟官方同步升级 | `WP144-computer-use.md` | `wp144-computer-use` · `wp/144-computer-use` | — | 已合并（09-24，Fable 终审：291 文件 4633 条过，六组模拟门禁过，默认关时零漂移；真机步骤待 Luoye 在场） |
| 29 | WP145 语音转写留「本机识别器」的口（对齐官方 ctx.speechToText，不打包不下载） | `WP145-speech-slot.md` | `wp145-speech-slot` · `wp/145-speech-slot` | — | 已合并（09-24，Fable 终审：128 文件 1594 条过，fast 模拟零漂移；只接了会议一处，云端与自带 key 合成一个识别器） |
| 30 | WP146 连接器运行时镜像钉版本（tag + digest）+ 进上游哨兵（W39 评估找回的建议） | `WP146-pin-open-connector.md` | `wp146-oc-pin` · `wp/146-oc-pin` | — | 已合并（09-24，Fable 终审：connect-adapter 117 条过、上游登记表测试 101 条过、check-upstreams 对账一致；钉 v1.6.5） |
| 31 | WP147 截图给 AI 看：打通工具结果图片进模型（电脑操控 + 两种浏览器），隐私告知 | `WP147-screenshots-to-model.md` | `wp147-screenshots` · `wp/147-screenshots` | — | 已合并（09-24，Fable 终审：259 文件 3907 条过，六组模拟门禁过） |
| 32 | WP148 带浏览器的运行改走 dsh 运行时（服务端真能用浏览器、看截图）+ 安装包第三方许可证说明 | `WP148-browser-runs-on-dsh.md` | `wp148-browser-dsh` · `wp/148-browser-dsh` | — | 已合并（09-24，Fable 终审：172 文件 2945 条过，六组模拟零漂移；合并时补了步数上限与许可证全文） |
| 33 | WP149 dsh 升级 0.1.7-rc.1 → 0.1.7-rc.2（照 docs/42 七步；列上游全部包；附「官方化 / 新出了什么」清单） | `WP149-dsh-0.1.7-rc.2.md` | `wp149-dsh-rc2` · `wp/149-dsh-rc2` | — | 已合并（09-25，Fable 终审：278 文件 4094 条过，六组模拟门禁过、1428 指标零漂移） |
| 34 | WP150 DeepSeek 账号登录跟上官方 rc.2：失效自动登出并提示、退出前确认并停掉账号任务 | `WP150-deepseek-account-lifecycle.md` | `wp150-ds-account` · `wp/150-ds-account` | — | 已合并（09-25，Fable 终审：241 文件 3605 条过，六组模拟门禁过；合并时顺带修了「启动后才接模型一直跑替身」） |
| 35 | WP151 DeepSeek 余额不足：说人话 + 去充值（账号路 / key 路分开引导） | `WP151-deepseek-balance-insufficient.md` | `wp151-ds-balance` · `wp/151-ds-balance` | — | 已合并（09-26，Fable 终审：237 文件 3573 条过，六组模拟门禁过） |
| 36 | WP152 DeepSeek 两种连接合成一张卡（官方 API 接口连接 / 官方账户登录，用户自选） | `WP152-deepseek-one-card.md` | `wp152-ds-card` · `wp/152-ds-card` | — | 已合并（09-26，Fable 终审：工作台 824 条 + server / model-gateway 1558 条过，六组模拟门禁过；合并时补了默认方案两条规则） |
| 37 | WP153 真账号冒烟三个小问题：回答露工具名与 markdown、事项摘要跑题、店主查不到岗位与连接 | `WP153-reply-quality-three-fixes.md` | `wp153-reply-fixes` · `wp/153-reply-fixes` | — | 已合并（09-26，Fable 终审：266 文件 3987 条过，六组模拟门禁过） |
| 38 | WP154 「内容与博客」升级成「内容与搜索」：GSC 每日六信号 → 每天 5 件事卡、先修再写、订单归因、GEO 每周探测、内容质检门禁 | `WP154-content-and-search.md` | `wp154-content-search` · `wp/154-content-search` | 契约与 WP155 共用（WP155 先合） | 已合并（09-26，Fable 终审：从零构建过；9 条服务端测试在满负载下超时，单独重跑全过；六组模拟门禁过、dtc-3c-3p 63 场景；合并时把 txn 改写口改成 fail-closed） |
| 39 | WP155 第三方搜索数据接口：SERP + 主流 AI 平台问答探测（选服务商、契约、官方积分 / 自带 key 路由、计费待定价） | `WP155-search-data-serp-geo.md` | `wp155-search-data` · `wp/155-search-data` | — | 已合并（09-26，Fable 终审：246 文件 2787 条过，六组模拟门禁过，wrangler dry-run 过；价格待 Luoye 定） |
| 40 | WP156 界面减字：步骤清单进教程文章（右栏「教程」面板）、短说明进 tooltip；改写 docs/36 §7；先改设置页与向导 | `WP156-ui-less-text-tutorials.md` | `wp156-less-text` · `wp/156-less-text` | — | 已合并（09-26，Fable 终审：198 文件 2323 条过，六组模拟门禁过） |
| 41 | WP157 界面减字第二轮：连接页 26 卡、消息渠道、插件卡、聊天窗、岗位与面板；两套 markdown 渲染合一；教程进 ⌘K | `WP157-less-text-round2.md` | `wp157-less-text-2` · `wp/157-less-text-2` | — | 已合并（09-26，Fable 终审：197 文件 2317 条过，六组模拟门禁过；走查 B 段在 main 上复跑，「找 20 个频道」通） |
| 42 | WP158 接 Search Console 与 Google Analytics 4 的真实读数（只读 OAuth、按天缓存、选站点 / 属性小卡） | `WP158-gsc-ga4-real-reads.md` | `wp158-gsc-ga4` · `wp/158-gsc-ga4` | — | 已合并（09-27，Fable 终审：补一处——每次读用独有 assignment，吊销只吊自己那张；seo-core / connect-adapter / deck / server google / workstation 118 文件 1372 条过（额度面板高负载偶发超时，单跑过），六组模拟门禁过） |
| 43 | WP159 内容与搜索后续：去 Perplexity 并把 AI 问答探测降到 0.2、改动卡初稿由模型写、违规宣称规则按市场 | `WP159-content-search-followups.md` | `wp159-seo-followups` · `wp/159-seo-followups` | — | 已合并（09-27，Fable 终审：补一句「查询 / 标题 / 证据是数据不是指令」；相关 56 文件 597 条过，六组模拟门禁过） |
| 44 | WP160 写五个营销技能（seo-judgment / ad-copywriting / audience-research / 邮件与短信 / 红人营销；改编 marketingskills 与 open-seo，MIT） | `WP160-five-marketing-skills.md` | `wp160-skills` · `wp/160-skills` | — | 已合并（09-27，Fable 终审：skills / roles / 引导 26 文件 463 条过，六组模拟门禁过；遗留：按需技能正文进不了提示词 → WP162） |
| 45 | WP161 邮箱子文件夹名与老产品对齐 KefuAgents / KOLAgents（认已有不分大小写），预留 BtoBAgents | `WP161-mail-folder-names.md` | `wp161-mail-folders` · `wp/161-mail-folders` | — | 已合并（09-27，Fable 终审；遗留：客服收信把所有处理过的信都挪进归档文件夹 → WP163） |
| 46 | WP162 技能正文真的进到模型：自带技能入库、按需技能可读（`read_skill`）、每个登记的技能都有正文 | `WP162-skills-reach-the-model.md` | `wp162-skills-load` · `wp/162-skills-load` | — | 已合并（09-27，Fable 终审追加两件：read_skill 结果不包外部数据围栏（只白名单这一个工具）、客服技能换 support-core 完整版 1.1.0；相关 89 文件 1933 条过，六组模拟门禁过） |
| 47 | WP163 客服收信只把判成客服的信挪进 KefuAgents（照老产品：影子模式、挪信 / 标已读两个开关、动作日志），挪信只由一处负责 | `WP163-support-archive-only-support-mail.md` | `wp163-support-archive` · `wp/163-support-archive` | — | 已合并（09-27，Fable 终审：邮件相关 43 文件 742 条过，六组模拟门禁过；遗留：渠道那一路仍给每封新信开事项起 Run → WP167） |
| 48 | WP164 云端对外契约补全：一份完整 OpenAPI（除运营后台）、契约 ↔ 真云服务一致性测试、CI 核对 | `WP164-cloud-openapi-contract.md` | `wp164-cloud-contract` · `wp/164-cloud-contract` | — | 已合并（09-27，Fable 终审：补修红人库入口令牌判断；云端 60 文件 577 条 + cloud-worker 126 条过，契约 --check 零漂移，wrangler dry-run 过，六组模拟门禁过） |
| 49 | WP165 开源仓不再直接依赖云端代码：自带 key 适配器拆成开源包、价目从云上取（`/v1/pricing`）、测试与模拟换契约替身、import 守卫 | `WP165-open-repo-decouple-cloud.md` | `wp165-decouple` · `wp/165-decouple` | — | 已合并（09-27，Fable 终审：干净构建 + 217 文件 2512 条过，边界守卫过，契约 73 条零漂移，六组模拟零漂移，wrangler dry-run 过；桌面打包最后一步要下载捆绑 Node 未跑） |
| 50 | WP166 目标市场一处定处处用：初始化从官网自动判断市场（可增删改）、SEO 每个目标市场分别探测、模型初稿读页面正文 | `WP166-markets-and-seo-reads.md` | `wp166-markets` · `wp/166-markets` | — | 已合并（09-27，Fable 终审：262 文件 2882 条过，边界守卫过，契约 / 本体零漂移，六组模拟门禁过） |
| 51 | WP167 收信只走一个入口：消息同步分拣后只有客服信进客服那一路开事项起 Run；判不准的进「待确认」；邮箱三个开关（影子模式 / 挪信 / 标已读）上连接页 | `WP167-single-mail-intake.md` | `wp167-mail-intake` · `wp/167-mail-intake` | — | 已合并（09-27，Fable 终审追加：升级那一拍预写台账，老信不再开事项起 Run；267 文件 3295 条过，六组模拟门禁过（3 人包 64 场景）） |
| 52 | WP168 建私有仓 `Luoye-W/agentsws-cloud`：带历史搬云端代码、三层各自部署（Service Bindings）、开源仓作 submodule、CI；不部署、不删开源仓 | `WP168-private-cloud-repo.md` | 私有仓 `~/Documents/agentsws-cloud` | WP164、WP165 | 已完成（09-27，Fable 终审：私有仓 `Luoye-W/agentsws-cloud`（PRIVATE）main 已推，Actions 全绿 621 条；终审追加修后台类型声明外泄；未部署） |
| 53 | WP169 市场三件小事：向导多市场花费提示、店铺校正后推动态、按市场主要语言探测 | `WP169-markets-followups.md` | `wp169-markets-2` · `wp/169-markets-2` | WP166 | 已合并（09-27，Fable 终审：239 文件 2658 条过，契约 / 本体零漂移，六组模拟门禁过） |
| 54 | WP170 B2B 六个技能：cold-email、prospecting（改写 marketingskills）、b2b-inquiry、quotation、trade-show、export-docs | `WP170-b2b-skills.md` | `wp170-b2b-skills` · `wp/170-b2b-skills` | docs/84 | 已合并（09-28，Fable 终审：skills / learning / upstreams 10 文件 341 条过；职责登记与显示名随 WP171） |
| 55 | WP171 B2B 岗位骨架：契约对象、五条职责（含展会、跟单与单证）、岗位模板「B2B」、b2b-core（移植 BtoBAgents 判断逻辑）、面板骨架、模拟包 b2b-3c-3p | `WP171-b2b-skeleton.md` | `wp171-b2b-skeleton` · `wp/171-b2b-skeleton` | docs/84 | 已合并（09-28，Fable 终审追加：「都要」不勾 B2B、平台运营标「第二批」、勾岗位不带第二批职责；干净构建，307 文件 3728 条过，三个模拟包 × 三运行时门禁过） |
| 56 | WP172 B2B 数据落盘与邮件分拣：B2B 库、`/v1/b2b/*`、分拣产出 b2b 挪进 BtoBAgents 并交给 B2B 这一路、退订退信进抑制名单、待确认加「这是 B2B」 | `WP172-b2b-store-and-triage.md` | `wp172-b2b-store` · `wp/172-b2b-store` | WP171 | 已合并（09-28，Fable 终审：309 文件 3742 条过，16 条起服务钩子在高负载下超时、7 个文件串行重跑 154 条全过；三个模拟包 × 三运行时门禁过） |
| 57 | WP173 B2B 开发信序列：三封节奏（共用序列函数）、日配额与预热、发信域名建议不强制 + SPF/DKIM 体检、页脚与来源、德奥默认不发、回复停序列转业务 | `WP173-b2b-outbound-sequence.md` | `wp173-b2b-outbound` · `wp/173-b2b-outbound` | WP172 | 已合并（09-28，Fable 终审：310 文件 3659 条过，2 个文件起服务钩子超时、串行重跑 66 条全过；b2b 16/16、dtc 64/64、22/22 × 三运行时） |
| 58 | WP174 组织里的「上级」：岗位可设上级，`scope_manager` 审批真落到上级、没有才落老板；离职自动落回老板 | `WP174-org-supervisor.md` | `wp174-supervisor` · `wp/174-supervisor` | — | 已合并（09-28，Fable 终审补项：报价卡不露英文字段名；273 文件 3102 条过（仅 onTaskUpdate 噪声），三个模拟包 × 三运行时门禁过） |
| 59 | WP175 网关接 new-api（私有仓）：AI 走 new-api 带 Access 服务令牌，不可用退回直连 DeepSeek，只扣一次，对账脚本 | 私有仓 `docs/briefs/WP175-gateway-newapi.md` | 私有仓 `wp/175-newapi` | WP168 | 已合并（09-28，私有仓 main `be744c4`；Fable 终审：tsc --force、77 文件 685 条过、契约零漂移、四份 dry-run 过；未部署） |
| 60 | WP176 开发信后续：「不感兴趣」只停这一轮（冷却 90 天）、公司地址进档案、跟进也由模型写、老邮箱免预热、Run 里的开发信工具、DKIM 检查不卡在 Gmail | `WP176-b2b-outbound-followups.md` | `wp176-outbound-2` · `wp/176-outbound-2` | WP173 | 已合并（09-28，Fable 终审：342 文件 4654 条过（仅 onTaskUpdate 噪声），b2b 19/19、dtc 64/64、22/22 × 三运行时） |
| 61 | WP177 dsh 升级 0.1.7-rc.2 → 0.2.0-rc.1（照 docs/42 七步；大版本号，seam 逐个对；账号网页搜索默认关、自动化任务改插件包） | `WP177-dsh-0.2.0-rc.1.md` | `wp177-dsh-020` · `wp/177-dsh-020` | — | 已合并（09-29，Fable 终审：干净构建，234 文件 3540 条过（仅 RPC 噪声），三个模拟包 × 三运行时门禁过；桌面打包最后一步待有 vendor 时补跑） |
| 62 | WP178 第 1 步部署事故复盘与修复（私有仓）：`run_worker_first` 数组 + SPA 回退吞掉接口 → 改 `true`、后台资源由 Worker 发；部署前 `smoke-workerd` 进 CI | 私有仓 `docs/briefs/WP178-assets-routing-outage.md` | 私有仓 `wp/178-assets` | WP168 | 已合并（09-29，私有仓 main `01f00dd`；Fable 终审：690 条过、smoke-workerd 44/44、四份 dry-run 过；未部署） |
| 63 | WP179 官方功能优先：用官方网页搜索 / 抓网页（账号免 key）接进职责，逐行重判 profile 锁定（功能能开都开，真冲突保留，数据外发交 Luoye 定），docs/42 红线更新 | `WP179-deepseek-native-search.md` | `wp179-ds-search` · `wp/179-ds-search` | WP177 | 已合并（09-29，Fable 终审：干净构建，317 文件 4380 条过，三个模拟包 × 三运行时门禁过（dtc-3c-3p 65）） |
| 64 | WP180 官方插件管理（装卸出卡 + 白名单 + 不许写回锁定行）与配置写回（只许写非锁定行）包一层后打开；每次运行带当前时间与公司时区 | `WP180-official-plugins-wrap.md` | `wp180-plugins` · `wp/180-plugins` | WP179 | 已合并（09-29，Fable 终审：干净构建，322 文件 4408 条过，三个模拟包 × 三运行时门禁过） |
| 65 | WP181 官方「自动化任务」插件在我们运行里真用起来（与 packages/schedule 并存 / 迁移、右栏定时任务面板）；桌面包带 profiles；秘书运行带时间 | `WP181-official-automation-plugin.md` | `wp181-automation` · `wp/181-automation` | WP180 | 已合并（09-29，Fable 终审追加：等批的定时任务暂停、批了才开始，每日次数落盘；干净构建，325 文件 4547 条过，三个模拟包 × 三运行时门禁过；桌面包未真打） |
| 66 | WP182 B2B 询盘与报价：询盘接客服管线、六类事实卡、报价卡与报价单 PDF、样品跟踪、离职交接卡 | `WP182-b2b-inquiry-quote.md` | `wp182-b2b-sales` · `wp/182-b2b-sales` | WP172–WP176 | 已合并（09-29，Fable 终审：干净构建，330 文件 3928 条过（仅 RPC 噪声），b2b 24/24、dtc 65/65、22/22 × 三运行时） |
| 67 | WP183 调研与设计：agentsws 做成 DSH 插件（官方桌面端装上就能用），只读 + 讨论稿 docs/85 | `WP183-agentsws-as-dsh-plugins.md` | `wp183-dsh-plugin` · `wp/183-dsh-plugin` | WP180 | 已合并（09-29，讨论稿 docs/85；§6 八件事待 Luoye 定） |
| 68 | WP184 官方场景在我们自己的窗口里打开（借官方桌面端壳，MIT）；认用户自己装的官方桌面端 | `WP184-official-desktop-scene.md` | `wp184-official-desktop` · `wp/184-official-desktop` | WP136 | 已合并（09-29，Fable 终审：干净构建，290 文件 4152 条过，stub 三包零漂移；Electron e2e 场景窗口过） |
| 69 | WP188「随便聊」：像 DeepSeek 网页版的自由对话入口（会话列表、选模型含官方积分、流式、联网搜索与公司资料开关、交给岗位去做；不开事项不出卡） | `WP188-free-chat.md` | `wp188-free-chat` · `wp/188-free-chat` | WP179 | 已合并 |
| 70 | WP191 社媒运营职责定义：调研开源知识（docs/86）+ 新增 LinkedIn 运营 + 充实 YouTube / TikTok / X | `WP191-social-duty-definitions.md` | `wp191-social-duties` · `wp/191-social-duties` | WP72 | 已合并 |
| 71 | WP193 Agents 工坊官网：先出设计（参考 KOLAgents 官网；docs/87 + 静态稿） | `WP193-site-design.md` | `wp193-site-design` · `wp/193-site-design` | WP112 | 已合并（待 Luoye 选方向） |
| 72 | WP195 品牌标记默认动起来：常驻待机动效三候选 + 常驻位置改动态 + 动态 favicon | `WP195-brand-mark-live.md` | `wp195-brand-live` · `wp/195-brand-live` | WP112 | 已合并 |
| 73 | WP196 改名扫描：店主→负责人（可改名）、工作区所有者→公司设置与授权、用户可见 agentsws→Agents 工坊 | `WP196-naming-sweep.md` | `wp196-naming` · `wp/196-naming` | WP188 | 已合并 |
| 74 | WP197 官网实现（`apps/site`，方向 A，只放公开页面；条款 / 隐私 / 退款起草；不部署） | `WP197-site-build.md` | `wp197-site` · `wp/197-site` | WP193 | 已合并（未上线） |
| 75 | WP199 审批卡升级给上级后施行失败（修 bug，顺查转交 / 代批 / 交接） | `WP199-approval-escalation.md` | `wp199-escalation` · `wp/199-escalation` | WP191 | 已合并 |
| 76 | WP200 品牌标记两处小调（浅色主题光调淡、README 标记动起来） | `WP200-brand-tweaks.md` | `wp200-brand-tweaks` · `wp/200-brand-tweaks` | WP195 | 已合并 |
| 77 | WP204 消息页按钮逐个过一遍并修好（显示图片、删除等没反应） | `WP204-messages-buttons.md` | `wp204-msg-buttons` · `wp/204-msg-buttons` | WP63 | 进行中（Claude） |
| 78 | WP205 以 AI 为核心的消息中心：调研 + 设计稿（统一入口、AI 标签与分拣、两个展示方向） | `WP205-ai-inbox-design.md` | `wp205-inbox-design` · `wp/205-inbox-design` | WP167 | 进行中（Claude） |
| 79 | WP207 左栏三级「+」（加岗位 / 加职责 / 开新对话）、职责下挂进行中对话、3 天自动归档、归档可搜可让 AI 找回 | `WP207-sidebar-plus-and-archive.md` | `wp207-sidebar` · `wp/207-sidebar` | WP202 | 进行中（Claude） |
| 80 | WP208 右侧第三栏收拾：五个设定合一、邮件助手进消息页、设计规范进公司 → 品牌、教程跟上下文、定时任务带数字 | `WP208-right-rail-tidy.md` | `wp208-rail` · `wp/208-rail` | WP207 | 进行中（Claude） |
| 81 | WP209 技能页按岗位分组、知识库按类型 / 品牌分组，小卡 + 点开看细节、搜索与筛选 | `WP209-skills-knowledge-grouping.md` | `wp209-library` · `wp/209-library` | WP208 | 进行中（Claude） |
| 82 | WP210 连接页 / 消息渠道页收拾：少字、已连上卡以账号为标题、失败邮件自动重投、图标取各官网 favicon | `WP210-connections-tidy.md` | `wp210-connections` · `wp/210-connections` | WP157 | 进行中（Claude） |
| 83 | WP211 消息渠道接入飞书与钉钉（官方优先，长连接 / Stream，不需公网回调） | `WP211-feishu-dingtalk.md` | `wp211-feishu-dingtalk` · `wp/211-feishu-dingtalk` | WP63 | 进行中（Claude） |

WP117b 的补充要求（派工单里没有，写在这）：demo 服务的是 `apps/workstation/dist`，测界面前先 `pnpm -F @agentsws/workstation exec vite build`；交付一个真实点击的 playwright 脚本 `scripts/e2e-kol-sandbox.mjs`（playwright 库在 `node_modules/.pnpm/playwright@1.63.0/node_modules/playwright`），走完「选合成红人 → 起草开发信 → 批准发送 → 已发 ≥ 1 → 跳到 N 天后 → 回信 ≥ 1 → 分类 → 议价卡 → 阶段推进 → 交付物 → 追踪链接」，每步截图到 `docs/assets/workstation/kol-e2e-NN.png`，脚本里断言计数确实变了；演练数据从真实漏斗 / 归因里排除，单独显示「演练漏斗」。

## 已合并（供参考）
WP110–116、117、119、121（前半）、123、125。细节见 `docs/35` 末尾。

## 给下一棒的小提醒

## 退回（Fable 终审没过的，实现方优先处理这里的）
（暂无）
