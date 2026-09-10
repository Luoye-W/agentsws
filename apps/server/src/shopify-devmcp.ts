/**
 * Shopify 官方 Dev MCP 接进运行时（WP44 交付 5）。
 *
 * 它是什么：`@shopify/dev-mcp` 是 Shopify 自己发的一个 **stdio MCP server**，
 * 本地跑、不需要任何认证、**碰不到任何店铺数据**。它只会三件事——查文档、
 * 给 GraphQL schema 的上下文、校验一段 GraphQL 有没有编字段。
 *
 * 为什么值得接：Admin GraphQL 有五百多个 mutation，模型编一个不存在的字段名太容易了。
 * 让它在 stage 之前先把文档拿到手、把要执行的那段 GraphQL 交给官方校验器过一遍，
 * 是**在提案还没进人的队列之前**就把幻觉挡住——比让人在审批卡上发现"这条根本跑不通"便宜得多。
 *
 * 三条纪律：
 *
 * 1. **只读，而且是三个我们自己命名的工具**：`shopify.docs.search` /
 *    `shopify.schema.introspect` / `shopify.graphql.validate`。上游的工具名一直在变
 *    （09-10 实查 1.15.0：`search_dev_docs` / `introspect_admin_schema` 这些**已经没有了**，
 *    换成了 `search_docs_chunks` / `learn_shopify_api`），所以对模型暴露的名字由我们定，
 *    映射到哪个上游工具由 {@link UPSTREAM_CANDIDATES} 按优先级挑——上游改名不动模型那一面。
 * 2. **起不来就降级，不是报错**：Dev MCP 要 `npx` 下载一个包，离线的机器上根本起不来。
 *    这时候 {@link guardGraphqlStage} 放行（"无校验但仍可 stage"）并记一条事件——
 *    校验是**加固**，不是**门禁**；没有它整条业务不该停摆。真正的门禁在 15 的账本那一侧。
 * 3. **不给它任何秘密**：子进程的环境走与 `shopify-theme.ts` 同一张白名单。
 *    它压根不需要凭据，那就一个都别给。
 */
import { spawn } from 'node:child_process'
import type { ToolDef } from '@agentsws/contracts'
import { PASSTHROUGH_ENV } from './shopify-theme.js'

/** 对模型暴露的三个名字（**我们的**，不是上游的）。 */
export const DOCS_TOOL = 'shopify.docs.search'
export const SCHEMA_TOOL = 'shopify.schema.introspect'
export const VALIDATE_TOOL = 'shopify.graphql.validate'
export const DEV_MCP_TOOLS: readonly string[] = [DOCS_TOOL, SCHEMA_TOOL, VALIDATE_TOOL]

/**
 * 我们的名字 → 上游可能叫什么，按优先级排。
 *
 * 09-10 实查 `@shopify/dev-mcp@1.15.0` 的实际工具表：
 * `learn_shopify_api` / `search_docs_chunks` / `validate_graphql_codeblocks` /
 * `validate_component_codeblocks` / `validate_theme` / `validate_theme_codeblocks` / `feedback`。
 * 旧版本的 `search_dev_docs` / `introspect_admin_schema` / `introspect_graphql_schema`
 * 在 1.15 里**一个都不存在**了，所以两代名字都列上，装到哪个版本都能用。
 *
 * `shopify.schema.introspect` 是最尴尬的一个：新版没有独立的 introspect 工具了，
 * schema 上下文改由 `learn_shopify_api` 按 API surface 一次性给出。退化到它是**对的**
 * ——模型要的本来就是"这个 API 长什么样"，不是一份 introspection JSON。
 */
export const UPSTREAM_CANDIDATES: Readonly<Record<string, readonly string[]>> = {
  [DOCS_TOOL]: ['search_docs_chunks', 'search_dev_docs'],
  [SCHEMA_TOOL]: ['introspect_admin_schema', 'introspect_graphql_schema', 'learn_shopify_api'],
  [VALIDATE_TOOL]: ['validate_graphql_codeblocks'],
}

/** 起 Dev MCP 的默认命令。`-y` 是为了让 npx 别在没有 TTY 的地方等人按回车。 */
export const DEV_MCP_COMMAND = 'npx'
export const DEV_MCP_ARGS: readonly string[] = ['-y', '@shopify/dev-mcp@latest']

