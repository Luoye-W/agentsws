/**
 * WP452（docs/109 §5.2 #13）：广告实验「保留 / 停 / 再测」卡的卡身——每一版的比例、对基准差多少、差得确不确定，
 * 一两句为什么（规则算的，照抄服务端的结论）。选项本身是下面那排单选（建议的那一个排第一、带「建议」）。
 */
import type { AdsExperimentReadoutPayload } from '@agentsws/contracts'
import type { ReactNode } from 'react'
import { Hint } from '@/components/ui/hint'
import { useApp } from '@/lib/app-context'

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v)

export function isExperimentReadoutPayload(p: unknown): p is AdsExperimentReadoutPayload {
  return (
    isRecord(p) &&
    p.form === 'ads_experiment_readout' &&
    isRecord(p.readout) &&
    Array.isArray((p.readout as { comparisons?: unknown }).comparisons)
  )
}

const pct = (n: number): string => `${Math.round(n * 10000) / 100}%`

export function ExperimentReadoutBody({
  payload,
}: {
  payload: AdsExperimentReadoutPayload
}): ReactNode {
  const { t } = useApp()
  const base = payload.readout.comparisons[0]
  const guards =
    payload.plan === undefined || payload.plan.guardrails.length === 0
      ? t('adsx.plan.no_guard')
      : payload.plan.guardrails.map((g) => `${g.metric} ≤ ${g.max_worse_pct}%`).join('、')
  return (
    <div className="mb-2.5 flex flex-col gap-2" data-testid="ads-experiment-readout">
      <p className="text-ws-ui text-foreground">{payload.change}</p>
      <table className="w-full text-ws-note">
        <thead>
          <tr className="text-left text-ws-muted-fg">
            <th className="py-1 font-normal">{t('adsx.arm')}</th>
            <th className="py-1 text-right font-normal">{t('adsx.rate')}</th>
            <th className="py-1 text-right font-normal">{t('adsx.lift')}</th>
            <th className="py-1 text-right font-normal">{t('adsx.sure')}</th>
          </tr>
        </thead>
        <tbody>
          {base === undefined ? null : (
            <tr className="border-t border-ws-line">
              <td className="py-1">{payload.arms[0]?.label ?? t('adsx.base')}</td>
              <td className="py-1 text-right tabular-nums">{pct(base.control_rate)}</td>
              <td className="py-1 text-right text-ws-muted-fg">—</td>
              <td className="py-1 text-right text-ws-muted-fg">—</td>
            </tr>
          )}
          {payload.readout.comparisons.map((c) => (
            <tr key={c.arm} className="border-t border-ws-line" data-testid="ads-experiment-arm">
              <td className="py-1">{payload.arms.find((a) => a.id === c.arm)?.label ?? c.arm}</td>
              <td className="py-1 text-right tabular-nums">{pct(c.rate)}</td>
              <td
                className={[
                  'py-1 text-right tabular-nums',
                  c.significant ? (c.lift_pct > 0 ? 'text-ws-good' : 'text-ws-bad') : '',
                ].join(' ')}
              >
                {c.lift_pct > 0 ? '+' : ''}
                {c.lift_pct}%
              </td>
              <td className="py-1 text-right">
                {c.significant ? t('adsx.sure.yes') : t('adsx.sure.no')}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      <ul className="flex flex-col gap-0.5 text-ws-note text-ws-muted-fg">
        {payload.readout.reasons.map((r) => (
          <li key={r}>{r}</li>
        ))}
      </ul>
      {payload.plan === undefined ? null : (
        <p className="flex items-center gap-1 text-ws-tiny text-ws-muted-fg">
          {t('adsx.plan', { per_arm: String(payload.plan.per_arm), guards })}
          <Hint text={t('adsx.hint')} />
        </p>
      )}
    </div>
  )
}
