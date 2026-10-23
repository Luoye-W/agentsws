/**
 * WP100（36 §9 那张表里的第四格）：**证据——这张卡凭什么**。
 * WP486：界面上改叫「详情」（Luoye 10-23：「证据」听着怪）；「学到」卡多一节「攒出这条的几次纠正」。
 *
 * WP71 把这一格的位置占住了（点开照实说"还没做"），WP98 又把卡面上的证据层
 * 全收进了右上角那枚「证据 N」——于是从 09-18 起，点那枚胶囊开的是一个空面板。
 * 这一版把正文补上：**人点「证据 N」，这里就摊开那 N 条**。
 *
 * 三条纪律：
 *
 * 1. **不加路由，一个请求都不发**。摊开的全是卡上已经有的字段（`entity_chips` /
 *    `evidence_chips` / `highlights` / `detail.citations` / `detail.precheck` /
 *    `detail.enrichment`）——它们在服务端投影那一步就算好了（14 §2「数字不经模型手」）。
 *    这一栏要是自己去查一遍库，界面上就会出现"卡上说查了 3 单、面板说 4 单"那种
 *    永远说不清的分歧。
 * 2. **裸 id 一个字不印**：对象引用只印 enrichment 查出来的展示名，事实卡只印那句
 *    引文，`fact_…` / `cus_…` 一律只用于跳转（37 §1 第 5 行，WP15 的教训）。
 * 3. **没有卡就照实说**：没人点过「证据 N」时这里不摆一个空壳子，
 *    直接写"点卡片右上角的「证据 N」"——那一句就是操作说明。
 *
 * 注册走的是**与第三方面板逐字相同的那两句**（`builtin-panels.tsx` 里
 * `registerPanelType` + `registerPanelBody(lazy)`，WP95 的纪律：内置不走后门）。
 * 这一栏认"当前是哪张卡"靠 `deck-focus.ts` 那份内存真源，而不是往注册接口上
 * 加一格——那份接口是所有面板共用的。
 */
import type { DeckCard } from '@agentsws/deck'
import type { ReactNode } from 'react'
import { Link, useInRouterContext } from 'react-router-dom'
import { FactChip, ObjectChip } from '@/components/chips'
import { useEvidenceCard } from '@/components/deck/deck-focus'
import { evidenceLines } from '@/components/deck/evidence-chips'
import { StatusPill } from '@/components/design'
import { useApp } from '@/lib/app-context'
import { formatDateTime } from '@/lib/format'

function Section({ title, children }: { title: string; children: ReactNode }): ReactNode {
  return (
    <section className="flex flex-col gap-1.5">
      <h3 className="text-xs font-medium text-muted-foreground">{title}</h3>
      {children}
    </section>
  )
}

/**
 * 事实卡引用那一段的状态胶囊。
 *
 * 状态**不是这里现判的**：它就是这张卡的出处预检（`precheck.provenance`）——
 * 那一格说"这次引用的出处核过了"，没核过的就是"待核"。卡上没有"每条事实卡各自的
 * 验证状态"这个字段，所以这里也不发明一个：宁可粗一点，不要编一个看起来很准的。
 */
function FactStatus({ card }: { card: DeckCard }): ReactNode {
  const { t } = useApp()
  const ok = card.detail.precheck.provenance === 'ok'
  return (
    <StatusPill tone={ok ? 'good' : 'warn'} data-testid="rail-evidence-fact-status">
      {ok ? t('rail.evidence.fact.verified') : t('rail.evidence.fact.pending')}
    </StatusPill>
  )
}

/** WP486：「学到」卡上攒出这条的那一次纠正（服务端 `SkillLessonSource` 的前端只读面）。 */
interface LessonSourceView {
  at: string
  signal: string
  quote: string
  approval_item_id?: string
  card_title?: string
  matter_id?: string
  before?: string
  after?: string
}

const str = (v: unknown): string | undefined => (typeof v === 'string' && v !== '' ? v : undefined)

/** 卡上的 `payload.sources`（只有「昨天学到的」卡有；早于 WP486 的卡没有就是空）。 */
export function lessonSourcesOf(card: DeckCard): LessonSourceView[] {
  const p = card.detail.payload as { form?: unknown; sources?: unknown } | null | undefined
  if (p?.form !== 'skill_lesson' || !Array.isArray(p.sources)) return []
  const out: LessonSourceView[] = []
  for (const raw of p.sources as unknown[]) {
    if (typeof raw !== 'object' || raw === null) continue
    const r = raw as Record<string, unknown>
    const at = str(r.at)
    const quote = str(r.quote)
    if (at === undefined || quote === undefined) continue
    const opt = (k: keyof LessonSourceView): Partial<LessonSourceView> => {
      const v = str(r[k])
      return v === undefined ? {} : { [k]: v }
    }
    out.push({
      at,
      quote,
      signal: str(r.signal) ?? '',
      ...opt('approval_item_id'),
      ...opt('card_title'),
      ...opt('matter_id'),
      ...opt('before'),
      ...opt('after'),
    })
  }
  return out
}

/** 那一次纠正出在哪张卡：有事项进事项并定位到卡，没有就开那张卡自己的页面（`/cards/:id`）。 */
function sourceHref(s: LessonSourceView): string | undefined {
  if (s.approval_item_id === undefined) return undefined
  const card = encodeURIComponent(s.approval_item_id)
  return s.matter_id === undefined
    ? `/cards/${card}`
    : `/matters/${encodeURIComponent(s.matter_id)}#card-${card}`
}

