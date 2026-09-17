# 本机手工验证：BrowserSkill 接你自己正在用的浏览器（WP92 / 55 §10）

自动化那一层测到哪为止，先说清楚：

| 层 | 谁测 | 测到哪 |
|---|---|---|
| 插件挂载、六个工具、scope 语义、`lazyTools`、"没装好就不挂" | `packages/dsh-adapter/test/browserskill-seam.test.ts`（**真插件 + 假 `bsk`**） | 自动，CI 里跑 |
| 读写按 `args.action`、三处域名白名单、两档策略、人接管 | 同上（真门禁 + 同名工具替身） | 自动，CI 里跑 |
| 装 `bsk`：钉版本 + 校验 sha256 + `bsk doctor` 的解析 | `apps/server/test/browserskill-install.test.ts`（假 release 服务器、假 `bsk`） | 自动，CI 里跑 |
| **真的装上扩展、真的附到你自己的浏览器、真的 observe 一次** | 下面这份手工步骤 | **手工**——CI 里没有带图形界面的浏览器，也不该让 CI 去装一个浏览器扩展 |

改过 `harness.ts` 的插件装配、`browserskill.ts` 的策略、或者升过 `bsk` /
`@wxg-prc-cpg/browser-skill-dsh-plugin` 的版本，跑一遍这份。

---

## 1. 装 `bsk`（我们自己装，不用上游的 install.sh）

设置页（**设置 → 浏览器 → 我正在用的浏览器 → ② 装 bsk**）那个按钮做的就是这一步。
手工跑一遍更直观：

```sh
pnpm exec tsc -b
AGENTSWS_DATA_DIR=${AGENTSWS_DATA_DIR:-$HOME/Library/Application\ Support/agentsws/data}
node --input-type=module -e "
import { installBrowserSkillCli } from './apps/server/dist/browserskill-install.js'
const res = await installBrowserSkillCli({ dataDir: process.env.AGENTSWS_DATA_DIR })
console.log(res)
"
```

期望：打印 `{ path: '…/bin/bsk', version: '0.3.0', sha256: 'f85b2d…' }`。

三件事一件都不能省：

- **版本与 sha256 都钉死在仓库根的 `browserskill.lock.json`**。校验不过就一个文件都不装
  （上游的 `install.sh` 在这种情况下只是打一句警告继续装，我们不接受那一种）。
- **装进数据目录，不进 PATH**。PATH 上有 `bsk` 的话，有 shell 的职责就能直接
  `bsk evaluate` 在页面里跑任意脚本——那条路归 shell 的命令 allowlist 管（WP89），
  不给它这个方便。
- **两个更新开关都要设**（这一条是实测出来的，不是照 README 抄的）：
  `BSK_AUTO_UPDATE=off` 关掉的是**装**（daemon 不再自己把自己换掉——那会绕开我们钉的
  版本与 sha256）；**查**要另设 `BSK_UPDATE_MANIFEST_URL`。只设前一条时 daemon
  **照样**每 30 分钟去 GitHub 取一次 `version.json` 并写进 `~/.bsk/update-check.json`
  （本机复现过；上游 `daemon/start.rs` 的 `spawn_update_check_task` 里，
  `refresh_update_cache` 发生在 `auto_update_step` 之前）。适配器挂插件之前两条一起写进
  环境（`dsh-adapter/src/browserskill.ts` 的 `applyBskEnv`），手工跑的时候自己带上：

  ```sh
  export BSK_AUTO_UPDATE=off
  export BSK_UPDATE_MANIFEST_URL=http://127.0.0.1:1/agentsws-no-update-check.json
  ```

  **管不到的一种情况**：daemon 早就在跑（用户自己装过 `bsk`、先用别的方式起过）时，
  它继承的是当初那个环境，这两条对它无效。`bsk doctor` 会把在跑的那个报出来。

## 2. 装浏览器扩展（只能你自己来）

在你**日常用的那个浏览器**里装，二选一：

- Chrome：<https://chromewebstore.google.com/detail/hhcmgoofomhgciiibhipgmgkgnoenaoi>
- Edge：<https://microsoftedge.microsoft.com/addons/detail/browserskill/emacgiaaaiojkkpkddmmdfhmokgmnikg>

装完打开扩展的弹窗，确认它说"已连接"。这一步没有 API，也不该有：往用户的浏览器里
装东西是**用户自己的决定**，设置页只给链接。

## 3. 体检

```sh
BSK_AUTO_UPDATE=off BSK_UPDATE_MANIFEST_URL=http://127.0.0.1:1/x.json \
  "$AGENTSWS_DATA_DIR/bin/bsk" doctor
```

期望每一条都是 `OK`，尤其这两条：

- `daemon running`：本机 daemon 起来了（第一次跑 `doctor` 会顺手起）；
- `browser extension connected`：扩展连上来了。**扩展没装 / 浏览器没开着**时它是
  `FAIL`，并给出"怎么修"那一句——设置页第 ③ 步把这几条原样列出来。

## 4. 真的让 Agent 附上去看一眼