export interface DevMcpStatus {
  available: boolean
  /** 上游报的 server 名字与版本（`initialize` 的结果）。 */
  server?: { name: string; version: string }
  /** 我们的三个名字各自映射到了哪个上游工具；映射不到的不出现。 */
  mapped: Record<string, string>
  /** 起不来时给人看的一句话。 */
  reason?: string
}

export type GraphqlVerdict =
  | { status: 'valid'; detail: string }
  | { status: 'invalid'; detail: string; errors: string[] }
  /** Dev MCP 起不来 / 没有校验工具：**放行**，但要记一笔。 */
  | { status: 'unavailable'; detail: string }

/** 一条还开着的 stdio 通道（测试注入假 server）。 */
export interface McpChannel {
  send(line: string): void
  onLine(cb: (line: string) => void): void
  close(): void
  exited: Promise<number>
}

export type SpawnMcp = (
  command: string,
  args: readonly string[],
  opts: { env: Record<string, string> },
) => McpChannel

export interface ShopifyDevMcpOptions {
  env?: NodeJS.ProcessEnv
  command?: string
  args?: readonly string[]
  spawnMcp?: SpawnMcp
  /** `initialize` 与每次 `tools/call` 的超时（毫秒）。 */
  timeoutMs?: number
  appendEvent?: (type: string, payload: Record<string, unknown>) => void
}

export interface ShopifyDevMcp {
  /** 起它（幂等：起过一次就回上次的结果）。**永不抛**——起不来就是 available: false。 */
  start(): Promise<DevMcpStatus>
  status(): DevMcpStatus
  /** 给运行时工具面的三个只读工具定义；起不来就是空数组（模型不该看见调不动的工具）。 */
  toolDefs(): ToolDef[]
  /** 按**我们的**名字调一次。 */
  call(name: string, input: Record<string, unknown>): Promise<{ text: string }>
  /** 把一段 GraphQL 交给官方校验器。 */
  validateGraphql(input: { document: string; api?: string }): Promise<GraphqlVerdict>
  close(): Promise<void>
}

// ── 工具定义（对模型那一面）──────────────────────────────────────────

const TOOL_DEFS: readonly ToolDef[] = [
  {
    name: DOCS_TOOL,
    description:
      'Search the official Shopify developer documentation. Read-only: this never touches a store. ' +
      'Use it before writing any Admin GraphQL, so field and mutation names come from the docs rather than memory.',
    input_schema: {
      type: 'object',
      required: ['query'],
      properties: {
        query: { type: 'string', description: 'What you want to know, in plain English.' },
      },
    },
  },
  {
    name: SCHEMA_TOOL,
    description:
      'Load the Shopify Admin GraphQL schema context for a given API surface. Read-only. ' +
      'Use it to check that a type, field or mutation actually exists before you propose a change.',
    input_schema: {
      type: 'object',
      properties: {
        api: {
          type: 'string',
          description: 'Which API surface (admin, storefront, functions, liquid…). Default: admin.',
        },
        query: { type: 'string', description: 'Type or mutation name to look up.' },
      },
    },
  },
  {
    name: VALIDATE_TOOL,
    description:
      'Validate a GraphQL document against the real Shopify schema. Read-only: it does NOT execute anything. ' +
      'Every write you propose must pass this first — an invalid document means the change could never be applied.',
    input_schema: {
      type: 'object',
      required: ['document'],
      properties: {
        document: { type: 'string', description: 'The GraphQL query or mutation, as text.' },
        api: { type: 'string', description: 'Which API surface. Default: admin.' },
      },
    },
  },
]

// ── 默认 stdio 实现 ────────────────────────────────────────────────────

function defaultSpawn(): SpawnMcp {
  return (command, args, opts) => {
    const child = spawn(command, [...args], {
      env: opts.env,
      stdio: ['pipe', 'pipe', 'pipe'],
    })
    const listeners: ((line: string) => void)[] = []
    let buffer = ''
    child.stdout?.on('data', (chunk: Buffer) => {
      buffer += chunk.toString('utf8')
      const lines = buffer.split('\n')
      buffer = lines.pop() ?? ''
      for (const line of lines) if (line.trim() !== '') for (const cb of listeners) cb(line)
    })
    // stderr 是 npx / server 的进度与报错，不是协议：只在起不来时有用，不喂给解析器
    return {
      send: (line) => child.stdin?.write(`${line}\n`),
      onLine: (cb) => listeners.push(cb),
      close: () => child.kill(),
      exited: new Promise<number>((resolve) => {
        child.on('close', (code) => resolve(code ?? 0))
        child.on('error', () => resolve(-1))
      }),
    }
  }
}

