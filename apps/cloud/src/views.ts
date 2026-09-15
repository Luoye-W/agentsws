/**
 * 对外形状。**这里是"令牌哈希不出门"的唯一守门处**：库里的 `WorkspaceLink`
 * 带 `token_sha256`，端出去的 `WorkspaceLinkView` 没有这一格。
 *
 * 哈希不是秘密，但也不是任何界面需要的东西：端出去只会让人误以为"拿到它能做点什么"，
 * 并且离线撞库确实能从一个已知前缀的令牌空间里验证猜测（21 §5 的保守解释）。
 */

import type { CloudScope, Iso8601, WorkspaceLink } from '@agentsws/contracts'

export interface WorkspaceLinkView {
  id: string
  workspace_id: string
  cloud_org_id: string
  label: string
  scopes: CloudScope[]
  created_at: Iso8601
  expires_at: Iso8601
  revoked_at?: Iso8601
  last_used_at?: Iso8601
  /** 过期或撤销了就是 false；界面据此决定出不出"续期"。 */
  active: boolean
}

export function linkView(link: WorkspaceLink, now: Iso8601): WorkspaceLinkView {
  const expired = Date.parse(now) >= Date.parse(link.expires_at)
  return {
    id: link.id,
    workspace_id: link.workspace_id,
    cloud_org_id: link.cloud_org_id,
    label: link.label,
    scopes: link.scopes,
    created_at: link.created_at,
    expires_at: link.expires_at,
    ...(link.revoked_at === undefined ? {} : { revoked_at: link.revoked_at }),
    ...(link.last_used_at === undefined ? {} : { last_used_at: link.last_used_at }),
    active: link.revoked_at === undefined && !expired,
  }
}
