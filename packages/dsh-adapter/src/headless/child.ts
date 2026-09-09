/**
 * headless 子进程的入口（WP30 A）。
 *
 * 这个进程里装的是**真的 dsh**：Cordis 树 + `SystemPrompt` / `ToolRuntime` /
 * `ApprovalService` / `LlmRuntime` + 我们的门禁插件（五个 seam 一个不少）。
 * 它自己不持有任何密钥、不连任何外部系统、不监听任何端口——
 * 工具出口、模型网关、stage / 起草 / 边界卡全部经 stdio 回调宿主。
 *
 * stdout 是协议（NDJSON JSON-RPC），任何调试输出只能走 stderr。
 */
import { realpathSync } from 'node:fs'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import type {
  Clock,
  Completion,
  Iso8601,
  RunEvent,
  RunRequest,
  RunResult,
} from '@agentsws/contracts'
import { JsonRpcLineTransport } from '@deepseek-ai/dsh-sdk-protocol'
import { createInProcessDshRuntime } from '../runtime.js'
import type { DshRuntimeOptions } from '../types.js'
import {
  type BoundaryResult,
  BRIDGE_PROTOCOL_VERSION,
  type CompleteResult,
  type DraftResult,
  ENV_CHILD_MARKER,
  ENV_RUN_TOKEN,
  type HelloParams,
  type HelloResult,
  M_CANCEL,
  M_EVENT,
  M_HELLO,
  M_HOST_BOUNDARY,
  M_HOST_COMPLETE,
  M_HOST_DRAFT,
  M_HOST_STAGE,
  M_HOST_TOOL,
  M_READY,
  M_RUN,
  M_SHUTDOWN,
  type RunParams,
  type RunResponse,
  type StageResult,
  type ToolCallResult,
} from './protocol.js'

/** 子进程侧的时钟：宿主每次应答都带 `now`，这里对表。合成时钟因此在子进程里也成立。 */
class MirrorClock implements Clock {
  constructor(private at: Iso8601) {}
  now(): Iso8601 {
    return this.at
  }
  sync(at: unknown): void {
    if (typeof at === 'string' && at.length > 0) this.at = at as Iso8601
  }
}

function asRecord(v: unknown): Record<string, unknown> {
  return v !== null && typeof v === 'object' ? (v as Record<string, unknown>) : {}
}

