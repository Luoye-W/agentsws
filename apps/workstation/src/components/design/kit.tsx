/**
 * WP456-T2（WP456 §2.6，决策 1446 / 847）：工作台里**一套**共用的小件——页头、节标题、列表组 / 行、
 * 分类标签、数字徽章、一行提醒、空状态、骨架行。分段切换在 `segmented.tsx`，决定卡外壳在
 * `decision-card.tsx`，状态药丸照旧是 `primitives.tsx` 的 `StatusPill`。
 *
 * 样子只写在 `index.css` 的 `.ws-*` 类里（genui 宿主自己画的那几种也用这批类），这里只管结构和
 * 可达性：
 * - 能点的行是真的 `<button>` / `<a>`，键盘能到、有焦点环；
 * - 状态类的东西挂 `data-slot="status"`（少字守卫不把它算成说明字），徽章挂 `data-slot="badge"`，
 *   标题挂 `data-slot="title"`——和以前各页手搓的那几份口径一样。
 */
import { ChevronRight, TriangleAlert } from 'lucide-react'
import type { ComponentProps, ElementType, HTMLAttributes, ReactNode } from 'react'
import { Link } from 'react-router-dom'
import { cn } from '@/lib/utils'

type DivProps = Omit<ComponentProps<'div'>, 'title'>

/* ── 页头 ─────────────────────────────────────────────── */

/**
 * 页头：左边标题 22 + 一行灰字，右边操作（最多一个主按钮 + 一个分段切换）。
 * 用在消息、待办、日历、助理、技能、知识这些单栏页；岗位 / 职责 / 事项页的标题在顶栏，不另放。
 */
export function PageHeader({
  title,
  sub,
  actions,
  className,
  titleTestId,
  ...rest
}: DivProps & {
  title: ReactNode
  sub?: ReactNode
  actions?: ReactNode
  titleTestId?: string
}): ReactNode {
  return (
    <header className={cn('ws-phead', className)} data-slot="page-header" {...rest}>
      <div className="min-w-0">
        <h1
          className="ws-phead-title"
          {...(titleTestId === undefined ? {} : { 'data-testid': titleTestId })}
        >
          {title}
        </h1>
        {sub === undefined || sub === null ? null : <div className="ws-phead-sub">{sub}</div>}
      </div>
      {actions === undefined || actions === null ? null : (
        <div className="ws-phead-acts">{actions}</div>
      )}
    </header>
  )
}

/* ── 节标题 / 分组名 ─────────────────────────────────────── */

/** 节标题：14/600 + 灰色计数；右边只放图标钮或小号弱按钮。 */
export function SectionHeader({
  title,
  count,
  actions,
  as: Tag = 'h2',
  className,
  ...rest
}: DivProps & {
  title: ReactNode
  count?: number | string | undefined
  actions?: ReactNode
  as?: 'h2' | 'h3' | 'h4'
}): ReactNode {
  return (
    <div className={cn('ws-sec-head', className)} {...rest}>
      <Tag className="ws-sec-title" data-slot="title">
        {title}
        {count === undefined ? null : <span className="ws-sec-count ws-num">{count}</span>}
      </Tag>
      {actions === undefined || actions === null ? null : (
        <div className="flex items-center gap-1">{actions}</div>
      )}
    </div>
  )
}

/** 列表里的分组名：12/600 灰字，后面可跟一个计数。 */
export function GroupLabel({
  children,
  count,
  className,
  ...rest
}: DivProps & { count?: number | string | undefined }): ReactNode {
  return (
    <div className={cn('ws-group-label', className)} data-slot="title" {...rest}>
      {children}
      {count === undefined ? null : (
        <span className="ws-num font-medium text-ws-faint">{count}</span>
      )}
    </div>
  )
}

/* ── 列表组 / 行 ─────────────────────────────────────────── */

/** 列表组：一张卡里放多行，行间一条细线（待办、消息、通知、连接列表、看板清单卡都用它）。 */
export function ListGroup({
  as: Tag = 'div',
  className,
  children,
  ...rest
}: ComponentProps<'div'> & { as?: 'div' | 'ul' | 'ol' | 'section' }): ReactNode {
  const Comp = Tag as ElementType
  return (
    <Comp className={cn('ws-group', className)} data-slot="list-group" {...rest}>
      {children}
    </Comp>
  )
}

