/**
 * 设置 → 账号与积分里的**积分那一段**（49 M5）。
 *
 * 四块，从上到下：
 * 1. **余额**——两类积分分开显示。为什么分开：充值买的永不过期，送的按周期清零，
 *    合成一个数字会让用户在清零那天觉得钱少了一截却说不清哪儿少的；
 * 2. **即将过期**——有期限的那几笔各列一行，按到期日排；
 * 3. **用量明细**——按能力 / 按工作区 / 按天三个切换；
 * 4. **价目表**——折叠着，想看的时候展开。
 *
 * 两条纪律：
 * - **这一层不算账**。每个数字都是云上那一份的透传，工作台连一次加法都不做。
 * - **看得到多少由令牌说了算**：owner 那把看整个组织，成员那把只看自己那个工作区。
 *   界面不做第二次裁剪——裁两次就会有一次是错的。
 */
import { useQuery } from '@tanstack/react-query'
import { ChevronDown, ChevronRight, Coins, ExternalLink, Wallet } from 'lucide-react'
import { useState } from 'react'
import { Link } from 'react-router-dom'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Hint } from '@/components/ui/hint'
import { Separator } from '@/components/ui/separator'
import { Skeleton } from '@/components/ui/skeleton'
import type { PricingEntry, UsageReportView } from '@/lib/api'
import { getCloudCredits, getCloudPricing, getCloudUsage } from '@/lib/api'
import { useApp } from '@/lib/app-context'

type Group = 'capability' | 'workspace' | 'day'

const GROUPS: Group[] = ['capability', 'workspace', 'day']

/** 充值页在云上，不在这里——付款永远在对方的页面上（13 §4.3 同一条理由）。 */
export const TOPUP_PATH = '/billing/topup'

