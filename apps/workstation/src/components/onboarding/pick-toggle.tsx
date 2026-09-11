/**
 * 一个勾选按钮：分配向导（`components/org/assign-wizard.tsx`）里选人、选岗位、选范围
 * 用的就是这个样子——一个带边框的小块，勾上了就描边高亮。
 *
 * 为什么在这里再放一份而不是从 `assign-wizard.tsx` 里抽出去：那个文件同期正被
 * WP50 改（品牌 / 产品线两栏），动它等于给合并制造麻烦。样式与语义保持一致，
 * 等两条线都并回 main 之后再把它收成一个共用件。
 */
import { cn } from '@/lib/utils'

export function PickToggle({
  checked,
  disabled,
  onToggle,
  testId,
  children,
  className,
}: {
  checked: boolean
  disabled?: boolean
  onToggle(): void
  testId?: string
  children: React.ReactNode
  className?: string
}): React.ReactNode {
  return (
    <button
      type="button"
      // 用 `aria-pressed` 而不是 `role="checkbox"`：它就是一个"按下去就算勾上"的
      // 切换按钮，读屏念的是"切换按钮，已按下"，比假装成复选框准确
      aria-pressed={checked}
      disabled={disabled === true}
      {...(testId === undefined ? {} : { 'data-testid': testId })}
      className={cn(
        'rounded-md border px-2 py-1 text-left transition-colors hover:bg-muted disabled:opacity-40',
        checked && 'border-primary bg-primary/10',
        className,
      )}
      onClick={onToggle}
    >
      {children}
    </button>
  )
}
