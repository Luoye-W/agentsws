/**
 * 四段式卡面（37 §1，照 KefuAgent `support-inbox-deck.tsx` 的骨架）。
 *
 * WP96：**头与脚全类共用，中间那块按 `card.layout` 换十一种排版**（画布《卡片排版
 * 一览》）。头一行还是 37 §1 定的那个顺序，只是换了皮，末尾多一个提案人头像；
 * 脚多一个右下角的 → 圆钮——**没按钮的卡也有它**，它是出口不是第四个动作。
 * 中间那块搬去了 `deck-card-body.tsx`。
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
import { useQuery } from '@tanstack/react-query'
import { useEffect, useState } from 'react'
import { FactChip } from '@/components/chips'
import { DeckActionBar } from '@/components/deck/deck-action-bar'
import { DeckCardBody } from '@/components/deck/deck-card-body'
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
import { CardChips, EvidencePill, evidenceLines } from '@/components/deck/evidence-chips'
import { GoButton, StatusPill, type Tone, WsAvatar } from '@/components/design'
import { useRailState } from '@/components/rail/rail-state'
import { getPositions, type RoleTaskExampleData } from '@/lib/api'
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
        // 47 J2：引的是知识层的一句话 → 走 FactChip（虚线 + 引号），
        // 与上面那排对象芯片刻意不同；原始 id 一个字都不露。
        <ul className="flex flex-wrap gap-1.5" data-testid="card-citations">
          {card.detail.citations.map((c) => (
            <li key={c.fact_card_id}>
              <FactChip label={t('chip.fact')} quote={c.quote} />
            </li>
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

/**
 * 头一行第二枚：**等待时长**（WP98 收口）。
 *
 * 09-18 之前这一行上并排着"排队 / 已过期 / 变更待批 / 邮件"四枚胶囊，加上倒计时与
 * "合并 N 张"能到六枚——而人扫一眼只想知道两件事：这是谁家的什么活儿、急不急。
 * 于是这一枚把**倒计时、已过期、已处理**合成一个：每秒还是滴答（37 §1 第 2 行），
 * 已过期的卡"期限"照旧在这里表达，其余的进右上角那个"证据 N"。
 *
 * 没有 `expires_at` 又还没决定的卡不出这一枚——没人在等就别装出有人在等。
 */
function WaitPill({ card }: { card: DeckCard }): React.ReactNode {
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
  const decidable = card.available_actions.some((a) => a !== 'open')
  if (!decidable)
    return (
      <StatusPill tone="neutral" data-testid="deck-wait" data-wait="done">
        {t('card.done')}
      </StatusPill>
    )
  if (card.expires_at === undefined) return null
  const left = secondsLeftOf(card.expires_at, nowMs)
  if (left === null) return null
  const face = countdownFace(left)
  const text =
    face.kind === 'expired'
      ? t('deck.countdown.expired')
      : face.kind === 'clock'
        ? t('deck.countdown', { clock: face.clock })
        : t(`deck.countdown.${face.kind}`, { n: face.n })
  return (
    <StatusPill
      tone={face.kind === 'expired' ? 'bad' : 'warn'}
      data-testid="deck-wait"
      data-wait={face.kind === 'expired' ? 'expired' : 'countdown'}
    >
      {text}
    </StatusPill>
  )
}

/**
 * 头一行第一枚：**岗位 · 类别**（画布《卡片排版一览》那一行的头一格）。
 *
 * 岗位名从首页那把 `['positions']` 的缓存里认（这张卡那条职责挂在哪个岗位下）——
 * 没装岗位面的服务进程查不到，那就只出类别，不编一个岗位名。
 * 优先级不再单占一枚胶囊，它变成这一枚的**颜色**：P0 红、P1 黄、P2 蓝、P3 灰。
 */
const BAND_TONE: Record<DeckCard['priority_band'], Tone> = {
  P0: 'bad',
  P1: 'warn',
  P2: 'info',
  P3: 'neutral',
}

function usePositionName(role_id: string): string | undefined {
  const { lang } = useApp()
  const positions = useQuery({ queryKey: ['positions'], queryFn: getPositions })
  const hit = (positions.data?.instances ?? []).find((p) =>
    p.roles.some((r) => r.role_id === role_id),
  )
  return hit === undefined ? undefined : lang === 'en' ? hit.name.en : hit.name.zh
}

