/**
 * 一次运行 = 一个 dsh 组合（headless、无状态）。
 *
 * 17 §5.1：运行不读上一次运行的会话文件。这里每次 `run()` 起一棵全新的 Cordis 树 +
 * 一个 Agent + 一个**内存** Session，结束即 dispose，两次运行之间没有任何共享状态
 * （工具注册表、提示词段、审批挂起、会话事件都随树消失）。
 *
 * WP81：回合改由 dsh 官方 Agent 层驱动（54（将改号 55）§2）。挂了哪些包见 `createHarness`
 * 上面那段注释；我们的五个门禁仍然是插件，装在 Agent 的 scoped ctx 上（`gate.ts`）。
 */
import { randomUUID } from 'node:crypto'
import { mkdirSync } from 'node:fs'
import { pathToFileURL } from 'node:url'
import type { ChatMessage, Completion, ModelMeta, RunEvent, ToolDef } from '@agentsws/contracts'
import { chatContentText } from '@agentsws/contracts'
import { canonicalJson, sha256 } from '@agentsws/core'
import { Context } from '@deepseek-ai/cordis'
import Include from '@deepseek-ai/cordis-plugin-include'
import Loader from '@deepseek-ai/cordis-plugin-loader'
import type { Agent, AgentHandle } from '@deepseek-ai/dsh-agent'
import AgentRegistry from '@deepseek-ai/dsh-agent'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import AgentPresetRegistry from '@deepseek-ai/dsh-agent-preset-registry'
import BrowserUseRegistry from '@deepseek-ai/dsh-browser-use'
import ComputerUseRegistry from '@deepseek-ai/dsh-computer-use'
import { credentialRef, isCredentialRefName } from '@deepseek-ai/dsh-credentials'
import * as PlaywrightMcpProvider from '@deepseek-ai/dsh-experimental-browser-use-playwright-mcp'
import * as CuaDriverMcpProvider from '@deepseek-ai/dsh-experimental-computer-use-cua-driver-mcp'
import type { GenerateOptions, RequestMessage, ToolSchema } from '@deepseek-ai/dsh-llm'
import LlmRuntime, { createMessage, createUserMessage } from '@deepseek-ai/dsh-llm'
import SandboxLocal from '@deepseek-ai/dsh-sandbox-local'
import SandboxPolicy from '@deepseek-ai/dsh-sandbox-policy'
import type { Session, SessionEvent, SessionId } from '@deepseek-ai/dsh-session'
import SessionStore from '@deepseek-ai/dsh-session'
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import * as ShellEnv from '@deepseek-ai/dsh-shell-env'
import SubprocessLocal from '@deepseek-ai/dsh-subprocess-local'
import SystemPrompt, { renderContextSections, renderPrompt } from '@deepseek-ai/dsh-system-prompt'
import * as ToolBash from '@deepseek-ai/dsh-tool-bash'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import ApprovalService from '@deepseek-ai/dsh-user-approval'
import * as BrowserSkillPlugin from '@wxg-prc-cpg/browser-skill-dsh-plugin'
import { browserProviderConfig } from './browser.js'
import { applyBskEnv, browserSkillPluginConfig, bskBinaryUsable } from './browserskill.js'
import {
  applyCuaEnv,
  computerUseGranted,
  computerUseProviderConfig,
  cuaDriverUsable,
} from './computer-use.js'
import { DshAdapterError } from './errors.js'
import type { GateApi, GateInput } from './gate.js'
import { installGate } from './gate.js'
import type { GatewayBudget } from './llm.js'
import { GATEWAY_PROVIDER, GatewayLlmAdapter } from './llm.js'
import { presetCredentialRefs, presetDefinition } from './preset.js'
import { AgentswsBashExecutor, runShell } from './shell.js'
import {
  installSubscriptionLlm,
  subscriptionProviderOf,
  watchSubscriptionCalls,
} from './subscription.js'

/** 装配 dsh 服务时等注入就绪的上限（毫秒）。 */
const READY_TIMEOUT_MS = 5000

/** 一次运行允许的模型步数上限（与 direct-llm 的 turn loop 同一个数）。 */
export const DEFAULT_MAX_STEPS = 8

