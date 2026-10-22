/**
 * 合作的五档色与四组（WP302，决策 406 第一期）。
 *
 * 色阶移植自 KOLAgents（Luoye 的产品，非模板代码）：`src/components/influencer/cards/status-tier.ts`
 * @ 88d74b2c——五档按急到缓：红（要你动手）/ 蓝（我们这边排上了）/ 黄（球在对方那儿）/
 * 绿（在做）/ 灰（没事）。颜色换成工坊的 `--ws-*` 令牌。哪一条落在哪一档由服务端
 * （`kol-core` 的 `collabStatus`）判，这里只管上色、分组。
 *
 * 档 → 组同 `kol-core` 的 `groupOfTier`（工作台不依赖服务端包，照抄这一行）。
 */
import type { ReactNode } from 'react'
import type { KolCollabTier } from '@/lib/api'
import { useApp } from '@/lib/app-context'
import { cn } from '@/lib/utils'

export const COLLAB_GROUPS = ['action', 'waiting', 'active', 'idle'] as const
export type CollabGroup = (typeof COLLAB_GROUPS)[number]

const TIER_ORDER: readonly KolCollabTier[] = ['action', 'scheduled', 'waiting', 'active', 'idle']

export function groupOfTier(tier: KolCollabTier | undefined): CollabGroup {
  if (tier === undefined) return 'active'
  return tier === 'scheduled' ? 'waiting' : tier
}

export function tierRank(tier: KolCollabTier | undefined): number {
  const i = tier === undefined ? -1 : TIER_ORDER.indexOf(tier)
  return i === -1 ? TIER_ORDER.length : i
}

const TIER_TONE: Readonly<Record<KolCollabTier, string>> = {
  action: 'bg-ws-bad-bg text-ws-bad',
  scheduled: 'bg-ws-info-bg text-ws-info',
  waiting: 'bg-ws-warn-bg text-ws-warn',
  active: 'bg-ws-good-bg text-ws-good',
  idle: 'bg-muted text-muted-foreground',
}

/** 清单行上那一小句，带档色。 */
export function TierTag({
  tier,
  label,
  className,
}: {
  tier: KolCollabTier
  label: string
  className?: string
}): ReactNode {
  return (
    <span
      className={cn(
        'inline-flex h-5 shrink-0 items-center rounded-full px-2 text-xs font-medium whitespace-nowrap',
        TIER_TONE[tier],
        className,
      )}
      data-testid="kol-collab-tier"
      data-tier={tier}
    >
      {label}
    </span>
  )
}

/** 组标题（只有组里有人才出，docs/96 P3）。 */
export function GroupTitle({ group, n }: { group: CollabGroup; n: number }): ReactNode {
  const { t } = useApp()
  return (
    <h4
      className="mt-1 flex items-baseline gap-1.5 text-xs font-medium text-muted-foreground"
      data-testid="kol-collab-group"
      data-group={group}
    >
      {t(`kol.collab.group.${group}`)}
      <span className="ws-num font-normal">{n}</span>
    </h4>
  )
}

/**
 * docs/96 P1：要你批的东西只在卡片流里。合作清单上「有卡等你批」那一行不放批的按钮，
 * 点了滚到同一页上面的卡片流（岗位页才有；单独的红人页回首页的卡片流）。
 */
export function jumpToCards(navigate: (to: string) => void): void {
  const deck = globalThis.document?.querySelector('[data-testid="position-deck"]')
  if (deck instanceof HTMLElement) {
    deck.scrollIntoView?.({ behavior: 'smooth', block: 'start' })
    return
  }
  navigate('/')
}
