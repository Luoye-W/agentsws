import type {
  Clock,
  RunEvent,
  RunId,
  RunRequest,
  RunResult,
  RuntimeAdapter,
} from '@agentsws/contracts'
import { canonicalJson, sha256 } from '@agentsws/core'

/** 17 §4 `dev-executor` 的产物；契约的 `RunOutput{kind:'dev_result'}` 只带 id，明细放这里。 */
export interface DevResult {
  dev_task_id: string
  pr_url: string
  theme_id: string
  branch: string
  commit: string
  checks: 'passed' | 'failed'
}

export interface DevStubOptions {
  clock: Clock
  seed?: number
  /** 固定返回值；不给用默认的假 PR / 主题副本。 */
  result?: Partial<Omit<DevResult, 'dev_task_id'>>
}

export interface DevStubRuntime extends RuntimeAdapter {
  /** 取某次运行的 dev_result 明细。 */
  resultOf(run_id: RunId): DevResult | undefined
}

const DEFAULT: Omit<DevResult, 'dev_task_id'> = {
  pr_url: 'https://github.com/agentsws/stand-in-repo/pull/1',
  theme_id: 'theme_stand_in_1',
  branch: 'agent/dev-task',
  commit: '0000000000000000000000000000000000000000',
  checks: 'passed',
}

/**
 * 26 §3 假编码执行器 / 17 §4 `dev-executor`：吃 `kind: 'dev_task'` 的 RunRequest，
 * 返回固定的 dev_result（PR url / theme id）。不写任何外部系统。
 */
export function createDevStubRuntime(options: DevStubOptions): DevStubRuntime {
  const results = new Map<RunId, DevResult>()
  const fixed: Omit<DevResult, 'dev_task_id'> = { ...DEFAULT, ...options.result }
  const seed = options.seed ?? 1

  return {
    name: 'dev-stub',
    capabilities() {
      return { tool_choice: false, streaming: false, followup: false, seedable: true }
    },
    async health() {
      return { ok: true }
    },
    resultOf(run_id) {
      const r = results.get(run_id)
      return r === undefined ? undefined : { ...r }
    },
    async run(
      req: RunRequest,
      sink: (e: RunEvent) => void,
      signal: AbortSignal,
    ): Promise<RunResult> {
      const startedMs = Date.parse(options.clock.now())
      sink({
        type: 'run.started',
        request_id: req.id,
        runtime: 'dev-stub',
        model: req.runtime.model,
      })

      const session_ref = {
        runtime: 'dev-stub',
        session_id: sha256(canonicalJson({ id: req.id, seed })).slice(0, 26),
        log_uri: `memory://dev-stub/${req.id}`,
      }
      const usage = {
        input_tokens: 0,
        output_tokens: 0,
        cached_tokens: 0,
        tool_calls: 0,
        seconds: 0,
        cost_base: 0,
      }

      if (req.kind !== 'dev_task') {
        const error = {
          code: 'invalid_input',
          message: `dev-stub 只接受 kind='dev_task'，收到 ${req.kind}`,
          retryable: false,
        }
        sink({ type: 'run.failed', error })
        return {
          request_id: req.id,
          status: 'failed',
          outputs: [],
          provenance: { run_id: req.id, seen: {}, read_full: [], recorded_at: options.clock.now() },
          memory_candidates: [],
          lessons: [],
          usage,
          session_ref,
          summary: error.message,
        }
      }

      const dev_task_id = req.work_item?.id ?? req.id
      for (const step of ['plan', 'implement', 'test', 'open_pr']) {
        if (signal.aborted) {
          sink({ type: 'run.cancelled' })
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
            usage,
            session_ref,
            summary: 'dev-stub 被中断',
          }
        }
        sink({ type: 'progress', step, note: `dev-stub ${step}` })
      }

      const result: DevResult = { dev_task_id, ...fixed }
      results.set(req.id, result)
      const summary = `dev_result: ${result.pr_url} / ${result.theme_id}`
      const finalUsage = {
        ...usage,
        seconds: Math.max(0, (Date.parse(options.clock.now()) - startedMs) / 1000),
      }
      const outputs = [{ kind: 'dev_result' as const, dev_task_id }]
      sink({ type: 'run.completed', usage: finalUsage, outputs, summary })
      return {
        request_id: req.id,
        status: 'completed',
        outputs,
        provenance: { run_id: req.id, seen: {}, read_full: [], recorded_at: options.clock.now() },
        memory_candidates: [],
        lessons: [],
        usage: finalUsage,
        session_ref,
        summary,
      }
    },
  }
}
