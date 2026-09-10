/**
 * 秘书自己那一小块状态，两档存储（内存 / SQLite）接口逐字一致，同一份用例各跑一遍。
 *
 * 秘书**拥有**的东西只有三样，别处没地方放：
 * 1. 本人可改的那半份 profile（擅长、联系偏好、可用时段、公开级别）；
 * 2. "谁问过我"清单（41 §1.2「本人能看到谁问了什么、秘书答了什么」）；
 * 3. "约时间"卡背后的记录（对方点头之前它还不是一场会）。
 *
 * 岗位、范围、进行中事项、日历——一个都不存：它们各有真源，存一份就会对不上。
 *
 * 21 敏感级：这三样都是**个人数据**（`owner = person_id`），默认 `confidential`。
 * 管理员对它们只有迁移 / 归档 / 销毁，没有读（40 §1.2 第二条规则）——所以这里的每个读方法
 * 都要 `person_id`，没有"列出全工作区所有人的问答"这种方法。
 */
import type { PersonId, WorkspaceId } from '@agentsws/contracts'
import type { AskedRecord, MeetProposal, ProfileRecord } from './types.js'

export interface AskedFilter {
  limit?: number
  /** 只看某个人问过的 */
  asked_by?: PersonId
}

export interface MeetFilter {
  /** 我发出去的 */
  from?: PersonId
  /** 等我点头的 */
  to?: PersonId
  state?: MeetProposal['state'][]
  limit?: number
}

export interface SecretaryStore {
  getProfile(workspace_id: WorkspaceId, person_id: PersonId): ProfileRecord | undefined
  putProfile(record: ProfileRecord): void
  /** 只给装配层用（离职 / 销毁时要遍历）；不经网关端出去。 */
  listProfiles(workspace_id: WorkspaceId): ProfileRecord[]

  appendAsked(record: AskedRecord): void
  /** 「谁问过我」——`person_id` 是**被问的人**，也就是这条记录的主人。 */
  listAsked(workspace_id: WorkspaceId, person_id: PersonId, filter?: AskedFilter): AskedRecord[]

  putMeet(proposal: MeetProposal): void
  getMeet(id: string): MeetProposal | undefined
  listMeets(workspace_id: WorkspaceId, filter?: MeetFilter): MeetProposal[]

  /** 21 §4 随主体删除：这个人的 profile、问答记录、约时间卡一起走。 */
  erasePerson(workspace_id: WorkspaceId, person_id: PersonId): number

  close?(): void
}

const key = (workspace_id: string, person_id: string): string => `${workspace_id} ${person_id}`

const byAtDesc = (a: { at: string; id: string }, b: { at: string; id: string }): number =>
  Date.parse(b.at) - Date.parse(a.at) || (a.id < b.id ? 1 : -1)

export class MemorySecretaryStore implements SecretaryStore {
  readonly #profiles = new Map<string, ProfileRecord>()
  readonly #asked: AskedRecord[] = []
  readonly #meets = new Map<string, MeetProposal>()

  getProfile(workspace_id: WorkspaceId, person_id: PersonId): ProfileRecord | undefined {
    const found = this.#profiles.get(key(workspace_id, person_id))
    return found === undefined ? undefined : structuredClone(found)
  }

  putProfile(record: ProfileRecord): void {
    this.#profiles.set(key(record.workspace_id, record.person_id), structuredClone(record))
  }

  listProfiles(workspace_id: WorkspaceId): ProfileRecord[] {
    return [...this.#profiles.values()]
      .filter((p) => p.workspace_id === workspace_id)
      .map((p) => structuredClone(p))
      .sort((a, b) => (a.person_id < b.person_id ? -1 : 1))
  }

  appendAsked(record: AskedRecord): void {
    this.#asked.push(structuredClone(record))
  }

  listAsked(
    workspace_id: WorkspaceId,
    person_id: PersonId,
    filter: AskedFilter = {},
  ): AskedRecord[] {
    return this.#asked
      .filter(
        (r) =>
          r.workspace_id === workspace_id &&
          r.person_id === person_id &&
          (filter.asked_by === undefined || r.asked_by === filter.asked_by),
      )
      .map((r) => structuredClone(r))
      .sort(byAtDesc)
      .slice(0, filter.limit ?? 50)
  }

  putMeet(proposal: MeetProposal): void {
    this.#meets.set(proposal.id, structuredClone(proposal))
  }

  getMeet(id: string): MeetProposal | undefined {
    const found = this.#meets.get(id)
    return found === undefined ? undefined : structuredClone(found)
  }

  listMeets(workspace_id: WorkspaceId, filter: MeetFilter = {}): MeetProposal[] {
    return [...this.#meets.values()]
      .filter(
        (m) =>
          m.workspace_id === workspace_id &&
          (filter.from === undefined || m.from === filter.from) &&
          (filter.to === undefined || m.to === filter.to) &&
          (filter.state === undefined || filter.state.includes(m.state)),
      )
      .map((m) => structuredClone(m))
      .sort((a, b) => Date.parse(b.created_at) - Date.parse(a.created_at) || (a.id < b.id ? 1 : -1))
      .slice(0, filter.limit ?? 100)
  }

  erasePerson(workspace_id: WorkspaceId, person_id: PersonId): number {
    let removed = 0
    if (this.#profiles.delete(key(workspace_id, person_id))) removed += 1
    for (let i = this.#asked.length - 1; i >= 0; i -= 1) {
      const r = this.#asked[i]
      if (r === undefined) continue
      if (r.workspace_id !== workspace_id) continue
      if (r.person_id !== person_id && r.asked_by !== person_id) continue
      this.#asked.splice(i, 1)
      removed += 1
    }
    for (const [id, m] of this.#meets) {
      if (m.workspace_id !== workspace_id) continue
      if (m.from !== person_id && m.to !== person_id) continue
      this.#meets.delete(id)
      removed += 1
    }
    return removed
  }
}
