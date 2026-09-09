/**
 * 四段式卡面（37 §1，照 KefuAgent `support-inbox-deck.tsx` 的骨架）。
 *
 * 四段是**三条边界线围出来的三个区域**，不是靠 margin 堆出来的四行：标签行和动作行
 * 各自带分隔线，中间是唯一会长高的内容区，而它长到 420px 就在卡内滚。动作行是唯一
 * 绝不许靠翻页才够得着的东西。
 *
 * ① 标签行：渠道 → 优先级 → 倒计时 → 卡型 → 合并 N 张（**客户名不进标签行**）
 * ② 标题：单行 15px 半粗
 * ③ 内容盒：一次一种语言 + 证据芯片 + 实体芯片
 * ④ 动作行：≤ 3 个快捷决定 + 安静区；折叠区就地替换它
 */
import type { DeckAction, DeckCard, DeckContentMode, InstructionScope } from '@agentsws/deck'
import { pickContent } from '@agentsws/deck'
import { useEffect, useState } from 'react'
import { DeckActionBar } from '@/components/deck/deck-action-bar'
import {
  countdownFace,
  isTypingTarget,
  secondsLeft as secondsLeftOf,
} from '@/components/deck/deck-gestures'
import {
  DECK_CARD_BODY_SCROLL_CLASS,
  DECK_CARD_MIN_HEIGHT_CLASS,
} from '@/components/deck/deck-layout'
import { DeckNotePanel, DeckSupplementPanel, type NoteMode } from '@/components/deck/deck-panels'
import { EntityChips, EvidenceChips, Highlights } from '@/components/deck/evidence-chips'
import { Label } from '@/components/ui/label'
import { RadioGroup, RadioGroupItem } from '@/components/ui/radio-group'
import { useApp } from '@/lib/app-context'
import { formatDateTime } from '@/lib/format'

export interface DeckDecideRequest {
  /**「打开」不是一次决定（它只是进入事项），所以这里不出现 */
  action: Exclude<DeckAction, 'open'>
  selected_option_id?: string
  instruction?: { scope: InstructionScope; text: string }
  reason?: string
  version: number
}

export type DeckExitDirection = 'left' | 'right' | 'up' | 'down'

const EXIT_CLASS: Record<DeckExitDirection, string> = {
  left: '-translate-x-[130%] -rotate-12 opacity-0',
  right: 'translate-x-[130%] rotate-12 opacity-0',
  up: '-translate-y-[140%] opacity-0',
  down: 'translate-y-[140%] opacity-0',
}

/** 详情区：按 kind 挑几个结构化字段展示，缺了就不展示，绝不编。 */
function CardDetail({ card }: { card: DeckCard }): React.ReactNode {
  const { t } = useApp()
  const payload = card.detail.payload
  const record =
    typeof payload === 'object' && payload !== null ? (payload as Record<string, unknown>) : {}
  const before = record.before
  const after = record.after
  return (
    <div className="mt-3 flex flex-col gap-3 border-t pt-3 text-sm" data-testid="deck-detail">
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
            <li key={c.fact_card_id}>「{c.quote}」</li>
          ))}
        </ul>
      )}
      <p className="text-xs text-muted-foreground">
        {t('deck.detail.proposer', { by: card.detail.proposer.id })}
        {card.detail.run_id === undefined ? '' : ` · ${card.detail.run_id}`}
      </p>
    </div>
  )
}

/** 倒计时徽章：**只有带 expires_at 的卡才出**，每秒滴答一次（37 §1 第 2 行）。 */
function Countdown({ expiresAt }: { expiresAt: string }): React.ReactNode {
  const { t } = useApp()
  const [nowMs, setNowMs] = useState(() => Date.now())
  useEffect(() => {
    const timer = setInterval(() => {
      setNowMs(Date.now())
    }, 1000)
    return () => {
      clearInterval(timer)
    }
  }, [])
  const left = secondsLeftOf(expiresAt, nowMs)
  if (left === null) return null
  const face = countdownFace(left)
  const text =
    face.kind === 'expired'
      ? t('deck.countdown.expired')
      : face.kind === 'clock'
        ? t('deck.countdown', { clock: face.clock })
        : t(`deck.countdown.${face.kind}`, { n: face.n })
  return (
    <span
      data-testid="deck-countdown"
      className="rounded-full border border-amber-400/70 bg-amber-50 px-2 py-0.5 text-amber-900 dark:bg-amber-500/10 dark:text-amber-200"
    >
      {text}
    </span>
  )
}

