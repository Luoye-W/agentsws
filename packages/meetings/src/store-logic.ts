/**
 * 两档存储共用的纯逻辑：默认敏感级、筛选、随主体删除的擦除算法。
 * 放这里是为了让内存档与 SQLite 档在同一份一致性套件下逐字节等价。
 */
import type {
  Meeting,
  MeetingFilter,
  MeetingOutputs,
  MeetingParticipant,
  MeetingRecord,
  MeetingTranscript,
  Sensitivity,
} from '@agentsws/contracts'

/** 37 §4 C4：有外部参与者默认 `restricted`，否则 `internal`。 */
export function defaultSensitivity(participants: readonly MeetingParticipant[]): Sensitivity {
  return participants.some((p) => p.external === true) ? 'restricted' : 'internal'
}

export function hasExternalParticipant(meeting: Pick<Meeting, 'participants'>): boolean {
  return meeting.participants.some((p) => p.external === true)
}

const norm = (s: string | undefined): string => (s ?? '').trim().toLowerCase()

/** 与会者匹配：person_id / email / name 任一命中（大小写与空白不敏感）。 */
export function participantMatches(p: MeetingParticipant, needle: string): boolean {
  const n = norm(needle)
  if (n === '') return false
  return norm(p.person_id) === n || norm(p.email) === n || norm(p.name) === n
}

export function matchesFilter(m: Meeting, filter: MeetingFilter): boolean {
  if (m.workspace_id !== filter.workspace_id) return false
  if (filter.participant !== undefined) {
    if (!m.participants.some((p) => participantMatches(p, filter.participant as string)))
      return false
  }
  if (filter.status !== undefined && !filter.status.includes(m.status)) return false
  if (filter.from !== undefined && Date.parse(m.end) < Date.parse(filter.from)) return false
  if (filter.to !== undefined && Date.parse(m.start) > Date.parse(filter.to)) return false
  return true
}

/** 列表顺序：开始时间倒序（最近的会在最上面），同刻按 id 稳定。 */
export function byStartDesc(a: Meeting, b: Meeting): number {
  const d = Date.parse(b.start) - Date.parse(a.start)
  return d !== 0 ? d : a.id.localeCompare(b.id)
}

/* ------------------------------------------------------------------ */
/* 随主体删除（21 §4）                                                   */
/* ------------------------------------------------------------------ */

export interface EraseSubject {
  person_id?: string
  email?: string
  name?: string
}

/** 该主体在会议里可能出现的所有称呼（说话人标签靠它匹配）。 */
export function subjectAliases(
  subject: EraseSubject,
  participants: readonly MeetingParticipant[],
): string[] {
  const aliases = new Set<string>()
  for (const v of [subject.person_id, subject.email, subject.name]) {
    if (v !== undefined && v.trim() !== '') aliases.add(norm(v))
  }
  for (const p of participants) {
    if (!matchesSubject(p, subject)) continue
    for (const v of [p.person_id, p.email, p.name]) {
      if (v !== undefined && v.trim() !== '') aliases.add(norm(v))
    }
  }
  return [...aliases]
}

export function matchesSubject(p: MeetingParticipant, subject: EraseSubject): boolean {
  return [subject.person_id, subject.email, subject.name].some(
    (v) => v !== undefined && participantMatches(p, v),
  )
}

const SPEAKER_PREFIX = /^\s*([^:：]{1,24})\s*[:：]\s*/u

/** 一行文本的说话人前缀（`张三：…`）。 */
export function speakerOfLine(line: string): string | undefined {
  return SPEAKER_PREFIX.exec(line)?.[1]?.trim()
}

/**
 * 抹掉某主体在一份转写里的痕迹：
 * ① 有 `segments` 就按 `speaker` 删段，正文按剩下的段重建；
 * ② 没有 `segments` 就按 `姓名：` 前缀删行。
 * 抹不掉的（别人提到他名字的句子）不动——那是别人的言论，不是他的个人数据。
 */
export function redactTranscript(
  transcript: MeetingTranscript,
  aliases: readonly string[],
): { transcript: MeetingTranscript; changed: boolean } {
  const hit = (name: string | undefined): boolean =>
    name !== undefined && aliases.includes(norm(name))

  if (transcript.segments !== undefined && transcript.segments.length > 0) {
    const kept = transcript.segments.filter((s) => !hit(s.speaker))
    if (kept.length === transcript.segments.length) return { transcript, changed: false }
    const speakers = [...new Set(kept.map((s) => s.speaker).filter((s) => s !== undefined))]
    return {
      transcript: {
        ...transcript,
        segments: kept,
        text: kept
          .map((s) => (s.speaker === undefined ? s.text : `${s.speaker}：${s.text}`))
          .join('\n'),
        ...(speakers.length === 0 ? {} : { speakers: speakers as string[] }),
      },
      changed: true,
    }
  }

  const lines = transcript.text.split(/\r?\n/)
  const kept = lines.filter((l) => !hit(speakerOfLine(l)))
  if (kept.length === lines.length) return { transcript, changed: false }
  return { transcript: { ...transcript, text: kept.join('\n') }, changed: true }
}

/** 产出里凡是出处发言人是该主体的条目，一并摘掉。 */
export function redactOutputs(
  outputs: MeetingOutputs,
  aliases: readonly string[],
): { outputs: MeetingOutputs; removed: number } {
  const hit = (speaker: string | undefined): boolean =>
    speaker !== undefined && aliases.includes(norm(speaker))
  let removed = 0
  const keep = <T extends { provenance: { speaker?: string } }>(rows: T[]): T[] =>
    rows.filter((r) => {
      if (!hit(r.provenance.speaker)) return true
      removed += 1
      return false
    })
  const next: MeetingOutputs = {
    ...outputs,
    decisions: keep(outputs.decisions),
    todos: keep(outputs.todos),
    boundary_answers: keep(outputs.boundary_answers),
    knowledge: keep(outputs.knowledge),
  }
  if (next.next_meeting !== undefined && hit(next.next_meeting.provenance.speaker)) {
    delete next.next_meeting
    removed += 1
  }
  return { outputs: next, removed }
}

/**
 * 一条记录的擦除结果。录的人就是被删主体时，整份原始材料与转写都要走
 * （他的声音本身就是他的个人数据）；否则只删他说过的段。
 */
export function redactRecord(
  record: MeetingRecord,
  subject: EraseSubject,
  aliases: readonly string[],
): { record: MeetingRecord; changed: boolean; raw_ref?: string } {
  const ownRecording =
    subject.person_id !== undefined && record.consent.recorded_by === subject.person_id
  if (ownRecording) {
    const raw_ref = record.media?.raw_ref
    const next: MeetingRecord = { ...record, error: 'subject_erased' }
    delete next.media
    delete next.transcript
    return { record: next, changed: true, ...(raw_ref === undefined ? {} : { raw_ref }) }
  }
  if (record.transcript === undefined) return { record, changed: false }
  const { transcript, changed } = redactTranscript(record.transcript, aliases)
  if (!changed) return { record, changed: false }
  return { record: { ...record, transcript }, changed: true }
}