/** 起子进程侧的桥。导出给测试用（可注入自造的流）。 */
export function startChildBridge(io: {
  input: NodeJS.ReadableStream
  output: NodeJS.WritableStream
  token: string
  exit: (code: number) => void
}): { transport: JsonRpcLineTransport; done: Promise<void> } {
  const transport = new JsonRpcLineTransport(
    io.input as never,
    io.output as never,
  ) as JsonRpcLineTransport
  let resolveDone: () => void = () => {}
  const done = new Promise<void>((r) => {
    resolveDone = r
  })
  let controller: AbortController | undefined

  const checkToken = (params: Record<string, unknown>): void => {
    if (params.token !== io.token) throw new Error('bad_run_token')
  }

  transport.onRequest(async (method, rawParams) => {
    const params = asRecord(rawParams)
    if (method === M_HELLO) {
      const hello = params as unknown as HelloParams
      checkToken(params)
      if (hello.protocol !== BRIDGE_PROTOCOL_VERSION) {
        throw new Error(`bridge_protocol_mismatch: ${String(hello.protocol)}`)
      }
      const probe = createInProcessDshRuntime({
        clock: new MirrorClock('1970-01-01T00:00:00.000Z' as Iso8601),
        gateway: {
          async complete() {
            throw new Error('unreachable')
          },
        },
      })
      const result: HelloResult = {
        protocol: BRIDGE_PROTOCOL_VERSION,
        runtime: probe.name,
        capabilities: probe.capabilities(),
      }
      return result
    }
    if (method === M_CANCEL) {
      checkToken(params)
      controller?.abort()
      return {}
    }
    if (method === M_SHUTDOWN) {
      checkToken(params)
      queueMicrotask(() => {
        transport.close()
        resolveDone()
        io.exit(0)
      })
      return {}
    }
    if (method !== M_RUN) throw new Error(`unknown_method: ${method}`)

    checkToken(params)
    const run = params as unknown as RunParams
    const clock = new MirrorClock(run.now as Iso8601)
    controller = new AbortController()
    // 宿主那边进来时就已经中断了 → 子进程照样走同一条路径（17 §5.6），事件序列一致
    if (run.aborted === true) controller.abort()
    const request: RunRequest = run.request
    const wire = run.options

    const ask = async <T extends { now: string }>(
      method_: string,
      body: Record<string, unknown>,
    ): Promise<T> => {
      const reply = (await transport.request(method_, { token: io.token, ...body })) as T
      clock.sync(reply?.now)
      return reply
    }

    const options: DshRuntimeOptions = {
      clock,
      mode: 'in-process',
      gateway: {
        async complete(req) {
          const reply = await ask<CompleteResult>(M_HOST_COMPLETE, { request: req })
          return reply.completion as Completion
        },
      },
      ...(wire.seed === undefined ? {} : { seed: wire.seed }),
      ...(wire.defaultReturnWindowDays === undefined
        ? {}
        : { defaultReturnWindowDays: wire.defaultReturnWindowDays }),
      ...(wire.signature === undefined ? {} : { signature: wire.signature }),
      ...(wire.presetRoot === undefined ? {} : { presetRoot: wire.presetRoot }),
      ...(wire.sessionLogRoot === undefined ? {} : { sessionLogRoot: wire.sessionLogRoot }),
      ...(wire.sideEffects === undefined ? {} : { sideEffects: wire.sideEffects }),
      ...(wire.has.executeTool
        ? {
            executeTool: async (call) => {
              const reply = await ask<ToolCallResult>(M_HOST_TOOL, {
                name: call.name,
                input: call.input,
              })
              return {
                status: reply.status,
                ...(reply.data === undefined ? {} : { data: reply.data }),
                ...(reply.reason === undefined ? {} : { reason: reply.reason }),
                ...(reply.provenance === undefined ? {} : { provenance: reply.provenance }),
              }
            },
          }
        : {}),
      ...(wire.has.stage
        ? {
            stage: async (intent) => {
              const { request: _drop, ...rest } = intent
              const reply = await ask<StageResult>(M_HOST_STAGE, { intent: rest })
              return reply.change_id === undefined ? undefined : { change_id: reply.change_id }
            },
          }
        : {}),
      ...(wire.has.createDraft
        ? {
            createDraft: async (payload) => {
              const { request: _drop, ...rest } = payload
              const reply = await ask<DraftResult>(M_HOST_DRAFT, { payload: rest })
              return reply.approval_item_id === undefined
                ? undefined
                : { approval_item_id: reply.approval_item_id }
            },
          }
        : {}),
      ...(wire.has.createPolicyQuestion
        ? {
            createPolicyQuestion: async ({ boundary }) => {
              const reply = await ask<BoundaryResult>(M_HOST_BOUNDARY, { boundary })
              return reply.approval_item_id === undefined
                ? undefined
                : { approval_item_id: reply.approval_item_id }
            },
          }
        : {}),
    }

    const runtime = createInProcessDshRuntime(options)
    const sink = (event: RunEvent): void => {
      transport.notify(M_EVENT, { token: io.token, event })
    }
    try {
      const result: RunResult = await runtime.run(request, sink, controller.signal)
      const ok: RunResponse = { ok: true, result }
      return ok
    } catch (e) {
      const err: RunResponse = {
        ok: false,
        code: 'internal',
        message: e instanceof Error ? e.message : String(e),
        retryable: false,
      }
      return err
    } finally {
      controller = undefined
    }
  })

  transport.start()
  transport.notify(M_READY, { protocol: BRIDGE_PROTOCOL_VERSION })
  return { transport, done }
}

/** 真入口：只有被当成脚本跑起来时才接管 stdio。 */
export function main(): void {
  const token = process.env[ENV_RUN_TOKEN]
  if (token === undefined || token.length === 0) {
    process.stderr.write(`${ENV_RUN_TOKEN} 未设置：拒绝启动\n`)
    process.exitCode = 2
    return
  }
  process.env[ENV_CHILD_MARKER] = '1'
  startChildBridge({
    input: process.stdin,
    output: process.stdout,
    token,
    exit: (code) => process.exit(code),
  })
}

/** 只有被当成脚本跑起来时才接管 stdio（被 import 时什么都不做）。 */
function isEntry(): boolean {
  const argv = process.argv[1]
  if (argv === undefined) return false
  try {
    return realpathSync(fileURLToPath(import.meta.url)) === realpathSync(resolve(argv))
  } catch {
    return false
  }
}

if (isEntry()) main()
