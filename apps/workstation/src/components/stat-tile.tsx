/**
 * 36 §3 数字块：**只显示值、环比箭头、迷你走势线**（参考 Shopify 后台的四个块）。
 *
 * 迷你走势是一条内联 SVG 折线，不是图表组件——首页不放图表也不放表格，
 * 那些在岗位面板里（36 §5.2）。数据源没连上时这里出「去连接」，不出空图。
 */
import type { StatTile } from '@agentsws/deck'
import { ArrowDownRight, ArrowRight, ArrowUpRight, Link2Off } from 'lucide-react'
import { Link } from 'react-router-dom'
import { connectPathFor } from '@/components/connections/links'
import { useApp } from '@/lib/app-context'
import { formatDelta, formatValue } from '@/lib/format'

function Sparkline({ points }: { points: number[] }): React.ReactNode {
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
      className="h-6 w-full text-muted-foreground/60"
      aria-hidden="true"
      focusable="false"
      data-testid="sparkline"
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

const ARROW = { up: ArrowUpRight, down: ArrowDownRight, flat: ArrowRight }

export function StatTileView({ tile }: { tile: StatTile }): React.ReactNode {
  const { t, lang } = useApp()
  if (tile.status === 'not_connected') {
    return (
      <div
        className="flex flex-col justify-between rounded-lg border border-dashed p-3"
        data-testid="stat-tile"
        data-tile={tile.id}
        data-status="not_connected"
      >
        <div className="text-xs text-muted-foreground">{tile.label}</div>
        {/* WP20 §C：点它就落到那个数据源对应的 provider 卡片上 */}
        <Link
          to={connectPathFor(tile.source)}
          className="mt-2 flex items-center gap-1.5 text-sm underline-offset-4 hover:underline"
          data-testid="tile-connect-link"
        >
          <Link2Off className="size-3.5" aria-hidden />
          <span>{t('tile.not_connected')}</span>
        </Link>
        <p className="mt-1 text-[11px] text-muted-foreground">{t('tile.not_connected.hint')}</p>
      </div>
    )
  }
  const delta = formatDelta(tile, lang)
  const Arrow = ARROW[tile.direction ?? 'flat']
  return (
    <div
      className="flex flex-col gap-1 rounded-lg border p-3"
      data-testid="stat-tile"
      data-tile={tile.id}
      data-status="ok"
    >
      <div className="text-xs text-muted-foreground">{tile.label}</div>
      <div className="text-xl font-semibold tabular-nums">
        {formatValue(tile.value, tile.format, lang, tile.currency)}
      </div>
      <div className="flex items-center gap-1 text-xs text-muted-foreground">
        <Arrow className="size-3" aria-hidden />
        <span className="tabular-nums">{delta ?? '—'}</span>
        <span>{t(`range.compare.${tile.range}`)}</span>
      </div>
      <Sparkline points={tile.spark} />
    </div>
  )
}
