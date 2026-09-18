/**
 * 卡片外围的那几个芯片（37 §1 第 5 行）+ WP98（09-18 收口）。
 *
 * WP96 之后真实页面上一张卡的正文底下常常挂着七八个小圆角标签：对象引用、事实卡引用、
 * 额度、期限、预检通过、引用了 N 条知识、读了 N 条记录、还有 N 条你无权查看已隐去……
 * 它们不是一类东西。**只有头三样是这次决定要看的**（这一单是谁的、能不能花这笔钱、
 * 依据哪一句），其余是"这件事被查过了"的证据层——证据该在需要时点开看，不该常驻卡面。
 *
 * 所以这个文件现在只出两样：
 * - {@link CardChips}：外围芯片，**最多三个**（对象引用 → 额度 / 总闸 → 事实卡引用）；
 * - {@link EvidencePill}：卡片右上角那个"证据 N"，点开在第三栏的证据面板看。
 *   面板走的是 WP95 那条**公开注册路**（`useRailState().show('evidence')`），
 *   这里只调用，注册层一个字不碰。
 *
 * 两条硬规矩一个字没改：
 * - 证据芯片**只渲染 i18n key + 参数**，它的数据里根本没有 ref 可露。
 * - 实体芯片**只渲染 `label`**（服务端 enrichment 查出来的展示名），`id` 只用来跳转，
 *   一个字都不印在卡面上——WP15 截图里的 `fact_775c…` / `cus_anna` 就是这么漏出去的。
 */
import type { DeckCard, DeckEntityChip, DeckHighlight } from '@agentsws/deck'
import { FileSearch } from 'lucide-react'
import { FactChip, ObjectChip } from '@/components/chips'
import { Badge } from '@/components/ui/badge'
import { useApp } from '@/lib/app-context'

/** `useApp().t`——这个文件里有一个纯函数要用它，所以把那一行签名写出来。 */
type Translate = (key: string, vars?: Record<string, string | number>) => string

/** 09-18 Luoye 定：外围**最多三个**。第四个开始就是"看不完，于是一个也不看"。 */
export const MAX_CARD_CHIPS = 3

/**
 * 「额度 / 总闸」那一家：**这次决定花不花得起**。
 *
 * 只有这两种进外围——它们是按下"批准"之前必须看清的一格（57 §1 总闸、14 §2 额度）。
 * 期限、渠道、排期、版规那些要么已经在主体里（`deck-card-body` 按 layout 各取各的），
 * 要么属于证据层，都进右上角那个胶囊。
 */
const GATE_TYPES: readonly DeckHighlight['type'][] = ['amount', 'spend_gate']

const isGate = (h: DeckHighlight): boolean => GATE_TYPES.includes(h.type)

/**
 * 外围芯片：与这次决定**直接相关**的那几个，按"对象 → 额度 → 依据"取，满三个就停。
 *
 * 顺序是有意的：人先问"这是哪一单"，再问"花不花得起"，最后才问"凭什么"。
 */
export function CardChips({
  chips,
  highlights,
  onOpen,
}: {
  chips: DeckEntityChip[]
  highlights: DeckHighlight[]
  onOpen?: (chip: DeckEntityChip) => void
}): React.ReactNode {
  const objects = chips.filter((c) => c.type !== 'fact_card')
  const facts = chips.filter((c) => c.type === 'fact_card')
  const gates = highlights.filter(isGate)
  const picked = [
    ...objects.map((c) => ({ kind: 'object' as const, chip: c })),
    ...gates.map((h) => ({ kind: 'gate' as const, highlight: h })),
    ...facts.map((c) => ({ kind: 'fact' as const, chip: c })),
  ].slice(0, MAX_CARD_CHIPS)
  if (picked.length === 0) return null
  return (
    <div className="mt-2.5 flex flex-wrap items-center gap-1.5" data-testid="card-chips">
      {picked.map((item) =>
        item.kind === 'gate' ? (
          <Badge
            key={`gate:${item.highlight.type}:${item.highlight.text}`}
            variant="outline"
            data-testid="gate-chip"
            className="border-chart-1/50 font-normal text-foreground"
          >
            {item.highlight.text}
          </Badge>
        ) : item.kind === 'fact' ? (
          // 47 J2：知识引用是虚线 + 引号，与实框的对象引用刻意不同——
          // 人一眼要分得出"这是现在的状态"还是"这是一句话"。
          <FactChip
            key={`fact:${item.chip.id}`}
            label={item.chip.label}
            onOpen={() => {
              onOpen?.(item.chip)
            }}
          />
        ) : (
          <ObjectChip
            key={`${item.chip.type}:${item.chip.id}`}
            label={item.chip.label}
            id={item.chip.id}
            onOpen={() => {
              onOpen?.(item.chip)
            }}
          />
        ),
      )}
    </div>
  )
}

/**
 * 这张卡的**证据层**摊成几句人话：预检结果、引用了几条知识、查了哪几单、
 * 读了多少条记录、还有几条无权查看已隐去、期限、以及外围没排上的那些高亮。
 *
 * 全是**已经在卡上的字段**，一句都不是这儿现编的（14 §2 数字不经模型手）。
 * `deadline` 那一条按本地时区排版，与它原来在高亮行里的样子一致。
 */
export function evidenceLines(
  card: DeckCard,
  t: Translate,
  formatDeadline: (iso: string) => string,
): string[] {
  const out = card.evidence_chips.map((chip) => t(chip.label_key, chip.params))
  for (const h of card.highlights) {
    if (isGate(h)) continue
    out.push(
      `${t(`highlight.${h.type}`)} ${h.type === 'deadline' ? formatDeadline(h.text) : h.text}`,
    )
  }
  const dropped = card.detail.enrichment.dropped_refs
  if (dropped > 0) out.push(t('deck.enrichment.dropped', { n: dropped }))
  if (card.merge_count > 1) out.push(t('deck.merge', { n: card.merge_count }))
  return out
}

/**
 * 卡片右上角那个「证据 N」。
 *
 * 点它 = 在第三栏打开证据面板（WP71 就有那一格）。走的是 WP95 定下的**公开注册路**，
 * 与应用包开一个面板用的是同一句——注册层这次一个字都没碰。
 * 悬停时 `title` 里就是那 N 条，于是"要不要点开"这件事本身不用点开才知道。
 */
export function EvidencePill({
  lines,
  onOpen,
}: {
  lines: string[]
  onOpen: () => void
}): React.ReactNode {
  const { t } = useApp()
  if (lines.length === 0) return null
  return (
    <button
      type="button"
      data-testid="deck-evidence"
      data-count={lines.length}
      title={lines.join(' · ')}
      aria-label={t('deck.evidence.open')}
      className="inline-flex h-6 shrink-0 items-center gap-1 rounded-full bg-ws-surface px-2 text-[11px] text-ws-muted-fg hover:text-ws-ink"
      onClick={onOpen}
    >
      <FileSearch className="size-3" aria-hidden />
      {t('deck.evidence.pill', { n: lines.length })}
    </button>
  )
}
