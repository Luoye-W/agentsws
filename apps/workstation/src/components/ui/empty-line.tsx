/**
 * WP238（36 §7「空态」）：空状态 = **一行灰字 + 一个去处按钮**，不占一张大卡。
 *
 * 「还没登记号」「群发没有去处」这类话是这一块唯一的引导，必须一眼可见（36 §7 可见档 ③），
 * 但它不值得一张带标题、带边框的卡——那会让人以为这里有一件事要处理。
 */
import type { ReactNode } from 'react'
import { Link } from 'react-router-dom'
import { Button } from '@/components/ui/button'

export function EmptyLine({
  icon,
  text,
  action,
  testId,
}: {
  icon?: ReactNode
  text: string
  /**
   * 去处按钮（站内地址）；不给就只有那一行字。
   * WP324：也可以是就地动作（`onClick`，如「去连接」在第三栏开连接卡），给了它就不跳页。
   */
  action?: {
    label: string
    to?: string
    onClick?: () => void
    testId?: string
    /** WP324：就地连的是哪一样（`data-connect`，给测试与排障看）。 */
    connect?: string | undefined
  }
  testId?: string
}): ReactNode {
  return (
    <div
      className="flex flex-wrap items-center gap-2 text-sm text-muted-foreground"
      data-slot="status"
      {...(testId === undefined ? {} : { 'data-testid': testId })}
    >
      {icon}
      <span>{text}</span>
      {action === undefined ? null : action.onClick !== undefined || action.to === undefined ? (
        <Button
          size="xs"
          variant="outline"
          onClick={action.onClick}
          {...(action.testId === undefined ? {} : { 'data-testid': action.testId })}
          {...(action.connect === undefined ? {} : { 'data-connect': action.connect })}
        >
          {action.label}
        </Button>
      ) : (
        <Button size="xs" variant="outline" asChild>
          <Link
            to={action.to}
            {...(action.testId === undefined ? {} : { 'data-testid': action.testId })}
          >
            {action.label}
          </Link>
        </Button>
      )}
    </div>
  )
}
