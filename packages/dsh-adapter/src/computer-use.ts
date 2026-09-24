/**
 * WP144（docs/80）：电脑操控——官方 `dsh-computer-use` + Cua Driver **MCP 提供方**。
 *
 * 工具面一个字都不是我们写的：驱动 `cua-driver mcp` 是独立进程，官方提供方经
 * `dsh-mcp-client` 把它自己报的工具原样挂成 `mcp__cua-driver-mcp__<tool>`。
 * **不用 native 提供方**：那个在我们的服务进程里跑原生模块，上游原话「原生崩溃
 * 可能终止该进程」。
 *
 * 我们这一侧只剩策略，全在这个文件里：
 *
 * | 策略 | 做法 |
 * |---|---|
 * | 挂不挂 | `RunRequest.computer_use` 在场、**而且**有没过期的 `granted_until` 才挂提供方；只在场没授权 = 只给 {@link REQUEST_COMPUTER_USE_TOOL} |
 * | 读写分类 | 驱动的工具**全部**按 `write_external`（截图、列窗口也算——整屏截图是隐私）；表外的新工具同样 |
 * | 授权窗口 | {@link checkComputerUse}：没授权 / 过期 / 已交还给人 → 立刻拒 |
 * | 硬拒 | 查更新、改驱动配置（出网 / 改自身行为）；`screenshot_out_file`（往任意路径写文件） |
 * | 人接手 | 登录 / 密码 / 支付 / 验证码一律停下，调 {@link COMPUTER_HANDOFF_TOOL} 出卡请人来做 |
 * | 截图不进模型 | 结果里的图片块与 base64 在 `tools/post-execute` 换成一句说明（{@link redactComputerUseValue}） |
 * | 遥测 / 更新 | 驱动的遥测与查更新两个开关都关（{@link applyCuaEnv}） |
 */
import { accessSync, constants, statSync } from 'node:fs'
import type { RunComputerUse, RunRequest } from '@agentsws/contracts'
import type { ToolDefinition } from '@deepseek-ai/dsh-tools'
import { defineTool } from '@deepseek-ai/dsh-tools'
import { DshAdapterError } from './errors.js'

/** 官方提供方写死的 MCP 服务器名（上游 `serverName: "cua-driver-mcp"`）。 */
export const CUA_SERVER_NAME = 'cua-driver-mcp'
/** 驱动工具在模型面前的前缀（上游 README：fixed `mcp__cua-driver-mcp__` namespace）。 */
export const CUA_TOOL_PREFIX = `mcp__${CUA_SERVER_NAME}__`

/** 没授权时唯一的那个工具：出一张授权卡。 */
export const REQUEST_COMPUTER_USE_TOOL = 'request_computer_use'
/** 授权期间遇到登录 / 密码 / 支付 / 验证码：停下、出卡请人接手。 */
export const COMPUTER_HANDOFF_TOOL = 'computer_handoff'

/** 去掉前缀之后的驱动工具短名；不是驱动的工具回 `undefined`。 */
export function cuaToolName(tool: string): string | undefined {
  return tool.startsWith(CUA_TOOL_PREFIX) ? tool.slice(CUA_TOOL_PREFIX.length) : undefined
}

/** 我们自己的两个电脑操控工具。 */
export function isComputerUseOwnTool(tool: string): boolean {
  return tool === REQUEST_COMPUTER_USE_TOOL || tool === COMPUTER_HANDOFF_TOOL
}

/**
 * 授权期间也**一律拒**的驱动工具。
 *
 * - `check_for_update`：驱动会去 GitHub 查新版本（出网）。版本由我们钉在
 *   `computer-use.lock.json`、由上游哨兵盯，不由 Agent 查；
 * - `set_config` / `get_config`：改的是驱动自己的持久配置（`~/.cua-driver/config.json`，
 *   里面就有遥测与查更新的开关），Agent 不该碰；
 * - 名字里带 update / telemetry / autostart / install 的：上游以后加进来的同类，一样拒。
 */
