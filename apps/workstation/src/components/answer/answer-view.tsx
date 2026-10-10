/**
 * WP291（决策 356；docs/96 §3 P4、§4.2）：当场回答的组件——按契约 `AnswerComponent` 的 `kind` 画，
 * 模型不吐 HTML。先做三种：一段字、表格 / 清单、数字；认不得的 `kind` 不画（新组件留口）。
 *
 * 岗位页输入框下面的当场回答、线程里 AI 那段话（带 ```answer 的）都用它。只排版，不算数。
 */
import type { AnswerComponent, AnswerMetric, AnswerTable } from '@agentsws/contracts'
import type { ReactNode } from 'react'
import { DeltaPill } from '@/components/design/primitives'
import { useApp } from '@/lib/app-context'

const fmt = (v: number | string, lang: string): string =>
  typeof v === 'number' ? v.toLocaleString(lang === 'en' ? 'en-US' : 'zh-CN') : v

function TableView({ c }: { c: AnswerTable }): ReactNode {
  const { t, lang } = useApp()
  // 一列全是数字 → 右对齐、等宽数字
  const numeric = c.columns.map((_, i) =>
    c.rows.every((r) => r[i] === null || typeof r[i] === 'number'),
  )
  return (
    <div data-testid="answer-table">
      <div className="max-w-full overflow-x-auto rounded-lg shadow-[inset_0_0_0_1px_var(--ws-line)]">
        <table className="w-full border-collapse text-[13px]">
          <thead>
            <tr className="text-left text-xs text-ws-muted-fg">
              {c.columns.map((col, i) => (
                <th
                  // biome-ignore lint/suspicious/noArrayIndexKey: 列没有 id，顺序就是身份
                  key={i}
                  scope="col"
                  className={`border-b border-ws-line px-3 py-2 font-medium whitespace-nowrap ${numeric[i] ? 'text-right' : ''}`}
                >
                  {col}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {c.rows.map((row, r) => (
              // biome-ignore lint/suspicious/noArrayIndexKey: 行没有 id，顺序就是身份
              <tr key={r} className="border-b border-ws-line last:border-b-0">
                {row.map((cell, i) => (
                  <td
                    // biome-ignore lint/suspicious/noArrayIndexKey: 同上
                    key={i}
                    className={`px-3 py-1.5 text-ws-ink ${numeric[i] ? 'ws-num text-right whitespace-nowrap' : ''}`}
                  >
                    {cell === null ? '—' : fmt(cell, lang)}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {c.total === undefined ? null : (
        <p className="mt-1 text-xs text-ws-muted-fg" data-testid="answer-table-total">
          {t('answer.table.total', { shown: c.rows.length, total: c.total })}
        </p>
      )}
    </div>
  )
}

function MetricTile({ m }: { m: AnswerMetric }): ReactNode {
  const { lang } = useApp()
  const delta = m.delta_pct
  return (
    <div
      className="flex min-w-[120px] flex-col gap-1 rounded-lg bg-ws-card px-3.5 py-3 shadow-[inset_0_0_0_1px_var(--ws-line)]"
      data-testid="answer-metric"
    >
      <span className="text-xs text-ws-muted-fg">{m.label}</span>
      <span className="ws-display text-[22px] leading-none text-ws-ink">
        {fmt(m.value, lang)}
        {m.unit === undefined ? null : (
          <span className="ml-0.5 text-[13px] text-ws-body">{m.unit}</span>
        )}
      </span>
      {delta === undefined ? null : (
        <DeltaPill direction={delta > 0 ? 'up' : delta < 0 ? 'down' : 'flat'}>
          {`${Math.abs(delta)}%`}
        </DeltaPill>
      )}
    </div>
  )
}

export function AnswerComponents({
  components,
}: {
  components: readonly AnswerComponent[]
}): ReactNode {
  if (components.length === 0) return null
  return (
    <div className="flex flex-col gap-3" data-testid="answer-components">
      {components.map((c, i) => {
        const key = `${c.kind}-${i}`
        if (c.kind === 'text')
          return (
            <p
              key={key}
              className="text-[14px] leading-[1.7] whitespace-pre-wrap text-ws-body"
              data-testid="answer-text"
            >
              {c.text}
            </p>
          )
        if (c.kind === 'table') return <TableView key={key} c={c} />
        if (c.kind === 'metric')
          return (
            <div key={key} className="flex flex-wrap gap-2.5" data-testid="answer-metrics">
              {c.items.map((m) => (
                <MetricTile key={m.label} m={m} />
              ))}
            </div>
          )
        return null
      })}
    </div>
  )
}
