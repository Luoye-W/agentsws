# 本机手工验证：官方浏览器 provider 接真 Chrome（WP82 / 55 §3）

自动化那一层测到哪为止，先说清楚：

| 层 | 谁测 | 测到哪 |
|---|---|---|
| provider 挂载、24 个工具名、提示词遮蔽、槽独占 | `packages/dsh-adapter/test/browser-seam.test.ts`（**真 provider**，attach 指一个没人监听的端口） | 自动，CI 里跑 |
| 域名白名单 / 读写分类 / 注 JS / 两档策略 | 同上（真门禁 + 同名工具替身） | 自动，CI 里跑 |
| **真的连上一个 Chrome，真的打开一个网页** | 下面这份手工步骤 | **手工**——CI 里没有带图形界面的 Chrome，也不该让 CI 去访问 youtube.com |

所以下面这几步是**唯一**能证明"端到端真的通"的地方。改过 `harness.ts` 的 provider
装配、`browser.ts` 的策略、或者升过 dsh / `@playwright/mcp` 的版本，跑一遍。

---

## 1. 起一个工作用的 Chrome

```sh
# macOS
"/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" \
  --remote-debugging-port=9333 \
  --remote-debugging-address=127.0.0.1 \
  --user-data-dir="$HOME/Library/Application Support/agentsws/browser-profile" \
  --no-first-run --no-default-browser-check about:blank
```

三件事一件都不能省：

- `--user-data-dir` 指一个**单独的 Profile**。不要用你日常那个——AI 用的浏览器和你收
  私人邮件的浏览器共用一份 cookie，一次越界就什么都拿到了（55 §3 末段）。
- `--remote-debugging-address=127.0.0.1`：调试口只听回环，别的机器连不上你的浏览器。
- `--no-first-run`：没有它 Chrome 会把新窗口交给**已经在跑的那个实例**，于是
  `--user-data-dir` 与调试口双双失效，provider 接到的是你日常那个浏览器。

桌面壳里托盘的「打开工作用的浏览器」做的就是这一条（`apps/desktop/src/work-browser.ts`），
起完还会把地址写进设置。手工验证时自己敲一遍更直观。

验证调试口开着：

```sh
curl -s http://127.0.0.1:9333/json/version | head -c 200
# 期望：{"Browser":"Chrome/1xx.0.xxxx.xx", "webSocketDebuggerUrl": …}
```

## 2. 在这个 Profile 里登录一次

打开 https://www.youtube.com 并登录（第一次一定要人来做：验证码、两步验证都在这一步，
13 §4「凭据不经模型」的落点就是这里——密码只在你自己的浏览器里输过）。

## 3. 让 provider 真的接上它

在仓库根：

```sh
pnpm exec tsc -b
node --input-type=module -e "
import { Context } from '@deepseek-ai/cordis'
import AgentRegistry from '@deepseek-ai/dsh-agent'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import BrowserUse from '@deepseek-ai/dsh-browser-use'
import * as Playwright from '@deepseek-ai/dsh-experimental-browser-use-playwright-mcp'
import Llm from '@deepseek-ai/dsh-llm'
import Sessions from '@deepseek-ai/dsh-session'
import Projection from '@deepseek-ai/dsh-session-projection'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import Tools from '@deepseek-ai/dsh-tools'
import Approval from '@deepseek-ai/dsh-user-approval'

const root = new Context()
for (const p of [Sessions, Projection, AgentRegistry, Tools, Approval, Llm, BrowserUse]) root.plugin(p)
root.plugin(SystemPrompt, { includeHarnessIdentity: false })
root.plugin(AgentLoop, { maxParallelToolCalls: 1, agents: [] })
const ctx = await new Promise((r) => root.plugin({
  name: 'probe', inject: ['tools','systemPrompt','llm','agents','sessions','browserUse'], apply: r,
}))
const handle = await ctx.agents.create({
  sessionId: 'manual-1', meta: { cwd: process.cwd() },
  agentOptions: { provider: 'none', model: 'none' },
  setup: async (agentCtx) => {
    await agentCtx.plugin(Playwright, { mode: 'attach', endpoint: 'http://127.0.0.1:9333' })
  },
})
const call = (name, args) => ctx.tools.execute({
  callId: 'c1', name: 'mcp__playwright-mcp__' + name, arguments: args,
  agent: handle.agent, signal: new AbortController().signal,
})
console.log('工具数：', ctx.tools.schemas(handle.agent).filter((s) => s.name.startsWith('mcp__')).length)
console.log(JSON.stringify(await call('browser_navigate', { url: 'https://www.youtube.com/' })).slice(0, 400))
console.log(JSON.stringify(await call('browser_snapshot', {})).slice(0, 600))
await handle.dispose(); await root.fiber.dispose()
"
```

期望：

1. **工具数：24**；
2. `browser_navigate` 回 `isError: false`，而且**你那个 Chrome 窗口真的跳到了 YouTube**
   （不是新开一个窗口——attach 用的就是它）；
3. `browser_snapshot` 回一棵可读的无障碍树，里面**能看到你的登录态**（右上角的头像、
   "订阅内容"这些只有登录了才有的东西）；
4. 脚本退出之后**浏览器还开着**——attach 收尾只断连，不关用户的浏览器（55 §3）。

## 4. 端到端（走工作台）

1. `pnpm dev:demo` 起工作台；
2. 设置 → 浏览器 → 「连接我电脑上的 Chrome」→ 点「自动找一下」（应探到 9333）→ 保存；
3. 给自己挂一条 `kol.youtube` 职责（它的 `browser_scope` 是 youtube.com 系）；
4. 在那条岗位下开一件事，让它去看某个频道的主页。

要看到的四件事：

- 事件日志里有 `tool.call{tool: 'mcp__playwright-mcp__browser_navigate'}` 与对应的
  `tool.result{status: 'ok'}`；
- 让它去 `amazon.com` → `tool.result{status: 'blocked'}`，理由是人话
  （"这个岗位只能打开 …"）；
- 公司档（`side_effect_policy: 'executor'`，默认）下让它点一个按钮 →
  `blocked`，理由 `write_external_requires_executor`；
- 遇到没登录的页面时它**停下来说"这个页面要先登录"**，而不是去填账号
  （规则写在 persona 段里，见 `browser.ts` 的 `browserBrief`）。

## 4.5 一个会留下文件的地方

官方 Playwright MCP 服务器把截图与快照落在 **Agent 的 `cwd` 下的 `.playwright-mcp/`**
（它 `--output-dir` 的默认值，我们没指定）。我们的 `meta.cwd` 就是服务进程的工作目录，
所以在仓库里跑手工验证会长出一个 `.playwright-mcp/` —— 已经进 `.gitignore`。
真要把它挪到别处，是给 provider 传 `--output-dir` 的事（上游 provider 的薄壳没有透出
这个参数，要改得先改上游）。

## 5. 收尾

```sh
# 关掉工作用的 Chrome（它是单独 Profile，关了不影响你日常那个）
pkill -f 'remote-debugging-port=9333'
```
