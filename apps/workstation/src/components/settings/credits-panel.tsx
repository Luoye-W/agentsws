/**
 * 设置 → 账号与积分里的**积分那一段**（49 M5；WP118 加了三块分组与充值四档）。
 *
 * 六块，从上到下：
 * 1. **余额**——两类积分分开显示。为什么分开：充值买的永不过期，送的按周期清零，
 *    合成一个数字会让用户在清零那天觉得钱少了一截却说不清哪儿少的；
 * 2. **这个月钱花在哪**——三张小卡，对应付费三块（数据接口 / AI 使用 / 增值服务，
 *    67 §1）。为什么要分块：这三块的**花钱方式**根本不同（按次 / 按 token / 按月），
 *    对着一张十几行的明细表，用户回答不了"这个月钱花哪儿了"；
 * 3. **即将过期**——有期限的那几笔各列一行，按到期日排；
 * 4. **用量明细**——按能力 / 按工作区 / 按天三个切换；
 * 5. **充值四档**——四张卡（US$20 / 50 / 100 / 200）。为什么是档位不是输入框：
 *    任意金额要用户先做一道除法（"我要多少积分？那是多少钱？"）；
 * 6. **价目表**——折叠着，按三块分组。
 *
 * 三条纪律：
 * - **这一层不算账**。每个数字都是云上那一份的透传。唯一的例外是三张小卡上那个
 *   和——它是把云上给的每条明细按块相加，加数与加法都看得见，且**不参与任何扣费**。
 * - **本地不碰支付凭据**：四张卡点下去是去云上建一笔单，然后打开 Stripe 自己的页面。
 * - **看得到多少由令牌说了算**：owner 那把看整个组织，成员那把只看自己那个工作区。
 *   界面不做第二次裁剪——裁两次就会有一次是错的。
 */
import { useMutation, useQuery } from '@tanstack/react-query'
import { ChevronDown, ChevronRight, Coins, ExternalLink, Wallet } from 'lucide-react'
import { useState } from 'react'
import { Link } from 'react-router-dom'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Hint } from '@/components/ui/hint'
import { Separator } from '@/components/ui/separator'
import { Skeleton } from '@/components/ui/skeleton'
import type { PricingEntry, TopupTierView, UsageReportView } from '@/lib/api'
import {
  createTopup,
  getCloudCredits,
  getCloudPricing,
  getCloudUsage,
  getTopupTiers,
} from '@/lib/api'
import { useApp } from '@/lib/app-context'
import { KolCloudCard } from './kol-cloud-card'

type Group = 'capability' | 'workspace' | 'day'

const GROUPS: Group[] = ['capability', 'workspace', 'day']

/** 付费三块（67 §1）。顺序就是界面上从左到右。 */
type Block = 'data' | 'ai' | 'service'
const BLOCKS: Block[] = ['data', 'ai', 'service']

/**
 * 一条能力归哪一块。
 *
 * `block` 有就用它；没有就按能力名前缀兜底——老版本的价目表（用户断网时本地内置
 * 的那一份）没有这一列，而界面不该因此少一张卡。这条兜底与云侧
 * `pricingBlockOf` 是同一条规则，写两遍是因为它要在两个进程里各成立一次。
 */
