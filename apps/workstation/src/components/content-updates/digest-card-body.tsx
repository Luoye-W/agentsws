/**
 * WP406（私有 docs/107 §5.1）：「<岗位> · 本周更新 · N 项」卡的卡身。
 *
 * - AI 一句建议（有才写）；
 * - 逐项一行：改了什么 + 你改过没（没改过 / 你改过 · 会保留 / 撞了）；新加的、急的各一个小标；
 * - 三个按钮：「全部应用」「挑着看」「这次跳过」。前后两个经审批总线定这张卡（选项），中间那个开第三栏。
 *
 * 卡片流与对话里就地画的是同一个组件（决策 847）。卡上不铺说明，解释进问号。
 */
import type { ContentDigestMine } from '@agentsws/contracts'
import type { DeckCard } from '@agentsws/deck'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import type { ReactNode } from 'react'
import { type FootAction, FootButtons, useCardFootActions } from '@/components/deck/card-foot'
import { StatusPill, type Tone, WsTag } from '@/components/design'
import { useRailState } from '@/components/rail/rail-state'
import { Hint } from '@/components/ui/hint'
import { decide } from '@/lib/api'
import { useApp } from '@/lib/app-context'
import {
  type ContentDigestCardPayload,
  contentUpdatesAddress,
  positionUpdatesKey,
} from '@/lib/content-digest-api'
import { RAIL_KEY } from '@/lib/work-archive'

export const MINE_TONE: Record<ContentDigestMine, Tone> = {
  untouched: 'neutral',
  kept: 'info',
  clash: 'warn',
}

export function DigestCardBody({
  card,
  payload,
}: {
  card: DeckCard
  payload: ContentDigestCardPayload
}): ReactNode {
  const { t, lang } = useApp()
  const rail = useRailState()
  const qc = useQueryClient()
  const decidable = card.available_actions.includes('approve')
  const go = useMutation({
    mutationFn: (option: 'apply_all' | 'skip') =>
      decide(
        card.id,
        {
          action: 'approve',
          version: card.version,
          via: 'workstation',
          // 按钮在卡身里：选的是哪一个放在 edited_payload 里（卡上不挂选项列表）
          edited_payload: { ...payload, selected_option_id: option },
        } as never,
        card.position_id,
      ),
    onSettled: () => {
      void qc.invalidateQueries({ queryKey: ['approval'] })
      void qc.invalidateQueries({ queryKey: ['deck'] })
      void qc.invalidateQueries({ queryKey: RAIL_KEY })
      void qc.invalidateQueries({ queryKey: positionUpdatesKey(payload.position_id) })
    },
  })
  // WP478：「全部应用 / 挑着看 / 这次跳过」并进卡底那一排（没有卡底时照旧画在卡身里）
  const actions: FootAction[] = [
    ...(decidable
      ? [
          {
            key: 'cd-apply',
            label: t('cd.apply_all'),
            primary: true,
            disabled: go.isPending,
            testId: 'content-digest-apply',
            onSelect: () => {
              go.mutate('apply_all')
            },
          },
        ]
      : []),
    {
      key: 'cd-pick',
      label: t('cd.pick'),
      testId: 'content-digest-pick',
      onSelect: () => {
        rail.openAddress(contentUpdatesAddress(payload.position_id))
      },
    },
    ...(decidable
      ? [
          {
            key: 'cd-skip',
            label: t('cd.skip'),
            disabled: go.isPending,
            testId: 'content-digest-skip',
            onSelect: () => {
              go.mutate('skip')
            },
          },
        ]
      : []),
  ]
  const hosted = useCardFootActions(actions)
  return (
    <div className="mt-2.5 flex flex-col gap-2" data-testid="content-digest">
      {payload.advice === undefined ? null : (
        <p className="text-[13px] text-ws-body" data-testid="content-digest-advice">
          {payload.advice}
        </p>
      )}
      <ul className="flex flex-col divide-y rounded-md border" data-testid="content-digest-items">
        {payload.items.map((i) => (
          <li
            key={i.item_id}
            className="flex items-center gap-2 px-3 py-1.5 text-[13px]"
            data-testid="content-digest-item"
            data-mine={i.mine}
          >
            <span
              className="min-w-0 flex-1 truncate text-ws-ink"
              title={lang === 'zh' ? i.summary.zh : i.summary.en}
            >
              {lang === 'zh' ? i.title.zh : i.title.en}
            </span>
            {i.urgent === true ? <WsTag className="text-ws-bad">{t('cd.urgent')}</WsTag> : null}
            {i.added === true ? (
              <WsTag>{t('cd.added')}</WsTag>
            ) : (
              <StatusPill tone={MINE_TONE[i.mine]} className="h-5 px-2">
                {t(`cd.mine.${i.mine}`)}
              </StatusPill>
            )}
          </li>
        ))}
      </ul>
      {hosted ? (
        <Hint text={t('cd.card.tip')} />
      ) : (
        <div className="flex flex-wrap items-center gap-2">
          <FootButtons actions={actions} />
          <Hint text={t('cd.card.tip')} />
        </div>
      )}
      {go.isError ? (
        <p className="text-xs text-ws-bad" data-testid="content-digest-error">
          {t('cd.failed', { reason: go.error instanceof Error ? go.error.message : '' })}
        </p>
      ) : null}
    </div>
  )
}
