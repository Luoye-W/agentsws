/**
 * WP71（36 §10）第三栏「技能」面板：**这一层挂着哪些技能，按六层列**。
 *
 * 一条技能在库里只有一份，六层各自往上打补丁（24 §1）。所以这一栏做的是两件事：
 *
 * - **按层分组列**（内置包 / 公司 / 部门 / 岗位 / 职责 / 个人）——分组用的是每条技能
 *   **基础版所在的那一层**（`SkillSummary.tier`），后面跟着它现在有几层 overlay；
 * - **本层的能动、别层的只读**：
 *   - 「不用它」（`POST /v1/skills/:name/exclude`）只影响本人（24 §2），所以任何一层都给；
 *   - 「提到这一层」（`POST /v1/skills/:name/promote`）把**个人层**上改过的那几段提到
 *     当前这一层——出的是一张待审卡，不是一次写入（24 §3）。个人层上什么都没改过时
 *     服务端会照实回一句"没有可以提上去的东西"，界面把那句话原样显示。
 *
 * **面板里不做技能编辑器**：改正文是一件要看得见全文与 diff 的事，380 宽的抽屉里做不了，
 * 那件事在技能页（`/skills`）。这里给的是"这一层现在吃着什么、我要不要让它吃"。
 */
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { ArrowUpFromLine, ExternalLink } from 'lucide-react'
import { Link } from 'react-router-dom'
import type { RailScope } from '@/components/rail/rail-scope'
import { Button } from '@/components/ui/button'
import { Skeleton } from '@/components/ui/skeleton'
import { getSkills, promoteSkillTo, type SkillSummary, setSkillExcluded } from '@/lib/api'
import { useApp } from '@/lib/app-context'
import { cn } from '@/lib/utils'

/** 真源是 `packages/skills` 的 `TIER_ORDER`；工作台不依赖那个包，这里抄的是顺序。 */
const TIERS = ['package', 'company', 'department', 'position', 'role', 'personal'] as const

function SkillRow({
  skill,
  scope,
  onChanged,
}: {
  skill: SkillSummary
  scope: RailScope
  onChanged: () => void
}): React.ReactNode {
  const { t } = useApp()
  const exclude = useMutation({
    mutationFn: (excluded: boolean) => setSkillExcluded(skill.name, excluded),
    onSettled: onChanged,
  })
  const promote = useMutation({
    mutationFn: () =>
      promoteSkillTo({
        skill: skill.name,
        section_ids: skill.sections.map((s) => s.id),
        to_tier: scope.tier,
        scope_id: scope.scope_id,
      }),
  })
  return (
    <li className="rounded-md border p-2" data-testid="rail-skill" data-skill={skill.name}>
      <div className="flex items-baseline gap-1">
        <span className={cn('min-w-0 flex-1 truncate text-sm', skill.excluded && 'line-through')}>
          {skill.name}
        </span>
        <span className="shrink-0 font-mono text-[11px] text-muted-foreground">
          v{skill.version}
        </span>
      </div>
      <p className="text-[11px] text-muted-foreground">
        {t('rail.skills.overlays', { count: skill.overlays.length })}
      </p>
      <div className="mt-1 flex flex-wrap gap-1">
        <Button
          size="xs"
          variant="ghost"
          data-testid="rail-skill-exclude"
          disabled={exclude.isPending}
          onClick={() => {
            exclude.mutate(!skill.excluded)
          }}
        >
          {skill.excluded ? t('rail.skills.include') : t('rail.skills.exclude')}
        </Button>
        <Button
          size="xs"
          variant="ghost"
          data-testid="rail-skill-promote"
          disabled={promote.isPending}
          onClick={() => {
            promote.mutate()
          }}
        >
          <ArrowUpFromLine aria-hidden className="size-3.5" />
          {t('rail.skills.promote', { tier: t(`rail.tier.${scope.tier}`) })}
        </Button>
      </div>
      {promote.data === undefined ? null : (
        <p
          className="mt-1 text-[11px] text-muted-foreground"
          data-testid="rail-skill-promote-result"
        >
          {promote.data.accepted ? t('memory.promote.ok') : promote.data.reason}
        </p>
      )}
    </li>
  )
}

export function SkillsPanel({ scope }: { scope: RailScope }): React.ReactNode {
  const { t } = useApp()
  const client = useQueryClient()
  const skills = useQuery({ queryKey: ['skills'], queryFn: getSkills })
  const onChanged = (): void => {
    void client.invalidateQueries({ queryKey: ['skills'] })
  }

  if (skills.isPending) return <Skeleton className="h-40 w-full" />
  if (skills.error !== null || skills.data === undefined)
    return <p className="text-muted-foreground">{t('error.generic')}</p>
  const rows = skills.data

  return (
    <div className="flex flex-col gap-3" data-testid="skills-panel" data-scope={scope.scope_id}>
      <p className="text-xs text-muted-foreground">{t('rail.skills.hint')}</p>
      {TIERS.map((tier) => {
        const here = rows.filter((s) => s.tier === tier)
        if (here.length === 0) return null
        return (
          <section key={tier} data-testid="rail-skill-tier" data-tier={tier}>
            <h3
              className={cn(
                'mb-1 text-xs font-medium',
                tier === scope.tier ? 'text-foreground' : 'text-muted-foreground',
              )}
            >
              {t(`rail.tier.${tier}`)}
              {tier === scope.tier ? ` · ${t('rail.skills.this_layer')}` : ''}
            </h3>
            <ul className="flex flex-col gap-2">
              {here.map((s) => (
                <SkillRow key={s.name} skill={s} scope={scope} onChanged={onChanged} />
              ))}
            </ul>
          </section>
        )
      })}
      <Link
        to="/skills"
        className="flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground"
        data-testid="rail-skills-more"
      >
        <ExternalLink aria-hidden className="size-3.5" />
        {t('rail.skills.more')}
      </Link>
    </div>
  )
}
