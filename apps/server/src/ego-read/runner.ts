/**
 * WP493：跑一趟 ego 只读（`script.ts`），把结果文件读回来、下载的文件读成字节，临时目录跑完就删。
 *
 * 子进程与 WP483 同一个跑法（`@agentsws/dsh-adapter` 的 `spawnEgo`：脚本走标准输入、不经 shell、超时只停自己起的那一个）。
 * ego 自己硬停（浏览器权限框 / 人接管）→ `needs_human`；Windows 管理员身份 → `unavailable` + 人话（与写那一路同一句）。
 */
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { EgoProcessResult } from '@agentsws/dsh-adapter'
import { spawnEgo } from '@agentsws/dsh-adapter'
import { EGO_ADMIN_SENTENCE, type EgoSpawn } from '../ego-write/runner.js'
import { type EgoReadScriptConfig, type EgoReadStep, egoReadScript } from './script.js'

/** 一趟最多等多久（飞书导出要等它在服务端生成文件，给足）。 */
export const EGO_READ_TIMEOUT_MS = 3 * 60_000

/** `read` 那一步读回来的页面。 */
export interface EgoPageSnapshot {
  final_url: string
  title: string
  text: string
  html?: string
  snapshot?: string
  password_inputs: number
  canvases: number
  tables: { source: 'table' | 'aria'; rows: string[][] }[]
}

export interface EgoFetchResponse {
  url: string
  status?: number
  final_url?: string
  content_type?: string
  body?: string
  error?: string
}

export interface EgoReadStepResult {
  id: string
  op: EgoReadStep['op'] | 'open'
  ok: boolean
  why?: string
  page?: EgoPageSnapshot
  responses?: EgoFetchResponse[]
  /** 下载下来的文件（已读成字节；临时文件已删）。 */
  file?: { name: string; bytes: Uint8Array }
  clicked?: string[]
  /** `copy` 那一步截住的 (type, value)。 */
  copied?: [string, string][]
  /** WP496：`capture` 那一步读到的（第一份是那一页本身，后面是顺手读的 link-in-bio 页）。 */
  captures?: Record<string, unknown>[]
  final_url?: string
}

export interface EgoReadResult {
  state: 'ok' | 'failed' | 'needs_human' | 'unavailable'
  why?: string
  space_id?: number
  /** 空间收掉了没有（`finish` 成功）。 */
  closed?: boolean
  duration_ms: number
  steps: EgoReadStepResult[]
}

/** 调用方给的那一份（空间名、结果文件、下载存哪由这里补）。 */
export interface EgoReadCall {
  url: string
  settle_ms?: number
  /** 下载类的步不用给 `save_as`（这里在临时目录里补）。 */
  steps: DistributiveOmit<EgoReadStep, 'save_as'>[]
  /** WP496：`capture` 步用的页面脚本模板（`@agentsws/creator-capture`）。 */
  capture?: { template: string; placeholder: string }
}
type DistributiveOmit<T, K extends PropertyKey> = T extends unknown ? Omit<T, K> : never

const ADMIN = /running as administrator/iu
const HANDED = /permission prompt|user now controls this task space|takeOverTaskSpace/iu

let seq = 0
/** 每趟一个新名字（同名会续上别人的空间）。 */
export function egoReadSpaceName(now = Date.now()): string {
  seq += 1
  return `工坊 · 读页 · ${seq.toString(36)}${now.toString(36).slice(-5)}`
}

/** 本机路径 → 脚本里用的写法（Windows 换成正斜杠，ego 的说明里这么要求）。 */
const scriptPath = (p: string): string =>
  process.platform === 'win32' ? p.replace(/\\/gu, '/') : p

