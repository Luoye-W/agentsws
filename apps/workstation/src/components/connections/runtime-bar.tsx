/**
 * 连接器状态条（08 §5 安装器策略的界面一侧）。
 *
 * 三种状态三种颜色，一眼看懂：
 * - `absent` → 灰：还没装，给一条"怎么装"的说明；
 * - `unhardened` → **红**：装了但没开鉴权 / 没开加密，凭据可能明文存放，**不给连**；
 * - `ready` → 绿；`stand_in` → 黄（开发替身，连出来的是假的）。
 *
 * 加固失败的原因原样列出来——用户不一定看得懂 `encryption_disabled`，
 * 但他要把这一行发给帮他装机的人。
 */

import { AlertTriangle, CheckCircle2, FlaskConical, PackageOpen } from 'lucide-react'
import type { RuntimeStatusView } from '@/lib/api'
import { useApp } from '@/lib/app-context'
import { cn } from '@/lib/utils'

const ICONS = {
  ready: CheckCircle2,
  absent: PackageOpen,
  unhardened: AlertTriangle,
  stand_in: FlaskConical,
} as const

const TONE = {
  ready: 'border-emerald-500/40 bg-emerald-500/5 text-emerald-700 dark:text-emerald-400',
  absent: 'border-border bg-muted/40 text-muted-foreground',
  unhardened: 'border-destructive/50 bg-destructive/10 text-destructive',
  stand_in: 'border-amber-500/40 bg-amber-500/5 text-amber-700 dark:text-amber-400',
} as const

export function RuntimeBar({ status }: { status: RuntimeStatusView }): React.ReactNode {
  const { t } = useApp()
  const Icon = ICONS[status.state]
  return (
    <section
      data-testid="runtime-bar"
      data-state={status.state}
      className={cn(
        'flex flex-col gap-1.5 rounded-lg border px-3 py-2.5 text-sm',
        TONE[status.state],
      )}
    >
      <div className="flex items-center gap-2 font-medium">
        <Icon className="size-4" aria-hidden />
        <span>{t(`connections.runtime.${status.state}`)}</span>
        {status.base_url === undefined ? null : (
          <code className="text-xs font-normal opacity-70">{status.base_url}</code>
        )}
      </div>
      <p className="text-xs opacity-90">{t(`connections.runtime.${status.state}.detail`)}</p>
      {status.reasons.length === 0 ? null : (
        <ul
          className="mt-0.5 flex flex-col gap-0.5 text-xs opacity-90"
          data-testid="runtime-reasons"
        >
          {status.reasons.map((r) => {
            // 原因码后面接上那一条检查的 detail（"匿名访问 /v1/health 得到 HTTP 200"）
            const detail = status.checks.find(
              (c) => !c.ok && c.detail.length > 0 && r.startsWith(c.name),
            )?.detail
            return (
              <li key={r}>
                · <code>{r}</code>
                {detail === undefined ? null : <span className="ml-1">— {detail}</span>}
              </li>
            )
          })}
        </ul>
      )}
      {status.secrets_vault.available ? null : (
        <p className="text-xs opacity-90" data-testid="vault-missing">
          {t('connections.vault.missing')}
          {status.secrets_vault.reason === undefined ? null : (
            <span className="ml-1 opacity-70">（{status.secrets_vault.reason}）</span>
          )}
        </p>
      )}
    </section>
  )
}