// ── JSON-RPC 骨架 ─────────────────────────────────────────────────────

interface RpcResponse {
  id?: number
  result?: unknown
  error?: { code: number; message: string }
}

interface UpstreamTool {
  name: string
  description?: string
  inputSchema?: { properties?: Record<string, unknown>; required?: string[] }
}

export function createShopifyDevMcp(options: ShopifyDevMcpOptions = {}): ShopifyDevMcp {
  const env = options.env ?? process.env
  const spawnMcp = options.spawnMcp ?? defaultSpawn()
  const timeoutMs = options.timeoutMs ?? 60_000
  const emit = (type: string, payload: Record<string, unknown>): void => {
    options.appendEvent?.(type, payload)
  }

  let channel: McpChannel | undefined
  let started: Promise<DevMcpStatus> | undefined
  let state: DevMcpStatus = { available: false, mapped: {} }
  let upstream: UpstreamTool[] = []
  /** 新版 Dev MCP 的工具靠一个会话 id 串起来（`learn_shopify_api` 先跑一次才给）。 */
  let conversationId: string | undefined
  let seq = 0
  const pending = new Map<number, (res: RpcResponse) => void>()

  /** 子进程的环境：与主题 CLI 同一张白名单。Dev MCP 不需要凭据，那就一个都别给。 */
  const childEnv = (): Record<string, string> => {
    const out: Record<string, string> = {}
    for (const key of PASSTHROUGH_ENV) {
      const value = env[key]
      if (typeof value === 'string') out[key] = value
    }
    out.CI = '1'
    // 官方发布版会把工具输入与结果上报到 shopify.dev；我们的运行内容不该出门
    out.OPT_OUT_INSTRUMENTATION = 'true'
    out.DO_NOT_TRACK = '1'
    return out
  }

  const rpc = async (method: string, params?: unknown): Promise<unknown> => {
    const ch = channel
    if (ch === undefined) throw new Error('Dev MCP 没有起来')
    seq += 1
    const id = seq
    const message = JSON.stringify({
      jsonrpc: '2.0',
      id,
      method,
      ...(params === undefined ? {} : { params }),
    })
    return new Promise<unknown>((resolve, reject) => {
      const timer = setTimeout(() => {
        pending.delete(id)
        reject(new Error(`Dev MCP 的 ${method} 超时了`))
      }, timeoutMs)
      ;(timer as { unref?: () => void }).unref?.()
      pending.set(id, (res) => {
        clearTimeout(timer)
        if (res.error !== undefined) {
          reject(new Error(`Dev MCP 的 ${method} 报错：${res.error.message}`))
          return
        }
        resolve(res.result)
      })
      ch.send(message)
    })
  }

  const notify = (method: string, params?: unknown): void => {
    channel?.send(
      JSON.stringify({ jsonrpc: '2.0', method, ...(params === undefined ? {} : { params }) }),
    )
  }

  /** 上游的结果是 `{ content: [{type:'text', text}] }`；拼成一段纯文本。 */
  const textOf = (result: unknown): string => {
    const content = (result as { content?: unknown } | undefined)?.content
    if (!Array.isArray(content)) return typeof result === 'string' ? result : JSON.stringify(result)
    return content
      .map((part) => {
        const p = part as { type?: unknown; text?: unknown }
        return typeof p.text === 'string' ? p.text : ''
      })
      .filter((t) => t !== '')
      .join('\n')
  }

  /** 上游这个工具要不要 `conversationId`。 */
  const wantsConversation = (name: string): boolean => {
    const tool = upstream.find((t) => t.name === name)
    const props = tool?.inputSchema?.properties ?? {}
    return 'conversationId' in props
  }

  const callUpstream = async (
    name: string,
    args: Record<string, unknown>,
  ): Promise<{ text: string }> => {
    const withConversation =
      conversationId !== undefined && wantsConversation(name) ? { ...args, conversationId } : args
    const result = await rpc('tools/call', { name, arguments: withConversation })
    return { text: textOf(result) }
  }

  const doStart = async (): Promise<DevMcpStatus> => {
    try {
      channel = spawnMcp(options.command ?? DEV_MCP_COMMAND, options.args ?? DEV_MCP_ARGS, {
        env: childEnv(),
      })
      // 子进程死了就别让调用方在超时上干等：把还挂着的请求当场判死
      void channel.exited.then((code) => {
        for (const [id, waiter] of [...pending]) {
          pending.delete(id)
          waiter({ id, error: { code: -1, message: `Dev MCP 进程退出了（code ${code}）` } })
        }
      })
      channel.onLine((line) => {
        let parsed: RpcResponse
        try {
          parsed = JSON.parse(line) as RpcResponse
        } catch {
          // npx 会往 stdout 打自己的东西；不是 JSON 的行直接扔掉
          return
        }
        if (typeof parsed.id !== 'number') return
        const waiter = pending.get(parsed.id)
        if (waiter !== undefined) {
          pending.delete(parsed.id)
          waiter(parsed)
        }
      })

      const init = (await rpc('initialize', {
        protocolVersion: '2024-11-05',
        capabilities: {},
        clientInfo: { name: 'agentsws', version: '0.0.0' },
      })) as { serverInfo?: { name?: unknown; version?: unknown } }
      notify('notifications/initialized')

      const listed = (await rpc('tools/list')) as { tools?: unknown }
      upstream = Array.isArray(listed.tools) ? (listed.tools as UpstreamTool[]) : []
      const names = new Set(upstream.map((t) => t.name))
      const mapped: Record<string, string> = {}
      for (const [ours, candidates] of Object.entries(UPSTREAM_CANDIDATES)) {
        const hit = candidates.find((c) => names.has(c))
        if (hit !== undefined) mapped[ours] = hit
      }

      // 新版的工具要先跑一次 `learn_shopify_api` 才认得这个会话
      if (names.has('learn_shopify_api')) {
        try {
          const { text } = await callUpstream('learn_shopify_api', { api: 'admin' })
          conversationId = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i.exec(
            text,
          )?.[0]
        } catch {
          // 拿不到会话 id 不致命：不要它的那些工具照样能调
        }
      }

      const serverName = init.serverInfo?.name
      const serverVersion = init.serverInfo?.version
      state = {
        available: Object.keys(mapped).length > 0,
        ...(typeof serverName === 'string'
          ? {
              server: {
                name: serverName,
                version: typeof serverVersion === 'string' ? serverVersion : 'unknown',
              },
            }
          : {}),
        mapped,
        ...(Object.keys(mapped).length > 0
          ? {}
          : { reason: 'Dev MCP 起来了，但它没有我们认识的任何一个工具（版本对不上？）' }),
      }
      emit('shopify.devmcp_started', {
        available: state.available,
        mapped: Object.values(mapped),
        ...(state.server === undefined ? {} : { server: state.server.name }),
      })
      return state
    } catch (e) {
      channel?.close()
      channel = undefined
      state = {
        available: false,
        mapped: {},
        reason:
          'Shopify 官方的 Dev MCP 没起来（多半是这台机器不能联网下载它，或者没装 Node 的 npx）。' +
          '影响只有一个：写 GraphQL 之前少了一道官方校验，别的照常。',
      }
      emit('shopify.devmcp_unavailable', {
        reason: e instanceof Error ? e.message.slice(0, 200) : 'unknown',
      })
      return state
    }
  }

  return {
    start() {
      started ??= doStart()
      return started
    },

    status: () => state,

    toolDefs() {
      if (!state.available) return []
      return TOOL_DEFS.filter((t) => state.mapped[t.name] !== undefined).map((t) => ({ ...t }))
    },

    async call(name, input) {
      const target = state.mapped[name]
      if (target === undefined) {
        throw new Error(`${name} 现在不可用：Dev MCP 没起来，或者上游没有对应的工具`)
      }
      // 我们的入参名 → 上游的。新旧两代工具的入参名不一样，都兜住
      const args: Record<string, unknown> = { ...input }
      if (name === DOCS_TOOL && typeof input.query === 'string') {
        args.prompt = input.query
      }
      if (name === SCHEMA_TOOL) {
        args.api ??= 'admin'
        if (target === 'learn_shopify_api') delete args.query
      }
      if (name === VALIDATE_TOOL && typeof input.document === 'string') {
        args.api ??= 'admin'
        // 1.15 的校验器收的是"代码块数组"
        args.codeblocks = [input.document]
      }
      return callUpstream(target, args)
    },

    async validateGraphql({ document, api }) {
      if (document.trim() === '') {
        return { status: 'invalid', detail: 'GraphQL 是空的', errors: ['empty document'] }
      }
      if (state.mapped[VALIDATE_TOOL] === undefined) {
        return {
          status: 'unavailable',
          detail: state.reason ?? 'Dev MCP 的 GraphQL 校验工具不可用',
        }
      }
      try {
        const { text } = await this.call(VALIDATE_TOOL, {
          document,
          ...(api === undefined ? {} : { api }),
        })
        return readVerdict(text)
      } catch (e) {
        return {
          status: 'unavailable',
          detail: `校验没跑成：${e instanceof Error ? e.message : String(e)}`,
        }
      }
    },

    async close() {
      channel?.close()
      const exited = channel?.exited
      channel = undefined
      started = undefined
      state = { available: false, mapped: {} }
      if (exited !== undefined) await exited.catch(() => 0)
    },
  }
}