const CUA_DENIED_TOOLS: ReadonlySet<string> = new Set([
  'check_for_update',
  'set_config',
  'get_config',
])
const CUA_DENIED_PATTERN = /(^|_)(update|telemetry|autostart|install|uninstall)(_|$)/u

/** 带了就拒的入参：`screenshot_out_file` 让驱动把 PNG 写到**任意路径**。 */
const CUA_DENIED_ARGS: readonly string[] = ['screenshot_out_file']

/** 这次运行的授权还有效吗（墙钟，毫秒）。 */
export function computerUseGranted(cu: RunComputerUse | undefined, nowMs: number): boolean {
  if (cu?.granted_until === undefined) return false
  const until = Date.parse(cu.granted_until)
  return Number.isFinite(until) && nowMs < until
}

export interface ComputerUsePolicyInput {
  tool: string
  args: Record<string, unknown>
  request: RunRequest
  /** 墙钟（毫秒）。授权是"接下来 N 分钟"——合成时钟不走的时候它也得走。 */
  nowMs: number
  /** 这次运行里 Agent 已经调过 `computer_handoff`，把电脑交还给人了。 */
  handedOff: boolean
}

/**
 * 驱动工具的门禁：回一句拒绝理由（人话 + 机器前缀），放行回 `undefined`。
 * 不是驱动的工具一律回 `undefined`（交给后面那几关）。
 */
export function checkComputerUse(input: ComputerUsePolicyInput): string | undefined {
  const short = cuaToolName(input.tool)
  if (short === undefined) return undefined
  const cu = input.request.computer_use
  if (cu === undefined) {
    return 'computer_use_not_enabled: 这条职责不能操作电脑'
  }
  if (cu.granted_until === undefined) {
    return 'computer_use_not_granted: 还没得到授权，先调 request_computer_use 出授权卡'
  }
  if (!computerUseGranted(cu, input.nowMs)) {
    return 'computer_use_expired: 授权时间到了，停下并说明做到哪一步'
  }
  if (input.handedOff) {
    return 'computer_use_handed_off: 已经请人接手，这次运行不再操作电脑'
  }
  if (CUA_DENIED_TOOLS.has(short) || CUA_DENIED_PATTERN.test(short)) {
    return `computer_use_tool_denied: ${short} 不给 Agent 用（查更新 / 改驱动配置）`
  }
  for (const key of CUA_DENIED_ARGS) {
    if (input.args[key] !== undefined) {
      return `computer_use_arg_denied: 不许用 ${key} 往磁盘写文件`
    }
  }
  return undefined
}

/** 官方提供方的 Config（上游 `Config`：command / args / toolCallTimeoutMs / reconnect）。 */
export interface CuaProviderConfig {
  command: string
  args: string[]
  toolCallTimeoutMs: number
  reconnect: { enabled: false }
}

/** 一次驱动调用的上限（毫秒）。桌面操作慢，但一次调用卡住一分钟就该当它坏了。 */
export const CUA_TOOL_TIMEOUT_MS = 60_000

/**
 * `RunRequest.computer_use` → 提供方的 Config。
 *
 * `reconnect.enabled: false`：驱动中途崩了不自动重连——一次运行一棵树（17 §5.1），
 * 断了就让这次运行明明白白地停下，而不是在人看不见的地方再起一个驱动。
 */
export function computerUseProviderConfig(cu: RunComputerUse): CuaProviderConfig {
  return {
    command: cu.command,
    args: [...cu.args],
    toolCallTimeoutMs: CUA_TOOL_TIMEOUT_MS,
    reconnect: { enabled: false },
  }
}

