/**
 * WP509：跑一趟「往飞书表格里写」（`script.ts`），把结果文件读回来；临时目录跑完就删。
 *
 * 子进程与 WP483 / WP493 同一个跑法（`@agentsws/dsh-adapter` 的 `spawnEgo`：脚本走标准输入、不经 shell、超时只停自己起的那一个）。
 * ego 自己硬停（浏览器权限框 / 人接管）→ `needs_human`；Windows 管理员身份 → `unavailable` + 人话（与写那一路同一句）。
 */
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { type EgoProcessResult, spawnEgo } from '@agentsws/dsh-adapter'
import { EGO_ADMIN_SENTENCE, type EgoSpawn } from '../ego-write/runner.js'
import { type EgoSheetScriptConfig, egoSheetScript } from './script.js'

/** 一趟最多等多久（读两遍整张表 + 走格子 + 粘贴；大表给足）。 */
export const EGO_SHEET_TIMEOUT_MS = 6 * 60_000

export type EgoSheetState =
  | 'ok'
  | 'login'
  | 'no_access'
  | 'unreadable'
  | 'columns_changed'
  | 'cannot_locate'
  | 'rolled_back'
  | 'rollback_unsure'
  | 'needs_human'
  | 'failed'
  | 'unavailable'

export type EgoSheetOpResult =
  | 'appended'
  | 'updated'
  | 'fallback_appended'
  | 'partial'
  | 'not_found'
  | 'ambiguous'
  | 'locate_failed'
  | 'no_new_row'
  | 'too_big'
  | 'verify_failed'
  | 'undone'

export interface EgoSheetResult {
  state: EgoSheetState
  why?: string
  space_id?: number
  closed?: boolean
  duration_ms: number
  kind?: 'bitable' | 'sheet' | 'auto'
  header?: string[]
  before_rows?: string[][]
  after_rows?: string[][]
  missing_columns?: string[]
  mutations?: number
  /** 多维表格新行是怎么来的：表尾空行 / 「添加记录」按钮 / 电子表格本来就有空行 / 没办法。 */
  tactic?: 'blank' | 'button' | 'sheet' | 'none'
  collateral?: number
  ops: {
    id: string
    op: 'append' | 'update'
    result: EgoSheetOpResult
    row?: number
    why?: string
    /** 退回进展行时：为什么退的（not_found / ambiguous / locate_failed / too_big）。 */
    fallback_for?: string
  }[]
}

export type EgoSheetCall = Omit<EgoSheetScriptConfig, 'out' | 'space'>

const ADMIN = /running as administrator/iu
const HANDED = /permission prompt|user now controls this task space|takeOverTaskSpace/iu

let seq = 0
/** 每趟一个新名字（同名会续上别人的空间）。 */
export function egoSheetSpaceName(now = Date.now()): string {
  seq += 1
  return `工坊 · 同步表格 · ${seq.toString(36)}${now.toString(36).slice(-5)}`
}

const scriptPath = (p: string): string =>
  process.platform === 'win32' ? p.replace(/\\/gu, '/') : p

/** 子进程输出 + 结果文件 → 结果（单测直接喂）。 */
export function parseEgoSheetOutput(
  proc: EgoProcessResult,
  outJson: string | undefined,
): EgoSheetResult {
  const all = `${proc.stdout}\n${proc.stderr}`
  const lines = all.split(/\r?\n/u)
  const spaceLine = lines.find((l) => l.startsWith('@@SPACE '))
  const space = spaceLine === undefined ? undefined : Number(spaceLine.slice(8).trim())
  const base = {
    duration_ms: proc.duration_ms,
    ...(space !== undefined && Number.isFinite(space) ? { space_id: space } : {}),
  }
  if (outJson !== undefined) {
    try {
      const f = JSON.parse(outJson) as EgoSheetResult
      return { ...base, ...f, ops: Array.isArray(f.ops) ? f.ops : [] }
    } catch {
      // 落到下面
    }
  }
  const finalLine = [...lines].reverse().find((l) => l.startsWith('@@FINAL '))
  if (finalLine !== undefined) {
    try {
      const f = JSON.parse(finalLine.slice(8)) as Omit<EgoSheetResult, 'ops'>
      return { ...base, ...f, ops: [] }
    } catch {
      // 落到下面
    }
  }
  if (proc.spawn_error !== undefined)
    return { ...base, state: 'unavailable', why: `ego 起不来：${proc.spawn_error}`, ops: [] }
  if (ADMIN.test(all)) return { ...base, state: 'unavailable', why: EGO_ADMIN_SENTENCE, ops: [] }
  if (HANDED.test(all))
    return { ...base, state: 'needs_human', why: '浏览器弹了要你处理的框', ops: [] }
  if (proc.timed_out) return { ...base, state: 'failed', why: 'ego 那一趟一直没跑完', ops: [] }
  const err = (proc.stderr.trim().split(/\r?\n/u).at(-1) ?? '').slice(0, 200)
  return {
    ...base,
    state: proc.exit_code === 0 ? 'failed' : 'unavailable',
    why: err === '' ? `ego 退出码 ${proc.exit_code ?? '（被停掉）'}` : err,
    ops: [],
  }
}

export interface RunEgoSheetInput {
  egoPath: string
  call: EgoSheetCall
  spawn?: EgoSpawn
  timeoutMs?: number
  root?: string
  space?: string
}

/** 跑一趟写。临时目录（结果文件）跑完就删。 */
export async function runEgoSheetWrite(input: RunEgoSheetInput): Promise<EgoSheetResult> {
  const root = input.root ?? tmpdir()
  mkdirSync(root, { recursive: true })
  const dir = mkdtempSync(join(root, 'agentsws-ego-sheet-'))
  try {
    const out = join(dir, 'result.json')
    const proc = await (input.spawn ?? spawnEgo)({
      egoPath: input.egoPath,
      args: ['nodejs'],
      stdin: egoSheetScript({
        ...input.call,
        space: input.space ?? egoSheetSpaceName(),
        out: scriptPath(out),
      }),
      timeoutMs: input.timeoutMs ?? EGO_SHEET_TIMEOUT_MS,
    })
    let outJson: string | undefined
    try {
      outJson = readFileSync(out, 'utf8')
    } catch {
      outJson = undefined
    }
    return parseEgoSheetOutput(proc, outJson)
  } finally {
    try {
      rmSync(dir, { recursive: true, force: true })
    } catch {
      // 删不掉下次系统清
    }
  }
}
