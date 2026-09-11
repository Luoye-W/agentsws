/**
 * 证据芯片与实体芯片（37 §1 第 5 行）。
 *
 * 两条硬规矩：
 * - 证据芯片**只渲染 i18n key + 参数**，它的数据里根本没有 ref 可露。
 * - 实体芯片**只渲染 `label`**（服务端 enrichment 查出来的展示名），`id` 只用来跳转，
 *   一个字都不印在卡面上——WP15 截图里的 `fact_775c…` / `cus_anna` 就是这么漏出去的。
 */
import type { DeckEntityChip, DeckEvidenceChip, DeckHighlight } from '@agentsws/deck'
import { FactChip, ObjectChip } from '@/components/chips'
import { Badge } from '@/components/ui/badge'
import { useApp } from '@/lib/app-context'

export function EvidenceChips({ chips }: { chips: DeckEvidenceChip[] }): React.ReactNode {
  const { t } = useApp()
  if (chips.length === 0) return null
  return (
    <ul className="mt-2.5 flex flex-wrap gap-1.5" aria-label={t('card.evidence')}>
      {chips.map((chip) => (
        <li key={`${chip.label_key}-${JSON.stringify(chip.params ?? {})}`}>
          <span className="inline-block rounded-lg border bg-muted/40 px-2.5 py-1 text-xs">
            {t(chip.label_key, chip.params)}
          </span>
        </li>
      ))}
    </ul>
  )
}

/**
 * 实体芯片另起一行（37 §1 第 5 行「实体 chip 另起一行」）。
 *
 * 47 J2：**对象引用与知识引用长得不一样**——`fact_card` 走 `FactChip`（虚线 + 引号），
 * 其余对象走 `ObjectChip`（实框 + 主色）。人一眼就分得出"这是现在的状态"还是"这是一句话"。
 */
export function EntityChips({
  chips,
  dropped,
  onOpen,
}: {
  chips: DeckEntityChip[]
  dropped: number
  onOpen?: (chip: DeckEntityChip) => void
}): React.ReactNode {
  const { t } = useApp()
  if (chips.length === 0 && dropped === 0) return null
  return (
    <div className="mt-1.5 flex flex-wrap items-center gap-1.5" data-testid="entity-chips">
      {chips.map((chip) =>
        chip.type === 'fact_card' ? (
          <FactChip
            key={`${chip.type}:${chip.id}`}
            label={chip.label}
            onOpen={() => {
              onOpen?.(chip)
            }}
          />
        ) : (
          <ObjectChip
            key={`${chip.type}:${chip.id}`}
            label={chip.label}
            id={chip.id}
            onOpen={() => {
              onOpen?.(chip)
            }}
          />
        ),
      )}
      {dropped === 0 ? null : (
        <span className="text-xs text-muted-foreground" data-testid="enrichment-note">
          {t('deck.enrichment.dropped', { n: dropped })}
        </span>
      )}
    </div>
  )
}

const TONE: Record<DeckHighlight['type'], string> = {
  amount: 'border-chart-2/40 text-foreground',
  deadline: 'border-chart-4/50 text-foreground',
  commitment: 'border-chart-5/50 text-foreground',
  risk_term: 'border-destructive/50 text-destructive',
  order_ref: 'border-border text-muted-foreground',
}

export function Highlights({
  highlights,
  formatDeadline,
}: {
  highlights: DeckHighlight[]
  formatDeadline: (iso: string) => string
}): React.ReactNode {
  const { t } = useApp()
  if (highlights.length === 0) return null
  return (
    <ul className="mt-2.5 flex flex-wrap gap-1.5">
      {highlights.map((h) => (
        <li key={`${h.type}-${h.text}`}>
          <Badge variant="outline" className={`font-normal ${TONE[h.type]}`}>
            <span className="text-[10px] uppercase opacity-60">{t(`highlight.${h.type}`)}</span>
            <span className="ml-1">{h.type === 'deadline' ? formatDeadline(h.text) : h.text}</span>
          </Badge>
        </li>
      ))}
    </ul>
  )
}