export function CreditsPanel({ assignment }: { assignment?: string }): React.ReactNode {
  const { t, lang } = useApp()
  const [group, setGroup] = useState<Group>('capability')
  const [pricingOpen, setPricingOpen] = useState(false)

  const credits = useQuery({
    queryKey: ['cloud-credits', assignment],
    queryFn: () => getCloudCredits(assignment),
    retry: false,
  })
  const usage = useQuery({
    queryKey: ['cloud-usage', group, assignment],
    queryFn: () => getCloudUsage(group, assignment),
    enabled: credits.data?.linked === true,
    retry: false,
  })
  const pricing = useQuery({
    queryKey: ['cloud-pricing', assignment],
    queryFn: () => getCloudPricing(assignment),
    retry: false,
  })

  const locale = lang === 'zh' ? 'zh-CN' : 'en-US'
  const num = (n: number): string =>
    n.toLocaleString(locale, { maximumFractionDigits: 2, minimumFractionDigits: 0 })
  /**
   * 单价那一列要更细。
   *
   * 两位小数在余额上刚好（钱），在单价上会把「每千 token 0.0015 积分」显示成 0——
   * 一个写着 0 的价目表是在说谎。所以单价按有效数字留，最多四位小数。
   */
  const price = (n: number): string =>
    n.toLocaleString(locale, { maximumFractionDigits: n < 0.01 ? 4 : 2 })

  if (credits.isPending) return <Skeleton className="h-64 w-full" />

  const linked = credits.data?.linked === true
  const balance = credits.data?.balance

  return (
    <Card data-testid="credits-panel" data-linked={linked}>
      <CardHeader className="pb-2">
        <CardTitle className="flex items-center gap-2 text-sm">
          <Coins className="size-4" aria-hidden />
          {t('credits.title')}
          <Hint text={t('credits.hint')} />
        </CardTitle>
      </CardHeader>
      <CardContent className="flex flex-col gap-4 text-sm">
        {/* 还没关联账号：一句人话 + 一个去处，而不是一堆 0 */}
        {!linked || balance === undefined ? (
          <p className="text-muted-foreground" data-testid="credits-not-linked">
            {credits.data?.reason ?? t('credits.not_linked')}
          </p>
        ) : (
          <>
            {/* ① 余额：两类分开 */}
            <section className="grid grid-cols-3 gap-2" data-testid="credits-balance">
              <Figure label={t('credits.available')} value={num(balance.available)} strong />
              <Figure label={t('credits.purchased')} value={num(balance.purchased)} />
              <Figure label={t('credits.granted')} value={num(balance.granted)} />
            </section>

            <div className="flex flex-wrap items-center gap-2">
              <Button size="sm" variant="outline" asChild data-testid="credits-topup">
                <a href={TOPUP_PATH} target="_blank" rel="noreferrer noopener">
                  <Wallet aria-hidden />
                  {t('credits.topup')}
                  <ExternalLink className="size-3" aria-hidden />
                </a>
              </Button>
              <span className="text-[11px] text-muted-foreground">
                {t('credits.month', { n: num(credits.data?.month_credits ?? 0) })}
              </span>
              {balance.low_balance ? (
                <span
                  className="text-[11px] text-amber-600 dark:text-amber-400"
                  data-testid="credits-low"
                >
                  {t('credits.low', { n: num(balance.low_balance_threshold) })}
                </span>
              ) : null}
            </div>

            {/* ② 即将过期 */}
            {balance.expiring.length === 0 ? null : (
              <section className="flex flex-col gap-1" data-testid="credits-expiring">
                <h4 className="text-xs font-medium text-muted-foreground">
                  {t('credits.expiring')}
                </h4>
                <ul className="flex flex-col gap-0.5 text-xs">
                  {balance.expiring.map((row) => (
                    <li key={row.expires_at} className="flex justify-between">
                      <span className="text-muted-foreground">{row.expires_at.slice(0, 10)}</span>
                      <span className="tabular-nums">{num(row.credits)}</span>
                    </li>
                  ))}
                </ul>
              </section>
            )}

            <Separator />

            {/* ③ 用量明细 */}
            <section className="flex flex-col gap-2" data-testid="credits-usage">
              <div className="flex items-center justify-between gap-2">
                <h4 className="text-xs font-medium text-muted-foreground">{t('credits.usage')}</h4>
                <div className="flex gap-1">
                  {GROUPS.map((g) => (
                    <Button
                      key={g}
                      size="xs"
                      variant={group === g ? 'secondary' : 'ghost'}
                      data-testid="credits-usage-group"
                      data-group={g}
                      data-active={group === g ? 'true' : 'false'}
                      onClick={() => {
                        setGroup(g)
                      }}
                    >
                      {t(`credits.group.${g}`)}
                    </Button>
                  ))}
                </div>
              </div>
              <UsageTable
                report={usage.data ?? null}
                pending={usage.isPending}
                group={group}
                num={num}
              />
            </section>
          </>
        )}

        {/* ④ 价目表：折叠着 */}
        <section className="flex flex-col gap-1.5" data-testid="credits-pricing">
          <Button
            size="xs"
            variant="ghost"
            className="self-start"
            aria-expanded={pricingOpen}
            onClick={() => {
              setPricingOpen((v) => !v)
            }}
          >
            {pricingOpen ? <ChevronDown aria-hidden /> : <ChevronRight aria-hidden />}
            {t('credits.pricing')}
          </Button>
          {pricingOpen ? (
            <div className="rounded-md border bg-muted/30 p-2.5">
              <p className="text-[11px] text-muted-foreground">
                {t('credits.pricing.note', { as_of: pricing.data?.as_of ?? '' })}
              </p>
              <table className="mt-1.5 w-full text-xs">
                <thead className="text-muted-foreground">
                  <tr className="border-b">
                    <th className="py-1 text-left font-normal">
                      {t('credits.pricing.capability')}
                    </th>
                    <th className="py-1 text-right font-normal">{t('credits.pricing.unit')}</th>
                    <th className="py-1 text-right font-normal">{t('credits.pricing.credits')}</th>
                  </tr>
                </thead>
                <tbody>
                  {(pricing.data?.entries ?? []).map((entry: PricingEntry) => (
                    <tr key={entry.capability} className="border-b last:border-0">
                      <td className="py-1">{lang === 'zh' ? entry.label_zh : entry.label_en}</td>
                      <td className="py-1 text-right text-muted-foreground">
                        {t(`credits.unit.${entry.unit}`)}
                      </td>
                      <td className="py-1 text-right tabular-nums">
                        {price(entry.credits_per_unit)}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : null}
        </section>

        <p className="text-[11px] text-muted-foreground">
          {t('credits.scope_note')}{' '}
          <Link to="/connections" className="text-primary underline-offset-4 hover:underline">
            {t('nav.connections')}
          </Link>
        </p>
      </CardContent>
    </Card>
  )
}

function Figure({
  label,
  value,
  strong = false,
}: {
  label: string
  value: string
  strong?: boolean
}): React.ReactNode {
  return (
    <div className="rounded-lg border p-2">
      <p className="text-[11px] text-muted-foreground">{label}</p>
      <p className={strong ? 'text-lg font-semibold tabular-nums' : 'text-base tabular-nums'}>
        {value}
      </p>
    </div>
  )
}

function UsageTable({
  report,
  pending,
  group,
  num,
}: {
  report: UsageReportView | null
  pending: boolean
  group: Group
  num: (n: number) => string
}): React.ReactNode {
  const { t } = useApp()
  if (pending) return <Skeleton className="h-20 w-full" />
  if (report === null || report.rows.length === 0) {
    return (
      <p className="text-xs text-muted-foreground" data-testid="credits-usage-empty">
        {t('credits.usage.empty')}
      </p>
    )
  }
  return (
    <table className="w-full text-xs" data-testid="credits-usage-table">
      <thead className="text-muted-foreground">
        <tr className="border-b">
          <th className="py-1 text-left font-normal">{t(`credits.group.${group}`)}</th>
          <th className="py-1 text-right font-normal">{t('credits.usage.calls')}</th>
          <th className="py-1 text-right font-normal">{t('credits.usage.credits')}</th>
        </tr>
      </thead>
      <tbody>
        {report.rows.map((row) => (
          <tr key={row.key} className="border-b last:border-0">
            <td className="py-1">{row.key}</td>
            <td className="py-1 text-right tabular-nums">{row.calls}</td>
            <td className="py-1 text-right tabular-nums">{num(row.credits)}</td>
          </tr>
        ))}
        <tr>
          <td className="py-1 font-medium">{t('credits.usage.total')}</td>
          <td />
          <td className="py-1 text-right font-medium tabular-nums">{num(report.total_credits)}</td>
        </tr>
      </tbody>
    </table>
  )
}
