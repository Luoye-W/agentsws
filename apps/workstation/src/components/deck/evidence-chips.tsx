/** 证据芯片：i18n key + 出处（36 §2.1「证据芯片带出处」）。 */
import type { DeckEvidenceChip, DeckHighlight } from '@agentsws/deck'
import { Badge } from '@/components/ui/badge'
import { useApp } from '@/lib/app-context'

export function EvidenceChips({ chips }: { chips: DeckEvidenceChip[] }): React.ReactNode {
  const { t } = useApp()
  if (chips.length === 0) return null
  return (
    <ul className="flex flex-wrap gap-1.5" aria-label={t('card.evidence')}>
      {chips.map((chip) => (
        <li key={`${chip.label_key}-${chip.ref?.type ?? ''}-${chip.ref?.id ?? ''}`}>
          <Badge variant="secondary" className="font-normal">
            <span>{t(chip.label_key)}</span>
            {chip.ref === undefined ? null : (
              <span className="ml-1 font-mono text-[10px] opacity-70">{chip.ref.id}</span>
            )}
          </Badge>
        </li>
      ))}
    </ul>
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
    <ul className="flex flex-wrap gap-1.5">
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
