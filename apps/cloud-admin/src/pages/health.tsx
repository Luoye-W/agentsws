/**
 * 健康（65 §4）。
 *
 * 每一项都写明**它测量了什么**（KOLAgents 那条，照搬）：一张只有红绿灯的健康页
 * 在出事那天最没用——看的人不知道绿的到底保证了什么，也不知道红了该去哪儿看。
 * 那句话由服务端给（`measures_zh`），这一页只负责把它印出来。
 */

import { Spinner, StatusPill, type Tone, WsCard } from '@/components/design'
import { PageHeader } from '@/components/layout'
import { useApp, useQuery } from '@/lib/app'
import { when } from '@/lib/format'
import type { Key } from '@/lib/i18n'

interface HealthItem {
  key: string
  label_zh: string
  measures_zh: string
  status: 'ok' | 'warn' | 'bad' | 'unknown'
  detail?: string
  at?: string
}

const TONE: Record<HealthItem['status'], Tone> = {
  ok: 'good',
  warn: 'warn',
  bad: 'bad',
  unknown: 'neutral',
}

export function HealthPage(): React.ReactNode {
  const { t } = useApp()
  const page = useQuery<{ items: HealthItem[]; at: string }>('/v1/admin/health')
  return (
    <>
      <PageHeader title={t('nav.health')} />
      {page.loading && page.data === undefined && <Spinner label={t('loading')} />}
      <div className="grid gap-3 xl:grid-cols-2">
        {page.data?.items.map((item) => (
          <WsCard key={item.key} className="flex flex-col gap-2 p-4">
            <div className="flex items-center justify-between gap-2">
              <h2 className="ws-display text-[15px] text-ws-ink">{item.label_zh}</h2>
              <StatusPill tone={TONE[item.status]}>{t(`health.${item.status}` as Key)}</StatusPill>
            </div>
            {item.detail !== undefined && (
              <p className="ws-num text-[13px] text-ws-body">{item.detail}</p>
            )}
            {item.at !== undefined && (
              <p className="ws-num text-xs text-ws-muted-fg">{when(item.at)}</p>
            )}
            <div className="mt-1 rounded-lg bg-ws-surface px-3 py-2">
              <p className="mb-1 font-semibold text-[11px] text-ws-muted-fg uppercase tracking-wide">
                {t('health.measures')}
              </p>
              <p className="text-[13px] text-ws-body leading-relaxed">{item.measures_zh}</p>
            </div>
          </WsCard>
        ))}
      </div>
    </>
  )
}
