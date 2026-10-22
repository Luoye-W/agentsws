/**
 * WP456-T2（WP456 §2.6 第 11 条）：**分段切换全站只留一种**——灰底，选中那一格白底加一点小阴影
 * （深色下比卡亮一档）。页签、筛选、浅 / 深色、月 / 周都用它；以前设置「通用」里的品牌绿实底、
 * 各页各写的「选中 = secondary 底」那几份都换成这一个。
 *
 * 两种语义（看的人看不出区别，读屏和键盘听得出）：
 * - `kind="radio"`（默认）：几选一的设置 / 筛选，每格是 `aria-pressed` 的按钮，外面一个带名字的 `fieldset`；
 * - `kind="tabs"`：切的是下面那块内容（右栏的页签、通知面板的「未读 / 全部」），`role=tablist` + `role=tab`。
 *
 * 每格的 `testId` / `data-value` 照原来那几份的写法挂上，老测试不用改选择器。
 */
import type { ReactNode } from 'react'
import { cn } from '@/lib/utils'

export interface SegmentedOption<V extends string> {
  value: V
  label: ReactNode
  /** 字前面的小图标（14）。 */
  icon?: ReactNode
  /** 字后面的灰色计数。 */
  count?: number | string | undefined
  testId?: string
  disabled?: boolean
  /** 鼠标停上去的说明（图标格必须给）。 */
  title?: string
  /** 再挂一些 data-*（排障 / 测试用）。 */
  data?: Record<`data-${string}`, string>
}

export function Segmented<V extends string>({
  value,
  options,
  onChange,
  label,
  kind = 'radio',
  size = 'md',
  testId,
  disabled = false,
  className,
  reselect = false,
}: {
  value: V | undefined
  options: readonly SegmentedOption<V>[]
  onChange: (v: V) => void
  /** 这一组叫什么（读屏念的）。 */
  label: string
  kind?: 'radio' | 'tabs'
  /** `sm`：右栏、弹层里那种窄地方（每格 22 高）。 */
  size?: 'md' | 'sm'
  testId?: string
  disabled?: boolean
  className?: string
  /** 点已经选中的那格也回调（「再点一下回到默认」那种页签）。 */
  reselect?: boolean
}): ReactNode {
  const tabs = kind === 'tabs'
  const items = options.map((o) => {
    const on = o.value === value
    return (
      <button
        key={o.value}
        type="button"
        className="ws-seg-item"
        data-on={on ? 'true' : 'false'}
        data-value={o.value}
        disabled={o.disabled}
        {...(tabs ? { role: 'tab', 'aria-selected': on } : { 'aria-pressed': on })}
        {...(o.title === undefined ? {} : { title: o.title })}
        {...(o.testId === undefined ? {} : { 'data-testid': o.testId })}
        {...(o.data ?? {})}
        onClick={() => {
          if (!on || reselect) onChange(o.value)
        }}
      >
        {o.icon}
        {o.label}
        {o.count === undefined ? null : <span className="ws-seg-count">{o.count}</span>}
      </button>
    )
  })
  const cls = cn('ws-seg', size === 'sm' && 'ws-seg-sm', className)
  const tid = testId === undefined ? {} : { 'data-testid': testId }
  if (tabs)
    return (
      <div role="tablist" aria-label={label} className={cls} data-slot="segmented" {...tid}>
        {items}
      </div>
    )
  return (
    <fieldset aria-label={label} disabled={disabled} className={cls} data-slot="segmented" {...tid}>
      {items}
    </fieldset>
  )
}
