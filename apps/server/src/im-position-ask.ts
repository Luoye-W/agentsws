/**
 * WP308（决策 447）：飞书 / 钉钉 / 企业微信里点名岗位（或按 WP306「问谁」落到某个岗位）的工作问题，
 * **直接问那个岗位的 Agent**——不再绕秘书（秘书只答「人」的事，岗位的专业问题它一律推回去）。
 *
 * 只读、只答一句：
 * - 问的是「今天有没有要我处理的 / 在忙什么 / 进展」→ 用这个岗位今天的摘要答（等你定的卡、待办、
 *   进行中、卡住了、最近一条记录；与岗位页「工作」同一个口径），不再起一次模型；
 * - 别的工作问题 → 岗位当场问答（WP291 `quick`：起一次运行，提示词里那段「只查、只答，不改任何东西、
 *   不出卡」），把「一句话 + 组件」压成几行字；答的时候真要动手了（出了卡）→ 已转成任务，聊天里只说一句；
 * - 要动手的交代（「帮我回一下这封邮件」）→ 照 WP291 的任务路径在那个岗位建任务（起运行，不等它），
 *   聊天里回「已记成任务，在工作台确认」。
 *
 * 不放任何批准按钮：决定仍回工作台（13 §4，`im-cards.ts` 同一条纪律）。每一句都附去工作台的链接。
 */

import { type AnswerComponent, type PositionWorkView, splitTaskText } from '@agentsws/contracts'
import { isPositionStatusQuestion } from './im-ask-route.js'
import type { PositionAnswer, PositionsAssembly } from './positions.js'

/** 回到聊天里的那一句（`link` 由调用方接在「去工作台处理：」后面）。 */
export interface ImPositionReply {
  answer: string
  link: string
  /** `task` = 建了任务（交代型，或当场答的时候要动手转成了任务）。 */
  kind: 'answer' | 'task'
}

export interface ImPositionAskDeps {
  positions: Pick<PositionsAssembly, 'open' | 'work' | 'instance' | 'positionOf' | 'mine'>
  /** 分配 → 职责与持有人（只认本人的分配）。 */
  assignment(id: string): { role_id: string; person_id: string } | undefined
  /** 工作台地址（深链的根）。 */
  base: string
}

/** 聊天里一句话最多多少字（IM 里没人读长文）。 */
export const IM_ANSWER_MAX = 600
/** 表格最多列几行进聊天。 */
export const IM_TABLE_ROWS = 5

const codeError = (code: string, message: string): Error =>
  Object.assign(new Error(message), { code })

const clip = (s: string, n: number): string => {
  const chars = Array.from(s.replace(/\s+/g, ' ').trim())
  return chars.length <= n ? chars.join('') : `${chars.slice(0, n - 1).join('')}…`
}

const url = (base: string, path: string): string => `${base.replace(/\/$/, '')}${path}`

/**
 * 这个岗位今天的一句摘要（卡 / 待办 / 进行中 / 卡住了 / 最近记录）。纯函数，测试直接喂。
 */
export function positionBriefText(input: {
  position_name: string
  pending_cards: number
  work: Pick<PositionWorkView, 'counts' | 'items'>
}): string {
  const { counts } = input.work
  const parts: string[] = []
  if (input.pending_cards > 0) parts.push(`${input.pending_cards} 张卡等你定`)
  if (counts.todos_today > 0)
    parts.push(
      `${counts.todos_today} 个待办${(counts.todos_overdue ?? 0) > 0 ? `（${counts.todos_overdue} 个已过期）` : ''}`,
    )
  // 「在做」只数 AI 在办的事项（待办自己就在上面那个数里，不重复算）
  const doing = input.work.items.filter((i) => i.kind === 'matter' && i.group === 'doing').length
  if (doing > 0) parts.push(`${doing} 件在做`)
  if ((counts.stuck ?? 0) > 0) parts.push(`${counts.stuck} 件卡住了`)
  const head =
    parts.length === 0
      ? `「${input.position_name}」今天没有要你处理的。`
      : `「${input.position_name}」今天：${parts.join('，')}。`
  // 最近一条记录：最近更新、带一句进展的那件
  const recent = [...input.work.items]
    .filter((i) => i.progress !== undefined && i.progress.trim() !== '')
    .sort((a, b) => b.updated_at.localeCompare(a.updated_at))[0]
  const tail =
    recent === undefined
      ? ''
      : `\n最近：「${clip(recent.title, 30)}」${clip(recent.progress ?? '', 60)}`
  return `${head}${tail}`
}

