# WP355 指定的模型用它自带的联网搜索（先只有 ChatGPT 订阅；Luoye 10-16，决策 937）

worktree `../agentsws-wt/wp355-nativesearch` · 分支 `wp/355-nativesearch`（从 main 拉；收尾前合一次最新 main）。先读 `_common.md`（「先找现成的」：dsh 官方 / 社区里有无 OpenAI Responses `web_search` / Codex 搜索的 provider，例如 `dsh-web-search-diy`、`dsh-web-search-litellm`，许可证只收 MIT / Apache 类）、`docs/briefs/reports/WP353.md`（我们的搜索链与 `agentsws-browser` 后端口）、`apps/server/src/models.ts`（`openai-codex` 订阅登录那一档）、dsh 里 Codex / OpenAI 订阅 provider 的实现。

## Luoye 原话
不是所有都用 AI 自带搜索，只有我指定的用，例如用户用的是 ChatGPT 订阅那个，就用 AI 自带的搜索。

## 要做
1. **一张由我们定的名单**（代码里的常量，不给用户开关）：哪些模型来源用「自带搜索」。第一版只有 `openai-codex`（ChatGPT 订阅登录）。其余（DeepSeek、工坊积分、各家 API key 等）照旧走 WP353 的搜索链。
2. **自带搜索怎么接**：当这次运行用的是名单里的来源时，`web_search` 的后端改成调这家的原生搜索（ChatGPT 订阅：Codex / Responses 的 web_search 工具；以实测为准），结果仍按 url / title / snippet 交回，工具面不变；失败或该来源不支持时自动退回 WP353 的链，并照实标「来自哪一路」。
3. 缓存、节流、审计、搜索语言（决策 922）照旧在我们这一层。
4. **实测**：真账号不在 CI 跑；写一个本机脚本，用 Luoye 本机已登录的订阅（不读 / 不打印任何令牌，令牌照旧在本机加密库）跑 `site:reddit.com smart glasses` 等几条，结果写进报告。脚本由 Luoye 或主会话手动跑，你写好即可。

## 测试
名单判定（codex → 原生；其他 → 我们的链）；原生失败退回；替身覆盖原生返回解析；工具面不变；模拟三包照跑。

## 纪律
不读 .env*；不碰 key / token；不调付费接口；测试不联网；不连远程机器；不碰本机 4317；不跑批量清理；不用 pkill。不合 main、不打 tag、不发版（决策 381）。报告 `docs/briefs/reports/WP355.md`（决策号 938–940）。