export interface HarnessInput extends GateInput {
  meta: ModelMeta
  /** dsh 侧的模型路由；provider 固定为我们的网关适配器。 */
  model: string
  /**
   * WP86：这条职责的 preset（`writePreset()` 刚写好的那个）。
   *
   * 不给 = 这次运行不挂 preset：不装 Loader / Include / AgentPresets，
   * 工具面里一个 `mcp__*` 都没有——与 WP82 的浏览器同一条纪律（不用的东西不挂）。
   */
  preset?: { root: string; id: string }
  /** 这次运行的 dsh 会话 id（无状态：一次运行一个，结束即销毁）。 */
  sessionId?: string
  /** 模型步数上限；缺省 8。 */
  maxSteps?: number
  /** 预算耗尽时的回调（宿主发 `budget.exhausted` 并停 Agent）；与 `GateInput` 同一个签名。 */
  /** 宿主累计的 token 用量（预算判定读它）。 */
  tokensSpent?: () => number
  /** 每次真的送进网关的请求（Model-visible ⟺ logged）。 */
  onModelRequest?: (request: { messages: ChatMessage[]; tools: ToolDef[] }) => void
  /** 每次补全的用量。 */
  onCompletion?: (completion: Completion) => void
  /** 网关抛错时的原样消息（26 `freeze_on_model_outage` 要的那句话）。 */
  onModelError?: (message: string) => void
}

export interface DshHarness {
  ctx: Context
  gate: GateApi
  /** dsh 官方 Agent 层的句柄；回合由它驱动。 */
  agent: Agent
  session: Session
  /** dsh 装配出来的系统提示词（persona complete 段）。 */
  systemText(): Promise<string>
  /** dsh 装配出来的动态上下文快照分节（每个 ContextItem 一段）。 */
  contextSections(): Promise<{ name: string; text: string }[]>
  /** 经 dsh 的 `ctx.llm` 走一次补全（一次性调用；回合里的补全由 agent-loop 发起）。 */
  complete(prompt: { messages: ChatMessage[]; tools: ToolDef[] }): Promise<{
    text: string
    completion: Completion
  }>
  /**
   * 投一轮：`followup(createUserMessage(...))` → `whenIdle()`。
   * 返回这一轮 Agent 最后说的那段文本与终止原因。
   */
  runTurn(text: string): Promise<{ text: string; reason: string }>
  /** 中断这一轮（17 §5.6）。 */
  cancel(): void
  dispose(): Promise<void>
}

/**
 * 一次性调用（`complete`）的消息翻译。
 *
 * WP132（0.1.7-rc.1）：`GenerateOptions.messages` 从 `Message[]` 放宽成 `RequestMessage[]`，
 * user 一侧可以是**不进会话日志**的 `RequestUserInput`（无 id、无 source）——这正是
 * 一次性调用要的，所以 user / tool 两种都走它（tool 照旧降成 user 文本，与 0.1.6 同形）。
 * assistant 一侧的类型收紧了：`source` 必须是 `{ kind: 'model', provider, model }`
 * （0.1.6 可以随便写 `{ kind: 'user' }`），这里如实标成我们的网关路由与这次的模型。
 * `toChatMessages` 对这三种的翻译结果与 0.1.6 逐字段相同（角色、文本、顺序都没变）。
 */
function toDshMessages(
  messages: ChatMessage[],
  model: string,
): { system: string; messages: RequestMessage[] } {
  const systems: string[] = []
  const rest: RequestMessage[] = []
  for (const m of messages) {
    if (m.role === 'system') {
      systems.push(chatContentText(m.content))
      continue
    }
    const content = [{ type: 'text' as const, text: chatContentText(m.content) }]
    if (m.role === 'assistant') {
      rest.push(
        createMessage({
          role: 'assistant',
          content,
          source: { kind: 'model', provider: GATEWAY_PROVIDER, model },
        }),
      )
      continue
    }
    rest.push({ role: 'user', content })
  }
  return { system: systems.join('\n\n'), messages: rest }
}

function toDshToolSchemas(tools: ToolDef[]): ToolSchema[] {
  return tools.map((t) => ({
    name: t.name,
    description: t.description,
    parameters: (t.input_schema ?? {}) as Record<string, unknown>,
  }))
}

/**
 * 挂 preset 的那一跳里，把 `!!js process.env.<REF>` 需要的值放进 `process.env`，挂完还原。
 *
 * 为什么是这个形状（诚实记一笔）：官方 `mcp-client` 的配置只认**值**，它没有
 * `ctx.credentials` 这条路；而官方自己给的写法就是 `!!js process.env.X`
 * （`mcp-client` README 的第一个例子）。于是链条只能是
 * `ctx.credentials.resolve(ref)` →（极短的一段时间里）`process.env[ref]` → 子进程 / 请求头。
 *
 * 三条纪律把这一段收紧：
 * 1. **只在这一跳里存在**：`finally` 里逐个还原（原来有值就还原成原值，没有就删掉）；
 * 2. **不覆盖既有的同名变量**：进程里本来就有这个名字的，说明是启动环境给的，
 *    那个值优先（与官方 `credentials-local` 的层级一致：inherited environment wins）；
 * 3. **一个字都不进事件、不进模型**：这里既不发事件也不记日志，名字都不记。
 *
 * 生成的文件里从头到尾只有名字——`preset.test.ts` 逐字节钉着这一条。
 */
