/**
 * WP71（36 §10 / 19）第三栏「知识」面板：**这一层管得着哪些知识**。
 *
 * 19 的规矩是"知识有适用范围"：一条职责能看的是某个**知识域**里、某个**范围**内、
 * 不超过某个**敏感级**的东西。这一栏把那三样原样摆出来，加上一句"库里现在有多少张
 * 事实卡"，再给一个进知识库的口子。
 *
 * **WP209**：再加一行「这一层常用的知识」——与知识库页同一套分组（`KnowledgeGroupCounts`），
 * 按岗位挑类（职责层用它所属的岗位），每类几条。
 *
 * **WP350**：助理把一份资料拆给几个岗位时要记的那几条，在这个岗位这一栏最上面列「待你确认」
 * （正文 + 出处那份资料的名字）；确认在卡片流那张「要记的 N 条」上点。
 *
 * **这里不做知识编辑器**。写事实卡要看得见出处、核对状态与复核队列（19 §1.1），
 * 380 宽的抽屉里做那件事只会做残；这一栏回答的是"我这一层看得见什么"。
 */
import { useQuery } from '@tanstack/react-query'
import { ExternalLink } from 'lucide-react'
import { Link } from 'react-router-dom'
import { KnowledgeGroupCounts } from '@/components/library/knowledge-groups'
import { PanelError } from '@/components/rail/panel-error'
import type { RailScope } from '@/components/rail/rail-scope'
import { Skeleton } from '@/components/ui/skeleton'
import { getPosition, getRoleDefinition, listKnowledgeCards, type RoleDetailView } from '@/lib/api'
import { useApp } from '@/lib/app-context'
import { knowledgeGroupsForPosition } from '@/lib/library'

export function KnowledgePanel({ scope }: { scope: RailScope }): React.ReactNode {
  const { t } = useApp()

  /**
   * 这一层摊开是哪几条职责：职责层就是它自己；岗位层是本人在这个岗位下持有的那几条
   * （别人那条不算——他看得见什么与我这一栏无关，54 §2）。
   */
  const duties = useQuery({
    queryKey: ['rail-knowledge', scope.tier, scope.scope_id],
    queryFn: async (): Promise<RoleDetailView[]> => {
      const ids =
        scope.tier === 'role'
          ? [scope.scope_id]
          : (await getPosition(scope.assignment ?? '')).roles
              .filter((r) => r.my_assignment_id !== undefined)
              .map((r) => r.role_id)
      return Promise.all(ids.map((id) => getRoleDefinition(id)))
    },
  })

  /** 19 §1.1：库里现在有多少张**在用**的事实卡（提议中与退役的不算）。 */
  const cards = useQuery({
    queryKey: ['knowledge', 'cards'],
    queryFn: () => listKnowledgeCards(),
    retry: false,
  })
  const active = (cards.data ?? []).filter((c) => c.status === 'active').length

  // WP350：这个岗位名下、助理扇出过来还没确认的那几条
  const positionId = scope.tier === 'position' ? scope.scope_id : scope.parent?.scope_id
  const pending = (cards.data ?? []).filter(
    (c) =>
      c.status === 'proposed' &&
      c.subject.type === 'assistant_note' &&
      positionId !== undefined &&
      c.subject.id === positionId,
  )

  if (duties.isPending) return <Skeleton className="h-40 w-full" />
  if (duties.error !== null || duties.data === undefined) return <PanelError error={duties.error} />

  return (
    <div className="flex flex-col gap-3" data-testid="knowledge-panel" data-scope={scope.scope_id}>
      {pending.length === 0 ? null : (
        <section
          className="flex flex-col gap-1 rounded-md border border-ws-warn/40 p-2"
          data-testid="rail-knowledge-pending"
        >
          <p className="text-xs font-medium text-ws-warn">
            {t('rail.knowledge.pending', { n: pending.length })}
          </p>
          <ul className="flex flex-col gap-1">
            {pending.map((c) => (
              <li key={c.id} className="text-[12px]" data-testid="rail-knowledge-pending-item">
                <p className="text-ws-ink">{c.statement}</p>
                {c.provenance?.[0]?.locator === undefined ? null : (
                  <p
                    className="truncate text-[11px] text-muted-foreground"
                    title={c.provenance[0].quote}
                  >
                    {t('fanout.batch', { title: c.provenance[0].locator })}
                  </p>
                )}
              </li>
            ))}
          </ul>
        </section>
      )}
      <p className="text-xs text-muted-foreground">{t('rail.knowledge.hint')}</p>
      {duties.data.map((role) => (
        <section key={role.id} className="rounded-md border p-2" data-testid="rail-knowledge-role">
          <p className="text-sm font-medium">{role.name}</p>
          <p className="text-[11px] text-muted-foreground">
            {t('rail.knowledge.domain', { domain: role.domain })}
          </p>
          <ul className="mt-1 flex flex-col gap-0.5 text-[11px] text-muted-foreground">
            {role.scopes.map((s) => (
              <li key={`${s.domain}:${s.range}`} data-testid="rail-knowledge-scope">
                {t('rail.knowledge.scope', {
                  domain: s.domain,
                  range: s.range,
                  sensitivity: s.max_sensitivity,
                })}
              </li>
            ))}
          </ul>
        </section>
      ))}
      {cards.data === undefined ? null : (
        <section className="flex flex-col gap-1" data-testid="rail-knowledge-groups">
          <p className="text-xs text-muted-foreground">{t('rail.knowledge.groups')}</p>
          <KnowledgeGroupCounts
            cards={cards.data.filter((c) => c.status !== 'retired')}
            groups={knowledgeGroupsForPosition(
              scope.tier === 'position' ? scope.scope_id : scope.parent?.scope_id,
            )}
          />
        </section>
      )}
      <p className="text-xs" data-testid="rail-knowledge-cards">
        {cards.error === null
          ? t('rail.knowledge.cards', { count: active })
          : t('rail.knowledge.cards.unavailable')}
      </p>
      <Link
        to="/knowledge"
        className="flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground"
        data-testid="rail-knowledge-more"
      >
        <ExternalLink aria-hidden className="size-3.5" />
        {t('rail.knowledge.more')}
      </Link>
    </div>
  )
}
