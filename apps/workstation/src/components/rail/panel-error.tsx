/**
 * WP71：第三栏里一条请求没成的时候，**说清楚是哪一种没成**。
 *
 * 这个件存在的理由是一个真账号上打出来的洞（见 docs/35 WP71 那条）：
 * 职责模板里**没有 `skill` 与 `policy` 这两个域**（只有 `common.owner` 有），
 * 而当前分配一旦切到某条职责，`GET /v1/memory`、`GET /v1/skills`、
 * `GET /v1/roles/:id` 三条就一起 403。
 *
 * 界面这一侧不去绕过它——换一条有权限的分配来问，正是 31 §3.1 与 54 §2 禁的
 * "借岗位扩权"。能做的是**把那句话说明白**：缺的是哪个域的哪个操作、
 * 这不是"坏了"而是"这条职责的分配上没有这一项"。真正的修法是制度层的选择
 * （给职责模板加这两条 read，或把这三条路由的 authz 降成"本人持有这一层"），
 * 那是 05 / 14 的事，不由界面定。
 */
import type { ReactNode } from 'react'
import { ApiClientError } from '@/lib/api'
import { useApp } from '@/lib/app-context'
import { apiErrorText } from '@/lib/error-text'

/** 403 的 `details` 里带着缺的那一条（网关放进去的）。 */
function missingScope(err: unknown): string | undefined {
  if (!(err instanceof ApiClientError) || err.status !== 403) return undefined
  const d = err.details as { domain?: unknown; op?: unknown } | undefined
  const domain = typeof d?.domain === 'string' ? d.domain : undefined
  const op = typeof d?.op === 'string' ? d.op : undefined
  return domain === undefined || op === undefined ? undefined : `${domain}.${op}`
}

export function PanelError({ error }: { error: unknown }): ReactNode {
  const { t } = useApp()
  const scope = missingScope(error)
  if (scope !== undefined)
    return (
      <p className="text-muted-foreground" data-testid="rail-no-permission">
        {t('rail.no_permission', { scope })}
      </p>
    )
  return (
    <p className="text-muted-foreground" data-testid="rail-error">
      {/* WP139：501 / 429 / 连不上……各说各的，不把网关原文端上来 */}
      {apiErrorText(error, t)}
    </p>
  )
}
