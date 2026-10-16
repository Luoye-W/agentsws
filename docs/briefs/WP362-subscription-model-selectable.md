# WP362 ChatGPT 订阅能被选来干活（Luoye 10-16 定 938）

worktree `../agentsws-wt/wp362-subscription` · 分支 `wp/362-subscription`（从 main 拉；收尾前合一次最新 main，WP355 / WP356 可能已合）。先读 `_common.md`、`docs/briefs/reports/WP355.md`（自带搜索已接好、等订阅能被选）、WP90 报告（订阅登录那一档）、WP342 报告（输入框按次选 AI、`Matter.model`）、`apps/server/src/models.ts`（`openai-codex`）、模型网关（`packages/model-gateway`）与三个运行时如何按来源路由、dsh / pi-ai 里 Codex 订阅 provider 的现成实现（_common「先找现成的」）。

## 现象
内测用户用 ChatGPT 订阅登录成功后，订阅模型只出现在登录那张卡里，进不了「默认模型」下拉，也进不了输入框的 AI 选择钮；岗位、助理、随便聊都不会用它跑。WP355 的自带搜索因此也用不上。

## 要做
1. **订阅模型进下拉**：登录成功后，订阅给出的模型（如 gpt-5.5 等，以订阅实际可用为准）出现在设置「AI → 模型」的默认模型、以及 WP342 输入框 AI 钮里；标明「ChatGPT 订阅」。只在个人档可用（WP90 口径），公司 / 托管档不出。
2. **真的能跑**：三个运行时（stub / direct / dsh）都能用订阅来源跑一轮对话与工具调用；令牌只在本机加密库与 pi-ai 内存里，不进事件、日志、运行输入。订阅过期 / 被限流时照 WP334 出就地重新登录的连接卡。
3. **WP355 收尾**：系统提示里「网页」那段对订阅运行改成说实话（搜索走 ChatGPT 自带）；名单判定接上真实的运行来源。
4. **本机真机验收脚本**：在 `scripts/` 留一个本机脚本（或扩展 `scripts/live-codex-search.mjs`）：用临时数据目录、设备码登录（人在手机上输码）、选订阅为默认模型、跑一轮「问一句 + 联网搜索 site:reddit.com smart glasses」，打印用的是哪个来源、搜索来自哪一路，不打印任何令牌；跑完删临时目录。由主会话和 Luoye 一起跑。

## 测试
订阅登录后模型出现在两处下拉；选了以后运行记录里来源是订阅；过期出卡；三个运行时替身跑通；令牌不出现在任何落盘 / 事件 / 输入；WP355 判定命中。模拟三包照跑。截图：模型下拉里的订阅项、输入框 AI 钮。

## 纪律
不读 .env*；不碰 key / token（只经本机加密库与官方库）；不调付费接口；测试不联网；不连远程机器；不碰本机 4317；不跑批量清理；不用 pkill。不合 main、不打 tag、不发版（决策 381）。测试用 `--maxWorkers=2 --testTimeout=120000`；验证日志写独立文件。报告 `docs/briefs/reports/WP362.md`（决策号 953–955）。
