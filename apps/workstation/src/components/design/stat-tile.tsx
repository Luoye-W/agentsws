/**
 * StatTile（画布 `.t2`）：彩色圆形图标徽 + 30px 大数字 + 标签 + 涨跌胶囊。
 *
 * 岗位页第一屏那四块就是它。它**只排版，不算数**：值、涨跌、方向都由上面传进来
 * （14 §2「数字不经模型手」——这一层连算都不算）。数据源没连上时出 `fallback`，
 * 不出一个假的 0。
 */
import { DeltaPill, type Direction, WsCard } from './primitives'
import { TONE_BADGE, type Tone } from './tone'

export function StatTile({
  icon,
  tone = 'brand',
  value,
  label,
  delta,
  direction,
  deltaTone,
  note,
  fallback,
  spark,
  selected,
  onClick,
}: {
  /** 一个 lucide 图标节点，放在圆徽里 */
  icon?: React.ReactNode
  tone?: Tone
  /** 已经格式化好的值，例如 `US$8,412` */
  value: string
  label: string
  /** 已经格式化好的涨跌，例如 `8.2% 比上周同时`；没有就不出胶囊 */
  delta?: string
  direction?: Direction
  deltaTone?: Tone
  /** 大数字下面那一句（画布上的 "低于 5 件"） */
  note?: string
  /** 数据源没连上时顶掉整块内容的那个节点 */
  fallback?: React.ReactNode
  /** 右下角那条走势线（深色画板那种）；自己画的，不上图表库 */
  spark?: React.ReactNode
  selected?: boolean
  onClick?: () => void
}): React.ReactNode {
  return (
    <WsCard
      data-testid="ws-stat-tile"
      {...(selected === undefined ? {} : { selected })}
      className="relative flex flex-col gap-3.5 p-[18px]"
      {...(onClick === undefined ? {} : { onClick })}
    >
      {icon === undefined ? null : (
        <span
          data-testid="ws-stat-tile-badge"
          className={`inline-flex size-10 items-center justify-center rounded-full ${TONE_BADGE[tone]}`}
        >
          {icon}
        </span>
      )}
      {fallback === undefined ? (
        <div>
          <div className="ws-display text-[30px] leading-none" data-testid="ws-stat-tile-value">
            {value}
          </div>
          <div className="mt-1.5 text-[13.5px] text-ws-body">{label}</div>
          {note === undefined ? null : <div className="mt-1 text-xs text-ws-muted-fg">{note}</div>}
        </div>
      ) : (
        <div>
          <div className="text-[13.5px] text-ws-body">{label}</div>
          <div className="mt-1.5">{fallback}</div>
        </div>
      )}
      <div className="flex items-end justify-between gap-2.5">
        {delta === undefined || fallback !== undefined ? (
          <span />
        ) : (
          <DeltaPill
            {...(direction === undefined ? {} : { direction })}
            {...(deltaTone === undefined ? {} : { tone: deltaTone })}
          >
            {delta}
          </DeltaPill>
        )}
        {spark}
      </div>
    </WsCard>
  )
}
