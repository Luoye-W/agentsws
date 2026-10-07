# WP243 长一点的云模型调用在 Windows 上被中途掐断（UND_ERR_SOCKET other side closed）+ 首次设置推荐太慢太长

worktree `../agentsws-wt/wp243-longcall` · 分支 `wp/243-longcall`（从 main 新起，含 WP242）。先读 `_common.md`、WP242 报告（`docs/briefs/reports/WP242.md`：`net-cause.ts`、一次重发）、`packages/model-gateway`（agentsws 云 provider、`providers/openai-compatible.ts`）、`apps/server/src/onboarding-suggest.ts`、私有云 `/v1/ai/chat/completions` 的转发方式（开源仓里能看到的契约部分即可，私有仓不改）。

## 现象（Fable 10-07 Windows 真机 ci.10，Rollout 首次设置第 ③ 步「帮我推荐」）
1. 10-06 16:22 一次成功：`model.usage` duration_ms **37911**、input 3126、**output 8859 tokens**、purpose extraction，推了 5 岗 21 职责。
2. 10-07 03:17 同一句话再点：`model.provider_down … fetch failed (UND_ERR_SOCKET other side closed)` → 退回按词对。WP242 的「掐一次重发」没救回来（attempts 只记 1 条，看不出有没有重发）。
3. 机器走 Clash Verge TUN（fake-IP 198.18.x），有火绒。同一台机短请求（health、401）一直正常；INMO 的 Reddit 调研（流式 / 多轮短调用）也跑通过。**怀疑**：非流式请求等几十秒都没有一个字节回来，中间的代理 / 某一跳把空闲连接掐了。

## 要做
1. **推荐这类一次性抽取别这么长**：查清 8859 个输出 token 是怎么来的（推理模式？提示让它把全目录复述？）——给 `onboarding-suggest` 设合理的 max_tokens、关掉思考（若 deepseek-flash 走思考）、只要 id + 一句理由的紧凑 JSON；目标 10 秒内、输出 < 1500 tokens，推荐质量不降（用 Rollout 那句做回归用例，期望含建站 / 社媒 / 红人 / 客服）。
2. **长调用不怕空闲掐线**：云 provider 对非流式调用改为内部走流式（`stream: true` 累积成完整结果），让连接上一直有字节；若云端转发不支持就在报告里说清楚。所有走 agentsws 云的调用路径都覆盖（抽取、随便聊、岗位运行）。
3. **重发要看得见**：`provider_down.attempts` 记每一次尝试（含重发那次）的 cause.code 与耗时；UND_ERR_SOCKET / ECONNRESET 在流式下中途断了，已收到部分的不要当成功，整体重发一次。
4. 测试：本机云替身模拟「45 秒不回字节就掐连接」——非流式会断、改后不断；以及中途断开重发一次成功。

## 纪律
不读 .env*；不跑批量清理命令；本机 4317 服务别碰；不连 Luoye 的 Windows（真机复测由 Fable 做）；私有云仓不动（需要云端配合的写进报告）。

## 验证
`scripts/verify-changed.sh` + 模拟三包 × stub/direct/dsh + `gen-sdk` / `gen-ontology --check` + `open-repo-boundary`；报告 `docs/briefs/reports/WP243.md`（推荐提速前后对比：耗时、输出 token；要 Luoye 定的事单列）。
