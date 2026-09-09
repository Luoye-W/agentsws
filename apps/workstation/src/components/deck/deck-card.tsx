/**
 * 36 §2 的卡片。
 *
 * 一张卡就是一次决定：标题两行人话、结构化的证据、最多三个按钮。
 * 卡型（§2.2 八种 + 通用卡）只影响详情区长什么样，动作矩阵与快捷行由服务端给的
 * `available_actions` / `action_labels` 决定——前端不硬编码 kind → 按钮。
 */
import type { DeckAction, DeckCard, InstructionScope } from '@agentsws/deck'
import { ChevronDown } from 'lucide-react'
import { useState } from 'react'
import { AskAiPanel } from '@/components/deck/ask-ai-panel'
import { DeckActionBar } from '@/components/deck/deck-action-bar'
import { DeckInstructSheet } from '@/components/deck/deck-instruct-sheet'
import { EvidenceChips, Highlights } from '@/components/deck/evidence-chips'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardFooter, CardHeader } from '@/components/ui/card'
import { Label } from '@/components/ui/label'
import { RadioGroup, RadioGroupItem } from '@/components/ui/radio-group'
import { Separator } from '@/components/ui/separator'
import { useApp } from '@/lib/app-context'
import { formatDateTime } from '@/lib/format'

export interface DeckDecideRequest {
  /** 「打开」不是一次决定（它只是展开详情），所以这里不出现 */
  action: Exclude<DeckAction, 'open'>
  selected_option_id?: string
  instruction?: { scope: InstructionScope; text: string }
  version: number
}

const BAND_TONE: Record<string, string> = {
  P0: 'bg-destructive/10 text-destructive border-destructive/30',
  P1: 'bg-chart-4/15 text-foreground border-chart-4/40',
  P2: 'bg-muted text-muted-foreground border-transparent',
  P3: 'bg-muted text-muted-foreground border-transparent',
}

/** 详情区：按 kind 挑几个结构化字段展示，缺了就不展示，绝不编。 */
function CardDetail({ card }: { card: DeckCard }): React.ReactNode {
  const payload = card.detail.payload
  const record =
    typeof payload === 'object' && payload !== null ? (payload as Record<string, unknown>) : {}
  const body = record.body
  const draft =
    typeof body === 'object' &&
    body !== null &&
    typeof (body as { text?: unknown }).text === 'string'
      ? (body as { text: string }).text
      : undefined
  const before = record.before
  const after = record.after
  return (
    <div className="flex flex-col gap-3 text-sm">
      {draft === undefined ? null : (
        <pre className="max-h-64 overflow-auto whitespace-pre-wrap rounded-md bg-muted/50 p-3 font-sans text-[13px] leading-relaxed">
          {draft}
        </pre>
      )}
      {before === undefined && after === undefined ? null : (
        <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 font-mono text-xs">
          <dt className="text-muted-foreground">before</dt>
          <dd className="truncate">{JSON.stringify(before)}</dd>
          <dt className="text-muted-foreground">after</dt>
          <dd className="truncate">{JSON.stringify(after)}</dd>
        </dl>
      )}
      {card.detail.citations.length === 0 ? null : (
        <ul className="list-inside list-disc text-xs text-muted-foreground">
          {card.detail.citations.map((c) => (
            <li key={c.fact_card_id}>
              <span className="font-mono">{c.fact_card_id}</span>
              <span className="ml-2">「{c.quote}」</span>
            </li>
          ))}
        </ul>
      )}
      <AskAiPanel />
    </div>
  )
}

