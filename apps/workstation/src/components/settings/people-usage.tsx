/**
 * 按人看用量。
 *
 * WP282（决策 281 / 286–290）：关联了云账号就看**积分**——每个人这个月在价目表三块（AI / 数据 / 服务）
 * 各花了多少、一共几次，「没标注」单独一行（上线前的老用量没按人记）。云上只回有用量的人，没用过的同事
 * 由本机按名册补 0 行。看得到谁由本机服务端判：② 全员；③ owner / admin 全员、别人只看自己；① 只有自己。
 *
 * 没关联（或云上暂时取不到）时：② 照旧显示本机记的模型次数 / token（WP276，决策 238），别的模式不出。
 * 只有名字和数字。
 */
import type { MemberUsageBlocks, MemberUsageReport } from '@agentsws/contracts'
import { useQuery } from '@tanstack/react-query'
import { Hint } from '@/components/ui/hint'
import { getCloudMemberUsage, listPeopleUsage } from '@/lib/api-peers'
import { useApp } from '@/lib/app-context'
import { useMode } from '@/lib/mode'

const BLOCKS = ['ai', 'data', 'service'] as const

const fmt = (n: number): string =>
  n >= 10_000 ? `${(n / 10_000).toFixed(1)} 万` : n.toLocaleString('zh-CN')

const credits = (n: number, locale: string): string =>
  n.toLocaleString(locale, { maximumFractionDigits: n > 0 && n < 0.01 ? 4 : 2 })

export function PeopleUsage({
  localFallback = false,
}: {
  /** 没关联云账号时显示本机记的次数 / token（② 用；WP276 那一张）。 */
  localFallback?: boolean
}): React.ReactNode {
  const cloud = useQuery({
    queryKey: ['usage', 'members'],
    queryFn: () => getCloudMemberUsage(),
    retry: false,
  })
  const report = cloud.data?.report
  if (report !== undefined)
    return <MemberCredits report={report} self={cloud.data?.scope === 'self'} />
  if (cloud.isPending || !localFallback) return null
  return <LocalPeopleUsage />
}

function MemberCredits({
  report,
  self,
}: {
  report: MemberUsageReport
  self: boolean
}): React.ReactNode {
  const { t, lang } = useApp()
  const { t: tm } = useMode()
  const locale = lang === 'zh' ? 'zh-CN' : 'en-US'
  const unattributed = !self && report.unattributed.credits > 0 ? report.unattributed : undefined
  const cells = (blocks: MemberUsageBlocks) =>
    BLOCKS.map((b) => (
      <td
        key={b}
        className="py-1 text-right tabular-nums text-muted-foreground"
        title={t('usage.members.calls_of', { n: blocks[b].calls })}
      >
        {credits(blocks[b].credits, locale)}
      </td>
    ))
  return (
    <section
      className="flex flex-col gap-2 rounded-xl border p-4 text-sm"
      data-testid="member-credits"
      data-scope={self ? 'self' : 'all'}
    >
      <h3 className="flex items-center gap-1 font-medium">
        {t(self ? 'usage.members.title.self' : 'usage.members.title')}
        {self ? null : <Hint text={tm('credits.scope_note')} />}
      </h3>
      <table className="w-full text-xs">
        <thead className="text-muted-foreground">
          <tr>
            <th className="py-1 text-left font-normal">{t('usage.people.who')}</th>
            {BLOCKS.map((b) => (
              <th key={b} className="py-1 text-right font-normal">
                {t(`credits.block.${b}`)}
              </th>
            ))}
            <th className="py-1 text-right font-normal">{t('credits.usage.calls')}</th>
            <th className="py-1 text-right font-normal">{t('usage.members.total')}</th>
          </tr>
        </thead>
        <tbody>
          {report.rows.map((r) => (
            <tr key={r.key} data-testid="member-credits-row" data-person={r.key}>
              <td className="py-1">{r.name ?? t('usage.members.someone')}</td>
              {cells(r.blocks)}
              <td className="py-1 text-right tabular-nums">{r.calls}</td>
              <td className="py-1 text-right font-medium tabular-nums">
                {credits(r.credits, locale)}
              </td>
            </tr>
          ))}
          {unattributed === undefined ? null : (
            <tr data-testid="member-credits-unattributed" className="text-muted-foreground">
              <td className="py-1">
                <span className="flex items-center gap-1">
                  {t('usage.members.unattributed')}
                  <Hint text={t('usage.members.unattributed.hint')} />
                </span>
              </td>
              {cells(unattributed.blocks)}
              <td className="py-1 text-right tabular-nums">{unattributed.calls}</td>
              <td className="py-1 text-right tabular-nums">
                {credits(unattributed.credits, locale)}
              </td>
            </tr>
          )}
        </tbody>
      </table>
    </section>
  )
}

/** WP276：没关联云账号时，② 看本机记的模型次数 / token。 */
function LocalPeopleUsage(): React.ReactNode {
  const { t } = useApp()
  const { t: tm } = useMode()
  const usage = useQuery({ queryKey: ['usage', 'people'], queryFn: listPeopleUsage, retry: false })
  const rows = usage.data?.people ?? []
  if (rows.length === 0) return null
  return (
    <section
      className="flex flex-col gap-2 rounded-xl border p-4 text-sm"
      data-testid="people-usage"
    >
      <h3 className="flex items-center gap-1 font-medium">
        {t('usage.people.title')}
        <Hint text={tm('credits.scope_note')} />
      </h3>
      <table className="w-full text-xs">
        <thead className="text-muted-foreground">
          <tr>
            <th className="py-1 text-left font-normal">{t('usage.people.who')}</th>
            <th className="py-1 text-right font-normal">{t('credits.usage.calls')}</th>
            <th className="py-1 text-right font-normal">{t('usage.people.tokens')}</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <tr key={r.person_id} data-testid="people-usage-row">
              <td className="py-1">{r.name}</td>
              <td className="py-1 text-right tabular-nums">{r.calls}</td>
              <td className="py-1 text-right tabular-nums">{fmt(r.tokens)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </section>
  )
}
