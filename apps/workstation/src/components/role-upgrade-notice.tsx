/**
 * WP462（beta.5 真机）：职责升了大版本、自动接不上的那几条分配——主区顶上**就地**一张确认卡，
 * 点「确认」就接着用（配置在对话流里完成，决策 690）。
 *
 * 以前一条分配对不上，`/v1/positions` 整个 409，首页只剩一行英文、左栏岗位全空。现在服务端只把那一条
 * 标出来（`needs_reconfirm`），别的岗位、职责照常；这里把标出来的那几条各出一行。
 * 只收窄权限 / 登记过的拆分在服务启动时已经自动接上，走到这里的只有放宽权限或没登记的那种。
 */
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { RefreshCw } from 'lucide-react'
import type { ReactNode } from 'react'
import { type PositionSummary, reconfirmAssignment } from '@/lib/api'
import { useApp } from '@/lib/app-context'

export function RoleUpgradeNotice({ positions }: { positions: PositionSummary[] }): ReactNode {
  const stale = positions.filter((p) => p.needs_reconfirm !== undefined)
  if (stale.length === 0) return null
  return (
    <div className="mb-4 flex flex-col gap-2" data-testid="role-upgrade-notices">
      {stale.map((p) => (
        <RoleUpgradeRow key={p.position_id} position={p} />
      ))}
    </div>
  )
}

function RoleUpgradeRow({ position }: { position: PositionSummary }): ReactNode {
  const { t } = useApp()
  const client = useQueryClient()
  const confirm = useMutation({
    mutationFn: () => reconfirmAssignment(position.position_id),
    onSuccess: async () => {
      await Promise.all([
        client.invalidateQueries({ queryKey: ['positions'] }),
        client.invalidateQueries({ queryKey: ['home'] }),
        client.invalidateQueries({ queryKey: ['session'] }),
      ])
    },
  })
  const role = position.needs_reconfirm?.role_name ?? position.role_name
  return (
    <div
      role="status"
      data-testid="role-upgrade-notice"
      data-role={position.role_id}
      className="flex items-center gap-2 rounded-lg bg-ws-card px-3 py-2 text-sm text-ws-ink shadow-[inset_0_0_0_1px_var(--ws-line)]"
    >
      <RefreshCw className="size-4 shrink-0 text-ws-muted-fg" aria-hidden />
      <span className="min-w-0 flex-1">
        {confirm.isError ? t('role.upgrade.failed') : t('role.upgrade.notice', { role })}
      </span>
      <button
        type="button"
        data-testid="role-upgrade-confirm"
        disabled={confirm.isPending}
        className="shrink-0 rounded-md bg-ws-ink px-2.5 py-1 text-xs font-medium text-ws-paper hover:opacity-90 disabled:opacity-50"
        onClick={() => {
          confirm.mutate()
        }}
      >
        {t('role.upgrade.confirm')}
      </button>
    </div>
  )
}
