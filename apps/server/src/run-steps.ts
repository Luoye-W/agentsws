/**
 * WP264（决策 182）：一次运行「做了哪几步」——事项页那一行灰字点开的步骤清单，以及运行中那一条
 * 「正在做…」+ 当前一步。
 *
 * 只从运行事件里取（`tool.call` / `tool.result`），步骤写成人话：读了哪个文件、改了哪个、检查、推送；
 * 不露工具名（工具名只在开发者视图）。主题工具认出具体文件，别的工具用统一的人话表（`toolWordZh`）
 * + 一个关键入参。只在内存里，跑完把摘要记进时间线（`MatterEvent.run_digest`）。
 */
import type { MatterRunDigest, MatterRunStep } from '@agentsws/contracts'
import { toolWordZh } from '@agentsws/stand-ins'

/** 摘要里最多列这么多步（多的不列，免得一次长运行把时间线撑爆）。 */
export const MAX_RUN_STEPS = 40

const KEY_INPUTS = ['path', 'name', 'query', 'subreddit', 'url', 'id', 'theme_id'] as const

const bare = (tool: string): string => {
  const i = tool.lastIndexOf('.')
  const j = tool.lastIndexOf('__')
  return tool.slice(Math.max(i + 1, j === -1 ? 0 : j + 2))
}

const str = (input: unknown, key: string): string | undefined => {
  if (input === null || typeof input !== 'object') return undefined
  const v = (input as Record<string, unknown>)[key]
  return typeof v === 'string' && v.trim() !== '' ? v.trim() : undefined
}

const clip = (s: string, n = 80): string => (s.length > n ? `${s.slice(0, n)}…` : s)

/** 一次工具调用 → 一步人话。 */
export function stepTextOf(tool: string, input: unknown): string {
  const name = bare(tool)
  const path = str(input, 'path')
  switch (name) {
    case 'theme_read_file':
      return path === undefined ? '读主题文件' : `读 ${clip(path)}`
    case 'theme_write_file':
      return path === undefined ? '改主题文件' : `改 ${clip(path)}`
    case 'theme_files':
      return '看主题里有哪些文件'
    case 'theme_check':
      return '主题检查'
    case 'theme_push_unpublished': {
      const n = str(input, 'name')
      return n === undefined ? '推成未发布主题，出预览' : `推成未发布主题「${clip(n, 60)}」`
    }
    case 'theme_publish':
      return '出发布审批卡'
    case 'theme_init_from_base':
      return '用开源主题起底'
    case 'theme_pull':
      return '把店里的主题拉一份下来'
    case 'theme_list':
      return '看店里有哪些主题'
    default: {
      const what = toolWordZh(tool)
      const key = KEY_INPUTS.map((k) => str(input, k)).find((v) => v !== undefined)
      return key === undefined ? what : `${what}「${clip(key, 60)}」`
    }
  }
}

interface Entry {
  call_id: string
  text: string
  started: number
  ended?: number
  status: MatterRunStep['status']
}

/** 一次运行的步骤记录（开跑建、收尾丢）。时间由调用方给（毫秒），本类不读钟。 */
export class RunStepLog {
  readonly #entries: Entry[] = []
  readonly #started: number

  constructor(startedMs: number) {
    this.#started = startedMs
  }

  call(call_id: string, tool: string, input: unknown, atMs: number): void {
    this.#entries.push({ call_id, text: stepTextOf(tool, input), started: atMs, status: 'running' })
  }

  result(call_id: string, status: 'ok' | 'error' | 'blocked', atMs: number): void {
    const hit = this.#entries.find((e) => e.call_id === call_id && e.status === 'running')
    if (hit === undefined) return
    hit.ended = atMs
    hit.status = status === 'ok' ? 'ok' : 'error'
  }

  /** 正在跑的样子：做完的几步 + 还在做的（`running`）。 */
  live(): MatterRunStep[] {
    return this.#entries.slice(-MAX_RUN_STEPS).map((e) => stepOf(e))
  }

  /** 跑完的摘要（还挂着没回来的那几步按失败算，不留「在做」）。 */
  digest(outcome: MatterRunDigest['outcome'], endedMs: number): MatterRunDigest {
    return {
      seconds: Math.max(0, Math.round((endedMs - this.#started) / 1000)),
      outcome,
      steps: this.#entries
        .slice(0, MAX_RUN_STEPS)
        .map((e) => stepOf(e.status === 'running' ? { ...e, status: 'error' } : e)),
    }
  }
}

function stepOf(e: Entry): MatterRunStep {
  return {
    text: e.text,
    status: e.status,
    ...(e.ended === undefined
      ? {}
      : { seconds: Math.max(0, Math.round((e.ended - e.started) / 1000)) }),
  }
}