/** 当场回答（一句话 + 组件）压成聊天里的几行字。 */
export function quickAnswerForIm(
  answer: Pick<PositionAnswer, 'lead' | 'text' | 'components'>,
): string {
  const lines: string[] = []
  const lead = answer.lead.trim() !== '' ? answer.lead : answer.text
  if (lead.trim() !== '') lines.push(lead.trim())
  for (const c of answer.components as AnswerComponent[]) {
    if (c.kind === 'metric')
      lines.push(c.items.map((m) => `${m.label} ${m.value}${m.unit ?? ''}`).join(' · '))
    if (c.kind === 'table') {
      for (const row of c.rows.slice(0, IM_TABLE_ROWS))
        lines.push(`· ${row.map((cell) => (cell === null ? '—' : String(cell))).join('，')}`)
      const total = c.total ?? c.rows.length
      if (total > IM_TABLE_ROWS) lines.push(`（共 ${total} 行，全部在工作台看）`)
    }
  }
  // 保留换行，只按总字数截
  const all = Array.from(lines.join('\n').trim())
  return all.length <= IM_ANSWER_MAX ? all.join('') : `${all.slice(0, IM_ANSWER_MAX - 1).join('')}…`
}

/**
 * 这条分配没安放、职责又挂在好几个岗位里（`positionOf` 说不准）：在本人的岗位里找持有这条分配的那几个，
 * 问题里带了岗位名的优先，否则取第一个（与左栏的顺序一样）。
 */
async function heldPositionOf(
  deps: ImPositionAskDeps,
  input: { viewer: string; question: string; assignment_id: string },
): Promise<string | undefined> {
  const held = (await deps.positions.mine(input.viewer)).filter((p) =>
    p.roles.some((r) => r.my_assignment_id === input.assignment_id),
  )
  const q = input.question.toLowerCase().replace(/\s+/g, '')
  const named = held.find((p) =>
    [p.name.zh, p.name.en].some(
      (n) => n !== undefined && n.trim() !== '' && q.includes(n.toLowerCase().replace(/\s+/g, '')),
    ),
  )
  return (named ?? held[0])?.position_id
}

/**
 * 问岗位 Agent（只读）或在岗位建任务。抛出来的错误带 `code`（调用方按它记原因码、回一句人话）。
 */
export async function askPositionAgent(
  deps: ImPositionAskDeps,
  input: { viewer: string; question: string; assignment_id: string; mode: 'ask' | 'task' },
): Promise<ImPositionReply> {
  const a = deps.assignment(input.assignment_id)
  if (a === undefined || a.person_id !== input.viewer)
    throw codeError('not_found', '这条分配不是提问人的')
  const position_id =
    deps.positions.positionOf(a.role_id, input.assignment_id).position_id ??
    (await heldPositionOf(deps, input))
  if (position_id === undefined) throw codeError('not_found', '这条职责不在任何岗位里')
  const instance = await deps.positions.instance(position_id, input.viewer)
  const name = instance.name.zh
  const positionLink = url(deps.base, `/positions/${encodeURIComponent(position_id)}`)
  const split = splitTaskText(input.question)
  const opening = {
    position_id,
    person_id: input.viewer,
    title: split.title,
    ...(split.summary === undefined ? {} : { summary: split.summary }),
    // 点名 / 挑中的就是这条职责：不再跑岗位内路由（与快捷提示同一把尺子，open 里照样核本人名下）
    role_id: a.role_id,
  }

  if (input.mode === 'task') {
    // WP291 的任务路径：建任务、起运行，不等它跑完（要出卡也是在工作台定）
    const out = await deps.positions.open({ ...opening, mode: 'task', detach: true })
    return {
      kind: 'task',
      answer: `已记成「${name}」的任务，在工作台确认。`,
      link: url(deps.base, `/matters/${encodeURIComponent(out.matter.id)}`),
    }
  }

  if (isPositionStatusQuestion(input.question)) {
    const work = await deps.positions.work(position_id, input.viewer)
    return {
      kind: 'answer',
      answer: positionBriefText({
        position_name: name,
        pending_cards: instance.pending_cards,
        work,
      }),
      link: positionLink,
    }
  }

  const out = await deps.positions.open({ ...opening, mode: 'quick' })
  if (out.mode === 'task')
    return {
      kind: 'task',
      answer: `这件事要动手，已记成「${name}」的任务，在工作台确认。`,
      link: url(deps.base, `/matters/${encodeURIComponent(out.matter.id)}`),
    }
  const answer = out.answer
  if (answer === undefined || answer.outcome !== 'answered')
    throw codeError(
      answer?.outcome === 'stopped' ? 'cancelled' : 'agent_error',
      '岗位当场问答没答成',
    )
  const text = quickAnswerForIm(answer)
  if (text === '') throw codeError('agent_error', '岗位当场问答没有回答')
  return { kind: 'answer', answer: text, link: positionLink }
}
