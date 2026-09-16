/**
 * WP71（36 §10 / 19）第三栏「知识」面板：**这一层管得着哪些知识**。
 *
 * 19 的规矩是"知识有适用范围"：一条职责能看的是某个**知识域**里、某个**范围**内、
 * 不超过某个**敏感级**的东西。这一栏把那三样原样摆出来，加上一句"库里现在有多少张
 * 事实卡"，再给一个进知识库的口子。
 *
 * **这里不做知识编辑器**。写事实卡要看得见出处、核对状态与复核队列（19 §1.1），
 * 380 宽的抽屉里做那件事只会做残；这一栏回答的是"我这一层看得见什么"。
 */
import { useQuery } from '@tanstack/react-query'
import { ExternalLink } from 'lucide-react'
import { Link } from 'react-router-dom'
import type { RailScope } from '@/components/rail/rail-scope'
import { Skeleton } from '@/components/ui/skeleton'
import { getPosition, getRoleDefinition, listKnowledgeCards, type RoleDetailView } from '@/lib/api'
import { useApp } from '@/lib/app-context'

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

  if (duties.isPending) return <Skeleton className="h-40 w-full" />
  if (duties.error !== null || duties.data === undefined)
    return <p className="text-muted-foreground">{t('error.generic')}</p>

  return (
    <div className="flex flex-col gap-3" data-testid="knowledge-panel" data-scope={scope.scope_id}>
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
