/**
 * 宿主侧的 headless 子进程档（WP30 A）。
 *
 * `RuntimeAdapter.run` 的语义、`capabilities()`、事件序列与进程内档**逐条一致**——
 * 同一份契约测试跑两遍就是验这件事。差别只在 dsh 的 Cordis 树跑在哪个进程里。
 *
 * 隔离（16 §3 最严解释 + 31 §3）：
 * - **只走 stdio**：子进程不 listen 任何端口，连 127.0.0.1 都不绑
 * - **环境变量白名单**：只传 PATH / HOME / TMPDIR / 语言与一次性 run token；
 *   任何 `*_API_KEY` / `*_TOKEN` / `AGENTSWS_*` 密钥都不进子进程
 * - **密钥不过线**：模型经 `agentsws/host/complete` 回调宿主的模型网关，
 *   凭据只在宿主进程里（子进程连网关地址都不知道）
 * - 崩溃 → `run.failed{retryable:true}`；超时 → `run.cancelled`（17 §5.6 同"中断"处理）
 */
import { type ChildProcessWithoutNullStreams, spawn } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { RunEvent, RunRequest, RunResult, RuntimeAdapter } from '@agentsws/contracts'
import { JsonRpcLineTransport } from '@deepseek-ai/dsh-sdk-protocol'
import type { DshRuntimeOptions } from '../types.js'
import {
  type BoundaryParams,
  BRIDGE_PROTOCOL_VERSION,
  type CompleteParams,
  type DraftParams,
  ENV_RUN_TOKEN,
  type EventParams,
  type HelloResult,
  M_CANCEL,
  M_EVENT,
  M_HELLO,
  M_HOST_BOUNDARY,
  M_HOST_COMPLETE,
  M_HOST_DRAFT,
  M_HOST_STAGE,
  M_HOST_TOOL,
  M_RUN,
  M_SHUTDOWN,
  type RunResponse,
  type StageParams,
  type ToolCallParams,
  type WireRuntimeOptions,
} from './protocol.js'

const RUNTIME_NAME = 'dsh'
const DEFAULT_TIMEOUT_MS = 60_000
/** 子进程装好并答上 hello 的上限。 */
const HELLO_TIMEOUT_MS = 20_000
/** 请求 shutdown 之后等它自己退的宽限。 */
const EXIT_GRACE_MS = 2_000
/** stderr 只留最后这么多字节，进 `run.failed.message`。 */
const STDERR_TAIL = 4_000

/** 传给子进程的环境变量白名单（值来自宿主环境；密钥一律不传）。 */
const ENV_ALLOWLIST = [
  'PATH',
  'HOME',
  'TMPDIR',
  'TEMP',
  'TMP',
  'LANG',
  'LC_ALL',
  'NODE_ENV',
  'SystemRoot',
  'ComSpec',
] as const

/** 一次性 run token：只用于宿主与自己那个子进程之间对暗号，不进任何持久化。 */
function randomToken(): string {
  return randomBytes(24).toString('base64url')
}

/**
 * 子进程入口的默认位置。
 *
 * 跑编译产物时它就在本文件旁边（`dist/headless/child.js`）；
 * 跑源码时（vitest 直接吃 `src/`）本文件在 `src/headless/`，编译产物在 `../../dist/headless/`。
 */
export function defaultChildEntry(): string {
  const here = fileURLToPath(new URL('.', import.meta.url))
  const candidates = [
    join(here, 'child.js'),
    join(here, '..', '..', 'dist', 'headless', 'child.js'),
  ]
  for (const candidate of candidates) {
    try {
      if (existsSync(candidate)) return candidate
    } catch {
      // 探测失败按"不存在"处理
    }
  }
  return candidates[0] as string
}

/** 能力探测：编译产物在不在。`mode: 'auto'` 用它决定走哪一档。 */
export function subprocessAvailable(entry = defaultChildEntry()): boolean {
  try {
    return existsSync(entry)
  } catch {
    return false
  }
}

