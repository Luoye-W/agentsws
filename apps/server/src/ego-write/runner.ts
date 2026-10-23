/**
 * WP483：跑一次 ego 写（或读回），把输出翻成 {@link EgoWriteResult}；外加「真连一次」的探测。
 *
 * 子进程用 `@agentsws/dsh-adapter` 的 `spawnEgo`（脚本走标准输入、不经任何 shell、超时只停自己起的那一个）。
 *
 * ego 自己会停下脚本的两种情况（不经过我们的 `@@FINAL`），这里从输出里认：
 * - **浏览器权限框**（WP464 实测 Facebook 一打开就弹「显示通知」）：ego 打印
 *   「A browser permission prompt … The user now controls this task space …」后结束 → `needs_human`；
 * - **Windows 管理员身份**（WP464 实测）：「ego-browser is running as administrator」→ `unavailable` + 人话。
 */
import type { EgoWriteResult } from '@agentsws/contracts'
import { type EgoProcessResult, spawnEgo } from '@agentsws/dsh-adapter'
import { type EgoWriteScriptConfig, egoWriteScript } from './script.js'

/** 一次写最多等多久（挂视频的 TikTok 最慢；超时就当失败，点没点过照脚本打印的算）。 */
export const EGO_WRITE_TIMEOUT_MS = 6 * 60_000
/** 读回一趟最多等多久。 */
export const EGO_READBACK_TIMEOUT_MS = 90_000

export type EgoSpawn = (input: {
  egoPath: string
  args: readonly string[]
  stdin?: string
  timeoutMs: number
}) => Promise<EgoProcessResult>

const ADMIN = /running as administrator/iu
const HANDED = /permission prompt|user now controls this task space|takeOverTaskSpace/iu

export const EGO_ADMIN_SENTENCE =
  '工坊现在是「以管理员身份运行」的，ego 不接受管理员身份的调用：关掉工坊，正常双击打开（不要右键「以管理员身份运行」）'

/** 把一次子进程的输出翻成结果（单测直接喂输出）。 */
export function parseEgoWriteOutput(
  cfg: Pick<EgoWriteScriptConfig, 'platform'>,
  proc: EgoProcessResult,
): EgoWriteResult {
  const all = `${proc.stdout}\n${proc.stderr}`
  // 真机实测（ego 2.1.0，Mac）：管道里脚本的 console.log 走的是 stderr——两路一起认
  const lines = all.split(/\r?\n/u)
  const finalLine = [...lines].reverse().find((l) => l.startsWith('@@FINAL '))
  const space = lines.find((l) => l.startsWith('@@SPACE '))
  const space_id = space === undefined ? undefined : Number(space.slice(8).trim())
  const clicked = lines.some((l) => l.startsWith('@@STEP ') && l.includes('"send-clicked"'))
  const base = {
    platform: cfg.platform,
    duration_ms: proc.duration_ms,
    ...(space_id !== undefined && Number.isFinite(space_id) ? { space_id } : {}),
  }
  if (finalLine !== undefined) {
    try {
      const f = JSON.parse(finalLine.slice(8)) as EgoWriteResult & { clicked?: boolean }
      return {
        ...base,
        ...f,
        platform: cfg.platform,
        ...(clicked ? { clicked: true } : f.clicked === true ? { clicked: true } : {}),
      }
    } catch {
      // 落到下面
    }
  }
  if (proc.spawn_error !== undefined)
    return { ...base, state: 'unavailable', why: `ego 起不来：${proc.spawn_error}` }
  if (ADMIN.test(all)) return { ...base, state: 'unavailable', why: EGO_ADMIN_SENTENCE }
  if (HANDED.test(all))
    return {
      ...base,
      state: 'needs_human',
      why: '浏览器弹了要你处理的框（比如「显示通知」）',
      ...(clicked ? { clicked: true } : {}),
    }
  if (proc.timed_out)
    return {
      ...base,
      state: 'failed',
      why: 'ego 那一趟一直没跑完',
      ...(clicked ? { clicked: true } : {}),
    }
  const err = (proc.stderr.trim().split(/\r?\n/u).at(-1) ?? '').slice(0, 200)
  return {
    ...base,
    state: proc.exit_code === 0 ? 'failed' : 'unavailable',
    why: err === '' ? `ego 退出码 ${proc.exit_code ?? '（被停掉）'}` : err,
    ...(clicked ? { clicked: true } : {}),
  }
}

/** 跑一次写 / 读回。 */
export async function runEgoWrite(input: {
  egoPath: string
  cfg: EgoWriteScriptConfig
  spawn?: EgoSpawn
  timeoutMs?: number
}): Promise<EgoWriteResult> {
  const spawn = input.spawn ?? spawnEgo
  const proc = await spawn({
    egoPath: input.egoPath,
    args: ['nodejs'],
    stdin: egoWriteScript(input.cfg),
    timeoutMs:
      input.timeoutMs ??
      (input.cfg.mode === 'readback' ? EGO_READBACK_TIMEOUT_MS : EGO_WRITE_TIMEOUT_MS),
  })
  return parseEgoWriteOutput(input.cfg, proc)
}

/** 「真连一次」的结果。 */
export interface EgoConnectProbe {
  connected: boolean
  admin?: boolean
  detail?: string
}

/**
 * 装好了之后真连一次：跑一段只数一下 Space 个数的脚本（不开页面、不读 Profile / cookie）。
 * 认得出的几种：管理员身份（Windows）、ego 没打开 / 首次引导没做完。
 */
export async function probeEgoConnection(
  egoPath: string,
  spawn: EgoSpawn = spawnEgo,
): Promise<EgoConnectProbe> {
  const proc = await spawn({
    egoPath,
    args: ['nodejs'],
    stdin: 'const s = await listTaskSpaces();\nconsole.log("@@OK " + s.length);\n',
    timeoutMs: 20_000,
  })
  if (`${proc.stdout}\n${proc.stderr}`.includes('@@OK ')) return { connected: true }
  const all = `${proc.stdout}\n${proc.stderr}`
  if (ADMIN.test(all)) return { connected: false, admin: true, detail: EGO_ADMIN_SENTENCE }
  if (proc.spawn_error !== undefined)
    return { connected: false, detail: `ego 起不来：${proc.spawn_error}` }
  if (proc.timed_out)
    return {
      connected: false,
      detail: 'ego 一直没回应：先打开 ego 一次、做完首次引导，再回来点「再看一次」',
    }
  return {
    connected: false,
    detail:
      'ego 装好了，但连不上：先打开 ego 一次、做完首次引导（导不导入 Chrome 都行），再回来点「再看一次」',
  }
}
