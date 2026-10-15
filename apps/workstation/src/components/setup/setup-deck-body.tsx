/**
 * WP324（决策 690）：连接卡 / 配置卡在**卡片流与事项时间线**里的身体（同一张卡的两处投影）。
 *
 * 主按钮在卡身里（连接 / 保存），所以卡底那排只剩「先不连 / 先不设」「稍后」（`quickActions` 去掉了 approve）：
 * - 连接卡：要连的都连上了 → 这张卡自己点「接着做」（`approve`）；服务端复核一遍再按原话接着跑；
 * - 配置卡：填好点「保存并接着做」→ `approve` 带 `values`；服务端存好再接着跑。
 */
import {
  type ConnectRequestPayload,
  isConnectRequestPayload,
  isSetupRequestPayload,
  type SetupRequestPayload,
} from '@agentsws/contracts'
import type { DeckCard } from '@agentsws/deck'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { type ReactNode, useCallback } from 'react'
import { decide } from '@/lib/api'
import { RAIL_KEY } from '@/lib/work-archive'
import { ConnectNeedsBody, useConnectContext } from './connect-card'
import { SetupFieldsBody } from './setup-card'
import { SetupPlanBody } from './setup-plan'

/** 这张卡是不是连接卡 / 配置卡（主按钮在卡身里）。 */
export const isSetupCard = (card: Pick<DeckCard, 'detail'>): boolean =>
  isConnectRequestPayload(card.detail.payload) || isSetupRequestPayload(card.detail.payload)

function useDecideSetup(card: DeckCard) {
  const client = useQueryClient()
  return useMutation({
    mutationFn: (edited?: SetupRequestPayload) =>
      decide(
        card.id,
        {
          action: 'approve',
          version: card.version,
          via: 'workstation',
          ...(edited === undefined ? {} : { edited_payload: edited }),
        } as never,
        card.position_id,
      ),
    onSettled: () => {
      void client.invalidateQueries({ queryKey: ['approval'] })
      void client.invalidateQueries({ queryKey: ['deck'] })
      void client.invalidateQueries({ queryKey: RAIL_KEY })
      void client.invalidateQueries({ queryKey: ['matter'] })
    },
  })
}

function ConnectRequestBody({
  card,
  payload,
}: {
  card: DeckCard
  payload: ConnectRequestPayload
}): ReactNode {
  const go = useDecideSetup(card)
  const duty =
    payload.resume === undefined
      ? undefined
      : { role_id: card.role_id, assignment_id: payload.resume.assignment_id }
  const ctx = useConnectContext(duty)
  const decidable = card.available_actions.includes('approve')
  const fire = useCallback(() => {
    if (decidable && !go.isPending && !go.isSuccess) go.mutate(undefined)
  }, [decidable, go])
  return (
    <div className="mt-2.5" data-testid="deck-layout-connect">
      <ConnectNeedsBody
        needs={payload.needs}
        risk={payload.risk}
        ctx={ctx}
        {...(decidable ? { onAllConnected: fire, onContinue: fire } : {})}
        continuing={go.isPending}
      />
    </div>
  )
}

function SetupRequestBody({
  card,
  payload,
}: {
  card: DeckCard
  payload: SetupRequestPayload
}): ReactNode {
  const go = useDecideSetup(card)
  if (!card.available_actions.includes('approve'))
    return <p className="mt-2.5 text-sm text-ws-body">{payload.why}</p>
  // WP348（决策 887）：方案卡——「就这样」原样存，「改一下」才展开表单
  if (payload.mode === 'plan' || payload.mode === 'change')
    return (
      <div className="mt-2.5" data-testid="deck-layout-setup">
        <SetupPlanBody
          payload={payload}
          saving={go.isPending}
          onAccept={() => {
            go.mutate(undefined)
          }}
          onSave={(values) => {
            go.mutate({ ...payload, values })
          }}
        />
      </div>
    )
  return (
    <div className="mt-2.5" data-testid="deck-layout-setup">
      <SetupFieldsBody
        payload={payload}
        saving={go.isPending}
        onSave={(values) => {
          go.mutate({ ...payload, values })
        }}
      />
    </div>
  )
}

/** 卡片流 / 时间线里的那一块（不是这两种卡回 `null`）。 */
export function SetupDeckBody({ card }: { card: DeckCard }): ReactNode {
  const p = card.detail.payload
  if (isConnectRequestPayload(p)) return <ConnectRequestBody card={card} payload={p} />
  if (isSetupRequestPayload(p)) return <SetupRequestBody card={card} payload={p} />
  return null
}
