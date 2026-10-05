# WP236 真机：研究任务 60 秒被静默取消 + 几处工具问题（Windows 实测）

worktree `../agentsws-wt/wp236-runtimeout` · 分支 `wp/236-runtimeout`（从 main 新起）。先读 `_common.md`、`packages/dsh-adapter/src/headless/subprocess.ts`（`DEFAULT_TIMEOUT_MS = 60_000`、超时 → `run.cancelled`）、桌面版用哪种 dsh 档、事项时间线怎么展示运行结束 / 取消、WP220 的 `read_reddit` 工具定义与 Reddit 两路路由、WP216 Dev MCP 启动时机、`social.reddit` 职责挂的工具清单。

## 现象（Fable 10-06 在 Luoye 的 Windows 真机 0.0.0-ci.6，岗位「社媒运营 → Reddit 运营」）
任务：「看看 Reddit 上最近一周大家在聊 INMO 智能眼镜的什么 … 挑最值得关注的 5 条帖子 … 只看不发。」
- 18:27:48 `run.started`（runtime dsh，桌面版走子进程档）→ 模型正常工作：read_skill、6 次 `read_reddit`（每次 8–12 秒，真取回了 Reddit 数据，还会主动排除同名噪音）……
- **18:28:48 `run.cancelled`，payload 为空**——正好 60 秒，是子进程档的 `DEFAULT_TIMEOUT_MS`。事项时间线上**什么都没显示**（没有结论、没有「超时了」），用户只看到任务没反应。
- 同一次里：
  - `read_reddit` 第一次调用没带 `action` → 报错「action 只能是 search / posts / comments」，模型多花一轮才改对；
  - 提供给模型的工具里有 `list_community_threads`，一调就 `unsupported_tool：这个进程没接`；
  - 品牌是 Shopify 站（INMO），跑的是 Reddit 职责，却触发了 `shopify.devmcp_started`（后台去下官方工具包）。

## 要做
1. **超时改成「没动静才停」**：子进程档不再用固定 60 秒总时长；改成**空闲超时**（连续 N 分钟没有任何事件才算卡死，默认 3 分钟）+ **总时长上限**（默认 20 分钟，研究类可配），两个数进设置 / 职责阈值。in-process 档与 direct 档对齐同一套口径。
2. **取消 / 超时要让人看见**：`run.cancelled` 带原因（`idle_timeout` / `max_duration` / `user`），事项时间线显示一句人话（「这次跑太久被停了：已经查到的部分在下面」）；**已有的过程话与工具结果不丢**——把模型已经说过的话 + 已取回的数据摘要作为部分结果挂在事项上，并给「接着跑」按钮（续跑同一事项）。
3. `read_reddit`：`action` 缺省时按 `search`（有 `query`）/ `posts`（有 `subreddit`）/ `comments`（有 `post_url`）推断；工具描述写清。
4. 给模型的工具清单只放**这个进程真接上了**的工具：`list_community_threads` 这类没接的不出现（查清 social.reddit 为什么带它、在哪接；能接就接，接不了就不提供），加一条「提供的工具都能调」的一致性测试。
5. Shopify Dev MCP 只在**建站类职责**（site.* 等声明需要它的职责）第一次运行时才启动 / 下载，Reddit 等职责运行不触发。
6. 测试：子进程档长任务（替身每 10 秒出一个事件、总长 2 分钟）不被取消；空闲 3 分钟才取消且带原因；取消后时间线有部分结果；read_reddit 缺 action 能推断；工具清单一致性；Dev MCP 触发条件。

## 纪律
不读 .env*；不跑批量清理命令；本机 4317 服务别碰；不连 Luoye 的 Windows（真机复测由 Fable 做）。

## 验证
`scripts/verify-changed.sh` + 模拟三包 × stub/direct/dsh + `gen-sdk` / `gen-ontology --check` + `open-repo-boundary`；报告 `docs/briefs/reports/WP236.md`。
