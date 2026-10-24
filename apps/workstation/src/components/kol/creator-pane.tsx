/**
 * WP500（决策 1758）：红人详情开在**第三栏**（KOLAgents 是红人池右边滑出的抽屉；工坊照 WP481 的规矩——
 * 第三栏同一时间一格、头上 ×、窗口够宽时并排、窄了盖在中栏上）。
 *
 * 和收件箱那一格（WP459 `inbox-item`）同一个做法：开哪个人记在这里（只在内存里），第三栏按面板 id
 * `kol-creator` 开一格，身体从这里读。再点另一个人 = 换人，不另开。
 *
 * 开不出来（单独渲染的页面、单测里没有外壳）时 {@link openCreatorPane} 回 `false`，调用方就地画详情。
 */
import { useQuery } from '@tanstack/react-query'
import { ArrowLeft } from 'lucide-react'
import { type ReactNode, useSyncExternalStore } from 'react'
import { EmptyState, SkeletonList } from '@/components/design'
import { openRightPane } from '@/components/rail/right-pane'
import { Button } from '@/components/ui/button'
import { getKolCreator, type KolChannelId } from '@/lib/api'
import { useApp } from '@/lib/app-context'
import { CreatorInfoCard } from './creator-info-card'
import { errorText, KolError } from './kol-shared'

/** 第三栏那一格的面板 id（`builtin-panels.tsx` 注册）。 */
export const KOL_CREATOR_PANE = 'kol-creator'

export interface CreatorPaneTarget {
  assignment: string
  channel: KolChannelId
  id: string
}

let target: CreatorPaneTarget | undefined
const listeners = new Set<() => void>()
const publish = (next: CreatorPaneTarget | undefined): void => {
  target = next
  for (const l of listeners) l()
}
const subscribe = (l: () => void): (() => void) => {
  listeners.add(l)
  return () => {
    listeners.delete(l)
  }
}

/** 现在第三栏里开着（或要开）的是谁。 */
export function useCreatorPaneTarget(): CreatorPaneTarget | undefined {
  return useSyncExternalStore(
    subscribe,
    () => target,
    () => target,
  )
}

/** 在第三栏开这个人。回 `false` = 没有外壳的第三栏（调用方就地画）。 */
export function openCreatorPane(next: CreatorPaneTarget): boolean {
  const before = target
  publish(next)
  const opened = openRightPane({ kind: 'panel', id: KOL_CREATOR_PANE })
  if (!opened) publish(before)
  return opened
}

/** 只给测试用。 */
export function resetCreatorPane(): void {
  publish(undefined)
}

/**
 * 一个人的详情：取数 + {@link CreatorInfoCard}。第三栏、就地、叠在候选池上面三处都用它。
 * `onBack` 给了就在顶上画一个「← 返回」（叠在第三栏里那种；第三栏自己的 × 在外壳上）。
 */
export function CreatorDetailView({
  assignment,
  channel,
  id,
  onBack,
  onRepoint,
}: CreatorPaneTarget & {
  onBack?: (() => void) | undefined
  onRepoint?: ((id: string) => void) | undefined
}): ReactNode {
  const { t } = useApp()
  const detail = useQuery({
    queryKey: ['kol-creator', id],
    queryFn: () => getKolCreator(id, assignment),
  })
  return (
    <div className="flex flex-col gap-3" data-testid="kol-creator-view">
      {onBack === undefined ? null : (
        <div>
          <Button size="xs" variant="ghost" data-testid="kol-detail-close" onClick={onBack}>
            <ArrowLeft className="size-3.5" aria-hidden />
            {t('kol.detail.back')}
          </Button>
        </div>
      )}
      {detail.isPending ? <SkeletonList rows={4} /> : null}
      {detail.error === null ? null : (
        <KolError
          error={errorText(detail.error, '这个红人的详情没取回来。')}
          testid="kol-detail-load-error"
        />
      )}
      {detail.data === undefined ? null : (
        <CreatorInfoCard
          view={detail.data}
          assignment={assignment}
          channel={channel}
          onRepoint={onRepoint}
        />
      )}
    </div>
  )
}

/** 第三栏那一格的身体。 */
export function CreatorPaneBody(): ReactNode {
  const { t } = useApp()
  const current = useCreatorPaneTarget()
  if (current === undefined)
    return <EmptyState text={t('kol.detail.pane.empty')} data-testid="kol-creator-pane-empty" />
  return (
    <CreatorDetailView
      key={current.id}
      {...current}
      onRepoint={(id) => {
        publish({ ...current, id })
      }}
    />
  )
}