export function DeckCardView({
  card,
  onDecide,
  busy,
  error,
}: {
  card: DeckCard
  onDecide: (request: DeckDecideRequest) => void
  busy?: boolean
  error?: string
}): React.ReactNode {
  const { t, lang } = useApp()
  const [open, setOpen] = useState(false)
  const [instructing, setInstructing] = useState(false)
  const [option, setOption] = useState<string>('')
  const [localError, setLocalError] = useState<string>('')

  const isQuestion = card.options !== undefined && card.options.length > 0
  const decidable = card.available_actions.some((a) => a !== 'open')

  const act = (action: DeckAction): void => {
    setLocalError('')
    if (action === 'open') {
      setOpen((v) => !v)
      return
    }
    if (action === 'instruct') {
      setInstructing(true)
      return
    }
    if (action === 'approve' && isQuestion && option === '') {
      // 36 §2.1：选择题卡裸 approve 服务端会拒（OPTION_REQUIRED）；界面上先说清楚，别让人白点一次。
      setLocalError(t('card.options.hint'))
      return
    }
    onDecide({
      action,
      ...(isQuestion && option !== '' ? { selected_option_id: option } : {}),
      version: card.version,
    })
  }

  return (
    <Card
      data-testid="deck-card"
      data-kind={card.kind}
      data-band={card.priority_band}
      className="gap-3"
    >
      <CardHeader className="gap-2">
        <div className="flex flex-wrap items-center gap-2 text-xs">
          <Badge variant="outline" className={BAND_TONE[card.priority_band] ?? ''}>
            {t(`band.${card.priority_band}`)}
          </Badge>
          <Badge variant="secondary" className="font-normal">
            {t(`kind.${card.kind}`)}
          </Badge>
          {card.customer_label === undefined ? null : (
            <span className="text-muted-foreground">{card.customer_label}</span>
          )}
          {card.snoozed_until === undefined ? null : (
            <span className="text-muted-foreground">
              {t('card.snoozed', { at: formatDateTime(card.snoozed_until, lang) })}
            </span>
          )}
          {decidable ? null : <span className="text-muted-foreground">{t('card.done')}</span>}
        </div>
        <h3 className="text-sm leading-snug font-medium">{card.title}</h3>
        <p className="text-sm text-muted-foreground">{card.summary}</p>
      </CardHeader>

      <CardContent className="flex flex-col gap-3">
        <Highlights
          highlights={card.highlights}
          formatDeadline={(iso) => formatDateTime(iso, lang)}
        />
        {isQuestion ? (
          <fieldset className="rounded-md border p-3" data-testid="deck-card-options">
            <legend className="px-1 text-xs text-muted-foreground">{t('card.options.hint')}</legend>
            <RadioGroup value={option} onValueChange={setOption}>
              {(card.options ?? []).map((o) => (
                <Label key={o.id} className="flex items-center gap-2 font-normal">
                  <RadioGroupItem value={o.id} />
                  <span>{o.label}</span>
                </Label>
              ))}
            </RadioGroup>
          </fieldset>
        ) : null}
        <EvidenceChips chips={card.evidence_chips} />
        {open ? (
          <>
            <Separator />
            <CardDetail card={card} />
          </>
        ) : null}
      </CardContent>

      <CardFooter className="flex-col items-stretch gap-2">
        {localError === '' && error === undefined ? null : (
          <p role="alert" className="text-xs text-destructive">
            {localError !== '' ? localError : error}
          </p>
        )}
        <div className="flex items-center justify-between gap-2">
          <DeckActionBar
            card={card}
            disabled={busy === true}
            onAction={act}
            labelOf={(a) => card.action_labels?.[a] ?? a}
          />
          <Button
            size="sm"
            variant="ghost"
            aria-expanded={open}
            onClick={() => {
              setOpen((v) => !v)
            }}
          >
            {t('card.detail')}
            <ChevronDown
              className={open ? 'rotate-180 transition-transform' : 'transition-transform'}
            />
          </Button>
        </div>
      </CardFooter>

      <DeckInstructSheet
        open={instructing}
        onOpenChange={setInstructing}
        busy={busy === true}
        onSubmit={(instruction) => {
          setInstructing(false)
          onDecide({ action: 'instruct', instruction, version: card.version })
        }}
      />
    </Card>
  )
}