/** WP486：攒出这条「学到」的那几次纠正——时间、哪张卡、原来是什么 / 你改成了什么 / 你说的理由。 */
function LessonSources({ sources }: { sources: readonly LessonSourceView[] }): ReactNode {
  const { t, lang } = useApp()
  const inRouter = useInRouterContext()
  return (
    <ol className="flex flex-col gap-2" data-testid="rail-evidence-sources">
      {sources.map((s) => {
        const href = sourceHref(s)
        const title = s.card_title ?? t('rail.evidence.source.card')
        return (
          <li
            key={`${s.approval_item_id ?? ''}:${s.at}:${s.quote}`}
            className="flex flex-col gap-1 rounded-lg bg-ws-surface p-2 text-[12px] leading-5"
            data-testid="rail-evidence-source"
          >
            <p className="flex flex-wrap items-baseline gap-x-1.5 text-muted-foreground">
              <span className="ws-num">{formatDateTime(s.at, lang)}</span>
              {href === undefined || !inRouter ? (
                <span className="text-ws-body">{title}</span>
              ) : (
                <Link
                  to={href}
                  className="text-ws-body hover:underline"
                  data-testid="rail-evidence-source-link"
                  title={t('rail.evidence.source.open')}
                >
                  {title} →
                </Link>
              )}
            </p>
            {s.signal === 'edit_diff' && (s.before !== undefined || s.after !== undefined) ? (
              <div className="flex flex-col gap-0.5">
                <p className="text-muted-foreground">{t('rail.evidence.source.edit')}</p>
                {s.before === undefined ? null : (
                  <p className="whitespace-pre-wrap text-ws-body">
                    <span className="text-muted-foreground">
                      {t('rail.evidence.source.before')}：
                    </span>
                    {s.before}
                  </p>
                )}
                <p className="whitespace-pre-wrap text-ws-body">
                  <span className="text-muted-foreground">{t('rail.evidence.source.after')}：</span>
                  {s.after ?? s.quote}
                </p>
              </div>
            ) : (
              <p className="whitespace-pre-wrap text-ws-body">
                <span className="text-muted-foreground">
                  {t(
                    s.signal === 'reject'
                      ? 'rail.evidence.source.reject'
                      : s.signal === 'redirect'
                        ? 'rail.evidence.source.redirect'
                        : s.signal === 'edit_diff'
                          ? 'rail.evidence.source.after'
                          : 'rail.evidence.source.other',
                  )}
                </span>
                「{s.quote}」
              </p>
            )}
          </li>
        )
      })}
    </ol>
  )
}

export function EvidencePanel(): ReactNode {
  const { t, lang } = useApp()
  const card = useEvidenceCard()

  if (card === null)
    return (
      <p className="text-muted-foreground" data-testid="rail-evidence-empty">
        {t('rail.evidence.empty')}
      </p>
    )

  // 与卡片右上角那枚胶囊**同一个函数**：面板里列的就是它 title 上那 N 条，
  // 一条不多一条不少（两处各算一遍的话，迟早会差一条）
  const lines = evidenceLines(card, t, (iso) => formatDateTime(iso, lang))
  const objects = card.entity_chips.filter((c) => c.type !== 'fact_card')
  const facts = card.entity_chips.filter((c) => c.type === 'fact_card')
  const citations = card.detail.citations
  const sources = lessonSourcesOf(card)

  return (
    <div className="flex flex-col gap-4" data-testid="rail-evidence">
      <p className="text-[13px] leading-5 font-medium" data-testid="rail-evidence-title">
        {card.title}
      </p>

      {/* WP486：「学到」卡先说它从哪来——攒出这条的那几次纠正 */}
      {sources.length === 0 ? null : (
        <Section title={t('rail.evidence.sources')}>
          <LessonSources sources={sources} />
        </Section>
      )}

      {objects.length === 0 ? null : (
        <Section title={t('rail.evidence.objects')}>
          <div className="flex flex-wrap gap-1.5">
            {objects.map((c) => (
              <ObjectChip key={`${c.type}:${c.id}`} label={c.label} id={c.id} />
            ))}
          </div>
        </Section>
      )}

      {facts.length === 0 && citations.length === 0 ? null : (
        <Section title={t('rail.evidence.facts')}>
          <ul className="flex flex-col gap-1.5" data-testid="rail-evidence-facts">
            {facts.map((c) => (
              <li key={`fact:${c.id}`} className="flex items-center gap-1.5">
                <FactChip label={c.label} />
                <FactStatus card={card} />
              </li>
            ))}
            {citations.map((c) => (
              <li
                key={`quote:${c.fact_card_id}`}
                className="rounded-lg bg-ws-surface p-2 text-[12px] leading-5 text-ws-body"
              >
                「{c.quote}」
              </li>
            ))}
          </ul>
        </Section>
      )}

      <Section title={t('rail.evidence.checks')}>
        <ul className="flex flex-col gap-1" data-testid="rail-evidence-lines">
          {lines.map((line) => (
            <li key={line} className="text-[12px] leading-5" data-testid="rail-evidence-line">
              {line}
            </li>
          ))}
        </ul>
      </Section>

      {/*
        29 §2：以本人身份查不到展示名的 ref 在投影那一步就被丢掉了，这里只说个数。
        "还有 N 条你无权查看"本身也在上面那 N 条里——这一句是把它说得更明白些，
        因为它回答的是人看完证据之后第一个会问的问题："是不是还有我没看见的？"
      */}
      {card.detail.enrichment.dropped_refs === 0 ? null : (
        <p className="text-xs text-muted-foreground" data-testid="rail-evidence-dropped">
          {t('deck.enrichment.dropped', { n: card.detail.enrichment.dropped_refs })}
        </p>
      )}
    </div>
  )
}