interface RowBase {
  /** 右边那一格（灰字、计数、小按钮）。 */
  end?: ReactNode
  /** 整行可点时右边那个「›」；`onClick` / `to` 给了默认就出。 */
  chevron?: boolean
  className?: string
  children?: ReactNode
}

/**
 * 列表里的一行：至少 44 高。给了 `onClick` 就是一颗整行按钮，给了 `to` 就是站内链接，
 * 都没给就是普通的一行（里面自己放勾选框、按钮）。
 */
export function ListRow({
  end,
  chevron,
  className,
  children,
  onClick,
  to,
  as,
  ...rest
}: RowBase &
  Omit<HTMLAttributes<HTMLElement>, 'onClick' | 'children'> & {
    onClick?: () => void
    to?: string
    /** 放在 `<ul>` 里时用 `li`。 */
    as?: 'div' | 'li'
  }): ReactNode {
  const act = onClick !== undefined || to !== undefined
  const showChev = chevron ?? act
  const inner = (
    <>
      {children}
      {end === undefined && !showChev ? null : (
        <span className="ws-row-end">
          {end}
          {showChev ? <ChevronRight aria-hidden className="ws-row-chev size-4" /> : null}
        </span>
      )}
    </>
  )
  if (to !== undefined)
    return (
      <Link to={to} className={cn('ws-row ws-row-act', className)} data-slot="list-row" {...rest}>
        {inner}
      </Link>
    )
  if (onClick !== undefined)
    return (
      <button
        type="button"
        className={cn('ws-row ws-row-act', className)}
        data-slot="list-row"
        onClick={onClick}
        {...rest}
      >
        {inner}
      </button>
    )
  const Comp = (as ?? 'div') as ElementType
  return (
    <Comp className={cn('ws-row', className)} data-slot="list-row" {...rest}>
      {inner}
    </Comp>
  )
}

/* ── 分类标签 / 数字徽章 ───────────────────────────────────── */

/** 分类标签：灰底、没有点（状态才用带点的 `StatusPill`）。`outline` 是描边版。 */
export function CategoryTag({
  outline = false,
  className,
  children,
  ...rest
}: ComponentProps<'span'> & { outline?: boolean }): ReactNode {
  return (
    <span
      data-slot="badge"
      className={cn('ws-tag', outline && 'ws-tag-outline', className)}
      {...rest}
    >
      {children}
    </span>
  )
}

/** 99 以上写「99+」。 */
export function countText(n: number, max = 99): string {
  return n > max ? `${max}+` : String(n)
}

/**
 * 数字徽章：灰色；要你处理的用品牌色（`brand`）；通知铃那颗「出错 / 未读」用 `alert`。
 * `corner` = 挂在图标钮右上角那一颗（外面要有 `relative`）。只放数字（11 号字只给数字和英文）。
 */
export function CountBadge({
  n,
  tone = 'neutral',
  corner = false,
  max = 99,
  className,
  ...rest
}: Omit<ComponentProps<'span'>, 'children'> & {
  n: number
  tone?: 'neutral' | 'brand' | 'alert'
  corner?: boolean
  max?: number
}): ReactNode {
  return (
    <span
      data-slot="badge"
      data-tone={tone}
      className={cn('ws-count', corner && 'ws-count-corner', className)}
      {...rest}
    >
      {countText(n, max)}
    </span>
  )
}

/* ── 一行提醒 ─────────────────────────────────────────── */

/**
 * 一行提醒：缺连接、缺设置都从整卡或黄条降到这一行——浅底、黄图标、右边一个链接。
 * `tone` 只换图标的颜色（要留意 = 黄、出错 = 红、提示 = 蓝），底色永远是浅灰，不铺一整条黄。
 * 字太长默认一行截断；`wrap` 让它折行（真要说两句的极少数地方）。
 */
