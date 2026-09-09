/**
 * 随主体删除（21 §4）的会议侧收口：一次调用把两边都清干净——
 * 存储里的与会者 / 转写 / 产出，和受控原始材料区里的字节。
 *
 * 密钥体系不在这里：`packages/data` 的主体密钥环是加密与「销毁即不可读」的唯一出处，
 * 本包不复制一套（35 §2），只调它给的 `RawCipher` 端口。
 *
 * 两个粒度：
 * - {@link eraseParticipant}：删一个人。他的转写行与产出没了，录音还在（还有别人在里面）。
 * - {@link eraseMeeting}：删整场会。**先销毁这场会的密钥**（这一刻起备份里的密文也读不出来），
 *   再删行——两件事都做，才叫删干净。
 */
import type { MeetingEraseResult, MeetingStore, WorkspaceId } from '@agentsws/contracts'
import type { MeetingEraseSubjectResult, MeetingRawStore } from './raw-store.js'

/** 会议档的主体标识：一场会一把密钥（见 `raw-store.ts` 的说明）。 */
export function meetingSubjectRef(meeting_id: string): string {
  return `meeting:${meeting_id}`
}

/** 删整场会议的原始材料：销毁密钥 + 删行。 */
export async function eraseMeeting(
  raw: MeetingRawStore,
  meeting_id: string,
): Promise<MeetingEraseSubjectResult> {
  return await raw.eraseSubject(meetingSubjectRef(meeting_id))
}

export interface EraseParticipantInput {
  workspace_id: WorkspaceId
  person_id?: string
  email?: string
  name?: string
}

export async function eraseParticipant(
  store: MeetingStore,
  raw: MeetingRawStore,
  input: EraseParticipantInput,
): Promise<MeetingEraseResult> {
  const result = await store.eraseParticipant(input)
  if (result.raw_refs.length > 0) await raw.erase(...result.raw_refs)
  return result
}
