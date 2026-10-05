# WP230 模型把「[calling …]」当文字吐出来（真模型实测发现）

worktree `../agentsws-wt/wp230-calltext` · 分支 `wp/230-calltext`（从 main 新起）。先读 `_common.md`、`packages/dsh-adapter/src/llm.ts`（约 228 行）、`packages/runtime-direct/src/runtime.ts`（约 570 行）。

## 现象（Fable 10-05 本机真模型 deepseek-chat 实测）
红人营销岗位接到「英文来信起草回复」：模型真调了 7 次工具（read_skill / search_policies / search_creators / list_collaborations / get_creator / list_deliverables / get_product），然后**最后一轮的文字输出**是三行
`[calling search_policies {"query":…}]` `[calling search_creators {…}]`——没有真 tool_calls，回合结束，`run.completed` 的 answer 就是这三行假调用文字，草稿没出来。

## 根因（Fable 判断，请核实）
两个运行时回放历史时，把 assistant 消息里的工具调用**同时**写成真 `tool_calls` 和 content 里的一行文字 `[calling 名字 参数]`。真模型看多了这种文字就模仿着「用文字调工具」。

## 要做
1. 两处都**不再往 assistant content 里写 `[calling …]` 文字**：content 只留模型自己说的话（没有就空 / null，按 provider 要求；DeepSeek / OpenAI 兼容口允许 content 为空字符串或 null 时带 tool_calls——照真 provider 的要求，别让它 400）。检查别处（摘要、记忆、事项时间线、审计、replay、缓存键）有没有依赖这行文字，有就改成读结构化字段。
2. **兜底**：模型最终文字里出现「像工具调用的文字」（如以 `[calling ` 开头的行、或 `<tool_call>` / `function_call` 一类伪格式），且这一轮没有真 tool_calls 时，不当答案：追加一条系统提示「你把工具调用写成了文字，请用真正的工具调用，或直接给出答案」再跑一轮（只重试 1 次；还这样就照实报「模型输出格式异常」，不把假文字当答案、不出卡）。三条运行时（stub / direct / dsh）一致。
3. 事项时间线里给人看的工具调用展示（「[calling 「规矩与政策库」 …]」这种）改成从结构化事件渲染，不靠这行文字。
4. 测试：回放历史后 assistant content 不含 `[calling`；模型吐伪调用文字 → 重试一次 → 第二次正常则正常收尾、仍异常则报格式异常；DeepSeek 口 content 为空 + tool_calls 不 400（替身按真 provider 规则校验）。
5. 模拟：token / 花费会略降（少了这些文字），基线按惯例重写并说明；行为指标不许变差。

## 纪律
不读 .env*；不跑批量清理命令；本机 4317 服务别碰；不连 Luoye 的 Windows。

## 验证
`scripts/verify-changed.sh` + 模拟三包 × stub/direct/dsh + `gen-sdk` / `gen-ontology --check` + `open-repo-boundary`；报告 `docs/briefs/reports/WP230.md`。合并后 Fable 用真模型复测同一条任务。
