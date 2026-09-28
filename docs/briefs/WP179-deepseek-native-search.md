# WP179 官方功能优先：用官方的网页搜索与抓网页，并逐行重判 profile 锁定，能开的都开、接进来用起来

worktree `../agentsws-wt/wp179-ds-search` · 分支 `wp/179-ds-search`（从 main 新起）。先读 `_common.md`、`docs/42-上游升级流程-v1.md`（红线与④bis）、`docs/briefs/reports/{WP177,WP149,WP148}.md`、`packages/dsh-adapter/{README,UPGRADE}.md`、**`profiles/agentsws/cordis.patch.yml`（整份，逐行读注释）**、`packages/dsh-adapter/test/profile-lockdown*.test.ts`、`docs/75`（数据接口路由）、WP134 / WP150 / WP151 的 DeepSeek 账号宿主、上游 `@deepseek-ai/dsh-web-search-deepseek`、`@deepseek-ai/dsh-tool-web`（`node_modules/.pnpm/…0.2.0-rc.1…` 里的 README 与 lib）。

## Luoye 09-29 定（新规矩，覆盖以前「默认锁」的做法）
1. **用 DeepSeek 账号时的免 key 网页搜索要做。**
2. **官方的抓网页工具不要关。**
3. **官方更新了什么、有什么新功能，尽量都集成进来用起来；除非真的有冲突、导致我们整个工具运行不起来，否则官方这些一定要尽量多，功能都要更新进来。**

所以本单不再「另写一份我们自己的搜索后端」，而是**直接用官方模块**，我们只在外面包一层（开关、职责白名单、用量与审计）。

## 要做
1. **网页搜索与抓网页用官方的**：解锁 `web-search-deepseek`（WP177 锁的那行）与 `tool-web` 相关行，让官方 `web_search` / `web_fetch`（以上游实际工具名为准）在我们的运行里可用；凭据照官方：DeepSeek 账号登录优先，其次用户自己的 DeepSeek API key。
   - **哪些职责能用**：默认给需要查资料的职责挂上——内容与搜索、B2B 主动开发 / 业务 / 展会、红人找人、店铺管理、广告投放；客服类默认不挂（不让客服回复夹网页内容）；由职责 YAML 的工具白名单决定，执行器再判一次。
   - **三个运行时怎么接**：官方工具只在 dsh 运行时里有。挂了网页工具的运行照 WP148 浏览器那条路走 dsh 运行时（没挂的运行逐字节不变，改前录金样）；stub 给剧本、direct 不挂或经工具桥（二选一，说理由）。
   - **包一层**：每次搜索 / 抓取写一条审计事件（查询或网址、结果条数，不写正文）；用量照 `model.usage` 记（搜索是一次完整模型回合，provider 标明账号或 key，用途 `web_search`），用量页能看到；每条运行的次数上限（默认搜索 5 次、抓取 10 次，职责阈值可调）；结果按外部数据进围栏（照官方的做法，官方已有就用官方的）。工坊不扣积分。
   - 数据接口路由（docs/75）里 `web.search` 这一能力：默认第一级就是官方这条；用户可以在设置里关掉或调顺序。对外文案叫「用你的 DeepSeek 账号搜索」。
2. **逐行重判 `profiles/agentsws/cordis.patch.yml` 的每一条锁定**（以及 dsh-adapter 里其他地方的「默认关」），按新规矩分三类，写成一张表进报告和 `packages/dsh-adapter/README.md`：
   - **A 功能、不冲突 → 打开并接进来**（插件管理、自动审阅、Inspector、定时 / 提醒、时间上下文、工作过程展示等等，逐个判；打开后要在我们的界面或运行里真能用上的，说清接在哪；只是打开没有入口的，写明「已开，入口排后」）。
   - **B 真冲突 → 保留锁定**：只有「打开会让我们的工具跑不起来」或「会绕过出卡 / 授权 / 花钱闸这些核心纪律」才算；每条写清冲突在哪、有没有办法包一层后打开。
   - **C 把用户业务数据发给第三方的上报**（`session-telemetry-otel`、`otel`、`plugin-package-inventory-deepseek`、`session-log-deepseek` 这一类）→ **本单先保持关，逐条用白话写清「打开会把什么数据发给谁」**，交 Luoye 定（这不是功能，是数据外发）。
   - `profile-lockdown` 测试跟着改：A 类改成「确认已开且能用」，B / C 类保留原断言。
3. **docs/42 红线更新**：把「官方功能优先，锁定只留给真冲突与数据外发」写进 §2 与 ④bis 的判定口径；以后升级新出来的功能默认接进来。
4. 模拟：挂了网页工具的职责在模拟包里加一个用到 `web_search` 的场景（stub 剧本），三运行时 fast 过；没挂的运行零漂移（金样逐字节比）。

## 纪律
契约只加不改；不连真 DeepSeek / 不真搜网页（替身）；不跑批量清理命令；不读 .env*；**Luoye 的本机服务在 4317 别碰也别重启**；测试 `--maxWorkers=2`，起服务钩子超时的文件串行重跑确认。

## 验证（审核方全量用）
`scripts/verify-changed.sh` + `vitest run packages/dsh-adapter packages/runtime-direct packages/simulation apps/server` + fast 模拟三个包三个运行时 + `gen-sdk` / `gen-ontology --check` / `gen-cloud-contract --check` + `node scripts/check-upstreams.mjs --check`。报告里单列「A / B / C 三类逐行表」与「打开后在哪里用得上」。