// ── 校验结果的判读 ─────────────────────────────────────────────────────

/**
 * 上游回的是一段人写的文本（不同版本格式不一样），这里只判"过没过"。
 *
 * **判不出来时按 `unavailable` 处理，不按 `valid`。** 一个看不懂的结果不能算"官方说这条没问题"
 * ——那样等于把幻觉洗成了背书。降级放行是明说的政策，冒充通过不是。
 */
export function readVerdict(text: string): GraphqlVerdict {
  const lower = text.toLowerCase()
  const failed =
    lower.includes('"result": "failed"') ||
    lower.includes('validation failed') ||
    lower.includes('is not a valid') ||
    lower.includes('cannot query field') ||
    lower.includes('unknown field') ||
    lower.includes('unknown argument') ||
    lower.includes('did you mean')
  if (failed) {
    const errors = text
      .split('\n')
      .map((l) => l.trim())
      .filter((l) => l !== '' && /error|invalid|cannot|unknown|did you mean|failed/i.test(l))
      .slice(0, 10)
    return {
      status: 'invalid',
      detail: '官方校验器说这段 GraphQL 不成立（多半是编了一个不存在的字段或参数）',
      errors: errors.length > 0 ? errors : [text.slice(0, 300)],
    }
  }
  const passed =
    lower.includes('"result": "success"') ||
    lower.includes('validation passed') ||
    lower.includes('is valid') ||
    lower.includes('no issues') ||
    lower.includes('all code blocks are valid')
  if (passed) return { status: 'valid', detail: '官方校验器认这段 GraphQL' }
  return { status: 'unavailable', detail: '官方校验器回了一段我们读不懂的结果，当作"没校验"处理' }
}

