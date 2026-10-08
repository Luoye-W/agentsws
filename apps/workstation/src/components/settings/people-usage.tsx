/**
 * WP276（决策 238）：② 同事互联——大家共用一个余额，**每个人这个月的用量都看得见**，不设每人上限。
 * 只有名字和数字；取不到（老服务进程）就整块不出。
 */
import { useQuery } from '@tanstack/react-query'
import { Hint } from '@/components/ui/hint'
import { listPeopleUsage } from '@/lib/api-peers'
import { useApp } from '@/lib/app-context'
import { useMode } from '@/lib/mode'

const fmt = (n: number): string =>
  n >= 10_000 ? `${(n / 10_000).toFixed(1)} 万` : n.toLocaleString('zh-CN')

export function PeopleUsage(): React.ReactNode {
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
