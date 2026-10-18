/**
 * WP410（真机 #9，Luoye 10-18）：AI 说连接 / 设置的状态**只读「当前设置快照」**——stub 那一段剧本。
 *
 * 快照由服务端每次运行现取、注进上下文（`ContextItem`，id `setup_state`，三个运行时同一份字节）：
 * 连接以插件交回 / 连接表为准，设置是库里的原值，另有最近一轮跑得怎样、还开着哪几张卡。
 * direct / dsh 的模型看得到同一段字；stub 没有模型，问到「连上了吗 / 现在怎么设的」就照这一段原样说，
 * 一个字都不靠记忆或之前的对话。快照里没有的就说不知道。
 */
import type { ContextItem, RunRequest } from '@agentsws/contracts'

/** 快照那一条上下文的 id（服务端 `SETUP_STATE_CONTEXT_ID` 同一个）。 */
export const SETUP_STATE_ITEM_ID = 'setup_state'

/** 问的是「现在怎样」：连没连上、设成什么样、跑没跑。 */
const ASK_STATE =
  /连上了?(吗|没)|连没连|连好了?(吗|没)|有没有连|(现在|目前).{0,8}(设置|设成|状态|关键词|版块)|设(得|成)(怎么样|什么样)|关键词(是|有)(哪|什么)|(巡查|设置).{0,6}(怎么样|状态|到哪|跑了?(吗|没))/u

interface SnapshotSetting {
  name?: string
  configured?: boolean
  values?: Record<string, string>
  connections?: Record<string, string>
  notes?: string[]
}
interface Snapshot {
  settings?: SnapshotSetting[]
  open_cards?: { kind?: string; title?: string }[]
}

function snapshotOf(item: ContextItem | undefined): Snapshot | undefined {
  if (item === undefined) return undefined
  try {
    const raw = typeof item.content === 'string' ? JSON.parse(item.content) : item.content
    return raw !== null && typeof raw === 'object' ? (raw as Snapshot) : undefined
  } catch {
    return undefined
  }
}

/** 这一轮问的是状态、上下文里又有快照 → 照快照说的那一段；否则 `undefined`（stub 其余路径一个字节不变）。 */
export function setupStateBranch(req: RunRequest, text: string): string | undefined {
  if (!ASK_STATE.test(text)) return undefined
  const snap = snapshotOf(req.context.find((c) => c.id === SETUP_STATE_ITEM_ID))
  if (snap === undefined || (snap.settings ?? []).length === 0) return undefined
  return renderSetupState(snap)
}

/** 快照 → 一段人话（粗体、列表；时间线会渲染）。 */
export function renderSetupState(snap: Snapshot): string {
  const lines: string[] = ['我刚从库里读的，现在是这样：']
  for (const s of snap.settings ?? []) {
    lines.push('', `**${s.name ?? '设置'}**（${s.configured === true ? '设好了' : '还没设好'}）`)
    for (const [k, v] of Object.entries(s.connections ?? {})) lines.push(`- ${k}：${v}`)
    for (const [k, v] of Object.entries(s.values ?? {})) lines.push(`- ${k}：${v}`)
    for (const n of s.notes ?? []) lines.push(`- ${n}`)
  }
  const open = snap.open_cards ?? []
  lines.push(
    '',
    open.length === 0
      ? '没有开着的设置卡 / 连接卡。'
      : `还开着的卡：${open.map((c) => `「${c.title ?? c.kind ?? ''}」`).join('、')}。`,
  )
  return lines.join('\n')
}
