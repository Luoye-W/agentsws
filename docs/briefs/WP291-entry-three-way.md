# WP291 岗位入口三分：简单问答出组件 / 多轮进会话 / 干活开任务（决策 356，docs/96 阶段 3 的第一块）

worktree `../agentsws-wt/wp291-threeway` · 分支 `wp/291-threeway`（从 main 新起）。先读 `_common.md`、`docs/96-卡片流与组件化复盘-v1.md`（§3 原则、§4.2 信息组件表、阶段 1 画板修订、10-10 交接）、组件画板（https://claude.ai/artifact/UTe4bmEaQw4Xc33DcbX24m 的说明已摘进 docs/96，以 docs/96 为准）、`docs/briefs/reports/WP287.md`（`classifyEntryIntent`、`ask` 事项、`detach`、线程流式）、`WP288.md`（岗位页现状）。

## Luoye 10-10（决策 356，原话）
「应该要 AI 自动判断：是简单的回答就行，那就直接组件展示的方式；如果觉得后续会有多轮对话，那就进会话线程；如果判断是要使用工具执行某些任务，或者用户的交代更像是一个工作任务而不是简单的问答，就开成任务。」

## 要做
1. **三分判断（模型判）**：岗位入口（岗位页、⌘K「交给某个岗位」、首页快捷提示）发出的一句话，先用便宜档模型（工作区默认模型里最便宜的那档 / `purpose: classify`，计入用量）判成三类之一：`quick`（一次答完的简单问答，可能要读数据）/ `chat`（看得出会多轮来回）/ `task`（要用工具执行、要出卡、更像一件工作）。给模型的判断提示要短、带几条例句（中英各几条），输出严格 JSON；超时 / 没接模型 / 解析失败时退回 WP287 的 `classifyEntryIntent` 规则（问 → quick，交办 → task）。判断理由记进本机事件（不显示）。
2. **quick → 岗位页上直接出组件**：不跳页、不建「工作」项。回答 = 一句话 + 组件（docs/96 §4.2：数字 / 表格清单 / 趋势 / 对比 / 图集；先做**一句话、表格清单、数字**三种，其余留口），在岗位页输入框下方出现（WP288 的岗位页顺序：有看板时在看板之下、输入框之下、要你处理之上），带「依据」小链接（读了哪些数据）。下面两个小动作：「接着聊」（转成会话线程，带上这一问一答）、「关掉」。同一时间只留最近一个回答；刷新后在「记录」里能找到。answer 的组件 payload 用契约里定义的 schema（新增 `AnswerComponent` 联合类型：text / table / metric[]），工作台按 schema 渲染，不让模型直接吐 HTML。
3. **chat → 会话线程**（WP287 现有行为）。
4. **task → 开任务**：建任务（进「工作」）、按 WP287 自动选职责，并**马上进这件任务的线程**（不能静默只加一行——Luoye 10-09 的痛点）；线程里第一句说「记成了任务，按『X』做」。
5. 判错的补救：quick 的回答下「接着聊」/「当成任务做」；chat 线程页头「⋯ → 转成任务」（已有）；task 线程里不需要回退。
6. 首页「今天还剩 N 张卡、N 件事」等计数不受 quick 影响。

## 测试
roles / server：三分判断（模型返回各类、超时退回规则、坏 JSON 退回规则、没接模型退回规则）、quick 不建事项且回组件 payload、chat 进线程、task 建任务且返回线程地址；工作台：岗位页 quick 回答区渲染一句话 + 表格 + 数字、「接着聊」转线程带上下文、「关掉」、task 发出后直接进线程；模拟：加场景「岗位里问店里有哪些商品 → quick 表格」「问怎么优化详情页（多轮）→ chat」「上架一个草稿商品 → task」，三运行时都过（stub / direct 下用固定判断替身）。

## 纪律
不读 .env*；不跑批量清理命令；本机 4317 服务别碰；不连远程机器；不调真实付费 API。另有 WP290（装包前冒烟）待合，若 main 有新提交先合 main、`npx tsc -b` 后再重出 gen-sdk / gen-ontology。界面少字：回答区不加标题、不加说明段。

## 验证
`scripts/verify-changed.sh` + 模拟三包 × stub/direct/dsh + `gen-sdk` / `gen-ontology --check` + `gen-cloud-contract --check` + `open-repo-boundary`；若 WP290 已合，再跑 `node scripts/preinstall-smoke.mjs`。截图 `docs/assets/wp291/`：quick 表格回答、quick 数字回答、「接着聊」后的线程、task 发出后直接进线程。报告 `docs/briefs/reports/WP291.md`，列自主决定，要 Luoye 定的事单列、每条附建议。
