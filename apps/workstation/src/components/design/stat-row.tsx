/**
 * StatRow（画布首页右上"今天的数"）：行式数字 + 涨跌胶囊 + 火花线。
 *
 * 与 `StatTile` 的分工：Tile 是"这一屏的主角，一块一个数"，Row 是"边上顺带看一眼，
 * 四五行叠着"。所以这里数字只有 16px，走势线也只有 22px 高。
 */
import { DeltaPill, type Direction, SparkLine } from './primitives'
import type { Tone } from './tone'

export function StatRow({
  label,
  value,
  delta,
  direction,
  deltaTone,
  spark,
  fallback,
}: {
  label: string
  /** 已经格式化好的值 */
  value: string
  delta?: string
  direction?: Direction
  deltaTone?: Tone
  spark?: number[]
  /** 数据源没连上时顶掉数字的那个节点 */
  fallback?: React.ReactNode
}): React.ReactNode {
  return (
    <div
      data-testid="ws-stat-row"
      className="flex items-center gap-3 border-b border-ws-line py-2.5 last:border-b-0"
    >
      <span className="w-[110px] shrink-0 text-[13px] text-ws-body">{label}</span>
      {fallback === undefined ? (
        <>
          <span className="ws-display ws-num w-[90px] shrink-0 text-base">{value}</span>
          {delta === undefined ? null : (
            <DeltaPill
              {...(direction === undefined ? {} : { direction })}
              {...(deltaTone === undefined ? {} : { tone: deltaTone })}
            >
              {delta}
            </DeltaPill>
          )}
          <span className="flex-1" />
          {spark === undefined ? null : <SparkLine points={spark} />}
        </>
      ) : (
        <span className="flex-1 text-[13px]">{fallback}</span>
      )}
    </div>
  )
}
