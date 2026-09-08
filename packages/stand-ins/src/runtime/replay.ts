import { readFileSync, writeFileSync } from 'node:fs'
import type {
  Clock,
  Iso8601,
  RunEvent,
  RunRequest,
  RunResult,
  RuntimeAdapter,
} from '@agentsws/contracts'
import { canonicalJson, sha256 } from '@agentsws/core'
import { StandInError } from '../errors.js'

export interface RecordedRun {
  hash: string
  /** 只留识别用的摘要，回放不读它。 */
  digest: { kind: RunRequest['kind']; workspace_id: string; role_id: string; tools: string[] }
  events: RunEvent[]
  result: RunResult
  recorded_by: string
  recorded_at: Iso8601
}

export interface Recording {
  schema_version: 1
  runs: RecordedRun[]
}

/** 默认从 canonical 请求里剔除的字段（每次运行都会变，但不改变"要做的事"）。 */
export const DEFAULT_OMIT_PATHS: readonly string[] = ['id', 'idempotency_key', 'trigger.event_id']

function omitPath(target: Record<string, unknown>, path: string): void {
  const parts = path.split('.')
  const last = parts.pop()
  if (last === undefined) return
  let cur: Record<string, unknown> | undefined = target
  for (const p of parts) {
    const next: unknown = cur?.[p]
    cur =
      next !== null && typeof next === 'object' && !Array.isArray(next)
        ? (next as Record<string, unknown>)
        : undefined
    if (!cur) return
  }
  delete cur[last]
}

/** 深拷贝后剔除 `omit` 路径，得到"同一件事"的规范形状。 */
export function canonicalRunRequest(
  req: RunRequest,
  omit: readonly string[] = DEFAULT_OMIT_PATHS,
): Record<string, unknown> {
  const clone = JSON.parse(JSON.stringify(req)) as Record<string, unknown>
  for (const p of omit) omitPath(clone, p)
  return clone
}

/** 录制 / 回放的键：canonical 请求的 sha256。 */
export function runRequestHash(req: RunRequest, omit?: readonly string[]): string {
  return sha256(canonicalJson(canonicalRunRequest(req, omit)))
}

export function emptyRecording(): Recording {
  return { schema_version: 1, runs: [] }
}

export function mergeRecordings(...recordings: Recording[]): Recording {
  const runs = new Map<string, RecordedRun>()
  for (const r of recordings) for (const run of r.runs) runs.set(run.hash, run)
  return { schema_version: 1, runs: [...runs.values()] }
}

export function loadRecording(path: string): Recording {
  const raw: unknown = JSON.parse(readFileSync(path, 'utf8'))
  if (raw === null || typeof raw !== 'object' || !Array.isArray((raw as Recording).runs)) {
    throw new StandInError('invalid_input', `不是合法的录制文件：${path}`, { path })
  }
  return raw as Recording
}

export function saveRecording(path: string, recording: Recording): void {
  writeFileSync(path, `${JSON.stringify(recording, null, 2)}\n`, 'utf8')
}

export interface RecordingRuntime extends RuntimeAdapter {
  recording(): Recording
}

/**
 * 26 §3 / 17 §4：把一次真实（或 stub）运行的事件序列录下来。
 * 包装器不改变被包装适配器的行为，只旁路记录。
 */
export function record(
  inner: RuntimeAdapter,
  opts: { clock: Clock; into?: Recording; omit?: readonly string[] },
): RecordingRuntime {
  const recording = opts.into ?? emptyRecording()
  return {
    name: inner.name,
    capabilities: () => inner.capabilities(),
    health: () => inner.health(),
    ...(inner.followup === undefined ? {} : { followup: inner.followup.bind(inner) }),
    async run(req, sink, signal) {
      const events: RunEvent[] = []
      const result = await inner.run(
        req,
        (e) => {
          events.push(e)
          sink(e)
        },
        signal,
      )
      const hash = runRequestHash(req, opts.omit)
      const entry: RecordedRun = {
        hash,
        digest: {
          kind: req.kind,
          workspace_id: req.workspace_id,
          role_id: req.actor.role_id,
          tools: [...req.tools.allow].sort(),
        },
        events,
        result,
        recorded_by: inner.name,
        recorded_at: opts.clock.now(),
      }
      const idx = recording.runs.findIndex((r) => r.hash === hash)
      if (idx >= 0) recording.runs[idx] = entry
      else recording.runs.push(entry)
      return result
    },
    recording: () => ({ schema_version: 1, runs: recording.runs.map((r) => ({ ...r })) }),
  }
}

export interface ReplayRuntimeOptions {
  clock: Clock
  recording?: Recording
  /** 录制文件路径；与 `recording` 可同时给（合并）。 */
  files?: string[]
  omit?: readonly string[]
}

export interface ReplayRuntime extends RuntimeAdapter {
  /** 追加 / 替换录制内容。 */
  load(recording: Recording): void
  loadFile(path: string): void
  has(req: RunRequest): boolean
  size(): number
}

/**
 * 26 §3 / 17 §4 `replay` 运行时（realistic 档）：按 RunRequest 的 canonical 哈希
 * 查录制文件，逐条重发事件序列并返回原 RunResult。miss 直接报错——
 * "replay 不用于证明新模型行为"（26 原则 ④），所以宁可红也不即兴生成。
 */
export function createReplayRuntime(options: ReplayRuntimeOptions): ReplayRuntime {
  const runs = new Map<string, RecordedRun>()
  const load = (rec: Recording): void => {
    for (const r of rec.runs) runs.set(r.hash, r)
  }
  if (options.recording) load(options.recording)
  for (const f of options.files ?? []) load(loadRecording(f))

  return {
    name: 'replay',
    capabilities() {
      return { tool_choice: false, streaming: true, followup: false, seedable: true }
    },
    async health() {
      return { ok: runs.size > 0, detail: `${runs.size} 条录制` }
    },
    load,
    loadFile(path) {
      load(loadRecording(path))
    },
    has(req) {
      return runs.has(runRequestHash(req, options.omit))
    },
    size() {
      return runs.size
    },
    async run(req, sink, signal): Promise<RunResult> {
      const hash = runRequestHash(req, options.omit)
      const entry = runs.get(hash)
      if (!entry) {
        throw new StandInError('not_found', `replay miss：没有 ${hash} 的录制`, {
          hash,
          request_id: req.id,
          known: runs.size,
        })
      }
      for (const e of entry.events) {
        if (signal.aborted) {
          sink({ type: 'run.cancelled' })
          return { ...entry.result, request_id: req.id, status: 'cancelled' }
        }
        sink(e)
      }
      return { ...entry.result, request_id: req.id }
    },
  }
}
