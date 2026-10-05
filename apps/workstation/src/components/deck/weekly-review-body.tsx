/**
 * WP224（docs/91 §2.2 #1）：**本周经营一页纸**那张卡的主体。
 *
 * 一张卡、五段：情况 / 发现 / 影响 / 建议 / 下一步，最后一行「没接」。每条发现的那个数
 * 带一个出处 tooltip（哪个岗位、哪块面板、什么时间窗）——界面少字（36 §7）：出处不铺在卡面上。
 *
 * 只排版：数是服务端从面板取好的（`composeWeeklyReview`），这里一个都不算。
 */
import type { WeeklyReviewPayload } from '@agentsws/contracts'
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip'
import { useApp } from '@/lib/app-context'

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v)

/** payload 是不是一页纸（看形状，不看卡的 kind——卡体按 layout 排，见 `deck-card-body`）。 */
export function isWeeklyReview(payload: unknown): payload is WeeklyReviewPayload {
  return isRecord(payload) && payload.kind === 'weekly_review' && Array.isArray(payload.findings)
}

function Section({
  title,
  children,
  testId,
}: {
  title: string
  children: React.ReactNode
  testId: string
}): React.ReactNode {
  return (
    <section data-testid={testId} className="flex flex-col gap-1">
      <h4 className="text-xs font-medium text-ws-muted-fg">{title}</h4>
      {children}
    </section>
  )
}

function Lines({ items }: { items: string[] }): React.ReactNode {
  return (
    <ul className="flex list-disc flex-col gap-0.5 pl-4 text-[13px] text-ws-body">
      {items.map((x) => (
        <li key={x}>{x}</li>
      ))}
    </ul>
  )
}

export function WeeklyReviewBody({ payload }: { payload: WeeklyReviewPayload }): React.ReactNode {
  const { t } = useApp()
  return (
    <div className="mt-2.5 flex flex-col gap-3" data-testid="weekly-review">
      <Section title={t('weekly.situation')} testId="weekly-situation">
        <p className="text-[13px] text-ws-body">{payload.situation}</p>
      </Section>
      {payload.findings.length === 0 ? null : (
        <Section title={t('weekly.findings')} testId="weekly-findings">
          <TooltipProvider>
            <ul className="flex flex-col gap-1.5">
              {payload.findings.map((f) => (
                <li
                  key={`${f.panel}:${f.text}`}
                  className="flex items-baseline gap-3 rounded-[10px] bg-ws-surface px-3 py-2"
                >
                  <Tooltip>
                    <TooltipTrigger asChild>
                      <button
                        type="button"
                        data-testid="weekly-finding-value"
                        data-hint={t('weekly.source', { source: f.source })}
                        aria-label={`${f.value}，${t('weekly.source', { source: f.source })}`}
                        className="ws-display ws-num shrink-0 text-base underline decoration-ws-line decoration-dotted underline-offset-4"
                      >
                        {f.value}
                      </button>
                    </TooltipTrigger>
                    <TooltipContent>{t('weekly.source', { source: f.source })}</TooltipContent>
                  </Tooltip>
                  <span className="min-w-0 flex-1 text-[13px] text-ws-body">{f.text}</span>
                </li>
              ))}
            </ul>
          </TooltipProvider>
        </Section>
      )}
      {payload.impact.length === 0 ? null : (
        <Section title={t('weekly.impact')} testId="weekly-impact">
          <Lines items={payload.impact} />
        </Section>
      )}
      {payload.recommendations.length === 0 ? null : (
        <Section title={t('weekly.recommendations')} testId="weekly-recommendations">
          <Lines items={payload.recommendations} />
        </Section>
      )}
      <Section title={t('weekly.next_steps')} testId="weekly-next">
        <Lines items={payload.next_steps} />
      </Section>
      {payload.not_connected.length === 0 ? null : (
        <p className="text-xs text-ws-muted-fg" data-testid="weekly-not-connected">
          {t('weekly.not_connected')}：
          {payload.not_connected.map((g) => `${g.label}（${g.reason}）`).join('、')}
        </p>
      )}
    </div>
  )
}