```sh
node --input-type=module -e "
import { Context } from '@deepseek-ai/cordis'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ApprovalService from '@deepseek-ai/dsh-user-approval'
import { createScope } from '@deepseek-ai/dsh-scope'
import * as Bsk from '@wxg-prc-cpg/browser-skill-dsh-plugin'

process.env.BSK_AUTO_UPDATE = 'off'
process.env.BSK_UPDATE_MANIFEST_URL = 'http://127.0.0.1:1/agentsws-no-update-check.json'
const root = new Context()
root.plugin(SystemPrompt, { includeHarnessIdentity: false })
root.plugin(ToolRuntime, {})
root.plugin(ApprovalService, {})
const ctx = await new Promise((r) =>
  root.plugin({ name: 'probe', inject: ['tools', 'systemPrompt'], apply: (c) => r(c) }),
)
const agent = { id: 'manual' }
const scope = createScope(ctx, agent)
await scope.ctx.plugin(Bsk, {
  bskPath: process.env.AGENTSWS_DATA_DIR + '/bin/bsk',
  lazyTools: false,
  observationEnabled: false,
  maxSessions: 1,
})
console.log('tools:', ctx.tools.schemas(agent).map((s) => s.name).sort())

const call = async (name, args) =>
  ctx.tools.execute({
    callId: String(Math.random()),
    name,
    arguments: args,
    agent,
    signal: new AbortController().signal,
  })

console.log(await call('browser_session', { action: 'start', url: 'https://www.youtube.com/' }))
console.log(await call('browser_inspect', { action: 'observe' }))
console.log(await call('browser_session', { action: 'stop' }))
await scope.dispose()
process.exit(0)
"
```

期望：

- `tools:` 六个名字 —— `browser_assist` / `browser_inspect` / `browser_interact` /
  `browser_page` / `browser_session` / `browser_tabs`（**`lazyTools: false` 是硬要求**：
  上游缺省 `true` 时这六个要等 `browser-skill` 这个技能被调用过一次才注册，而我们的
  组合里没有 skill 那一层，于是一个工具都不会有）；
- `browser_session{start}` 之后你的浏览器里**多出一个 Agent 窗口**（不是抢你现在这个标签）；
- `browser_inspect{observe}` 回一棵压缩过的页面结构（VOM，带 `@e1` 这样的 ref）；
- `browser_session{stop}` 之后那个窗口关掉，你原来的标签一个没动。

> 真要用你已经开着的某个标签：`browser_tabs{action:'borrow', tabId}`，用完
> `return` 还回去。这会打断你手上的事，所以提示词里写着"先问一句"。

## 5. 走一遍设置页

**设置 → 浏览器**：三种方式并列，选「我正在用的浏览器」出那三步向导。
截图见 `docs/assets/workstation/wp92-settings-browser.png`。

---

## 这次实测记到哪一步（2026-09-17）

| 步 | 结果 |
|---|---|
| ① 装 `bsk` | **通过**。`installBrowserSkillCli()` 真的从 GitHub Releases 下了 `cli-v0.3.0` 的 darwin-arm64 产物，sha256 与 `browserskill.lock.json` 逐字相同（`f85b2d46…`），装进 `bin/bsk`，`bsk --version` 回 `bsk 0.3.0` |
| ② 装扩展 | **没做**。往浏览器里装扩展要真人在他自己的浏览器里点"添加"，这一步只能 Luoye 自己来 |
| ③ `bsk doctor` | **跑了，结论如实**：`bsk home writable` / `daemon running`（pid + `ws://127.0.0.1:52800` + unix sock）/ `daemon local process identity` / `protocol compatible`（daemon protocol 1.3, app 0.3.0）都 OK；`extension connected` 是 **FAIL**（"0 browsers connected"，hint 给的正是那两个商店链接）——正是没做第 ② 步该有的样子。服务端那个包装（`browserSkillDoctor()`）拿真 `bsk` 跑了一遍，七条逐条解析正确、`hint` 原样带出 |
| ④ 真 observe | **没做**（要第 ② 步先成立） |

两条顺手撞到、值得记下来的：

- **`BSK_HOME` 不能太长**。第一次把 `BSK_HOME` 指到 scratchpad 里那个一百多字符的路径，
  daemon 起不来（`daemon failed to become ready within 3s`，日志停在"lock acquired"）——
  它的 IPC 是 unix socket，路径有 104 字节上限。用默认的 `~/.bsk` 一次就起来了。
- **`BSK_AUTO_UPDATE=off` 只关"装"不关"查"**：设着 off 跑完 doctor，`~/.bsk/update-check.json`
  里照样多出一条 `{"checked_at_epoch_secs":…,"latest_version":"0.3.0"}`。这就是上面那条
  `BSK_UPDATE_MANIFEST_URL` 的由来。

所以"真的附到一个浏览器上、真的 observe 一次"这一段**仍然欠着**，装好扩展之后照上面
第 4 步跑一遍，把结果补进这张表。

> 跑完记得 `bsk daemon stop`。`bsk status` / `bsk doctor` 会**顺手把 daemon 起起来**
> （ensure-spawn），所以停完别再顺手跑一次 `status` 去"确认停了"——那一下又把它起了。