/**
 * 驱动的遥测与查更新开关（上游 `telemetry.rs` / `version_check.rs`，tag `cua-driver-rs-v0.28.0`）。
 *
 * - `CUA_DRIVER_RS_TELEMETRY_ENABLED=false`：上游**默认开**遥测（PostHog，只发事件名与
 *   分桶计数，不含内容），优先级「环境变量 → 持久配置 → 默认开」，环境变量最高；
 *   `CUA_TELEMETRY_ENABLED` 是它认的兼容名，一起设；
 * - `CUA_DRIVER_RS_UPDATE_CHECK=false`：`mcp` 一起就在后台去 GitHub 查新版本（20 小时一次）。
 *
 * 驱动由 `dsh-mcp-client` spawn，子进程环境 = 我们这个进程的环境（去掉名字像密钥的那几个），
 * 提供方又不收 `env`——所以只能在挂之前写进 `process.env`（与 `applyBskEnv` 同一条路）。
 * 写死覆盖：这是纪律不是偏好。
 */
export const CUA_ENV: Readonly<Record<string, string>> = {
  CUA_DRIVER_RS_TELEMETRY_ENABLED: 'false',
  CUA_TELEMETRY_ENABLED: 'false',
  CUA_DRIVER_RS_UPDATE_CHECK: 'false',
}

export function applyCuaEnv(env: NodeJS.ProcessEnv = process.env): void {
  for (const [k, v] of Object.entries(CUA_ENV)) env[k] = v
}

/**
 * 驱动这个文件在不在、能不能执行。**装好了才挂**（WP92 那条坑的同一条纪律）：
 * 路径指错时提供方的激活会失败，我们宁可在挂之前就让这次运行明明白白地失败。
 */
export function cuaDriverUsable(path: string): boolean {
  try {
    if (!statSync(path).isFile()) return false
    accessSync(path, constants.X_OK)
    return true
  } catch {
    return false
  }
}

/** 替换掉的截图 / 大段 base64 在模型面前变成这一句。 */
export const SCREENSHOT_OMITTED = '[截图不进模型（docs/80 隐私）：请看无障碍树文字 tree_markdown]'

/** 超过这么长、又只由 base64 字符组成的字符串，按"图片数据"处理。 */
const BASE64_MIN = 2048
const BASE64_RE = /^[A-Za-z0-9+/=\r\n]+$/u

/**
 * 把驱动结果里的图片拿掉（`tools/post-execute` 在围栏之前调）。
 *
 * v1 的纪律：**截图不进模型**。我们的树里没挂附件库、网关路由也不声明图片输入，
 * 官方 MCP 桥本来就会把图片块换成一段诊断文字；但**规范值**（canonical value）里
 * 仍然留着原始 MCP 块——里面是 base64 的整屏像素。我们在 post-execute 里接受的是值，
 * 所以这里再扫一遍：`type: 'image'` 的块换成一句说明，任何长得像 base64 的长字符串
 * 也换掉。模型靠无障碍树文字（`tree_markdown`）干活。
 */
export function redactComputerUseValue(value: unknown): unknown {
  if (typeof value === 'string') {
    return value.length >= BASE64_MIN && BASE64_RE.test(value) ? SCREENSHOT_OMITTED : value
  }
  if (Array.isArray(value)) return value.map(redactComputerUseValue)
  if (value === null || typeof value !== 'object') return value
  const obj = value as Record<string, unknown>
  if (obj.type === 'image' || obj.type === 'audio') {
    return { type: 'text', text: SCREENSHOT_OMITTED }
  }
  const out: Record<string, unknown> = {}
  for (const [k, v] of Object.entries(obj)) out[k] = redactComputerUseValue(v)
  return out
}

/**
 * 写进提示词的那一段（persona 的 `complete` 段里，与浏览器那一段并列）。
 *
 * 官方提供方自己不写任何指导（它只挂驱动报的工具），所以「什么时候能动、
 * 遇到密码怎么办、截图看不看得到」只能由我们写。
 */
