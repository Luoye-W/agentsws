/**
 * WP277（docs/95 §3.4–§3.6，决策 239 / 240）：③ 公司模式要的两条接口——开公司模式向导 /
 * 回到同事互联那一屏要的东西（`GET /v1/orgs/:id/mode`）、真开 / 真降（`PUT` 同一条）。
 */
import { api, type OrganizationView } from './api'

export interface CompanyModeView {
  mode: 'solo' | 'peers' | 'company'
  /** 只有发起人、而且现在还不是 ③。 */
  can_open: boolean
  /** 只有老板、而且现在是 ③、没有离职交接卡在等。 */
  can_close: boolean
  close_blocked?: string
  legal_name: string
  owner_id: string
  people: { person_id: string; name: string; role: 'owner' | 'admin' | 'member' }[]
}

export interface SetCompanyModeInput {
  mode: 'company' | 'peers'
  legal_name?: string
  boss?: string
  admins?: string[]
}

const enc = encodeURIComponent

export const getCompanyMode = (org_id: string, assignment?: string): Promise<CompanyModeView> =>
  api<CompanyModeView>(`/v1/orgs/${enc(org_id)}/mode`, {
    ...(assignment === undefined ? {} : { assignment }),
  })

export const setCompanyMode = (
  org_id: string,
  input: SetCompanyModeInput,
  assignment?: string,
): Promise<OrganizationView> =>
  api<OrganizationView>(`/v1/orgs/${enc(org_id)}/mode`, {
    method: 'PUT',
    body: input,
    ...(assignment === undefined ? {} : { assignment }),
  })

/** 点掉「X 把这里改回了同事互联」那一行（记在组织上）。 */
export const markModeSeen = (org_id: string): Promise<{ ok: true }> =>
  api<{ ok: true }>(`/v1/orgs/${enc(org_id)}/mode/seen`, { method: 'POST' })
