/**
 * WP335（docs/99 §5.6）：**Prompt × AI 方格**——每格一个符号：
 * 绿点 + 名次 = 提到了、蓝色角标 = 引用了我们、灰叉 = 没提到、空 = 没查成；行尾小箭头 = 比上一期升 / 降。
 *
 * 点一格 → 第三栏「一条回答」（`agentsws://geo-answer/<分配>/<回答 id>`，不离开这一页）。
 * 怎么读进问号（页面零说明）；Claude 那一列的表头带一个问号（取数说明，不写取数方式与批发商名）。
 * 好几个市场时每格按市场再分（每个市场各一个符号，前面一个国家码）。
 */
import type { AiPlatform, GeoGridCell, GeoGridView } from '@agentsws/contracts'
import { Link2, X } from 'lucide-react'
import type { ReactNode } from 'react'
import { useRailState } from '@/components/rail/rail-state'
import { Hint } from '@/components/ui/hint'
import { useApp } from '@/lib/app-context'
import { geoAnswerAddress } from '@/lib/geo-watch-api'
import { ChangeMark } from './geo-bits'

function CellMark({ cell }: { cell: GeoGridCell }): ReactNode {
  const { t } = useApp()
  if (cell.state === 'failed')
    return (
      <span
        role="img"
        className="inline-block size-3"
        aria-label={t('geo.cell.failed')}
        title={t('geo.cell.failed')}
      />
    )
  if (cell.state === 'absent')
    return <X role="img" className="size-3.5 text-ws-muted-fg" aria-label={t('geo.cell.absent')} />
  const label =
    cell.rank === undefined
      ? t('geo.cell.mentioned_norank')
      : t('geo.cell.mentioned', { n: String(cell.rank) })
  return (
    <span
      role="img"
      className="relative inline-flex items-center gap-1"
      aria-label={label}
      title={label}
    >
      <span className="inline-block size-2 rounded-full bg-ws-good" aria-hidden />
      {cell.rank === undefined ? null : (
        <span className="ws-num text-xs font-medium text-ws-good">{cell.rank}</span>
      )}
      {cell.cited ? (
        <Link2
          role="img"
          className="-mt-2 size-3 text-ws-info"
          aria-label={t('geo.cell.cited')}
          data-testid="geo-cell-cited"
        />
      ) : null}
    </span>
  )
}

export function GeoGrid({
  grid,
  assignment,
}: {
  grid: GeoGridView
  assignment: string
}): ReactNode {
  const { t } = useApp()
  const rail = useRailState()
  if (grid.rows.length === 0) return null
  const many = grid.markets.length > 1
  const open = (cell: GeoGridCell): void => {
    rail.openAddress(geoAnswerAddress(assignment, cell.answer_id))
  }
  const head = (p: AiPlatform): ReactNode => (
    <span className="inline-flex items-center gap-1">
      {t(`geo.platform.${p}`)}
      {p === 'claude' ? <Hint text={t('geo.claude.hint')} testId="geo-claude-hint" /> : null}
    </span>
  )
  return (
    <div className="flex flex-col gap-2" data-testid="geo-grid">
      <h4 className="flex items-center gap-1 text-sm font-medium">
        {t('geo.grid')}
        <Hint text={t('geo.grid.hint')} />
      </h4>
      <div className="-mx-1 overflow-x-auto">
        <table className="w-full text-[13px]">
          <thead>
            <tr className="bg-ws-surface text-left text-xs font-medium text-ws-muted-fg">
              <th scope="col" className="rounded-l-lg px-3 py-2.5">
                {t('geo.grid.prompt')}
              </th>
              {grid.platforms.map((p) => (
                <th key={p} scope="col" className="px-2 py-2.5 text-center">
                  {head(p)}
                </th>
              ))}
              <th scope="col" className="w-8 rounded-r-lg px-2 py-2.5">
                <span className="sr-only">{t('geo.change.up')}</span>
              </th>
            </tr>
          </thead>
          <tbody>
            {grid.rows.map((row) => (
              <tr
                key={row.prompt_id}
                className="border-b border-ws-line last:border-0"
                data-testid="geo-grid-row"
                data-prompt={row.prompt_id}
              >
                <td className="max-w-[22rem] px-3 py-2.5">
                  <span className="line-clamp-2">{row.prompt_text}</span>
                  {row.branded === true ? (
                    <span className="text-xs text-ws-muted-fg">{t('geo.grid.branded')}</span>
                  ) : null}
                </td>
                {grid.platforms.map((p) => {
                  const cells = row.cells.filter((c) => c.platform === p)
                  return (
                    <td key={p} className="px-2 py-2.5 text-center">
                      <span className="inline-flex flex-col items-center gap-1">
                        {cells.map((c) => (
                          <button
                            key={`${c.platform}|${c.market}`}
                            type="button"
                            data-testid="geo-cell"
                            data-state={c.state}
                            data-answer={c.answer_id}
                            className="inline-flex min-h-6 min-w-8 items-center justify-center gap-1 rounded-md px-1 hover:bg-ws-surface focus-visible:outline-2"
                            onClick={() => open(c)}
                          >
                            {many ? (
                              <span className="text-ws-tiny text-ws-muted-fg">{c.market}</span>
                            ) : null}
                            <CellMark cell={c} />
                          </button>
                        ))}
                      </span>
                    </td>
                  )
                })}
                <td className="px-2 py-2.5">
                  <ChangeMark change={row.change} />
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  )
}
