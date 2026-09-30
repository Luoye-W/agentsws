/**
 * WP209：技能**按岗位分组**的那一整块（技能页用它；第三栏「设定 → 技能」用 `SkillTagList`）。
 *
 * 顺序：本人开了的岗位（摊开）→ 通用（摊开）→「没开的岗位」（整块收着，里面每个岗位也收着）。
 * 一个技能挂在几个岗位下，就在几个组里各出现一次，卡上标「共用」。
 */
import { type ReactNode, useState } from 'react'
import type { SkillSummary } from '@/lib/api'
import { useApp } from '@/lib/app-context'
import { groupSkills, type SkillGroup, skillLabel } from '@/lib/library'
import { cn } from '@/lib/utils'
import { LibraryGroup } from './library-group'
import { SkillTile } from './skill-tile'

export interface SkillGroupsProps {
  skills: readonly SkillSummary[]
  onToggleExcluded(name: string, next: boolean): void
  /** 搜索 / 筛选生效时：所有组摊开（结果不能藏在收着的组里）。 */
  forceOpen?: boolean
}

export function SkillGroups({
  skills,
  onToggleExcluded,
  forceOpen = false,
}: SkillGroupsProps): ReactNode {
  const { t, lang } = useApp()
  // 点开的那一张：`组:技能`——同一个技能在两个组里各是一张卡，点一张不该把另一张也撑开
  const [openKey, setOpenKey] = useState<string | null>(null)
  const { mine, common, others } = groupSkills(skills)

  const renderGroup = (group: SkillGroup, level: 1 | 2, defaultOpen: boolean): ReactNode => (
    <LibraryGroup
      key={group.id}
      id={group.id}
      title={group.name[lang]}
      count={group.skills.length}
      level={level}
      defaultOpen={defaultOpen}
      forceOpen={forceOpen}
    >
      <ul className="grid gap-2 sm:grid-cols-2">
        {group.skills.map((skill) => {
          const key = `${group.id}:${skill.name}`
          return (
            <SkillTile
              key={key}
              skill={skill}
              open={openKey === key}
              onToggle={() => {
                setOpenKey(openKey === key ? null : key)
              }}
              onToggleExcluded={(next) => {
                onToggleExcluded(skill.name, next)
              }}
            />
          )
        })}
      </ul>
    </LibraryGroup>
  )

  const othersCount = new Set(others.flatMap((g) => g.skills.map((s) => s.name))).size
  return (
    <div className="flex flex-col gap-5" data-testid="skill-groups">
      {mine.map((g) => renderGroup(g, 1, true))}
      {common === undefined ? null : renderGroup(common, 1, true)}
      {others.length === 0 ? null : (
        <LibraryGroup
          id="others"
          title={t('skills.group.others')}
          count={othersCount}
          hint={t('skills.group.others.hint')}
          // 一个岗位都没开的人（刚装好）：别让整页只剩一个收着的组
          defaultOpen={mine.length === 0 && common === undefined}
          forceOpen={forceOpen}
        >
          <div className="flex flex-col gap-3 pl-5">
            {others.map((g) => renderGroup(g, 2, false))}
          </div>
        </LibraryGroup>
      )}
    </div>
  )
}

/**
 * 第三栏用的精简版：一行一个技能名 + 待看建议数。过滤（按当前岗位 / 职责）由调用方用
 * `skillsForScope` 做，这里只管摆。
 */
export function SkillTagList({
  skills,
  className,
}: {
  skills: readonly SkillSummary[]
  className?: string
}): ReactNode {
  const { t, lang } = useApp()
  return (
    <ul className={cn('flex flex-wrap gap-1', className)} data-testid="skill-tag-list">
      {skills.map((s) => (
        <li
          key={s.name}
          data-skill={s.name}
          className={cn(
            'inline-flex h-[22px] items-center gap-1 rounded-md bg-ws-surface px-2 text-xs text-ws-body',
            s.excluded && 'line-through',
          )}
        >
          {skillLabel(s, lang)}
          {s.pending_proposals > 0 ? (
            <span
              className="rounded-full bg-ws-warn-bg px-1 text-[10px] text-ws-warn"
              title={t('skills.badge.proposals', { count: s.pending_proposals })}
            >
              {s.pending_proposals}
            </span>
          ) : null}
        </li>
      ))}
    </ul>
  )
}