function blockOf(capability: string, declared?: Block): Block {
  if (declared !== undefined) return declared
  if (capability.startsWith('ai.')) return 'ai'
  if (capability.startsWith('kol.service.') || capability.startsWith('support.service.'))
    return 'service'
  return 'data'
}

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
  /*
   * 三张小卡永远按**能力**那一份算：用户在上面把明细切成"按天"的时候，卡上的
   * 三个数不该跟着变——那三个数回答的是"这个月钱花在哪三块"，与他正在看哪个切法无关。
   */
  const byCapability = useQuery({
    queryKey: ['cloud-usage', 'capability', assignment],
    queryFn: () => getCloudUsage('capability', assignment),
    enabled: credits.data?.linked === true,
    retry: false,
  })
  const tiers = useQuery({
    queryKey: ['cloud-topup-tiers', assignment],
    queryFn: () => getTopupTiers(assignment),
    enabled: credits.data?.linked === true,
    retry: false,
  })
  const order = useMutation({
    mutationFn: (tier_id: string) => createTopup(tier_id, assignment),
    onSuccess: (created) => {
      /*
       * 付款永远在对方的页面上（13 §4.3）。新窗口打开，**不在工作台里嵌一个
       * iframe**——那会让用户分不清卡号填在谁的页面上。
       */
      if (created.checkout_url !== undefined)
        window.open(created.checkout_url, '_blank', 'noreferrer,noopener')
    },
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

  /** 每条能力归哪一块（价目表说了算；表里没有的按前缀兜底）。 */
  const blockOfCapability = (capability: string): Block => {
    const entry = pricing.data?.entries.find((e) => e.capability === capability)
    return blockOf(capability, entry?.block)
  }
  const perBlock = new Map<Block, { credits: number; calls: number }>(
    BLOCKS.map((b) => [b, { credits: 0, calls: 0 }]),
  )
  for (const row of byCapability.data?.rows ?? []) {
    const bucket = perBlock.get(blockOfCapability(row.key))
    if (bucket === undefined) continue
    bucket.credits += row.credits
    bucket.calls += row.calls
  }

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

            {/* ② 这个月钱花在哪：付费三块各一张小卡（67 §1） */}
            <section className="flex flex-col gap-1.5" data-testid="credits-blocks">
              <h4 className="text-xs font-medium text-muted-foreground">{t('credits.blocks')}</h4>
              <div className="grid grid-cols-3 gap-2">
                {BLOCKS.map((b) => {
                  const sum = perBlock.get(b) ?? { credits: 0, calls: 0 }
                  return (
                    <div
                      key={b}
                      className="rounded-lg border p-2"
                      data-testid="credits-block"
                      data-block={b}
                    >
                      <p className="flex items-center gap-1 text-[11px] text-muted-foreground">
                        {t(`credits.block.${b}`)}
                        <Hint text={t(`credits.block.${b}.note`)} />
                      </p>
                      <p className="text-base tabular-nums">{num(sum.credits)}</p>
                      <p className="text-[11px] text-muted-foreground">
                        {sum.calls === 0
                          ? t('credits.blocks.none')
                          : t('credits.usage.calls') + ' ' + String(sum.calls)}
                      </p>
                    </div>
                  )
                })}
              </div>
            </section>

            <div className="flex flex-wrap items-center gap-2">
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

            {/* ⑤ 充值四档：四张卡（67 §2） */}
            <Separator />
            <section className="flex flex-col gap-2" data-testid="credits-tiers">
              <div className="flex items-baseline justify-between gap-2">
                <h4 className="text-xs font-medium text-muted-foreground">{t('credits.tiers')}</h4>
                <span className="text-[11px] text-muted-foreground">{t('credits.tiers.note')}</span>
              </div>
              {tiers.isPending ? (
                <Skeleton className="h-20 w-full" />
              ) : (
                <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
                  {(tiers.data?.tiers ?? []).map((tier: TopupTierView) => (
                    <button
                      key={tier.id}
                      type="button"
                      className={`flex flex-col items-start gap-0.5 rounded-lg border p-2.5 text-left transition-colors hover:bg-muted/50 disabled:opacity-60 ${
                        tier.recommended === true ? 'border-primary' : ''
                      }`}
                      data-testid="credits-tier"
                      data-tier={tier.id}
                      data-recommended={tier.recommended === true ? 'true' : 'false'}
                      disabled={order.isPending}
                      onClick={() => {
                        order.mutate(tier.id)
                      }}
                    >
                      <span className="flex items-center gap-1 text-[11px] text-muted-foreground">
                        {lang === 'zh' ? tier.label_zh : tier.label_en}
                        {tier.recommended === true ? (
                          <span className="rounded bg-primary/10 px-1 text-primary">
                            {t('credits.tiers.recommended')}
                          </span>
                        ) : null}
                      </span>
                      <span className="text-lg font-semibold tabular-nums">US${num(tier.usd)}</span>
                      <span className="text-xs text-muted-foreground tabular-nums">
                        {t('credits.tiers.credits', { n: num(tier.credits) })}
                      </span>
                      <span className="flex items-center gap-1 text-[11px] text-primary">
                        <Wallet className="size-3" aria-hidden />
                        {t('credits.tiers.go')}
                        <ExternalLink className="size-3" aria-hidden />
                      </span>
                    </button>
                  ))}
                </div>
              )}
              {order.isError ? (
                <p className="text-[11px] text-destructive" data-testid="credits-tier-error">
                  {t('credits.tiers.failed', {
                    msg: order.error instanceof Error ? order.error.message : '',
                  })}
                </p>
              ) : null}
            </section>

            <Separator />

            {/*
             * ⑤b 红人营销增值服务（67 §3，WP118）。
             *
             * 放在充值四档下面是有意的：这一项是**订阅**，而"欠费暂停"那一档用户
             * 要做的下一件事就是充值——两件事挨着，比让他在页面里来回找少一步。
             * 上面那三张小卡里"增值服务"那一格是这个月**已经花掉**的，这一张是
             * **现在是什么状态**，两个问题不同，所以两处都在。
             */}
            <KolCloudCard assignment={assignment} />
          </>
        )}

        {/* ⑥ 价目表：按三块分组，折叠着 */}
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
                {/*
                 * 按三块分组（67 §1）。分组是**给人看的**：价目表原样一条不改，
                 * 只是把同一块的排在一起，各带一行小标题。
                 */}
                {BLOCKS.map((b) => {
                  const rows = (pricing.data?.entries ?? []).filter(
                    (e: PricingEntry) => blockOf(e.capability, e.block) === b,
                  )
                  if (rows.length === 0) return null
                  return (
                    <tbody key={b} data-testid="credits-pricing-block" data-block={b}>
                      <tr>
                        <td colSpan={3} className="pt-2 pb-0.5 text-[11px] text-muted-foreground">
                          {t(`credits.block.${b}`)}
                        </td>
                      </tr>
                      {rows.map((entry: PricingEntry) => (
                        <tr key={entry.capability} className="border-b last:border-0">
                          <td className="py-1">
                            {lang === 'zh' ? entry.label_zh : entry.label_en}
                          </td>
                          <td className="py-1 text-right text-muted-foreground">
                            {t(`credits.unit.${entry.unit}`)}
                          </td>
                          <td className="py-1 text-right tabular-nums">
                            {price(entry.credits_per_unit)}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  )
                })}
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
