# WP179 DeepSeek 原生网页搜索：进我们自己的数据接口路由，模型多一个 `web_search` 工具

worktree `../agentsws-wt/wp179-ds-search` · 分支 `wp/179-ds-search`（从 main 新起）。先读 `_common.md`、`docs/75-数据接口路由与自带数据接口-v1.md`（四级路由表、「对外不出现第三方平台名」）、`docs/81`（搜索数据接口）、`docs/briefs/reports/WP177.md`（为什么把官方 `web-search-deepseek` 整行锁掉）、WP134 / WP150 / WP151 的 DeepSeek 账号宿主（`packages/model-gateway/src/providers/deepseek-*`、`apps/server` 账号那几处）、`packages/dsh-adapter`（profile 锁定表、工具桥）、上游包 `@deepseek-ai/dsh-web-search-deepseek@0.2.0-rc.1`（MIT，`node_modules/.pnpm/@deepseek-ai+dsh-web-search-deepseek@0.2.0-rc.1*/.../README.md` 与 `lib/index.js`）和 `@deepseek-ai/dsh-tool-web`（模型侧 `web_search` 工具的描述与结果形状）。

## Luoye 09-29 定
用 DeepSeek 账号时的**免 key 网页搜索要做**。但官方那条路（`web-search-deepseek` 整行开着）会绕开我们的数据接口——不许重开；做法是**在我们自己的数据接口里加一个「DeepSeek 原生搜索」后端**，计费 / 缓存 / 审计 / 开关都在我们这一层。

## 要做
1. **移植后端**（移植优先，MIT，文件头注出处与版本）：照上游 `dsh-web-search-deepseek` 的做法——DeepSeek 没有单独的搜索接口，一次搜索 = 一次带服务端搜索工具的 Messages 请求，结果只取返回里的结构化搜索块（不从回复正文里抠），没有搜索块就明确报错。凭据按次解析：优先当前登录的 DeepSeek 账号令牌（WP134 宿主），其次用户自己配的 DeepSeek API key；两样都没有就不可用。**不打开** profile 里锁掉的那一行；这是我们自己的一份实现，经我们的模型网关出站。
2. **进路由表**（docs/75 §1 的四级表加一种能力 `web.search`）：级序默认 = ① DeepSeek 原生搜索（用户自己的账号 / key，工坊不收积分）→ ② 用户自带的数据接口（如有支持网页搜索的）→ ③ 官方数据接口（如已有网页搜索能力就接上，没有就这一级先空着并在报告写明）→ ④ 都没有：一句人话。顺序与开关照 `data_source_routing` 可调可关；设置 / 连接页照少字规矩只露一行开关。**对外文案不说「DeepSeek 官方」以外的第三方名**；这一级就叫「用你的 DeepSeek 账号搜索」。
3. **模型侧工具 `web_search`**（只读）：描述与参数照上游 `dsh-tool-web` 借形；结果按外部数据进围栏（不可信内容）；每条结果带来源 URL 与标题；工具名进 `TOOL_WORDS_ZH`（「网页搜索」）。**哪些职责能用**：默认挂给需要查资料的职责——内容与搜索、B2B 主动开发 / 业务 / 展会、红人找人、店铺管理；客服类默认不挂（不让客服回复里夹网页内容）；由职责 YAML 的工具白名单决定，执行器再判一次。stub / direct / dsh 三个运行时同一份定义（dsh 走 WP148 的工具桥）。
4. **计费、用量与缓存**：用账号 / 用户 key 搜，工坊**不扣积分**；但每次搜索是一次完整模型回合，记一条 `model.usage`（provider 标明是 DeepSeek 账号或 key、用途 `web_search`），用量页能看到「网页搜索用掉的 token」。同一查询本机缓存（默认 6 小时，可调），缓存命中不再发请求。每条运行的网页搜索次数有上限（默认 5 次，职责阈值可调），超了说人话。账号余额不足 / 登录失效沿用 WP150 / WP151 的判定与提示。
5. **审计**：每次搜索写一条事件（查询词、走了哪一级、结果条数、是否命中缓存；不写结果正文）。
6. 测试全替身（替身 Messages 返回带 / 不带搜索块、账号过期、余额不足、key 路）；模拟：`dtc-3c-3p` 或 `b2b-3c-3p` 加一个用到 `web_search` 的场景（stub 剧本），三运行时 fast 过，其余零漂移；WP177 的 profile 锁定测试照过（`web-search-deepseek` 仍锁）。

## 纪律
契约只加不改；不连真 DeepSeek（替身）；不跑批量清理命令；不读 .env*；**Luoye 的本机服务在 4317 别碰也别重启**；测试 `--maxWorkers=2`，起服务钩子超时的文件串行重跑确认。

## 验证（审核方全量用）
`scripts/verify-changed.sh` + fast 模拟三个包三个运行时 + `gen-sdk` / `gen-ontology --check` / `gen-cloud-contract --check` + `scripts/open-repo-boundary.test.mjs`（用 vitest 跑）+ `node scripts/check-upstreams.mjs --check`（`upstreams.yml` 登记这次移植：`kind: ported`、上游包与版本）。
