/**
 * 连接器状态（08 §5 安装器策略的界面一侧；WP210 按 Luoye 09-30 缩成一行）。
 *
 * 平时就一行：「✓ 连接器就绪」+ 一个问号，网络 / 代理（fake-IP）/ 信任名单 / 连接器地址这些
 * 细节都在问号里——它们以前铺成一整块，名单一长还会溢出框外。
 *
 * **只有要用户动手时才多出一条提示**，而且不溢出：
 * - `absent`（没装连接器）→ 一句怎么办 + 问号；
 * - `unhardened`（装了但没开鉴权 / 加密，**不给连**）→ 红的，原因列表只露前两条，其余点开看；
 *   原因码原样给——用户不一定看得懂 `encryption_disabled`，但他要把这一行发给帮他装机的人；
 * - 秘密库密钥缺了 → 一句（邮箱密码暂时存不了）。
 *
 * fake-IP 不算「要动手」：连接器已经自己改用公共 DNS 了，所以它只进问号。
 */

import { AlertTriangle, CheckCircle2, FlaskConical, PackageOpen } from 'lucide-react'
import { useState } from 'react'
import { Button } from '@/components/ui/button'
import { Hint } from '@/components/ui/hint'
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
  ready: 'text-emerald-700 dark:text-emerald-400',
  absent: 'text-muted-foreground',
  unhardened: 'text-destructive',
  stand_in: 'text-amber-700 dark:text-amber-400',
} as const

/** 原因列表先露几条（其余折起来，免得把框撑破）。 */
const REASONS_SHOWN = 2

type Translate = (key: string, vars?: Record<string, string>) => string

/** 问号里的那几句：状态说明、连接器地址、出站网络（fake-IP / 信任名单）。 */
function detailOf(status: RuntimeStatusView, t: Translate): string {
  const parts = [t(`connections.runtime.${status.state}.detail`)]
  if (status.base_url !== undefined)
    parts.push(t('connections.runtime.at', { url: status.base_url }))
  const egress = status.egress
  if (egress?.fake_ip_detected === true) {
    const why = egress.detail === undefined ? '' : `（${egress.detail}）`
    parts.push(
      `${t('connections.egress.fake_ip')}：${t('connections.egress.fake_ip.detail')}${why}`,
    )
  }
  if (egress !== undefined && egress.trusted_hosts.length > 0) {
    parts.push(t('connections.egress.trusted', { hosts: egress.trusted_hosts.join('、') }))
  }
  return parts.join(' ')
}

export function RuntimeBar({ status }: { status: RuntimeStatusView }): React.ReactNode {
  const { t } = useApp()
  const [open, setOpen] = useState(false)
  const Icon = ICONS[status.state]
  const reasons = status.reasons.map((r) => {
    // 原因码后面接上那一条检查的 detail（"匿名访问 /v1/health 得到 HTTP 200"）
    const detail = status.checks.find(
      (c) => !c.ok && c.detail.length > 0 && r.startsWith(c.name),
    )?.detail
    return { code: r, detail }
  })
  const shown = open ? reasons : reasons.slice(0, REASONS_SHOWN)
  const needsAction = status.state === 'absent' || status.state === 'unhardened'

  return (
    <section
      data-testid="runtime-bar"
      data-state={status.state}
      className="flex min-w-0 flex-col gap-1.5 text-sm"
    >
      <p className={cn('flex items-center gap-1.5 font-medium', TONE[status.state])}>
        <Icon className="size-4 shrink-0" aria-hidden />
        <span data-slot="status">{t(`connections.runtime.${status.state}`)}</span>
        <Hint text={detailOf(status, t)} testId="runtime-detail" />
      </p>
      {needsAction ? (
        <div
          data-testid="runtime-action"
          className={cn(
            'flex min-w-0 flex-col gap-1 overflow-hidden rounded-md border px-2.5 py-1.5 text-xs',
            status.state === 'unhardened'
              ? 'border-destructive/50 bg-destructive/10 text-destructive'
              : 'border-border bg-muted/40 text-muted-foreground',
          )}
        >
          <p className="flex items-center gap-1" data-slot="status">
            {t(`connections.runtime.${status.state}.action`)}
            {status.state === 'absent' ? (
              <Hint text={t('connections.runtime.absent.hint')} />
            ) : null}
          </p>
          {reasons.length === 0 ? null : (
            <ul className="flex min-w-0 flex-col gap-0.5" data-testid="runtime-reasons">
              {shown.map((r) => (
                <li key={r.code} className="break-words" data-slot="status">
                  · <code className="break-all">{r.code}</code>
                  {r.detail === undefined ? null : <span className="ml-1">— {r.detail}</span>}
                </li>
              ))}
            </ul>
          )}
          {reasons.length > REASONS_SHOWN ? (
            <Button
              size="xs"
              variant="ghost"
              className="self-start"
              data-testid="runtime-reasons-toggle"
              aria-expanded={open}
              onClick={() => {
                setOpen((v) => !v)
              }}
            >
              {open
                ? t('connections.runtime.less')
                : t('connections.runtime.more', { n: String(reasons.length - REASONS_SHOWN) })}
            </Button>
          ) : null}
        </div>
      ) : null}
      {status.secrets_vault.available ? null : (
        <p
          className="flex items-center gap-1 text-xs text-amber-700 dark:text-amber-400"
          data-testid="vault-missing"
          data-slot="status"
        >
          {t('connections.vault.missing')}
          {status.secrets_vault.reason === undefined ? null : (
            <Hint text={status.secrets_vault.reason} />
          )}
        </p>
      )}
    </section>
  )
}
