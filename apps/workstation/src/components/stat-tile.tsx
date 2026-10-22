/**
 * 36 §3 数字块：**只显示值、环比箭头、迷你走势线**（参考 Shopify 后台的四个块）。
 *
 * 迷你走势是一条内联 SVG 折线，不是图表组件——首页不放图表也不放表格，
 * 那些在岗位面板里（36 §5.2）。数据源没连上时这里出「去连接」，不出空图。
 *
 * WP96：外观换成设计画布那块 `StatTile`（圆图标徽 + 30px 大数字 + 涨跌胶囊），
 * 但**这一层的职责没变**：它只把服务端算好的 `StatTile` 排出来，一个数都不算。
 */
import type { StatTile as StatTileData } from '@agentsws/deck'
import { Link2Off, TrendingUp } from 'lucide-react'
import { connectServiceFor } from '@/components/connections/links'
import type { Direction, Tone } from '@/components/design'
import { StatTile } from '@/components/design'
import { useOpenConnect } from '@/components/setup/use-open-connect'
import { useApp } from '@/lib/app-context'
import { formatDelta, formatValue } from '@/lib/format'

/**
 * 迷你走势线。testid 保持 `sparkline`：36 §5.2 那条「首页无图表」的断言按它数。
 * WP392：竞品变化表的价格走势也用它（换个 testid、可换尺寸）。
 */
export function Sparkline({
  points,
  testId = 'sparkline',
  className = 'h-6 w-24 text-ws-brand',
}: {
  points: number[]
  testId?: string
  className?: string
}): React.ReactNode {
  if (points.length < 2) return null
  const max = Math.max(...points)
  const min = Math.min(...points)
  const span = max - min === 0 ? 1 : max - min
  const step = 100 / (points.length - 1)
  const path = points
    .map((v, i) => `${(i * step).toFixed(2)},${(24 - ((v - min) / span) * 22).toFixed(2)}`)
    .join(' ')
  return (
    <svg
      viewBox="0 0 100 24"
      preserveAspectRatio="none"
      className={className}
      aria-hidden="true"
      focusable="false"
      data-testid={testId}
    >
      <polyline
        points={path}
        fill="none"
        stroke="currentColor"
        strokeWidth="1.5"
        vectorEffect="non-scaling-stroke"
      />
    </svg>
  )
}

const DIRECTION: Record<string, Direction> = { up: 'up', down: 'down', flat: 'flat' }

/** 数据源 → 图标徽的颜色。只是分得开，不表示好坏（好坏在涨跌胶囊上）。 */
const TONE_BY_SOURCE: Record<string, Tone> = {
  shop: 'good',
  ga4: 'info',
  gsc: 'info',
  ads: 'warn',
  approvals: 'brand',
}

export function StatTileView({ tile }: { tile: StatTileData }): React.ReactNode {
  const { t, lang } = useApp()
  const openConnect = useOpenConnect()
  if (tile.status === 'not_connected') {
    return (
      <div data-testid="stat-tile" data-tile={tile.id} data-status="not_connected">
        <StatTile
          value=""
          label={tile.label}
          tone="neutral"
          fallback={
            <>
              {/* WP324（决策 690）：点它在第三栏就地连那个数据源（不跳到连接页） */}
              <button
                type="button"
                onClick={() => {
                  openConnect(connectServiceFor(tile.source))
                }}
                className="flex items-center gap-1.5 text-sm underline-offset-4 hover:underline"
                data-testid="tile-connect-link"
                data-connect={connectServiceFor(tile.source)}
              >
                <Link2Off className="size-3.5" aria-hidden />
                <span>{t('tile.not_connected')}</span>
              </button>
              <p className="mt-1 text-xs text-ws-muted-fg">{t('tile.not_connected.hint')}</p>
            </>
          }
        />
      </div>
    )
  }
  const delta = formatDelta(tile, lang)
  return (
    <div data-testid="stat-tile" data-tile={tile.id} data-status="ok">
      <StatTile
        icon={<TrendingUp className="size-[18px]" aria-hidden />}
        tone={TONE_BY_SOURCE[tile.source] ?? 'brand'}
        value={formatValue(tile.value, tile.format, lang, tile.currency)}
        label={tile.label}
        delta={`${delta ?? '—'} ${t(`range.compare.${tile.range}`)}`}
        direction={DIRECTION[tile.direction ?? 'flat'] ?? 'flat'}
        spark={<Sparkline points={tile.spark} />}
      />
    </div>
  )
}
