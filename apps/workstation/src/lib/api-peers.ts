/**
 * WP276（docs/95 §4，决策 237–243）：② 同事互联要的那几条接口——交给对方、同事名单、退出、
 * 导出自己的副本、交接几天退回。单独一个文件，不再往 `api.ts` 里堆。
 */
import type { Handoff } from '@agentsws/contracts'
import { api } from './api'

export type HandoffKind = 'matter' | 'todo'

/** 一次交接给人看的样子（名字由服务端补，前端不印 id）。 */
export interface HandoffView {
  kind: HandoffKind
  id: string
  title: string
  handoff: Handoff
  from_label: string
  to_label: string
  matter_id?: string
  summary?: string
  due?: string
  progress?: string
  status: string
}

export interface HandoffLists {
  to_me: HandoffView[]
  from_me: HandoffView[]
  /** WP277（决策 241）：③ 里上级派给我、我还没点掉的（直接生效，没有卡）。 */
  dispatched?: HandoffView[]
}

export interface ColleagueView {
  person_id: string
  name: string
  in_progress: number
  load: string
  initiator?: boolean
}

const enc = encodeURIComponent

export const offerHandoff = (
  kind: HandoffKind,
  id: string,
  input: { to: string; note?: string },
): Promise<{ handoff: HandoffView }> =>
  api(`/v1/handoffs/${kind}/${enc(id)}`, { method: 'POST', body: input })

export const acceptHandoff = (
  kind: HandoffKind,
  id: string,
  position_id?: string,
): Promise<{ handoff: HandoffView }> =>
  api(`/v1/handoffs/${kind}/${enc(id)}/accept`, {
    method: 'POST',
    body: position_id === undefined ? {} : { position_id },
  })

export const declineHandoff = (
  kind: HandoffKind,
  id: string,
  reason?: string,
): Promise<{ handoff: HandoffView }> =>
  api(`/v1/handoffs/${kind}/${enc(id)}/decline`, {
    method: 'POST',
    body: reason === undefined || reason === '' ? {} : { reason },
  })

export const withdrawHandoff = (kind: HandoffKind, id: string): Promise<{ handoff: HandoffView }> =>
  api(`/v1/handoffs/${kind}/${enc(id)}/withdraw`, { method: 'POST' })

export const seenHandoff = (kind: HandoffKind, id: string): Promise<{ ok: true }> =>
  api(`/v1/handoffs/${kind}/${enc(id)}/seen`, { method: 'POST' })

export const listHandoffs = (all = false): Promise<HandoffLists> =>
  api<HandoffLists>(`/v1/handoffs${all ? '?all=1' : ''}`)

export const listColleagues = (): Promise<{ colleagues: ColleagueView[] }> =>
  api<{ colleagues: ColleagueView[] }>('/v1/work/colleagues')

/** ② 里自己退出（发起人不行，先把发起人交给同事）。 */
export const leaveWorkspace = (
  workspace_id: string,
): Promise<{ revoked_assignments: number; returned: number }> =>
  api(`/v1/workspaces/${enc(workspace_id)}/leave`, { method: 'POST' })

/** 我参与过的事项（含时间线）与名下的待办——退出前带走一份副本。 */
export const exportMyWork = (): Promise<unknown> => api<unknown>('/v1/work/mine/export')

/** 打开「让同事找到我」（「和同事一起用」那一下，决策 234）。 */
export const turnOnDiscovery = (org_id: string, assignment?: string): Promise<unknown> =>
  api(`/v1/orgs/${enc(org_id)}`, {
    method: 'PATCH',
    body: { discoverable: true },
    ...(assignment === undefined ? {} : { assignment }),
  })

/** ② 每个人这个月的用量（共用一个余额，只显示，不设上限）。 */
export interface PersonUsageView {
  person_id: string
  name: string
  calls: number
  tokens: number
}

export const listPeopleUsage = (): Promise<{ people: PersonUsageView[] }> =>
  api<{ people: PersonUsageView[] }>('/v1/usage/people')
