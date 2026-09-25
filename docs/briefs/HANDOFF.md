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
| 33 | WP149 dsh 升级 0.1.7-rc.1 → 0.1.7-rc.2（照 docs/42 七步；列上游全部包；附「官方化 / 新出了什么」清单） | `WP149-dsh-0.1.7-rc.2.md` | `wp149-dsh-rc2` · `wp/149-dsh-rc2` | — | 进行中（Claude） |

WP117b 的补充要求（派工单里没有，写在这）：demo 服务的是 `apps/workstation/dist`，测界面前先 `pnpm -F @agentsws/workstation exec vite build`；交付一个真实点击的 playwright 脚本 `scripts/e2e-kol-sandbox.mjs`（playwright 库在 `node_modules/.pnpm/playwright@1.63.0/node_modules/playwright`），走完「选合成红人 → 起草开发信 → 批准发送 → 已发 ≥ 1 → 跳到 N 天后 → 回信 ≥ 1 → 分类 → 议价卡 → 阶段推进 → 交付物 → 追踪链接」，每步截图到 `docs/assets/workstation/kol-e2e-NN.png`，脚本里断言计数确实变了；演练数据从真实漏斗 / 归因里排除，单独显示「演练漏斗」。

## 已合并（供参考）
WP110–116、117、119、121（前半）、123、125。细节见 `docs/35` 末尾。

## 给下一棒的小提醒

## 退回（Fable 终审没过的，实现方优先处理这里的）
（暂无）
