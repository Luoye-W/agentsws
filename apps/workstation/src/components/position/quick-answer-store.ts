/**
 * WP291（决策 356）：岗位入口的一句话发出去之后的那一下——三个入口（岗位页输入框、⌘K「交给某个岗位」、
 * 首页快捷提示）共用这一份。
 *
 * - 发出去立刻记一条「正在查」（岗位页输入框下面出 …，不会「发出去没反应」）；
 * - 服务端判成**当场问答** → 回答（一句话 + 组件）留在这里，岗位页画；
 * - 判成**会话 / 任务** → 记下要进的线程，岗位页马上跳过去（`thread`）；
 * - 没交出去 → 记下错误，岗位页在同一处说一句、给「重试」。
 *
 * 同一时间只留最近一个（Luoye：只留最近一个回答）；只在内存里——刷新后到岗位「记录」里找。
 */
import { useSyncExternalStore } from 'react'
import { type OpenAtPositionData, openMatterAtPosition, type PositionAnswerData } from '@/lib/api'
import { handoffInput } from '@/lib/handoff'

export interface QuickAnswerEntry {
  /** 岗位页地址里的那个 id（提交时用的那条分配 / 岗位模板 id） */
  position: string
  question: string
  summary?: string
  role_id?: string
  status: 'pending' | 'done' | 'thread' | 'choice' | 'error'
  answer?: PositionAnswerData
  /** 老服务端回了一张「走哪条职责」（WP291 起服务端不再出）：原样交给入口摆候选 */
  open?: OpenAtPositionData
  /** `done`：当场问答落在哪件（「接着聊」「当成任务做」用）；`thread`：要进的线程 */
  matter_id?: string
  error?: unknown
  nonce: number
}

let current: QuickAnswerEntry | undefined
let seq = 0
const listeners = new Set<() => void>()

const publish = (next: QuickAnswerEntry | undefined): void => {
  current = next
  for (const l of listeners) l()
}

const subscribe = (l: () => void): (() => void) => {
  listeners.add(l)
  return () => {
    listeners.delete(l)
  }
}

/** 这个岗位页上现在那一条（别的岗位的不出）。 */
export function useQuickAnswer(position: string | undefined): QuickAnswerEntry | undefined {
  const entry = useSyncExternalStore(
    subscribe,
    () => current,
    () => current,
  )
  return entry !== undefined && entry.position === position ? entry : undefined
}

/** 关掉（只关这一条；之后又来的不受影响）。 */
export function closeQuickAnswer(nonce?: number): void {
  if (current === undefined) return
  if (nonce !== undefined && current.nonce !== nonce) return
  publish(undefined)
}

/** 测试用：清干净。 */
export function resetQuickAnswer(): void {
  publish(undefined)
}

/**
 * 发一句话给岗位。回包到了只更新**还是这一条**的那份（中途又发了一句，旧的回包不覆盖新的）。
 * `mode: 'quick'` = 重试当场问答（不再判一次）。
 */
export async function askAtPosition(input: {
  position: string
  text: string
  /** 已经拆好的描述（⌘K 从随便聊带过来的上下文）：给了就用 `text` 当标题、原样交，不再拆 */
  summary?: string
  role_id?: string
  mode?: 'quick'
}): Promise<QuickAnswerEntry | undefined> {
  seq += 1
  const nonce = seq
  const base = {
    position: input.position,
    question: input.text,
    nonce,
    ...(input.summary === undefined || input.summary === '' ? {} : { summary: input.summary }),
    ...(input.role_id === undefined ? {} : { role_id: input.role_id }),
  }
  publish({ ...base, status: 'pending' })
  const settle = (next: QuickAnswerEntry): QuickAnswerEntry | undefined => {
    if (current?.nonce !== nonce) return undefined
    publish(next)
    return next
  }
  try {
    const out = await openMatterAtPosition(input.position, {
      ...(input.summary === undefined || input.summary === ''
        ? handoffInput(input.text)
        : { title: input.text, summary: input.summary }),
      ...(input.role_id === undefined ? {} : { role_id: input.role_id }),
      ...(input.mode === undefined ? {} : { mode: input.mode }),
    })
    if (out.ambiguous && out.approval_item_id !== undefined)
      return settle({ ...base, status: 'choice', matter_id: out.matter.id, open: out })
    if (out.mode === 'quick' && out.answer !== undefined)
      return settle({ ...base, status: 'done', answer: out.answer, matter_id: out.matter.id })
    return settle({ ...base, status: 'thread', matter_id: out.matter.id })
  } catch (error) {
    return settle({ ...base, status: 'error', error })
  }
}
