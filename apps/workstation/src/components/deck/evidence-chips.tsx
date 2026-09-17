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
  // WP64：群发的受众规模与剔除人数是中性事实（不是风险词，别染成红的）；
  // 超期天数是这张卡存在的理由，给它告警色。
  audience: 'border-chart-2/40 text-foreground',
  suppressed: 'border-border text-muted-foreground',
  overdue: 'border-destructive/50 text-destructive',
  tracking: 'border-border text-muted-foreground',
  // WP67：红人是谁、合作走到哪一步、这条链接带回来多少——都是中性事实。
  // 归因那一格给强调色：它是这个岗位存在的理由。
  creator: 'border-chart-2/40 text-foreground',
  stage: 'border-border text-muted-foreground',
  attribution: 'border-chart-1/50 text-foreground',
  // WP72：渠道、申请人、管理动作都是中性事实；**发布时间**给强调色——
  // 批了之后这条内容会在那个时刻自己出去，它是人按下那一下之前最该看清的一格。
  channel: 'border-border text-muted-foreground',
  scheduled: 'border-chart-1/50 text-foreground',
  member: 'border-border text-muted-foreground',
  // 转客服：这条不归我答。给它一个能一眼扫到的边，免得压在队列里没人接
  handoff: 'border-chart-4/50 text-foreground',
  // WP76（58 §3）：规格与张数是中性事实。
  spec: 'border-border text-muted-foreground',
  variants: 'border-border text-muted-foreground',
  // **谁点的头**给强调色：04 §6 那条"视觉决定永远是人"在界面上唯一看得见的
  // 地方就是它——批的人要一眼看出，这一张是有人挑过的，不是机器自己选的。
  picked_by: 'border-chart-1/50 text-foreground',
  // 没有图片模型：这不是错误，是一句要被读完的人话。给它一个能一眼扫到的边。
  no_image_model: 'border-chart-4/50 text-foreground',
  // WP77：**预览链接**给强调色——12 §2「预览链接就是审批材料」，
  // 它是人按下"发布"之前最该点开的一格。缺项数给告警色（那是这张卡存在的理由）；
  // 这张卡对着哪一封信 / 哪一个 App 是中性事实。
  preview: 'border-chart-1/50 text-foreground',
  gaps: 'border-destructive/50 text-destructive',
  site_target: 'border-border text-muted-foreground',
  // WP75：平台是中性事实；**总闸**给告警色——它是"今天还能不能再花钱"那一格，
  // 而这张卡正要花钱；止损判据给强调色：那是人真正要判的内容（不是"止损"两个字）。
  platform: 'border-border text-muted-foreground',
  spend_gate: 'border-destructive/50 text-destructive',
  stop_loss: 'border-chart-1/50 text-foreground',
  // WP78：**版规**给告警色——我们在别人的地盘上，那一格说的是"这一条会不会
  // 让整个品牌被那个版赶走"，它是外部发帖卡上最该先看清的一格。
  // 数字出处是中性事实（提得上来的稿子那两个数永远相等）；舆情给强调色：
  // 一条被转了 30 次的负面与一条孤零零的抱怨，要不要现在就回是两个答案。
  venue_rules: 'border-destructive/50 text-destructive',
  facts_cited: 'border-border text-muted-foreground',
  sentiment: 'border-chart-1/50 text-foreground',
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
