/**
 * WP415（自查 R1，决策 1236–1238）：卡上与时间线上那一格「接没接通 / 办没办成」。
 *
 * - `WiringNote`：出卡时就标——生产里没有真执行器的卡写「这一步还没接通」（卡上没有「通过」，
 *   只有「知道了」）；演示里只走空桩的卡写「演示」。说明只进问号（界面少字）。
 * - `ExecutionPill`：执行过的卡 / 时间线那一行——办好了 · 已核对 / 已执行 · 没能回读核对 /
 *   没做（· 还没接通）/ 演示。原因进问号。
 */
import type { ExecutionOutcomeView, ExecutionWiring } from '@agentsws/contracts'
import { StatusPill, type Tone } from '@/components/design'
import { Hint } from '@/components/ui/hint'
import { useApp } from '@/lib/app-context'

export function WiringNote({ wiring }: { wiring?: ExecutionWiring | undefined }): React.ReactNode {
  const { t } = useApp()
  if (wiring === undefined) return null
  const notWired = wiring.state === 'not_wired'
  return (
    <p
      className="mt-1 flex items-center gap-1.5"
      data-testid="deck-wiring"
      data-wiring={wiring.state}
    >
      <StatusPill tone={notWired ? 'warn' : 'neutral'}>
        {t(notWired ? 'exec.not_wired' : 'exec.demo')}
      </StatusPill>
      <Hint text={t(notWired ? 'exec.not_wired.hint' : 'exec.demo.hint')} />
    </p>
  )
}

const TONE: Record<ExecutionOutcomeView['outcome'], Tone> = {
  verified: 'good',
  unverified: 'warn',
  not_done: 'bad',
  demo: 'neutral',
}

/** 一格执行结果的字（时间线、记录面板共用）。 */
export function executionText(view: ExecutionOutcomeView, t: (key: string) => string): string {
  if (view.outcome === 'not_done' && view.not_wired === true) return t('exec.outcome.not_wired')
  return t(`exec.outcome.${view.outcome}`)
}

export function ExecutionPill({
  view,
}: {
  view?: ExecutionOutcomeView | undefined
}): React.ReactNode {
  const { t } = useApp()
  if (view === undefined) return null
  return (
    <span className="inline-flex items-center gap-1" data-testid="exec-outcome">
      <StatusPill tone={TONE[view.outcome]} data-outcome={view.outcome}>
        {executionText(view, t)}
      </StatusPill>
      {view.reason === undefined ? null : <Hint text={view.reason} />}
    </span>
  )
}
