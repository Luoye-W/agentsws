/**
 * WP100（36 §9 那张表里的第四格）：**证据——这张卡凭什么**。
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
import { FactChip, ObjectChip } from '@/components/chips'
import { useEvidenceCard } from '@/components/deck/deck-focus'
import { evidenceLines } from '@/components/deck/evidence-chips'
import { StatusPill } from '@/components/design'
import { useApp } from '@/lib/app-context'
import { formatDateTime } from '@/lib/format'

function Section({ title, children }: { title: string; children: ReactNode }): ReactNode {
  return (
    <section className="flex flex-col gap-1.5">
      <h3 className="text-[11px] font-medium text-muted-foreground">{title}</h3>
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

  return (
    <div className="flex flex-col gap-4" data-testid="rail-evidence">
      <p className="text-[13px] leading-5 font-medium" data-testid="rail-evidence-title">
        {card.title}
      </p>

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
                className="rounded-[10px] bg-ws-surface p-2 text-[12px] leading-5 text-ws-body"
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
        <p className="text-[11px] text-muted-foreground" data-testid="rail-evidence-dropped">
          {t('deck.enrichment.dropped', { n: card.detail.enrichment.dropped_refs })}
        </p>
      )}
    </div>
  )
}
