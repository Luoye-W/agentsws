/**
 * 会议纪要导出（37 §4.2 免费默认层的最后一项）。
 *
 * 纪要是**给人看的文档**，不是可执行的东西：可执行的部分（待办）只以认领卡的形式
 * 到对应的人手里（06 §2.6「不做所有人都收到全部纪要」）。所以纪要里的待办一栏
 * 明确标着言语状态与"待认领"，不写成"某某的任务"。
 */
import type { Meeting, MeetingOutputs, MeetingRecord } from '@agentsws/contracts'

const SOURCE_ZH: Readonly<Record<MeetingRecord['source'], string>> = {
  online_meeting: '线上会议导出',
  in_app_recording: '一键录音',
  device: '录音设备',
  third_party: '第三方工具导出',
  handed_over: '别人交过来的记录',
  manual_notes: '手写笔记',
}

const STATE_ZH: Readonly<Record<string, string>> = {
  suggested: '建议',
  confirmed: '本人已认',
  assigned: '会上指派',
}

const SENSITIVITY_ZH: Readonly<Record<string, string>> = {
  public: '公开',
  internal: '内部',
  confidential: '机密',
  restricted: '受限',
}

function participantLine(meeting: Meeting): string {
  if (meeting.participants.length === 0) return '（没有登记与会者）'
  return meeting.participants
    .map((p) => {
      const name = p.name ?? p.email ?? p.person_id ?? '未具名'
      return p.external === true ? `${name}（外部）` : name
    })
    .join('、')
}

function locationLine(meeting: Meeting): string | undefined {
  if (meeting.location === undefined) return undefined
  return typeof meeting.location === 'string' ? meeting.location : meeting.location.online
}

export interface MinutesInput {
  meeting: Meeting
  records: readonly MeetingRecord[]
  outputs: readonly MeetingOutputs[]
}

/** 会议 → markdown 纪要。纯函数：同样的输入永远同样的字节（可以进快照测试）。 */
export function renderMinutes(input: MinutesInput): string {
  const { meeting } = input
  const lines: string[] = []
  lines.push(`# ${meeting.title}`, '')
  lines.push(`- 时间：${meeting.start} — ${meeting.end}`)
  const where = locationLine(meeting)
  if (where !== undefined) lines.push(`- 地点：${where}`)
  lines.push(`- 与会：${participantLine(meeting)}`)
  lines.push(`- 敏感级：${SENSITIVITY_ZH[meeting.sensitivity] ?? meeting.sensitivity}`)
  if (meeting.agenda !== undefined && meeting.agenda.trim() !== '')
    lines.push(`- 议程：${meeting.agenda}`)
  lines.push('')

  lines.push('## 记录来源', '')
  if (input.records.length === 0) lines.push('（还没有任何记录）', '')
  for (const r of input.records) {
    const bits = [SOURCE_ZH[r.source] ?? r.source, r.status]
    if (r.media !== undefined) bits.push(r.media.kind)
    if (r.consent.notice_given) bits.push('已告知录音')
    lines.push(`- ${bits.join(' · ')}`)
  }
  if (input.records.length > 0) lines.push('')

  const decisions = input.outputs.flatMap((o) => o.decisions)
  lines.push('## 决定', '')
  if (decisions.length === 0) lines.push('（这次会没有记录到明确的决定）', '')
  for (const d of decisions) lines.push(`- ${d.text}　（原话：「${d.provenance.quote}」）`)
  if (decisions.length > 0) lines.push('')

  const todos = input.outputs.flatMap((o) => o.todos)
  lines.push('## 待办提案（待认领）', '')
  if (todos.length === 0) lines.push('（没有抽到待办）', '')
  for (const t of todos) {
    const who = t.assignee_hint === undefined ? '' : `　→ ${t.assignee_hint}`
    const due = t.due === undefined ? '' : `　截止 ${t.due.slice(0, 10)}`
    lines.push(`- [${STATE_ZH[t.speech_state] ?? t.speech_state}] ${t.text}${who}${due}`)
  }
  if (todos.length > 0) lines.push('', '> 认领卡发到了对应的人手上；**本人确认前不形成责任**。', '')

  const boundaries = input.outputs.flatMap((o) => o.boundary_answers)
  if (boundaries.length > 0) {
    lines.push('## 会上定的口径（待确认）', '')
    for (const b of boundaries) lines.push(`- ${b.question}　答：${b.answer}`)
    lines.push('')
  }

  const knowledge = input.outputs.flatMap((o) => o.knowledge)
  if (knowledge.length > 0) {
    lines.push('## 可能要进知识库的（待确认）', '')
    for (const k of knowledge) lines.push(`- ${k.statement}`)
    lines.push('')
  }

  const next = input.outputs.map((o) => o.next_meeting).find((n) => n !== undefined)
  if (next !== undefined) {
    lines.push('## 下次会议', '')
    lines.push(`- ${next.note ?? next.title ?? next.start ?? ''}`.trimEnd())
    lines.push('')
  }

  return `${lines
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trimEnd()}\n`
}