export function computerUseBrief(input: {
  granted: boolean
  minutes: number
  until?: string
}): string {
  if (!input.granted) {
    return [
      '### 操作这台电脑',
      `- 这条职责**可以请求**操作用户的电脑，但现在还没有授权，你看不到任何桌面工具。`,
      `- 只有真要在电脑上的某个应用里点、输入时，才调 \`${REQUEST_COMPUTER_USE_TOOL}\`，` +
        '把要做什么写清楚（一句话）。会给用户出一张授权卡，' +
        `问他「让它在接下来 ${input.minutes} 分钟操作这台电脑？」；批了这件事会重新开始，那时才能操作。`,
      '- 发出请求后就结束这一轮，把做到哪一步说清楚。不用电脑也能做完的事不要请求。',
    ].join('\n')
  }
  return [
    '### 操作这台电脑',
    `- 用户允许你操作这台电脑 ${input.minutes} 分钟${input.until === undefined ? '' : `（到 ${input.until} 为止）`}；` +
      '时间一到工具会被拒，那时停下并说明做到哪一步。',
    '- 先看后动：先列应用与窗口、读窗口状态，看清楚再点；每一步之后核对结果。',
    '- **遇到登录、密码、支付、验证码（短信 / 邮件 / 二次验证）、银行卡或证件号：立刻停下**，' +
      `调 \`${COMPUTER_HANDOFF_TOOL}\` 写清楚要用户做什么。不许自己输入、不许猜、不许从别处复制。`,
    '- 不要开终端执行命令、不要改系统设置、不要装或卸软件、不要往磁盘写文件。',
    '- 截图不会传给你（隐私）：靠窗口状态里的无障碍树文字判断界面。',
  ].join('\n')
}

/** 两个自有工具共用的入参：一句人话。 */
const REASON_PARAMS = {
  reason: {
    type: 'string',
    description:
      'One short sentence for the user: what you need to do on this computer, or what they must do.',
    required: true,
  },
} as const

export interface ComputerUseToolHooks {
  /** 出一张授权卡（`stage: 'authorize'`）或接手卡（`'handoff'`）；回 `undefined` = 宿主没接这条路。 */
  card(
    callId: string,
    stage: 'authorize' | 'handoff',
    reason: string,
  ): Promise<{ approval_item_id: string } | undefined>
}

/**
 * 我们自己的电脑操控工具（与 `stage_refund` 同一类：**不碰外部，只出卡**）。
 *
 * - 没授权：只有 {@link REQUEST_COMPUTER_USE_TOOL}；
 * - 授权中：只有 {@link COMPUTER_HANDOFF_TOOL}（人接手；调了这次运行就不再动电脑）。
 */
export function computerUseToolDefinitions(
  granted: boolean,
  hooks: ComputerUseToolHooks,
): ToolDefinition[] {
  const name = granted ? COMPUTER_HANDOFF_TOOL : REQUEST_COMPUTER_USE_TOOL
  const stage = granted ? ('handoff' as const) : ('authorize' as const)
  return [
    defineTool({
      name,
      description: granted
        ? 'Stop operating the computer and hand this step to the user (login, password, payment, verification code). Creates a card; you cannot use the computer again in this run.'
        : 'Ask the user for permission to operate this computer. Creates an approval card; the work item restarts with desktop tools only after they approve.',
      parameters: REASON_PARAMS,
      output: {
        schema: { type: 'json' },
        render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }],
      },
      async execute(args, exec) {
        const reason = typeof args.reason === 'string' ? args.reason.trim() : ''
        const res = await hooks.card(
          String(exec.callId),
          stage,
          reason === '' ? '（没写原因）' : reason,
        )
        if (res === undefined) {
          throw new DshAdapterError('not_approved', '这台服务没接电脑操控的授权卡（fail-closed）')
        }
        return {
          approval_item_id: res.approval_item_id,
          note: granted
            ? 'Card sent. Stop now and summarise where you stopped; do not touch the computer again.'
            : 'Card sent. Stop now and summarise what you will do once approved.',
        }
      },
    }),
  ]
}
