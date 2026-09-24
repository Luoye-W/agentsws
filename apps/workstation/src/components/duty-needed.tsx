/**
 * WP139：独立页面挑不到身份时的那一格（`useDutyAssignment` 回 `none` / `no_range`）。
 *
 * 挑不到就**不发请求**（发了必 403），改成说清楚两件事：
 * - 缺的是哪条职责（「你名下没有『网站在线客服』这条职责」）；
 * - 去哪加：「公司」里给自己加上，或者重走设置向导勾上；
 *   有这条职责但还没分配店铺 / 品牌的，给「去分配」（跟岗位页那张 NoRangeNotice 同一个去处）。
 */
import { ScanSearch } from 'lucide-react'
import type { ReactNode } from 'react'
import { Link } from 'react-router-dom'
import { Button } from '@/components/ui/button'
import { useApp } from '@/lib/app-context'
import type { DutyNeed } from '@/lib/pick-assignment'

export function DutyNeeded({
  need,
  kind,
  testid = 'duty-needed',
  compact = false,
}: {
  need: DutyNeed
  kind: 'none' | 'no_range'
  testid?: string
  /** 卡片里的一小块（连接页）：一句话 + 一个链接 */
  compact?: boolean
}): ReactNode {
  const { t } = useApp()
  const duty = t(need.duty_key)
  const line = kind === 'none' ? t('need.none', { duty }) : t('need.no_range', { duty })
  if (compact)
    return (
      <p
        role="status"
        data-testid={testid}
        data-kind={kind}
        className="text-[11px] text-muted-foreground"
      >
        {line}{' '}
        <Link
          to="/org?tab=positions"
          className="underline underline-offset-2"
          data-testid={`${testid}-org`}
        >
          {kind === 'none' ? t('need.go_org') : t('need.go_assign')}
        </Link>
      </p>
    )
  return (
    <div
      role="status"
      data-testid={testid}
      data-kind={kind}
      className="flex max-w-xl flex-col gap-3 rounded-[10px] border border-ws-line bg-ws-card p-4 text-sm"
    >
      <p className="flex items-start gap-2 font-medium">
        <ScanSearch aria-hidden className="mt-0.5 size-4 shrink-0 text-ws-muted-fg" />
        {line}
      </p>
      {kind === 'none' ? <p className="text-muted-foreground">{t('need.none.how')}</p> : null}
      <div className="flex flex-wrap gap-2">
        <Button size="sm" variant="outline" asChild>
          <Link to="/org?tab=positions" data-testid={`${testid}-org`}>
            {kind === 'none' ? t('need.go_org') : t('need.go_assign')}
          </Link>
        </Button>
        {kind === 'none' ? (
          <Button size="sm" variant="ghost" asChild>
            <Link to="/onboarding" data-testid={`${testid}-onboarding`}>
              {t('need.go_onboarding')}
            </Link>
          </Button>
        ) : null}
      </div>
    </div>
  )
}