function childEnv(token: string): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {}
  for (const key of ENV_ALLOWLIST) {
    const value = process.env[key]
    if (value !== undefined) env[key] = value
  }
  env[ENV_RUN_TOKEN] = token
  return env
}

function wireOptions(options: DshRuntimeOptions): WireRuntimeOptions {
  return {
    ...(options.seed === undefined ? {} : { seed: options.seed }),
    ...(options.defaultReturnWindowDays === undefined
      ? {}
      : { defaultReturnWindowDays: options.defaultReturnWindowDays }),
    ...(options.signature === undefined ? {} : { signature: options.signature }),
    ...(options.presetRoot === undefined ? {} : { presetRoot: options.presetRoot }),
    ...(options.sessionLogRoot === undefined ? {} : { sessionLogRoot: options.sessionLogRoot }),
    ...(options.sideEffects === undefined ? {} : { sideEffects: options.sideEffects }),
    has: {
      executeTool: options.executeTool !== undefined,
      stage: options.stage !== undefined,
      createDraft: options.createDraft !== undefined,
      createPolicyQuestion: options.createPolicyQuestion !== undefined,
    },
  }
}

/** 子进程起不来（握手失败）；`exited` 说明它是直接死了还是只是没答话。 */
class BridgeStartupError extends Error {
  constructor(
    message: string,
    readonly exited: boolean,
  ) {
    super(message)
    this.name = 'BridgeStartupError'
  }
}

interface Child {
  proc: ChildProcessWithoutNullStreams
  transport: JsonRpcLineTransport
  token: string
  stderr: () => string
  exited: Promise<number | null>
  kill(): void
}

function spawnChild(entry: string): Child {
  const token = randomToken()
  const proc = spawn(process.execPath, [entry], {
    env: childEnv(token),
    stdio: ['pipe', 'pipe', 'pipe'],
    // 子进程不继承宿主的工作目录以外的东西；cwd 用宿主的（preset / 会话日志按绝对路径给）
    cwd: process.cwd(),
  }) as ChildProcessWithoutNullStreams
  // 子进程已经死了还往它 stdin 写 → EPIPE。桥自己会把请求 reject，管道错误吞掉即可。
  proc.stdin.on('error', () => {})
  proc.stdout.on('error', () => {})
  proc.on('error', () => {})
  let tail = ''
  proc.stderr.setEncoding('utf8')
  proc.stderr.on('error', () => {})
  proc.stderr.on('data', (chunk: string) => {
    tail = (tail + chunk).slice(-STDERR_TAIL)
  })
  const exited = new Promise<number | null>((resolve) => {
    proc.once('exit', (code) => resolve(code))
    proc.once('error', () => resolve(null))
  })
  const transport = new JsonRpcLineTransport(proc.stdout as never, proc.stdin as never)
  return {
    proc,
    transport,
    token,
    stderr: () => tail,
    exited,
    kill() {
      if (proc.exitCode === null && proc.signalCode === null) proc.kill('SIGKILL')
    },
  }
}

async function closeChild(child: Child): Promise<void> {
  try {
    await Promise.race([
      child.transport.request(M_SHUTDOWN, { token: child.token }),
      new Promise((r) => setTimeout(r, EXIT_GRACE_MS)),
    ])
  } catch {
    // 子进程可能已经死了；下面的 kill 兜底
  }
  await Promise.race([child.exited, new Promise((r) => setTimeout(r, EXIT_GRACE_MS))])
  child.kill()
  child.transport.close()
  try {
    child.proc.stdin.end()
  } catch {
    // 管道已关
  }
}

/**
 * 17 §4 的 dsh 运行时（**跨进程 headless** 档）。
 *
 * 每次 `run()` 起一个全新的子进程、跑完即回收（16 §1 公司端执行器"每次运行一进程"），
 * 所以两次运行之间在**进程层面**没有任何共享状态——比进程内档还严格地满足 17 §5.1。
 */