export function NoticeLine({
  icon: Icon = TriangleAlert,
  tone = 'warn',
  wrap = false,
  action,
  end,
  className,
  children,
  ...rest
}: Omit<ComponentProps<'div'>, 'children'> & {
  icon?: (props: { className?: string; 'aria-hidden'?: boolean }) => ReactNode
  tone?: 'warn' | 'bad' | 'info'
  wrap?: boolean
  /** 右边那个链接（`ws-link`）；要别的（小按钮、关掉）用 `end`。 */
  action?: NoticeAction
  end?: ReactNode
  children: ReactNode
}): ReactNode {
  return (
    <div
      data-slot="status"
      data-tone={tone}
      data-wrap={wrap ? 'true' : undefined}
      className={cn('ws-notice', className)}
      {...rest}
    >
      <Icon aria-hidden className="ws-notice-icon" />
      <span className="ws-notice-text">{children}</span>
      {action === undefined && end === undefined ? null : (
        <span className="ws-notice-end">
          {end}
          {action === undefined ? null : <ActionLink action={action} />}
        </span>
      )}
    </div>
  )
}

export interface NoticeAction {
  label: ReactNode
  onClick?: () => void
  /** 站内地址；给了它（又没给 `onClick`）就是一个链接。 */
  to?: string
  testId?: string
  disabled?: boolean
  /** 其余要挂在那颗按钮上的 data-*（如 WP324 的 `data-connect`）。 */
  data?: Record<`data-${string}`, string>
}

function ActionLink({ action }: { action: NoticeAction }): ReactNode {
  const extra = {
    ...(action.testId === undefined ? {} : { 'data-testid': action.testId }),
    ...(action.data ?? {}),
  }
  if (action.onClick === undefined && action.to !== undefined)
    return (
      <Link to={action.to} className="ws-link" {...extra}>
        {action.label}
      </Link>
    )
  return (
    <button
      type="button"
      className="ws-link"
      disabled={action.disabled}
      onClick={action.onClick}
      {...extra}
    >
      {action.label}
    </button>
  )
}

/* ── 空状态 ─────────────────────────────────────────── */

/** 空状态：灰图标 + 一句话 + 最多一个链接。不画插图（只有助理首屏能放品牌标）。 */
export function EmptyState({
  icon: Icon,
  text,
  action,
  className,
  ...rest
}: Omit<ComponentProps<'div'>, 'children'> & {
  icon?: (props: { className?: string; 'aria-hidden'?: boolean }) => ReactNode
  text: ReactNode
  action?: NoticeAction
}): ReactNode {
  return (
    <div data-slot="status" className={cn('ws-empty', className)} {...rest}>
      {Icon === undefined ? null : <Icon aria-hidden className="ws-empty-icon" />}
      <span>{text}</span>
      {action === undefined ? null : <ActionLink action={action} />}
    </div>
  )
}

/* ── 骨架 ─────────────────────────────────────────── */

/** 一条骨架（一行字那么高）。 */
export function SkeletonBar({ className, ...rest }: ComponentProps<'span'>): ReactNode {
  return <span aria-hidden className={cn('ws-skel', className)} {...rest} />
}

/**
 * 一行骨架，和真行一样高一样排：勾选框（`check`）+ 半行字 + 右边小块。
 * 放进 `ListGroup` 里就是列表在加载的样子。
 */
export function SkeletonRow({
  check = true,
  className,
}: {
  check?: boolean
  className?: string
}): ReactNode {
  return (
    <div className={cn('ws-row', className)} aria-hidden data-slot="skeleton-row">
      {check ? <span className="ws-skel ws-skel-box" /> : null}
      <span className="ws-skel w-1/2" />
      <span className="ws-row-end">
        <span className="ws-skel w-12" />
      </span>
    </div>
  )
}

/** 列表在加载：一张列表组里 `rows` 行骨架（读屏念一句「加载中」）。 */
export function SkeletonList({
  rows = 3,
  check = true,
  label,
  className,
  ...rest
}: Omit<ComponentProps<'div'>, 'children'> & {
  rows?: number
  check?: boolean
  /** 读屏念的那一句。 */
  label?: string
}): ReactNode {
  return (
    <div
      role="status"
      aria-busy="true"
      {...(label === undefined ? {} : { 'aria-label': label })}
      className={cn('ws-group', className)}
      data-slot="skeleton"
      {...rest}
    >
      {Array.from({ length: rows }, (_, i) => (
        // biome-ignore lint/suspicious/noArrayIndexKey: 骨架行没有身份，下标就是它
        <SkeletonRow key={i} check={check} />
      ))}
    </div>
  )
}
