/**
 * WP209：技能页上一个技能的**小卡**。
 *
 * 一眼只看四样（36 §7 少字）：中文名、一句话、哪几条职责在用（小标签）、有几条建议待看。
 * 原描述进名字旁边的问号；段落与三层改动**点开才看**（`SkillDetails`，原来那张大卡的内容）。
 */
import { ChevronDown } from 'lucide-react'
import type { ReactNode } from 'react'
import { StatusPill, WsCard, WsTag } from '@/components/design'
import { SkillDetails } from '@/components/skills/skill-card'
import { Hint } from '@/components/ui/hint'
import type { SkillSummary } from '@/lib/api'
import { useApp } from '@/lib/app-context'
import { sharedAcross, skillLabel, skillSummaryLine } from '@/lib/library'
import { cn } from '@/lib/utils'

/** 卡上最多摆几条职责标签，多出来的折成「+N」（名字全在问号里）。 */
const MAX_ROLE_TAGS = 3

export function SkillTile({
  skill,
  open,
  onToggle,
  onToggleExcluded,
}: {
  skill: SkillSummary
  open: boolean
  onToggle(): void
  onToggleExcluded(next: boolean): void
}): ReactNode {
  const { t, lang } = useApp()
  const label = skillLabel(skill, lang)
  const line = skillSummaryLine(skill, lang)
  const shared = sharedAcross(skill)
  const roles = skill.roles ?? []
  const shown = roles.slice(0, MAX_ROLE_TAGS)
  const rest = roles.slice(MAX_ROLE_TAGS)
  return (
    <li className={cn('list-none', open && 'sm:col-span-2')}>
      <WsCard
        data-testid="skill-tile"
        data-skill={skill.name}
        data-open={open ? 'yes' : 'no'}
        selected={open}
        className="flex flex-col gap-2 px-4 py-3"
      >
        <div className="flex items-start gap-2">
          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-1">
              <span
                className={cn(
                  'truncate font-medium text-ws-ink',
                  skill.excluded && 'text-ws-muted-fg line-through',
                )}
                data-testid="skill-tile-name"
              >
                {label}
              </span>
              {skill.description === undefined ? null : <Hint text={skill.description} />}
            </div>
            {line === undefined ? null : (
              <p className="truncate text-xs text-ws-muted-fg" data-testid="skill-tile-line">
                {line}
              </p>
            )}
          </div>
          {skill.pending_proposals > 0 ? (
            <StatusPill tone="warn" data-testid="skill-tile-proposals">
              {t('skills.badge.proposals', { count: skill.pending_proposals })}
            </StatusPill>
          ) : null}
        </div>

        <div className="flex flex-wrap items-center gap-1">
          {shared > 1 ? (
            <WsTag
              className="bg-ws-tint text-ws-brand-ink"
              data-testid="skill-tile-shared"
              title={t('skills.shared.hint', { count: shared })}
            >
              {t('skills.shared')}
            </WsTag>
          ) : null}
          {skill.excluded ? <WsTag>{t('skills.excluded')}</WsTag> : null}
          {roles.length === 0 && skill.roles !== undefined ? (
            <span className="text-xs text-ws-muted-fg">{t('skills.roles.none')}</span>
          ) : null}
          {shown.map((r) => (
            <WsTag
              key={r.role_id}
              data-testid="skill-tile-role"
              className={cn(r.mine && 'font-medium text-ws-ink')}
            >
              {r.name[lang]}
            </WsTag>
          ))}
          {rest.length === 0 ? null : (
            <WsTag title={rest.map((r) => r.name[lang]).join('、')}>+{rest.length}</WsTag>
          )}
          <button
            type="button"
            aria-expanded={open}
            data-testid="skill-tile-toggle"
            className="ml-auto inline-flex items-center gap-0.5 text-xs text-ws-muted-fg hover:text-ws-ink"
            onClick={onToggle}
          >
            {open ? t('skills.details.close') : t('skills.details')}
            <ChevronDown
              aria-hidden
              className={cn('size-3.5 transition-transform', open && 'rotate-180')}
            />
          </button>
        </div>

        {open ? (
          <div className="border-t border-ws-line pt-3">
            <SkillDetails skill={skill} onToggleExcluded={onToggleExcluded} />
          </div>
        ) : null}
      </WsCard>
    </li>
  )
}