export function createSubprocessDshRuntime(options: DshRuntimeOptions): RuntimeAdapter {
  const entry = options.childEntry ?? defaultChildEntry()
  const timeoutMs = options.subprocessTimeoutMs ?? DEFAULT_TIMEOUT_MS

  /** 起子进程、握手、装好宿主侧的回调路由。 */
  const connect = async (req: RunRequest | undefined): Promise<Child> => {
    const child = spawnChild(entry)
    child.transport.onRequest(async (method, params) => {
      const now = options.clock.now()
      const body = (params ?? {}) as Record<string, unknown>
      if (body.token !== child.token) throw new Error('bad_run_token')
      if (method === M_HOST_COMPLETE) {
        const p = body as unknown as CompleteParams
        const completion = await options.gateway.complete(
          p.request as Parameters<DshRuntimeOptions['gateway']['complete']>[0],
        )
        return { now: options.clock.now(), completion }
      }
      if (method === M_HOST_TOOL) {
        const p = body as unknown as ToolCallParams
        if (options.executeTool === undefined || req === undefined) {
          return { now, status: 'error', reason: 'no_tool_executor' }
        }
        const res = await options.executeTool({ name: p.name, input: p.input, request: req })
        return { now: options.clock.now(), ...res }
      }
      if (method === M_HOST_STAGE) {
        const p = body as unknown as StageParams
        if (options.stage === undefined || req === undefined) return { now }
        const res = await options.stage({ ...p.intent, request: req })
        return {
          now: options.clock.now(),
          ...(res === undefined ? {} : { change_id: res.change_id }),
        }
      }
      if (method === M_HOST_DRAFT) {
        const p = body as unknown as DraftParams
        if (options.createDraft === undefined || req === undefined) return { now }
        const res = await options.createDraft({ ...p.payload, request: req })
        return {
          now: options.clock.now(),
          ...(res === undefined ? {} : { approval_item_id: res.approval_item_id }),
        }
      }
      if (method === M_HOST_BOUNDARY) {
        const p = body as unknown as BoundaryParams
        if (options.createPolicyQuestion === undefined || req === undefined) return { now }
        const res = await options.createPolicyQuestion({ request: req, boundary: p.boundary })
        return {
          now: options.clock.now(),
          ...(res === undefined ? {} : { approval_item_id: res.approval_item_id }),
        }
      }
      throw new Error(`unknown_method: ${method}`)
    })
    child.transport.start()
    try {
      await Promise.race([
        child.transport.request(M_HELLO, {
          token: child.token,
          protocol: BRIDGE_PROTOCOL_VERSION,
        }),
        new Promise((_r, reject) =>
          setTimeout(
            () => reject(new Error(`子进程握手超时（${HELLO_TIMEOUT_MS}ms）`)),
            HELLO_TIMEOUT_MS,
          ),
        ),
      ])
    } catch (e) {
      // 握手挂了：把 stderr 尾巴带出去（"boom"、缺 token、模块解析失败都在那儿）
      const tail = child.stderr().trim()
      await closeChild(child)
      const error = new BridgeStartupError(
        `dsh headless 子进程起不来：${e instanceof Error ? e.message : String(e)}${
          tail.length > 0 ? ` | ${tail}` : ''
        }`,
        child.proc.exitCode !== null,
      )
      throw error
    }
    return child
  }

  return {
    name: RUNTIME_NAME,

    capabilities() {
      // 与进程内档同一份实测值：换装配形态不换语义
      return { tool_choice: false, streaming: true, followup: false, seedable: true }
    },

    async health() {
      if (!subprocessAvailable(entry)) {
        return { ok: false, detail: `dsh headless 子进程入口不存在：${entry}（先 tsc -b）` }
      }
      let child: Child | undefined
      try {
        child = await connect(undefined)
        const hello = (await child.transport.request(M_HELLO, {
          token: child.token,
          protocol: BRIDGE_PROTOCOL_VERSION,
        })) as HelloResult
        return {
          ok: hello.runtime === RUNTIME_NAME,
          detail: `dsh 0.1.3-alpha.2 headless 子进程可起（桥协议 v${hello.protocol}，stdio JSON-RPC）`,
        }
      } catch (e) {
        return { ok: false, detail: e instanceof Error ? e.message : String(e) }
      } finally {
        if (child !== undefined) await closeChild(child)
      }
    },

    async run(req, sink, signal): Promise<RunResult> {
      const events: RunEvent[] = []
      const emit = (e: RunEvent): void => {
        events.push(e)
        sink(e)
      }
      const failed = (code: string, message: string, retryable: boolean): RunResult => {
        if (!events.some((e) => e.type === 'run.started')) {
          emit({
            type: 'run.started',
            request_id: req.id,
            runtime: RUNTIME_NAME,
            model: req.runtime.model,
          })
        }
        emit({ type: 'run.failed', error: { code, message, retryable } })
        return {
          request_id: req.id,
          status: 'failed',
          outputs: [],
          provenance: { run_id: req.id, seen: {}, read_full: [], recorded_at: options.clock.now() },
          memory_candidates: [],
          lessons: [],
          usage: {
            input_tokens: 0,
            output_tokens: 0,
            cached_tokens: 0,
            tool_calls: 0,
            seconds: 0,
            cost_base: 0,
          },
          session_ref: { runtime: RUNTIME_NAME, session_id: `sub_${req.id}` },
          summary: `这次没跑完：${message}。`,
        }
      }

      let child: Child
      try {
        child = await connect(req)
      } catch (e) {
        const crashed = e instanceof BridgeStartupError && e.exited
        return failed(
          crashed ? 'runtime_crashed' : 'runtime_unavailable',
          e instanceof Error ? e.message : String(e),
          /* retryable */ true,
        )
      }

      child.transport.onNotification((method, params) => {
        if (method !== M_EVENT) return
        const p = params as unknown as EventParams
        if (p.token !== child.token) return
        emit(p.event)
      })

      let timer: NodeJS.Timeout | undefined
      let cancelled = false
      const cancel = (): void => {
        cancelled = true
        child.transport.request(M_CANCEL, { token: child.token }).catch(() => {})
      }
      const onAbort = (): void => cancel()
      signal.addEventListener('abort', onAbort, { once: true })

      try {
        const response = await Promise.race([
          child.transport.request(M_RUN, {
            token: child.token,
            request: req,
            options: wireOptions(options),
            now: options.clock.now(),
            ...(signal.aborted ? { aborted: true } : {}),
          }) as Promise<RunResponse>,
          new Promise<RunResponse>((resolve) => {
            timer = setTimeout(() => {
              cancel()
              resolve({
                ok: false,
                code: 'timeout',
                message: `子进程超时（${timeoutMs}ms）`,
                retryable: true,
              })
            }, timeoutMs)
          }),
          child.exited.then<RunResponse>((code) => ({
            ok: false,
            code: 'runtime_crashed',
            message: `dsh headless 子进程退出（code ${String(code)}）：${child.stderr().trim()}`,
            retryable: true,
          })),
        ])

        if (response.ok) return response.result
        if (response.code === 'timeout') {
          // 17 §5.6：超时与中断同一处理——补齐、发 run.cancelled
          emit({ type: 'run.cancelled' })
          return {
            request_id: req.id,
            status: 'cancelled',
            outputs: [],
            provenance: {
              run_id: req.id,
              seen: {},
              read_full: [],
              recorded_at: options.clock.now(),
            },
            memory_candidates: [],
            lessons: [],
            usage: {
              input_tokens: 0,
              output_tokens: 0,
              cached_tokens: 0,
              tool_calls: 0,
              seconds: 0,
              cost_base: 0,
            },
            session_ref: { runtime: RUNTIME_NAME, session_id: `sub_${req.id}` },
            summary: '这次被中断了：子进程超时，已经把它收掉。',
          }
        }
        return failed(response.code, response.message, response.retryable)
      } catch (e) {
        if (cancelled) {
          emit({ type: 'run.cancelled' })
          return failed('cancelled', '运行被中断', false)
        }
        return failed(
          'runtime_crashed',
          `${e instanceof Error ? e.message : String(e)}${child.stderr().trim()}`,
          true,
        )
      } finally {
        if (timer !== undefined) clearTimeout(timer)
        signal.removeEventListener('abort', onAbort)
        await closeChild(child)
      }
    },
  }
}