/**
 * WP84：这张卡那条职责的示例任务（指导抽屉顶部用）。
 *
 * 真源只有一处：职责 yml → `GET /v1/positions` 的 `roles[].task_examples`。这里读的是
 * 首页那把 `['positions']` 的缓存，所以岗位卡与指导抽屉看到的永远是同一份；
 * 没装岗位面的服务进程查不到，那就什么都不出（`undefined`），指导框照旧能用。
 */
function useTaskExamples(role_id: string): RoleTaskExampleData[] | undefined {
  const positions = useQuery({ queryKey: ['positions'], queryFn: getPositions })
  for (const p of positions.data?.instances ?? []) {
    const hit = p.roles.find((r) => r.role_id === role_id)
    if (hit?.task_examples !== undefined && hit.task_examples.length > 0) return hit.task_examples
  }
  return undefined
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
  const examples = useTaskExamples(card.role_id)
  const positionName = usePositionName(card.role_id)
  const rail = useRailState()
  const evidence = evidenceLines(card, t, (iso) => formatDateTime(iso, lang))

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
      data-layout={card.layout}
      data-band={card.priority_band}
      className={[
        'ws-card relative flex flex-col overflow-hidden transition-all duration-300 ease-out',
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

      {/*
        ① 标签行 —— WP98 收口：**两枚胶囊 + 证据 + 提案人**。
        「岗位 · 类别」（优先级变成它的颜色）→ 等待时长 → 证据 N → 谁提的。
        渠道、合并 N 张、预检那些都在右上角那个"证据 N"里，点开在第三栏看。
      */}
      <div
        className="flex flex-wrap items-center gap-2 border-b border-ws-line px-5 py-3 text-xs"
        data-testid="deck-tag-row"
      >
        <StatusPill tone={BAND_TONE[card.priority_band]} data-testid="deck-band">
          {positionName === undefined
            ? t(`kind.${card.kind}`)
            : `${positionName} · ${t(`kind.${card.kind}`)}`}
        </StatusPill>
        <WaitPill card={card} />
        <span className="ml-auto flex items-center gap-2">
          {/*
            右上角那个「证据 N」：点它在第三栏的证据面板里看（WP71 就有那一格）。
            走 WP95 的公开注册路 `show('evidence')`，注册层一个字不碰。
          */}
          <EvidencePill
            lines={evidence}
            onOpen={() => {
              rail.show('evidence')
            }}
          />
          {/* WP96 通用头的最后一格：**谁提的**。只按 proposer.kind 出字，不印任何 id。 */}
          <WsAvatar
            name={t(`deck.proposer.${card.detail.proposer.kind}`)}
            tone={card.detail.proposer.kind === 'agent' ? 'good' : 'neutral'}
            className="size-[22px] text-[10px]"
          />
        </span>
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

        {/* ③ 主体 —— WP96：按 card.layout 换十一种排版，见 deck-card-body.tsx */}
        <DeckCardBody
          card={card}
          mode={mode}
          option={option}
          onOption={setOption}
          onOpen={() => {
            onOpen(card)
          }}
        />

        {/*
          ③ 外围芯片 —— WP98 收口：**最多三个**，只留与这次决定直接相关的
          （对象引用 → 额度 / 总闸 → 事实卡引用）。证据层那些进上面的"证据 N"。
        */}
        <CardChips
          chips={card.entity_chips}
          highlights={card.highlights}
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

      {/* ④ 动作行 —— 或者它就地展开的那块面板；右下角的 → 圆钮全类都有 */}
      <div className="flex items-center gap-3 border-t border-ws-line bg-ws-surface px-5 py-3">
        <div className="min-w-0 flex-1">
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
              {...(examples === undefined ? {} : { examples })}
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
        {/*
          09-18 定：**每张卡右下角都有一个 → 圆钮**，没按钮的卡也有。
          它不是第四个动作，是出口——点它离开队列，进这件事的详情 / 工作线程。
        */}
        <GoButton
          label={t('deck.go')}
          onClick={() => {
            onOpen(card)
          }}
        />
      </div>
    </div>
  )
}
