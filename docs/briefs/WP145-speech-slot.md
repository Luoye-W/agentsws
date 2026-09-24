# WP145 语音转写留一个「本机识别器」的口（不打包、不下载模型）

worktree `../agentsws-wt/wp145-speech-slot` · 分支 `wp/145-speech-slot`（从 main 新起）。先读 `_common.md`；官方 `packages/experimental/speech-to-text`、`api-speech-to-text`、`speech-to-text-sensevoice` 的 README
（上游仓库 `deepseek-ai/deepseek-harness` tag `dsh-v0.1.7-rc.1`）；我们的 `apps/server/src/meetings.ts`（`transcribe` 槽）、`packages/model-gateway`（`transcribe`）、`packages/metering/src/pricing.json` 的 `transcribe.minute`。

## Luoye 09-24 定
**先不走本地**（电脑要求高、各机器方案不同、安装包会大很多），**留个口就行**。

## 要做
1. 在我们的转写入口（会议 / 知识入库等所有调 `transcribe` 的地方）前面加一层「识别器选择」：现在只有「云端（积分）」「自带模型 key」两种，接口形状对齐官方 `ctx.speechToText`（具名 provider、`resolve` → `transcribe`、`languages`、`prepare` / 下载源），**以后加一个本机识别器 = 注册一个 provider**，不用改调用方。
2. **不装、不挂**任何本机识别器包（`speech-to-text-sensevoice` 等一个都不进依赖树）；不下载模型；设置页不露「本机识别」这一项（或者露一行灰的「本机识别：以后提供」——选前者，除非 docs/36 有「预告位」惯例）。
3. 契约只加不删；写一条测试：注册一个替身 provider 后，会议转写走它、不扣积分；没注册时行为与现在逐字相同（计费、事件、错误话术）。
4. docs：在转写相关文档里写两句「为什么现在不做本地、口在哪、以后怎么接」。

## 验证（审核方全量用）
`vitest run apps/server packages/model-gateway packages/meetings packages/knowledge` + fast 模拟两个包（stub，应零漂移）。