async function withPresetCredentials<T>(
  ctx: Context,
  input: HarnessInput,
  body: () => Promise<T>,
): Promise<T> {
  const refs =
    input.options.credentials === undefined
      ? []
      : presetCredentialRefs(input.request).filter(isCredentialRefName)
  const restore: { name: string; before: string | undefined }[] = []
  if (refs.length > 0) {
    for (const name of refs) {
      if (process.env[name] !== undefined) continue
      const hit = await ctx.credentials.resolve(credentialRef(name))
      if (hit === undefined) continue
      restore.push({ name, before: undefined })
      process.env[name] = hit.value
    }
  }
  try {
    return await body()
  } finally {
    for (const { name, before } of restore) {
      if (before === undefined) delete process.env[name]
      else process.env[name] = before
    }
  }
}

/** 等一个已 provide 的服务出现在 context 上（Cordis 的注入是异步的）。 */
async function inject(root: Context, services: string[]): Promise<Context> {
  return new Promise<Context>((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(
        new DshAdapterError('timeout', `dsh 服务未就绪：${services.join(', ')}`, {
          retryable: true,
        }),
      )
    }, READY_TIMEOUT_MS)
    root.plugin({
      name: 'agentsws-gate-host',
      inject: services,
      apply(ctx: Context) {
        clearTimeout(timer)
        resolve(ctx)
      },
    })
  })
}

/**
 * 起一棵 dsh 组合树：官方 Agent 层 + 核心服务 + 我们的门禁插件 + LlmAdapter。
 *
 * **最小挂载**（54（将改号 55）§2.1，不用 `dsh-base`、不起 web server、不读 DSH_HOME）：
 * - `dsh-session`：Session 是 Agent 的真源；**不挂** `session-persistence-jsonl` → 内存会话（17 §5.1）
 * - `dsh-session-projection`：`agent-loop` 的 `inject` 之一（inbox 与 turn-boundary 两个投影要它）
 * - `dsh-agent`：`ctx.agents` 与 `Agent` 句柄
 * - `dsh-agent-loop`：唯一的官方驱动（把自己注册成 `ctx.agents` 的 factory），回合就是它排的
 * - `dsh-system-prompt` / `dsh-tools` / `dsh-user-approval` / `dsh-llm`：四个门禁挂的地方，WP30 起就在
 *
 * 注意这是**同进程**的 headless 组合，不是 `dsh --profile headless` 子进程：
 * 模拟回路要在同一进程里拿到 `stage` / `createDraft` 回调与合成时钟。
 * 跨进程那一档见 `headless/child.ts`（同一份组合，换宿主进程）。
 */
