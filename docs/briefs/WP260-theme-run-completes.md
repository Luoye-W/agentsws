# WP260 网页模板的运行要真把活干完：压缩历史别把刚读的文件丢掉、查清并修「没写一个字就结束」

worktree `../agentsws-wt/wp260-themerun` · 分支 `wp/260-themerun`（从 main 新起，含 WP253 / 预算放宽）。先读 `_common.md`、WP253 报告（九个主题工具、`theme_read_file` 等）、`apps/server/src/runtime.ts`（`runBudgetCaps`、compact_history、运行何时算完成：模型只回文本不调工具即结束？最大轮数？看门狗 idle / max）、dsh 适配器的运行循环与 `progress: compact_history`、`packages/roles/roles/site/shopify-theme.yml`（persona / 规矩）、agentsws-theme 的 AGENTS.md / CATALOG.json / recipes（主题给 AI 的说明）。

## 真机现象（Fable 10-07 Windows ci.15 / ci.16，Rollout 建站「Shopify 网页模板」，模型 deepseek-flash 经 Agents 工坊接口）
任务：用 agentsws-theme 搭英文首页（横幅 / 主推占位 / 品牌故事 / FAQ / 订阅），推未发布主题给预览。
- **第一轮（ci.15）**：21 秒、12 次工具调用就 `budget.exhausted max_tokens 75488/60000` 停了，只读文件。→ 已由 Fable 放到 40 万 token / 60 次（`runBudgetCaps`）。
- **第二轮（ci.16，预算已放宽）**：57 秒结束，`run.completed outputs: [answer: "现在读首页模板、FAQ/容器分区、标题块的 schema，并顺手看店里有没有可引用的商品。"]`，**一个文件都没写、没 check、没 push**。期间：
  - `progress compact_history: N 条工具结果换成占位` 几乎每一步都出现（1、4、3、1、4、4 条），刚读完的文件内容立刻被换成占位；
  - 同一批文件反复读：`AGENTS.md`、`sections/hero.liquid`、`sections/faq.liquid`、`templates/index.json` 在两轮里各读两遍以上；
  - 还调了 `get_product` → `not_connected`（店铺连接可选，模型却去查商品）。
  - 没有 budget 事件，停的原因不明（模型回了一句不带工具调用的话就被当成完成？还是有最大轮数？）。

## 要做
1. **查清停的原因并写进报告**：第二轮为什么在第 ~25 次调用后以一句「现在读…」结束；列出运行循环的所有终止条件。
2. **压缩历史按工作类型调**：主题运行（以及同类「读一批文件再改」的工作）里，工具结果压缩不能把**最近读过、马上要改的文件**换成占位；按 token 阈值（接近上限才压）而不是每步压；压的时候保留文件路径 + 摘要（schema 要点）而不是空占位。给出主题运行的具体阈值并测试。
3. **「说了要做却停下」要接着做**：模型回文本但明显是「我接下来要…」且本轮没有产出（没写文件 / 没推送 / 没出卡）时，运行不算完成——自动续一轮（有上限，比如 3 次）或按 dsh 的正确续跑方式处理；与看门狗时长线一致。只对有主题工具这类「要产出」的运行生效，别影响普通问答。
4. **主题职责的提示 / 规矩**：在 `site.shopify-theme` 的 persona / 规矩里写清工作法——先读 AGENTS.md / CATALOG.json 一次、按 recipes 改 `templates/index.json` 与 `config/settings_data.json`、`theme_check`、`theme_push_unpublished`、最后给预览链接；不要中途汇报；店铺没连时不要去调 `get_product` 之类要店铺连接的工具（或在工具面里干脆不给）。
5. **回放测试**：用真机这两轮的事件形状做一个可回放的假模型脚本（先读一批文件、接着写 index.json / settings_data、check、push），断言：不重复读同一文件超过一次、最终调用 `theme_push_unpublished` 并出「预览好了」；以及「只说不做」的回复会被续跑。
6. 报告里给 Fable 的真机复测步骤。

## 纪律
不读 .env*；不跑批量清理命令；本机 4317 服务别碰；不连远程机器；不真去 Shopify（假 CLI）；不调真模型（测试用假模型 / 回放）。

## 验证
`scripts/verify-changed.sh` + 模拟三包 × stub/direct/dsh（压缩 / 续跑改动可能影响全局，三种运行时都要过，sims 基线有漂移要解释）+ `gen-sdk` / `gen-ontology --check` + `open-repo-boundary`；报告 `docs/briefs/reports/WP260.md`。
