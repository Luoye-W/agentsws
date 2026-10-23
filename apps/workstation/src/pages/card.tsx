/**
 * WP333（决策 584）：一张卡自己的页面 `/cards/:id`。
 *
 * 个人微信里推来的卡只带一个深链（`去工作台处理：…/cards/<卡号>?brand=…`，见
 * `packages/channels/src/im-cards.ts`）。以前工作台没有这条路由，点开落到首页、
 * 还得自己在牌堆里翻。现在直接打开那一张：还没定的照常能定；已经定过的卡还能看
 * （状态签是「已处理」，只剩「打开」）。品牌那一格由外壳的 `useBrandLink` 先处理（WP311）。
 *
 * 卡的长相与首页牌堆同一个 `DeckCardView`；决定走同一个 `decide`。
 */
import type { ExecutionWiring } from '@agentsws/contracts'
import { DECIDABLE_STATES, type DeckCard, projectCard } from '@agentsws/deck'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { ArrowLeft } from 'lucide-react'
import { type ReactNode, useState } from 'react'
import { Link, useNavigate, useParams } from 'react-router-dom'
import { DeckCardView, type DeckDecideRequest } from '@/components/deck/deck-card'
import { DEFAULT_CONTENT_MODE } from '@/components/deck/deck-filters'
import { DECK_MAX_WIDTH_CLASS } from '@/components/deck/deck-layout'
import { PageError } from '@/components/page-error'
import { Skeleton } from '@/components/ui/skeleton'
import { ApiClientError, assignmentId, decide, getApproval, getPositions } from '@/lib/api'
import { useApp } from '@/lib/app-context'
import { useTelemetryContext } from '@/lib/telemetry/context'
import { matterUrl } from '@/lib/work'

export function CardPage(): ReactNode {
  const { id = '' } = useParams()
  const { t } = useApp()
  const navigate = useNavigate()
  const client = useQueryClient()
  const [receipt, setReceipt] = useState('')
  const [error, setError] = useState('')

  const item = useQuery({
    queryKey: ['approval', id, 'card-page'],
    queryFn: () => getApproval(id),
    retry: false,
    enabled: id !== '',
  })
  // 卡挂在哪条职责上：本人在那条职责上的分配就是这张卡的岗位（决定时带它）
  const positions = useQuery({ queryKey: ['positions'], queryFn: getPositions })
  // WP477：这张卡挂在哪条职责上
  useTelemetryContext(item.data === undefined ? undefined : { role_id: item.data.role_id })

  const decision = useMutation({
    mutationFn: (input: { card: DeckCard; request: DeckDecideRequest }) =>
      decide(
        input.card.id,
        {
          action: input.request.action,
          version: input.request.version,
          ...(input.request.selected_option_id === undefined
            ? {}
            : { selected_option_id: input.request.selected_option_id }),
          ...(input.request.instruction === undefined
            ? {}
            : { instruction: input.request.instruction }),
          ...(input.request.reason === undefined ? {} : { reason: input.request.reason }),
        },
        input.card.position_id,
      ),
    onError: (err) => {
      setError(err.message)
      setReceipt('')
    },
    onSuccess: () => {
      setError('')
      setReceipt(t('cardPage.done'))
    },
    onSettled: () => {
      void client.invalidateQueries({ queryKey: ['approval', id] })
      void client.invalidateQueries({ queryKey: ['deck'] })
      void client.invalidateQueries({ queryKey: ['home'] })
    },
  })

  const back = (
    <Link
      to="/"
      data-testid="card-page-home"
      className="inline-flex items-center gap-1 text-xs text-ws-muted-fg hover:text-ws-ink"
    >
      <ArrowLeft className="size-3" aria-hidden />
      {t('cardPage.home')}
    </Link>
  )

  // 岗位列表也等一下：决定要带对那条分配（取失败就退回当前分配，不卡住）
  if (item.isPending || positions.isPending)
    return (
      <div className={`flex flex-col gap-3 ${DECK_MAX_WIDTH_CLASS}`} data-testid="card-page">
        {back}
        <Skeleton className="h-64 w-full" />
      </div>
    )

  if (item.error !== null) {
    const missing = item.error instanceof ApiClientError && item.error.status === 404
    return (
      <div className={`flex flex-col gap-3 ${DECK_MAX_WIDTH_CLASS}`} data-testid="card-page">
        {back}
        {missing ? (
          <p role="alert" data-testid="card-page-missing" className="text-sm text-ws-muted-fg">
            {t('cardPage.missing')}
          </p>
        ) : (
          <PageError error={item.error} onRetry={() => void item.refetch()} />
        )}
      </div>
    )
  }

  // 找不到（底座职责 `common.*` 之类不在岗位列表里）就用当前那条分配
  const position_id =
    positions.data?.positions.find((p) => p.role_id === item.data.role_id)?.position_id ??
    assignmentId() ??
    ''
  // WP415：服务端说这一步还没接通 / 是演示，卡上照实标（与牌堆同一把尺子）
  const wiring = (item.data as { execution_wiring?: ExecutionWiring }).execution_wiring
  const card = projectCard(item.data, {
    now: new Date().toISOString(),
    position_id,
    ...(wiring === undefined ? {} : { wiring: () => wiring }),
  })
  const settled = !DECIDABLE_STATES.includes(item.data.state)

  return (
    <div
      className={`flex flex-col gap-3 ${DECK_MAX_WIDTH_CLASS}`}
      data-testid="card-page"
      data-card={card.id}
      // 定过的卡：卡上那个状态签（「已处理」）就说清了，不再多写一行字
      data-settled={settled ? 'true' : undefined}
    >
      {back}
      {receipt !== '' ? (
        <p role="status" className="text-xs text-ws-good" data-testid="card-page-receipt">
          {receipt}
        </p>
      ) : null}
      <DeckCardView
        card={card}
        mode={DEFAULT_CONTENT_MODE}
        busy={decision.isPending}
        {...(error === '' ? {} : { error })}
        onDecide={(request) => {
          decision.mutate({ card, request })
        }}
        onOpen={(c) => {
          navigate(matterUrl(c))
        }}
      />
    </div>
  )
}
