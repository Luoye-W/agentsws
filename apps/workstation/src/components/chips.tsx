/**
 * 47 J2 最后一条：**对象引用与知识引用长得不一样，人一眼能分。**
 *
 * 同一张卡上"订单 #1001"和"退货政策 14 天"是两回事——前者是操作层的当前状态
 * （实时、可点开看、矛盾时以它为准），后者是知识层的一句话（人写的、会过时）。
 * 界面上长一个样，人就会把两者一视同仁地信，而这正是 47 要拦的那个错。
 *
 * 所以两个芯片刻意不同：
 * - `ObjectChip`——实心底、方框图标、边框是主色：**一个东西**，点得开。
 * - `FactChip`——虚线框、引号图标、通体灰：**一句话**，带"当时"的时候还会把日期写出来。
 *
 * 两个都遵守 37 §1 第 5 行：**不露原始 id**，只显示服务端 enrichment 查出来的人话标签；
 * id 只用来跳转与做 key。
 */

import { cn } from 'cn'
import { Quote, Square } from 'lucide-react'
import { useApp } from '@/lib/app-context'

export interface ObjectChipProps {
  /** 人话标签（`DeckEntityChip.label`）。查不到展示名的 ref 在服务端就丢了，不会到这里。 */
  label: string
  /** 只用来跳转，一个字都不印在卡面上。 */
  id?: string
  onOpen?: () => void
  className?: string
}

/** 操作层的一个对象：点得开，显示的是它**现在**是什么样。 */
export function ObjectChip({ label, onOpen, className }: ObjectChipProps): React.ReactNode {
  const { t } = useApp()
  return (
    <button
      type="button"
      data-testid="object-chip"
      data-chip="object"
      title={t('chip.object.hint')}
      aria-label={`${t('chip.object')}：${label}`}
      className={cn(
        'inline-flex items-center gap-1 rounded-lg border border-primary/40 bg-primary/5 px-2.5 py-1 text-xs hover:bg-primary/10',
        className,
      )}
      onClick={onOpen}
    >
      <Square className="size-3 opacity-60" aria-hidden />
      <span>{label}</span>
    </button>
  )
}

export interface FactChipProps {
  /** 人话标签（事实卡的主题），不是 id。 */
  label: string
  /** 引的那一句（有就显示，界面上带引号）。 */
  quote?: string
  /**
   * 47 J2：这张卡是"当时"的历史案例时，把那个时间写在芯片上。
   * 给了它，这条引用就自带一句"这是那时候的情况"，不必读的人自己去猜。
   */
  asOf?: string
  onOpen?: () => void
  className?: string
}

/** 知识层的一句话：虚线框 + 引号，跟对象芯片一眼就分得开。 */
export function FactChip({
  label,
  quote,
  asOf,
  onOpen,
  className,
}: FactChipProps): React.ReactNode {
  const { t, lang } = useApp()
  const text = quote === undefined || quote === '' ? label : `「${quote}」`
  const when =
    asOf === undefined
      ? undefined
      : new Date(asOf).toLocaleDateString(lang === 'zh' ? 'zh-CN' : 'en-US')
  return (
    <button
      type="button"
      data-testid="fact-chip"
      data-chip="fact"
      title={asOf === undefined ? t('chip.fact.hint') : t('chip.fact.stale.hint')}
      aria-label={`${t('chip.fact')}：${label}`}
      className={cn(
        'inline-flex max-w-full items-center gap-1 rounded-lg border border-dashed bg-muted/30 px-2.5 py-1 text-xs text-muted-foreground hover:bg-muted/60',
        className,
      )}
      onClick={onOpen}
    >
      <Quote className="size-3 shrink-0 opacity-60" aria-hidden />
      <span className="truncate">{text}</span>
      {when === undefined ? null : (
        <span className="shrink-0 rounded border px-1 text-[10px]" data-testid="fact-chip-as-of">
          {t('chip.fact.as_of', { at: when })}
        </span>
      )}
    </button>
  )
}