export function DeckCardView({
  card,
  mode,
  onDecide,
  onOpen,
  busy,
  exiting,
  error,
}: {
  card: DeckCard
  /** 队列级的语言选择（37 §1 第 4 行） */
  mode: DeckContentMode
  onDecide: (request: DeckDecideRequest) => void
  /** 37 §2.2b：`open` = 进入事项（事项页由 WP22 做） */
  onOpen: (card: DeckCard) => void
  busy?: boolean
  exiting?: DeckExitDirection | null
  error?: string
}): React.ReactNode {
  const { t, lang } = useApp()
  const [detail, setDetail] = useState(false)
  const [panel, setPanel] = useState<NoteMode | 'supplement' | null>(null)
  const [option, setOption] = useState<string>('')

  // 换卡就把折叠区收回去：上一张卡写了一半的指导不该出现在下一张卡上。
  // biome-ignore lint/correctness/useExhaustiveDependencies: 依赖就是"换了一张卡"这件事，不是 setter
  useEffect(() => {
    setPanel(null)
    setDetail(false)
    setOption('')
  }, [card.id])

  const isQuestion = card.options !== undefined && card.options.length > 0
  const content = pickContent(card.content_variants, mode)
  const decidable = card.available_actions.some((a) => a !== 'open')

  const act = (action: DeckAction): void => {
    if (action === 'open') {
      onOpen(card)
      return
    }
    // 不对 / 指导都先就地开面板——卡只有在人真说了句话之后才离开。
    if (action === 'reject' || action === 'instruct') {
      setPanel(action)
      return
    }
    onDecide({
      action,
      ...(isQuestion && option !== '' ? { selected_option_id: option } : {}),
      version: card.version,
    })
  }

  return (
    <div
      data-testid="deck-card"
      data-kind={card.kind}
      data-band={card.priority_band}
      className={[
        'relative flex flex-col overflow-hidden rounded-2xl border bg-card shadow-xl transition-all duration-300 ease-out',
        DECK_CARD_MIN_HEIGHT_CLASS,
        exiting == null ? '' : EXIT_CLASS[exiting],
      ].join(' ')}
    >
      {/* 37 §2.2b：卡片是指向事项的指针。点它 = 进入那个工作现场。 */}
      {card.matter_id === undefined ? null : (
        <button
          type="button"
          data-testid="deck-matter-link"
          className="border-b px-5 py-2 text-left text-xs text-muted-foreground hover:text-foreground"
          onClick={() => {
            onOpen(card)
          }}
        >
          {t('deck.matter', { title: card.matter_label ?? card.matter_id })}
        </button>
      )}

      {/* ① 标签行 —— 渠道 → 优先级 → 倒计时 → 卡型 → 合并 N 张 */}
      <div
        className="flex flex-wrap items-center gap-2 border-b px-5 py-3 text-xs"
        data-testid="deck-tag-row"
      >
        {card.channel === undefined ? null : (
          <span className="rounded-full border bg-background px-2 py-0.5 text-muted-foreground">
            {t(`channel.${card.channel}`)}
          </span>
        )}
        <span
          data-testid="deck-band"
          className={
            card.priority_band === 'P0'
              ? 'rounded-full bg-destructive px-2 py-0.5 text-destructive-foreground'
              : 'rounded-full bg-primary px-2 py-0.5 text-primary-foreground'
          }
        >
          {t(`band.${card.priority_band}`)}
        </span>
        {card.expires_at === undefined ? null : <Countdown expiresAt={card.expires_at} />}
        <span className="text-muted-foreground">{t(`kind.${card.kind}`)}</span>
        {card.merge_count > 1 ? (
          <span
            data-testid="deck-merge"
            className="rounded-full border bg-background px-2 py-0.5 text-muted-foreground"
          >
            {t('deck.merge', { n: card.merge_count })}
          </span>
        ) : null}
        {decidable ? null : <span className="text-muted-foreground">{t('card.done')}</span>}
      </div>

      {/*
        ②③ 标题 + 内容盒。这是唯一允许长高的区域，而它长到 max-h 就在卡内滚：
        一封三千字的邮件在卡里滚，而不是把动作行推出屏幕底下。
      */}
      {/* biome-ignore lint/a11y/noStaticElementInteractions: 点卡面展开详情（37 §1 第 6 行），键盘走下面那个按钮 */}
      {/* biome-ignore lint/a11y/useKeyWithClickEvents: 同上 */}
      <div
        className={`flex-1 px-5 py-4 ${DECK_CARD_BODY_SCROLL_CLASS}`}
        data-testid="deck-body"
        onClick={(e) => {
          // 点按钮、点链接、点输入框不算「点卡面」
          const target = e.target as HTMLElement
          if (target.closest('button, a, input, textarea, label') !== null) return
          if (isTypingTarget(target)) return
          setDetail((v) => !v)
        }}
      >
        {/* ② 一句话标题 */}
        <p className="text-[15px] leading-6 font-semibold">{card.title}</p>

        {/* ③ 内容盒 —— 一次只显示一种语言 */}
        {isQuestion ? (
          <fieldset className="mt-2.5 rounded-lg border p-3" data-testid="deck-card-options">
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
        ) : (
          <>
            <p
              data-testid="deck-content"
              data-mode={content.mode}
              className="mt-2.5 rounded-lg border bg-muted/40 p-3 text-sm leading-6 whitespace-pre-wrap"
            >
              {content.text}
            </p>
            {content.fell_back ? (
              <p
                data-testid="deck-content-fallback"
                className="mt-1.5 text-xs text-amber-600 dark:text-amber-400"
              >
                {t('deck.content.fallback')}
              </p>
            ) : null}
          </>
        )}

        <Highlights
          highlights={card.highlights}
          formatDeadline={(iso) => formatDateTime(iso, lang)}
        />
        <EvidenceChips chips={card.evidence_chips} />
        <EntityChips
          chips={card.entity_chips}
          dropped={card.detail.enrichment.dropped_refs}
          onOpen={() => {
            onOpen(card)
          }}
        />
        {detail ? <CardDetail card={card} /> : null}
        <button
          type="button"
          className="sr-only"
          aria-expanded={detail}
          onClick={() => {
            setDetail((v) => !v)
          }}
        >
          {t('deck.detail.toggle')}
        </button>
      </div>

      {/* ④ 动作行 —— 或者它就地展开的那块面板 */}
      <div className="border-t bg-muted/30 px-5 py-3">
        {error === undefined ? null : (
          <p role="alert" className="mb-2 text-xs text-destructive">
            {error}
          </p>
        )}
        {panel === 'supplement' ? (
          <DeckSupplementPanel
            onCancel={() => {
              setPanel(null)
            }}
            onSnooze={() => {
              setPanel(null)
              onDecide({ action: 'snooze', version: card.version })
            }}
          />
        ) : panel === null ? (
          <DeckActionBar
            card={card}
            disabled={busy === true}
            optionMissing={isQuestion && option === ''}
            onAction={act}
            onSupplement={() => {
              setPanel('supplement')
            }}
          />
        ) : (
          <DeckNotePanel
            mode={panel}
            busy={busy === true}
            ask={{ card_id: card.id }}
            onCancel={() => {
              setPanel(null)
            }}
            onSubmit={({ text, scope }) => {
              setPanel(null)
              onDecide({
                action: panel,
                version: card.version,
                ...(scope === undefined
                  ? { reason: text }
                  : { instruction: { scope, text }, reason: text }),
              })
            }}
          />
        )}
      </div>
    </div>
  )
}