export async function createHarness(input: HarnessInput): Promise<DshHarness> {
  const root = new Context()
  /*
   * WP86（55 §4 第三层）：**只有这条职责真有连接才有 preset 这一层**。
   *
   * preset 服务要一个 `loader`（组合是一列插件行，得有人 import 它们），
   * 行在 `cordis-plugin-include` 的子树里起。两个都只在这时候挂。
   *
   * `ctx.baseUrl` 是**包名从哪解析**：preset 的行写的是包名（`@deepseek-ai/dsh-mcp-client`），
   * 要从这个包的依赖里解析，所以 base 必须指回这个包（registry 激活时用的是
   * `record.context.baseUrl`，即注册它的那个 ctx 的 base）。
   *
   * WP132（dsh 0.1.7-rc.1）：官方把 `dsh-agent-presets`（按目录扫 roster，WP86 用的
   * `roots` / `includeShippedRoot: false` / `includeUserRoot: false` / `trust: 'system'`）
   * 整包换成了 `dsh-agent-preset-registry`：**不扫目录、不收路径**，官方四个 preset
   * 与 `$DSH_HOME` 下的用户 preset 都只能以 bundle 的插件行进来。我们的树里不挂任何
   * bundle 行，所以 roster 里**只有我们注册的这一条**——16 §1「公司端不装第三方代码」
   * 从"两个开关关着"变成"结构上就没有入口"。
   */
  const preset = input.preset
  if (preset !== undefined) {
    root.baseUrl = `${pathToFileURL(import.meta.dirname).href}/`
    await root.plugin(Loader)
    root.loader.builtins.include = Include
  }
  root.plugin(SessionStore)
  root.plugin(SessionProjectionRegistry)
  root.plugin(AgentRegistry)
  root.plugin(SystemPrompt, { includeHarnessIdentity: false })
  root.plugin(ToolRuntime, {})
  root.plugin(ApprovalService, {})
  root.plugin(LlmRuntime)
  /*
   * WP90（55 §9 Q8）：**这次运行走不走订阅登录那条路**。
   *
   * `RunRequest.runtime.model.provider` 是 `openai-codex` / `anthropic` 才挂官方
   * `dsh-llm-pi-ai`；它按 provider 名注册自己的适配器，与我们的 `agentsws-gateway`
   * 在同一棵树上并存、互不知道对方。不走这条路的运行里连这个插件都不装
   * ——与浏览器、preset 同一条纪律（不用的东西不挂）。
   */
  const subscription = subscriptionProviderOf(input.request.runtime.model.provider)
  if (subscription !== undefined) await installSubscriptionLlm(root)
  /*
   * WP82（55 §3）：**只有这次运行真要开浏览器才有浏览器这一层**。
   *
   * `browserUse` 是官方的独占 provider 槽（一棵树一个 provider）；provider 本身
   * 按职责挂在 Agent 的 scoped ctx 上（`setup` 里，AGENT-LAYER §8.1 第 ② 条）。
   * 不给 `RunRequest.browser` 的运行里连这个服务都不存在——没有工具、没有提示词段、
   * 也不会起任何 MCP 子进程。
   */
  const browser = input.request.browser
  /*
   * WP92（55 §10）：**一次运行只挂一种浏览器**。第二种（腾讯 BrowserSkill）走的不是
   * 官方 `dsh-browser-use` seam——那个插件直接 `ctx.tools.register` 六个工具，
   * 所以这一档连 `browserUse` 这个服务都不挂（挂了也没人注册 provider，白占一个槽）。
   */
  const browserSkill = browser?.mode === 'browserskill'
  if (browser !== undefined && !browserSkill) root.plugin(BrowserUseRegistry)
  /*
   * WP144（docs/80）：**只有人批过、而且还没过期，才有电脑操控这一层**。
   *
   * `computerUse` 是官方的独占 provider 槽（一棵树一个 provider，第二个激活即失败）；
   * provider 本身按 Agent 挂在 scoped ctx 上（`setup` 里，排在浏览器之后）。
   * 只给了 `computer_use`、还没批的运行里**连这个服务都不挂**——模型只看得见
   * `request_computer_use` 那一个自有工具（`gate.ts`），驱动一个进程都不会起。
   * 授权按墙钟判（授权是「接下来 N 分钟」，与合成时钟无关）。
   */
  const computerUse = input.request.computer_use
  const cuGranted = computerUseGranted(computerUse, (input.options.wallClockMs ?? Date.now)())
  if (cuGranted) root.plugin(ComputerUseRegistry)
  /*
   * WP89（55 §8 Q7）：**只有建站与主题那条职责、而且请求里真给了 `shell`，才有终端**。
   *
   * 挂的是官方那一摞，一个都不是我们写的（顺序就是依赖顺序）：
   * - `dsh-subprocess-local` → `ctx.subprocess`：真正 fork 进程的那一层；
   * - `dsh-sandbox-local` → `ctx.sandbox`：按平台选笼子（macOS Seatbelt / Linux
   *   bwrap→Landlock / Windows 受限令牌）。选不出来就 `SANDBOX_UNAVAILABLE` **fail-closed**
   *   ——命令不会"没关笼子就跑"，这正是我们要的；
   * - `dsh-sandbox-policy` → `ctx.sandboxPolicy`：档位与可写根。**`workspaceRoot` 只是
   *   "没有会话时的兜底"**；真正管着 Agent 那次调用的是**会话的 cwd**（上游原话：
   *   normal agent calls use their session cwd instead），所以下面 `agents.create`
   *   的 `meta.cwd` 必须是同一个目录，少一处就会写到别的地方去；
   * - `dsh-bash-sandbox` → `ctx.shell`：一条命令 = 一个 `bash -c` 子进程，经沙箱包一层。
   *   **一棵树只许有一个执行器**，所以 `dsh-bash-local` 不单独挂（它是前者的父类）。
   *   挂的是它的子类 {@link AgentswsBashExecutor}——多的那一点见 `shell.ts` 的注释：
   *   凭据经 `resolve()` 的显式 `env` 直接进子进程，一次都不进这个进程的环境。
   *
   * 档位从契约来，而契约里只有 `read-only` / `workspace-write`——
   * `danger-full-access` 在这条路上根本拼不出来（`contracts/run.ts` 的 `RunShell`）。
   */
  /*
   * **为什么不写进职责 preset**（WP89 的取舍，实测过，不是猜的）。
   *
   * Q7 的交付单原话是"在这条职责的 preset 里挂"。试了：把这六行写进
   * `agent.cordis.yml` 再 `mount()`，上游当场拒——
   *
   * > agent-presets: preset "…" failed to mount: row(s) published process-global
   * > service(s) [sandbox, sandboxPolicy, shell, shellEnv, subprocess];
   * > a preset service must sit behind an `isolate` realm or move to the host composition
   *
   * 这与 WP82 的浏览器 provider 是同一条纪律（`preset.ts` 的 manifest 注释已经写过
   * "不许往 root realm 发服务"），只是那次没撞上、这次撞上了。上游给的两条路里
   * ——`isolate` realm、或者搬到宿主组合——我们选后者：沙箱根是**一次运行一个值**
   * （这家店的副本目录），写进 preset 文件等于每次运行都重写它，而上游把"代"钉在
   * 组合文件的 mtime + size 上、被顶掉的那一代永不回收（`preset.ts` 文件头那段）。
   *
   * 所以职责 preset 那一层只管 MCP 连接；终端与沙箱按职责在这里挂——
   * "谁有终端"仍然是职责说了算（`runShell()`），只是挂的地方在宿主。
   */
  const shell = runShell(input.request)
  if (shell !== undefined) {
    // 副本目录不存在就建出来：沙箱要 canonicalize 这个根，不存在会当场 fail-closed
    mkdirSync(shell.workspace_root, { recursive: true })
    root.plugin(SubprocessLocal, {} as never)
    root.plugin(SandboxLocal, {} as never)
    root.plugin(SandboxPolicy, {
      mode: shell.mode,
      workspaceRoot: shell.workspace_root,
    } as never)
    root.plugin(AgentswsBashExecutor, { cwd: shell.workspace_root } as never)
    root.plugin(ShellEnv, {} as never)
  }
  // 串行：并行工具调用会让两档的事件顺序不可比（17 §4「换宿主不换语义」）
  root.plugin(AgentLoop, { maxParallelToolCalls: 1, agents: [] })
  /*
   * WP86 凭据段（55 §4）：官方 `ctx.credentials` 是**单 provider**——实测一棵树上
   * 第二个 `CredentialProvider` 直接抛 `service "credentials" has been registered`。
   * 所以这里挂的是调用方给的**那一个**（本机凭据与 OpenConnector 的分层由
   * `@agentsws/credentials-openconnector` 的组合 provider 在它内部做）。
   */
  const credentials = input.options.credentials
  if (credentials !== undefined) {
    // 形状是 cordis 的插件（`CredentialProvider` 的子类或带 `apply` 的对象）；
    // 这一层不该知道是哪一个，所以类型在 `DshRuntimeOptions` 上是 `unknown`。
    root.plugin(credentials as Parameters<Context['plugin']>[0], undefined as never)
  }
  if (preset !== undefined) {
    root.plugin(AgentPresetRegistry, { default: preset.id } as never)
  }

  const ctx = await inject(root, [
    'tools',
    'systemPrompt',
    'llm',
    'agents',
    'sessions',
    ...(browser === undefined || browserSkill ? [] : ['browserUse']),
    ...(cuGranted ? ['computerUse'] : []),
    ...(preset === undefined ? [] : ['agentPresets']),
    ...(shell === undefined ? [] : ['shell', 'sandbox', 'sandboxPolicy', 'shellEnv', 'subprocess']),
    // Cordis 的规矩：没 `inject` 过的服务连读都读不到（"cannot get property … without inject"）
    ...(credentials === undefined ? [] : ['credentials']),
  ])

  /*
   * WP89：官方 `bash` 工具。**必须在 `agents.create` 之前挂完**——`installGate` 里的
   * `tools.restrict({ allow })` 只认调用当刻**已经全局注册**的名字（与 WP86 的 preset
   * 同一条实测），晚一步 `bash` 就会被职责白名单挡在 Agent 的 scope 之外。
   *
   * `enableRunInBackground: false`：不挂 `dsh-jobs`，而且 17 §5.1 一次运行一棵树、
   * 跑完即销毁——后台进程在这条路上没有主人。关掉之后模型连这个参数都看不见。
   */
  /*
   * WP132：`promoteOnTimeout` 是 0.1.7 新加的开关、**默认 true**（上游 `tool-bash` README 配置表：
   * 「Keep a foreground command that reaches its timeout running as its background job instead
   * of killing it」）。上游实现里它与 `enableRunInBackground` 取与（`src/index.ts` 第 236 行），
   * 所以在我们这条路上本来就不生效；照样显式写 false——默认值是上游可以单方面翻的，
   * 而"超时的命令不杀、转后台接着跑"与 17 §5.1「一次运行一棵树、跑完即销毁」正面冲突。
   */
  if (shell !== undefined) {
    await ctx.plugin(ToolBash, { enableRunInBackground: false, promoteOnTimeout: false } as never)
  }

  /*
   * WP132：把这条职责的 preset **注册**进 registry（0.1.7 的新入口，取代按目录扫）。
   *
   * 0.1.7 是**注册即激活**：`register()` 当场建 scope + 内存 Loader 树、把每一行
   * 真的 import 并起起来（mcp-client 的子进程 / 连接就在这一刻起），`mount()` 只是把
   * Agent 绑到这一代上。所以凭据引用要在 `register()` 这一跳里解析——
   * `withPresetCredentials` 从 `mount()` 挪到了这里，三条纪律一条不改。
   * 激活失败**不抛**（registry 把它记成 broken，随后 `mount()` 才拒）；这里读一遍
   * `resolve()` 把 broken 当场翻成错误，免得晚到 `setup` 里才露出来、错误信息变成"绑定失败"。
   * 注销不用我们管：registry 挂在 root 上，`root.fiber.dispose()` 连这一代一起收。
   */
  if (preset !== undefined) {
    await withPresetCredentials(ctx, input, async () => {
      await ctx.agentPresets.register(presetDefinition(input.request))
    })
    const resolved = await ctx.agentPresets.resolve(preset.id)
    if (resolved.broken !== undefined) {
      await root.fiber.dispose()
      throw new DshAdapterError('internal', `职责 preset 挂不上：${resolved.broken}`)
    }
  }

  let lastCompletion: Completion | undefined
  const budget: GatewayBudget | undefined =
    input.onBudgetExhausted === undefined || input.tokensSpent === undefined
      ? undefined
      : {
          max_steps: input.maxSteps ?? DEFAULT_MAX_STEPS,
          max_tokens: input.request.budget.max_tokens,
          spent: input.tokensSpent,
          exhausted: (which, used, cap) => input.onBudgetExhausted?.(which, used, cap),
        }
  const adapter = new GatewayLlmAdapter({
    gateway: input.options.gateway,
    meta: input.meta,
    ...(input.options.seed === undefined ? {} : { seed: input.options.seed }),
    max_cost_base: input.request.budget.max_cost_base,
    ...(budget === undefined ? {} : { budget }),
    ...(input.onModelRequest === undefined ? {} : { onRequest: input.onModelRequest }),
    ...(input.onModelError === undefined ? {} : { onError: input.onModelError }),
    onCompletion: (c) => {
      lastCompletion = c
      input.onCompletion?.(c)
    },
  })
  const releaseAdapter = ctx.llm.registerAdapter([GATEWAY_PROVIDER], adapter)
  /*
   * 订阅路由的记账（55 §9「网关只记 token、`cost_base` 0」）。官方适配器不经我们的
   * 网关，所以请求事件、用量投影、预算三件事在 `llm/stream` 这道 waterfall 上补回来。
   */
  const releaseSubscription =
    subscription === undefined
      ? () => undefined
      : watchSubscriptionCalls(ctx, {
          provider: subscription,
          model: input.model,
          ...(budget === undefined ? {} : { budget }),
          ...(input.onModelRequest === undefined ? {} : { onRequest: input.onModelRequest }),
          onCompletion: (c) => {
            lastCompletion = c
            input.onCompletion?.(c)
          },
        })

  const sessionId = (input.sessionId ?? `agentsws-${randomUUID()}`) as SessionId
  let gate: GateApi | undefined
  let handle: AgentHandle
  try {
    handle = await ctx.agents.create({
      sessionId,
      /*
       * WP89：会话的 `cwd` **就是沙箱的可写边界**（`sandbox-policy` 按它解析
       * `workspace-write`，见上面挂那一摞时的注释）。没有终端的运行照旧用进程 cwd
       * ——那时候没人读它。
       */
      meta: { cwd: shell?.workspace_root ?? process.cwd() },
      agentOptions: { provider: subscription ?? GATEWAY_PROVIDER, model: input.model },
      setup: async (agentCtx: Context, agent: Agent) => {
        /*
         * ① preset 先挂（WP86）。**顺序是硬的**，实测两条：
         *
         * - preset 挂上来的 `mcp__*` 工具**受** `ctx.tools.restrict({ allow })` 管
         *   （与浏览器 provider 相反），所以名字必须进白名单；
         * - `restrict` 只认调用当刻**已经注册**的名字，先 restrict 后 mount 会抛
         *   `tools.restrict() names unknown global tools`，而且抛完整个白名单都没装上。
         *
         * 所以：mount → installGate（它里面调 restrict）→ 浏览器 provider。
         */
        if (preset !== undefined) {
          // WP132：凭据已在 `register()` 那一跳解析过（见上），这里只绑定
          await ctx.agentPresets.mount(agentCtx, preset.id)
        }
        // 工具与 hook 装在宿主 ctx 上（scope-filtered dispatch 按 `exec.agent` 路由），
        // `tools.restrict` 则必须在 Agent 的 scoped ctx 上调——全局 ctx 会抛。
        gate = installGate(ctx, { ...input, agent, agentCtx })
        if (browser !== undefined) await mountBrowser(agentCtx)
        /*
         * WP144：电脑操控提供方，排在浏览器**之后**（mount → installGate → 浏览器 →
         * 电脑操控）。挂的位置与浏览器 provider 同类：Agent 的 scoped ctx，工具因此是
         * scoped registration——`tools.restrict` 遮不住，也不能列进白名单。
         */
        if (cuGranted && computerUse !== undefined) await mountComputerUse(agentCtx, computerUse)
      },
    })
  } catch (e) {
    releaseSubscription()
    releaseAdapter()
    await root.fiber.dispose()
    throw e
  }

  /** WP82 / WP92：浏览器那一层（两种执行器一次只挂一种）。 */
  async function mountBrowser(agentCtx: Context): Promise<void> {
    if (browser === undefined) return
    if (browserSkill) {
      /*
       * WP92：腾讯官方的 dsh 插件（`@wxg-prc-cpg/browser-skill-dsh-plugin`）。
       * 挂的位置与官方 provider **一模一样**：同一个 `setup`、同一步（mount →
       * installGate → 浏览器），挂在 Agent 的 scoped ctx 上——实测它注册的六个工具
       * 因此是 **scoped registration**（`ctx.tools.restrict` 遮不住、也不能列进
       * 白名单，列了当场抛 `unknown global tools`）。详见 AGENT-LAYER §9.7。
       */
      const config = browserSkillPluginConfig(browser)
      if (!bskBinaryUsable(config.bskPath)) {
        /*
         * **装好了才挂**。`bskPath` 指到一个不存在的文件时，插件加载时那次
         * `bsk --version` 探活 spawn 失败却仍被记进 in-flight 表，卸载时
         * `killAll()` 对一个没有 pid 的子进程发 SIGINT——信号落到**我们自己
         * 这个进程组**上，整个服务进程当场退出（实测，AGENT-LAYER §9.7）。
         * 所以这里宁可让这次运行明明白白地失败。
         */
        throw new DshAdapterError(
          'invalid_input',
          `BrowserSkill 没装好：${config.bskPath} 不在，或者不能执行（设置页的第 ② 步「装 bsk」）`,
        )
      }
      // 两个更新开关（55 §10）：不自己换版本，也不去 GitHub 查——实测 `off`
      // 只关掉"装"，"查"要另设清单地址（`applyBskEnv` 的注释里有复现结论）。
      applyBskEnv()
      await agentCtx.plugin(BrowserSkillPlugin, config as never)
      return
    }
    /*
     * 官方 Playwright MCP provider。`setup` 是**只装配**的一跳（官方 `dsh-agent`
     * 的原话：setup composes, it never drives），而且它跑在 `agent/created`
     * **之前**——provider 整个挂在那个事件上，所以必须在这里 await 装完，
     * 晚一步这个 Agent 就拿不到浏览器工具。
     *
     * 一个 Agent 一个 MCP 客户端、attach 模式独占（`exclusive: mode === 'attach'`），
     * `handle.dispose()` 时跟着走 —— 与 17 §5.1「一次运行一棵树」天然一致。
     */
    await agentCtx.plugin(PlaywrightMcpProvider, browserProviderConfig(browser) as never)
  }

  /**
   * WP144（docs/80）：官方 Cua Driver **MCP** 提供方（驱动是独立进程；不用 native）。
   *
   * **装好了才挂**（WP92 那条坑的同一条纪律）：驱动路径指错时提供方激活会失败，
   * 这里宁可在挂之前就让这次运行明明白白地失败——服务端 `forRun` 那一侧更早一步，
   * 没装根本不给 `computer_use`。挂之前把驱动的遥测与查更新两个开关关掉
   * （子进程继承我们这个进程的环境，提供方不收 `env`）。
   */
  async function mountComputerUse(agentCtx: Context, cu: NonNullable<typeof computerUse>) {
    if (!cuaDriverUsable(cu.command)) {
      throw new DshAdapterError(
        'invalid_input',
        `电脑操控的驱动没装好：${cu.command} 不在，或者不能执行（设置页「电脑操控」第 ① 步）`,
      )
    }
    applyCuaEnv()
    await agentCtx.plugin(CuaDriverMcpProvider, computerUseProviderConfig(cu) as never)
  }
  if (gate === undefined) {
    await handle.dispose()
    releaseSubscription()
    releaseAdapter()
    await root.fiber.dispose()
    throw new DshAdapterError('internal', 'Agent setup 没有装上门禁插件')
  }
  const installed = gate
  const agent = handle.agent

  const assemble = async () => ctx.systemPrompt.assemble({ agent } as never)

  return {
    ctx,
    gate: installed,
    agent,
    session: agent.session,
    async systemText() {
      return renderPrompt(await assemble())
    },
    async contextSections() {
      return renderContextSections(await assemble()).map((s) => ({ name: s.name, text: s.text }))
    },
    async complete(prompt) {
      const { system, messages } = toDshMessages(prompt.messages, input.model)
      const options: GenerateOptions = {
        provider: GATEWAY_PROVIDER,
        model: input.model,
        system,
        messages,
        tools: toDshToolSchemas(prompt.tools),
      }
      let text = ''
      for await (const chunk of ctx.llm.stream(options)) {
        if (chunk.type === 'text-delta') text += chunk.text
        if (chunk.type === 'finish' && chunk.reason.kind === 'error') {
          throw new DshAdapterError('provider_unavailable', 'dsh LlmRuntime 报告补全失败', {
            retryable: true,
          })
        }
      }
      if (lastCompletion === undefined) {
        throw new DshAdapterError('provider_unavailable', '网关没有返回补全')
      }
      return { text, completion: lastCompletion }
    },
    async runTurn(text) {
      /*
       * WP133：这一轮的摘要从**送到手的事件**里边收边折（`session/event`），不再回头按 seq
       * 翻会话日志。`session.eventAt()` / `snapshotEvents()` / `ownEvents()` 上游已弃用
       * （`dsh-session` README「Read the log」；官方 Agent Note 2026-09-09「Deprecate synchronous
       * reads of arbitrary Session events」：普通逻辑"process the delivered current event
       * instead of looking back through historical events"）。事件是 `append` 时同步发布的，
       * 订阅挂在 `followup` 之前，`whenIdle()` 之后这一轮的事件一条不少。
       */
      const turn = new TurnSummary()
      const sessionId = agent.session.id
      const off = ctx.on('session/event', (session: { id: unknown }, event: SessionEvent) => {
        if (session.id === sessionId) turn.observe(event)
      })
      try {
        agent.followup(
          createUserMessage({ content: [{ type: 'text', text }], source: { kind: 'user' } }),
        )
        await agent.whenIdle()
      } finally {
        off()
      }
      return turn.result()
    },
    cancel() {
      agent.cancel({ kind: 'user' } as never)
    },
    async dispose() {
      releaseSubscription()
      releaseAdapter()
      await installed.dispose()
      await handle.dispose()
      await root.fiber.dispose()
    },
  }
}

/**
 * 一轮的摘要：Agent 最后说的那段文本 + 终止原因（官方 headless 的 `summarize` 同款）。
 * 逐条喂这一轮的 `session/event`，折法与 WP133 之前按 seq 用 `eventAt()` 回扫**逐条相同**：
 * 最后一条文字非空的 `assistant/message` 胜出，`turn/end` 给出原因，别的事件不看。
 */
export class TurnSummary {
  private text = ''
  private reason = 'unknown'

  observe(event: SessionEvent): void {
    if (event.type === 'assistant/message') {
      const joined = (
        event.data as { message: { content: readonly { type: string; text?: string }[] } }
      ).message.content
        .filter((b) => b.type === 'text')
        .map((b) => b.text ?? '')
        .join('')
      if (joined !== '') this.text = joined
    }
    if (event.type === 'turn/end') {
      this.reason = (event.data as { reason: { kind: string } }).reason.kind
    }
  }

  result(): { text: string; reason: string } {
    return { text: this.text, reason: this.reason }
  }
}

/** 一段模型可见内容的指纹（事件里只记哈希，正文不重复进日志）。 */
export function visibleDigest(value: unknown): string {
  return sha256(canonicalJson(value)).slice(0, 16)
}

export type { RunEvent }
