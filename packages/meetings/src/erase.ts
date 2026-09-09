/**
 * 随主体删除（21 §4）的会议侧收口：一次调用把两边都清干净——
 * 存储里的与会者 / 转写 / 产出，和受控原始材料区里的字节。
 *
 * 密钥销毁不在这里：`packages/data` 的主体密钥环是加密与"销毁即不可读"的唯一出处，
 * 本包不复制一套密钥体系（35 §2）。宿主销毁密钥之后再调这个，两步合起来才是完整的删除。
 */
import type { MeetingEraseResult, MeetingStore, WorkspaceId } from '@agentsws/contracts'
import type { MeetingRawStore } from './raw-store.js'

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