/** 子进程输出 + 结果文件 → 结果（单测直接喂）。 */
export function parseEgoReadOutput(
  proc: EgoProcessResult,
  outJson: string | undefined,
): EgoReadResult {
  const all = `${proc.stdout}\n${proc.stderr}`
  const lines = all.split(/\r?\n/u)
  const finalLine = [...lines].reverse().find((l) => l.startsWith('@@FINAL '))
  const spaceLine = lines.find((l) => l.startsWith('@@SPACE '))
  const space = spaceLine === undefined ? undefined : Number(spaceLine.slice(8).trim())
  const base = {
    duration_ms: proc.duration_ms,
    ...(space !== undefined && Number.isFinite(space) ? { space_id: space } : {}),
  }
  if (outJson !== undefined) {
    try {
      const f = JSON.parse(outJson) as EgoReadResult
      return { ...base, ...f, steps: Array.isArray(f.steps) ? f.steps : [] }
    } catch {
      // 落到下面
    }
  }
  if (finalLine !== undefined) {
    try {
      const f = JSON.parse(finalLine.slice(8)) as Omit<EgoReadResult, 'steps'>
      return { ...base, ...f, steps: [] }
    } catch {
      // 落到下面
    }
  }
  if (proc.spawn_error !== undefined)
    return { ...base, state: 'unavailable', why: `ego 起不来：${proc.spawn_error}`, steps: [] }
  if (ADMIN.test(all)) return { ...base, state: 'unavailable', why: EGO_ADMIN_SENTENCE, steps: [] }
  if (HANDED.test(all))
    return { ...base, state: 'needs_human', why: '浏览器弹了要你处理的框', steps: [] }
  if (proc.timed_out) return { ...base, state: 'failed', why: 'ego 那一趟一直没跑完', steps: [] }
  const err = (proc.stderr.trim().split(/\r?\n/u).at(-1) ?? '').slice(0, 200)
  return {
    ...base,
    state: proc.exit_code === 0 ? 'failed' : 'unavailable',
    why: err === '' ? `ego 退出码 ${proc.exit_code ?? '（被停掉）'}` : err,
    steps: [],
  }
}

export interface RunEgoReadInput {
  egoPath: string
  call: EgoReadCall
  spawn?: EgoSpawn
  timeoutMs?: number
  /** 临时目录放哪（缺省系统临时目录）。 */
  root?: string
  /** 空间名（测试给固定的）。 */
  space?: string
}

/** 跑一趟。临时目录（结果文件 + 下载）跑完就删。 */
export async function runEgoRead(input: RunEgoReadInput): Promise<EgoReadResult> {
  const root = input.root ?? tmpdir()
  mkdirSync(root, { recursive: true })
  const dir = mkdtempSync(join(root, 'agentsws-ego-read-'))
  try {
    const out = join(dir, 'result.json')
    const steps = input.call.steps.map((s, i) =>
      s.op === 'download_url' || s.op === 'export'
        ? { ...s, save_as: scriptPath(join(dir, `download-${i + 1}`)) }
        : s,
    ) as EgoReadStep[]
    const cfg: EgoReadScriptConfig = {
      space: input.space ?? egoReadSpaceName(),
      url: input.call.url,
      out: scriptPath(out),
      ...(input.call.settle_ms === undefined ? {} : { settle_ms: input.call.settle_ms }),
      steps,
      ...(input.call.capture === undefined
        ? {}
        : {
            capture_template: input.call.capture.template,
            capture_placeholder: input.call.capture.placeholder,
          }),
    }
    const proc = await (input.spawn ?? spawnEgo)({
      egoPath: input.egoPath,
      args: ['nodejs'],
      stdin: egoReadScript(cfg),
      timeoutMs: input.timeoutMs ?? EGO_READ_TIMEOUT_MS,
    })
    let outJson: string | undefined
    try {
      outJson = readFileSync(out, 'utf8')
    } catch {
      outJson = undefined
    }
    const res = parseEgoReadOutput(proc, outJson)
    // 下载下来的文件读成字节（只认这一趟临时目录里的）
    for (const s of res.steps) {
      const saved = (s as { saved?: unknown }).saved
      if (typeof saved !== 'string' || !saved.startsWith(scriptPath(dir))) continue
      try {
        const bytes = new Uint8Array(readFileSync(saved))
        const name = (s as { name?: unknown }).name
        s.file = { name: typeof name === 'string' ? name : '', bytes }
      } catch {
        s.ok = false
        s.why = 'download-missing'
      }
      delete (s as { saved?: unknown }).saved
    }
    return res
  } finally {
    try {
      rmSync(dir, { recursive: true, force: true })
    } catch {
      // 删不掉下次系统清
    }
  }
}
