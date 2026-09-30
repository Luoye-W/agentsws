/**
 * WP209：知识库**按类型分组**的那一整块，外加第三栏用的精简版。
 *
 * 一条知识一行：正文那句话 + 状态（已生效 / 待确认 / 已过期 / 冲突）+ 来源（上传 / Agent 提议 /
 * 手填）+ 它是哪一份（政策里的退换 / 运费…、B2B 里的价格与 MOQ…）+ 适用范围。
 * 分类、状态、来源的判定都在 `lib/library.ts`（纯函数），这里只管摆。
 *
 * 「上传的文档」是另一张表（`KnowledgeSource`）：它的那一列由页面自己画（点一份在第三栏预览、
 * 删除按钮），以 `uploads` 插进它该在的位置。空组不显示。
 */
import type { ReactNode } from 'react'
import { StatusPill, type Tone, WsTag } from '@/components/design'
import type { KnowledgeCardRow } from '@/lib/api'
import { useApp } from '@/lib/app-context'
import {
  b2bCategoryOf,
  groupKnowledge,
  KNOWLEDGE_GROUPS,
  type KnowledgeGroupId,
  type KnowledgeStatus,
  knowledgeOriginOf,
  knowledgeStatusOf,
  policyKindOf,
  scopeLabel,
  statementParts,
} from '@/lib/library'
import { LibraryGroup } from './library-group'

export const STATUS_TONE: Record<KnowledgeStatus, Tone> = {
  active: 'good',
  pending: 'warn',
  expired: 'neutral',
  conflict: 'bad',
}

/** 适用范围的名字：调用方给了名字表就用名字，没有就「类别 · id」。 */
export type ScopeNameOf = (scope: { kind: string; id: string }) => string

export function KnowledgeRow({
  card,
  now,
  scopeName,
}: {
  card: KnowledgeCardRow
  now?: Date
  scopeName?: ScopeNameOf
}): ReactNode {
  const { t } = useApp()
  const status = knowledgeStatusOf(card, now)
  const origin = knowledgeOriginOf(card)
  const policy = policyKindOf(card)
  const b2b = b2bCategoryOf(card)
  const parts = statementParts(card.statement)
  const kind =
    b2b !== undefined
      ? t(`knowledge.b2b.${b2b}`)
      : policy !== undefined
        ? t(`knowledge.policy.${policy}`)
        : undefined
  return (
    <li
      className="flex flex-col gap-1.5 py-2.5 sm:flex-row sm:items-start sm:gap-3"
      data-testid="knowledge-row"
      data-card={card.id}
      data-status={status}
      data-origin={origin}
    >
      <div className="min-w-0 flex-1 text-sm">
        {parts.title === undefined ? null : (
          <p className="truncate font-medium text-ws-ink">{parts.title}</p>
        )}
        <p
          className={
            parts.title === undefined
              ? 'line-clamp-2 text-ws-ink'
              : 'truncate text-xs text-ws-muted-fg'
          }
        >
          {parts.body}
        </p>
      </div>
      <div className="flex shrink-0 flex-wrap items-center gap-1 sm:max-w-[55%] sm:justify-end">
        {kind === undefined ? null : <WsTag>{kind}</WsTag>}
        {(card.scope ?? []).map((s) => (
          <WsTag key={`${s.kind}:${s.id}`} data-testid="knowledge-row-scope">
            {scopeName === undefined ? scopeLabel(s, [], t) : scopeName(s)}
          </WsTag>
        ))}
        {card.stage === undefined || card.stage === 'both' ? null : (
          <WsTag>{t(`knowledge.stage.${card.stage}`)}</WsTag>
        )}
        <WsTag data-slot="status">{t(`knowledge.origin.${origin}`)}</WsTag>
        <StatusPill tone={STATUS_TONE[status]}>{t(`knowledge.status.${status}`)}</StatusPill>
      </div>
    </li>
  )
}

export function KnowledgeGroups({
  cards,
  uploads,
  forceOpen = false,
  now,
  scopeName,
}: {
  cards: readonly KnowledgeCardRow[]
  /** 「上传的文档」那一组：页面画好的列表 + 条数；条数为 0 不显示。 */
  uploads?: { count: number; node: ReactNode }
  forceOpen?: boolean
  now?: Date
  scopeName?: ScopeNameOf
}): ReactNode {
  const { t } = useApp()
  const groups = groupKnowledge(cards)
  return (
    <div className="flex flex-col gap-4" data-testid="knowledge-groups">
      {KNOWLEDGE_GROUPS.map((id: KnowledgeGroupId) => {
        if (id === 'uploads') {
          if (uploads === undefined || uploads.count === 0) return null
          return (
            <LibraryGroup
              key={id}
              id={id}
              title={t('knowledge.group.uploads')}
              count={uploads.count}
              forceOpen={forceOpen}
            >
              {uploads.node}
            </LibraryGroup>
          )
        }
        const group = groups.find((g) => g.id === id)
        if (group === undefined) return null
        return (
          <LibraryGroup
            key={id}
            id={id}
            title={t(`knowledge.group.${id}`)}
            count={group.cards.length}
            forceOpen={forceOpen}
          >
            <ul className="ws-card divide-y divide-ws-line px-4">
              {group.cards.map((c) => (
                <KnowledgeRow
                  key={c.id}
                  card={c}
                  {...(now === undefined ? {} : { now })}
                  {...(scopeName === undefined ? {} : { scopeName })}
                />
              ))}
            </ul>
          </LibraryGroup>
        )
      })}
    </div>
  )
}

/**
 * 第三栏「设定 → 知识」用的精简版：这一层常用的那几类各有几条（同一套分组，按岗位挑类）。
 * 挑哪几类用 `knowledgeGroupsForPosition`；为 0 的类不显示。
 */
export function KnowledgeGroupCounts({
  cards,
  groups,
  uploads = 0,
}: {
  cards: readonly KnowledgeCardRow[]
  groups: readonly KnowledgeGroupId[]
  uploads?: number
}): ReactNode {
  const { t } = useApp()
  const counts = new Map(groupKnowledge(cards).map((g) => [g.id as string, g.cards.length]))
  counts.set('uploads', uploads)
  const shown = groups.filter((g) => (counts.get(g) ?? 0) > 0)
  if (shown.length === 0) return null
  return (
    <ul className="flex flex-wrap gap-1" data-testid="knowledge-group-counts">
      {shown.map((g) => (
        <li key={g} data-group={g}>
          <WsTag>
            {t(`knowledge.group.${g}`)}
            <span className="ml-1 text-ws-muted-fg">{counts.get(g)}</span>
          </WsTag>
        </li>
      ))}
    </ul>
  )
}
