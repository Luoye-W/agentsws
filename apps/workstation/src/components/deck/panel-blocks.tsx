/**
 * WP96（09-18）：**不是卡的那两样**——报表块与告警块。
 *
 * 只有要人决定的才是卡（36 §2）。日报（WP63）与上线检查单（WP77）一个决定都不要
 * 人做，它们是"看一眼就过"；像素异常 / 库存告急 / 负面预警 / 超期未发也不要人决定，
 * 它们要的是**被看见**。于是这两样都离开卡片队列：
 *
 * - 报表块：一行标题 + 几个数，右下角一个 → 进详情；**没有批准 / 驳回**
 * - 告警块：一条一行，带 tone；它同时已经走了通知（06 §1.2 immediate）
 *
 * 它们**引出的**决定照旧是卡：恢复投放（⑦）、补货（②）、回应舆情（①）。
 */
import type { DeckCard } from '@agentsws/deck'
import { GoButton, StatusPill, WsCard } from '@/components/design'
import { Hint } from '@/components/ui/hint'
import { useApp } from '@/lib/app-context'
import { fieldLabel, fieldValue } from '@/lib/humanize'
import type { Lang } from '@/lib/i18n'

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v)

/**
 * 报表里那几个数：payload 上的标量字段，直接取，不算也不编（14 §2）。
 *
 * WP141：列头原来就是字段名（`date / sales / orders / low_stock`），现在过
 * `lib/humanize`——「日期 / 销售额 / 订单 / 库存告急」。
 */
function figuresOf(card: DeckCard, lang: Lang): [string, string][] {
  const payload = card.detail.payload
  if (!isRecord(payload)) return []
  const out: [string, string][] = []
  for (const [k, v] of Object.entries(payload)) {
    // WP154：`variant` 是搜索报告卡的分支名（daily / weekly_*），不是给人看的数
    if (k === 'kind' || k === 'variant') continue
    if (typeof v === 'number' || (typeof v === 'string' && v.length <= 24))
      out.push([fieldLabel(k, lang), fieldValue(k, v, lang)])
    if (out.length === 4) break
  }
  return out
}

export function ReportBlocks({
  reports,
  onOpen,
}: {
  reports: DeckCard[]
  onOpen: (card: DeckCard) => void
}): React.ReactNode {
  const { t, lang } = useApp()
  if (reports.length === 0) return null
  return (
    <section data-testid="panel-reports">
      <div className="mb-2 flex items-center gap-2">
        <h2 className="text-sm font-medium">{t('panel.reports')}</h2>
        {/* WP157：小节说明进问号 */}
        <Hint text={t('panel.reports.hint')} testId="panel-reports-hint" />
      </div>
      <div className="flex flex-col gap-2">
        {reports.map((r) => (
          <WsCard
            key={r.id}
            data-testid="report-block"
            data-kind={r.kind}
            className="flex items-center gap-3 px-4 py-3"
          >
            <div className="min-w-0 flex-1">
              <p className="truncate text-sm font-medium">{r.title}</p>
              <p className="truncate text-xs text-ws-muted-fg">{r.summary}</p>
            </div>
            <dl className="hidden shrink-0 items-center gap-4 sm:flex" data-testid="report-figures">
              {figuresOf(r, lang).map(([k, v]) => (
                <div key={k} className="text-right">
                  <dt className="text-[11px] text-ws-muted-fg">{k}</dt>
                  <dd className="ws-display ws-num text-base">{v}</dd>
                </div>
              ))}
            </dl>
            <GoButton
              label={t('deck.go')}
              onClick={() => {
                onOpen(r)
              }}
            />
          </WsCard>
        ))}
      </div>
    </section>
  )
}

export function AlertBlocks({
  alerts,
  onOpen,
}: {
  alerts: DeckCard[]
  onOpen: (card: DeckCard) => void
}): React.ReactNode {
  const { t } = useApp()
  if (alerts.length === 0) return null
  return (
    <section data-testid="alerts">
      <div className="mb-2 flex items-center gap-2">
        <h2 className="text-sm font-medium">{t('home.alerts')}</h2>
        <Hint text={t('panel.alerts.hint')} testId="panel-alerts-hint" />
      </div>
      <ul className="flex flex-col gap-2">
        {alerts.map((a) => (
          <li key={a.id}>
            <WsCard data-testid="alert-block" className="flex items-center gap-3 px-4 py-3">
              <StatusPill tone={a.priority_band === 'P0' ? 'bad' : 'warn'}>
                {t(`band.${a.priority_band}`)}
              </StatusPill>
              <span className="min-w-0 flex-1 truncate text-sm">{a.title}</span>
              <GoButton
                label={t('deck.go')}
                onClick={() => {
                  onOpen(a)
                }}
              />
            </WsCard>
          </li>
        ))}
      </ul>
    </section>
  )
}
