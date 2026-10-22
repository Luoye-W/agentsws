/**
 * WP456-T2（WP456 §2.6 第 13 条）：**决定卡外壳**——「要你处理」、事项页里的卡、卡片流共用一种。
 *
 * 外壳只管框和几段的位置，不管里面写什么（那是各张卡自己的事，T3 再收内容）：
 * - 卡：无边框、圆角 16、卡阴影（深色带一圈细边）。以前事项页那几种「绿框 / 黄框 / 红框」都去掉——
 *   颜色只表示状态，状态用头一行的药丸说；
 * - 头一行 `DecisionCardHead`：分类标签 + 状态药丸，右边「证据 N」之类；
 * - 中间 `DecisionCardBody`：标题 16、说明一行灰字，下面放对比块 `CompareBlock` / 选项组 `OptionGroup`；
 * - 底一行 `DecisionCardFoot`：主 / 次 / 弱三个按钮，快捷键（`keys`）灰字放最右边。
 */
import type { ComponentProps, ReactNode } from 'react'
import { cn } from '@/lib/utils'

export function DecisionCard({ className, children, ...rest }: ComponentProps<'div'>): ReactNode {
  return (
    <div className={cn('ws-dcard', className)} data-slot="decision-card" {...rest}>
      {children}
    </div>
  )
}

export function DecisionCardHead({
  end,
  className,
  children,
  ...rest
}: ComponentProps<'div'> & { end?: ReactNode }): ReactNode {
  return (
    <div className={cn('ws-dcard-head', className)} {...rest}>
      {children}
      {end === undefined || end === null ? null : <span className="ws-dcard-head-end">{end}</span>}
    </div>
  )
}

export function DecisionCardBody({
  title,
  desc,
  className,
  children,
  ...rest
}: Omit<ComponentProps<'div'>, 'title'> & { title?: ReactNode; desc?: ReactNode }): ReactNode {
  return (
    <div className={cn('ws-dcard-body', className)} {...rest}>
      {title === undefined ? null : (
        <p className="ws-dcard-title" data-slot="title">
          {title}
        </p>
      )}
      {desc === undefined || desc === null ? null : <p className="ws-dcard-desc">{desc}</p>}
      {children}
    </div>
  )
}

export function DecisionCardFoot({
  keys,
  className,
  children,
  ...rest
}: ComponentProps<'div'> & {
  /** 快捷键提示（「↑ 稍后 · ↓ 修改」），灰字放最右边。 */
  keys?: ReactNode
}): ReactNode {
  return (
    <div className={cn('ws-dcard-foot', className)} {...rest}>
      {children}
      {keys === undefined || keys === null ? null : <span className="ws-dcard-keys">{keys}</span>}
    </div>
  )
}

/** 对比块：左「现在」、右「改成」（右边品牌浅底）。 */
export function CompareBlock({
  before,
  after,
  beforeLabel,
  afterLabel,
  className,
}: {
  before: ReactNode
  after: ReactNode
  beforeLabel: ReactNode
  afterLabel: ReactNode
  className?: string
}): ReactNode {
  return (
    <div className={cn('ws-cmp', className)} data-slot="data">
      <div className="ws-cmp-cell">
        <div className="ws-cmp-label">{beforeLabel}</div>
        <div>{before}</div>
      </div>
      <div className="ws-cmp-cell" data-after="true">
        <div className="ws-cmp-label">{afterLabel}</div>
        <div>{after}</div>
      </div>
    </div>
  )
}

export interface DecisionOption {
  id: string
  label: ReactNode
  /** 右边的灰字（「推荐」「上次选的」）。 */
  note?: ReactNode
  disabled?: boolean
  testId?: string
}

/** 选项组：整行可点，选中那行品牌浅底；读屏是一组带名字的按钮（选中那颗 `aria-pressed`）。 */
export function OptionGroup({
  options,
  value,
  onChange,
  label,
  className,
}: {
  options: readonly DecisionOption[]
  value: string | undefined
  onChange: (id: string) => void
  label: string
  className?: string
}): ReactNode {
  return (
    <fieldset aria-label={label} className={cn('ws-opts m-0 border-0 p-0', className)}>
      {options.map((o) => {
        const on = o.id === value
        return (
          <button
            key={o.id}
            type="button"
            aria-pressed={on}
            className="ws-opt"
            data-on={on ? 'true' : 'false'}
            data-option={o.id}
            disabled={o.disabled}
            {...(o.testId === undefined ? {} : { 'data-testid': o.testId })}
            onClick={() => {
              onChange(o.id)
            }}
          >
            <span aria-hidden className="ws-opt-radio" />
            <span className="min-w-0 flex-1">{o.label}</span>
            {o.note === undefined ? null : (
              <span className="shrink-0 text-xs text-ws-muted-fg">{o.note}</span>
            )}
          </button>
        )
      })}
    </fieldset>
  )
}