// ── stage 前的那道关 ───────────────────────────────────────────────────

export type StageGuardOutcome =
  /** 过了（`degraded` = 没校验成，按政策放行）。 */
  | { ok: true; degraded: boolean; detail: string }
  /** 没过：这段 GraphQL 本身就跑不通，别拿去占人的队列。 */
  | { ok: false; reason: string; errors: string[] }

/**
 * **写类 GraphQL 变更在 stage 之前必须过这一关。**
 *
 * 两种放行、一种拦截：
 * - 校验通过 → 放行；
 * - Dev MCP 起不来 / 结果读不懂 → **放行但记一条事件**（`degraded: true`）：
 *   校验是加固不是门禁，没有它整条业务不该停摆；真正的门禁在 15 的账本那边；
 * - 校验说不成立 → 拦住，把官方的错误原样交回给模型，让它自己改。
 */
export async function guardGraphqlStage(
  devmcp: Pick<ShopifyDevMcp, 'validateGraphql'>,
  input: { document: string; api?: string },
  appendEvent?: (type: string, payload: Record<string, unknown>) => void,
): Promise<StageGuardOutcome> {
  const verdict = await devmcp.validateGraphql(input)
  if (verdict.status === 'valid') {
    return { ok: true, degraded: false, detail: verdict.detail }
  }
  if (verdict.status === 'invalid') {
    appendEvent?.('shopify.graphql_rejected', { errors: verdict.errors.slice(0, 3) })
    return {
      ok: false,
      reason: `${verdict.detail}。改完再提一次。`,
      errors: verdict.errors,
    }
  }
  appendEvent?.('shopify.graphql_unvalidated', { reason: verdict.detail })
  return {
    ok: true,
    degraded: true,
    detail: `${verdict.detail}。这条变更照常进审批队列，但审批的人要知道：它没经过官方校验。`,
  }
}
