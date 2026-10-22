/**
 * WP372（决策 1001 / 1004）：右侧面板「对话」——卡（最多 5 条，要你看的排最上）与完整列表（「显示更多」，WP433 起多于 5 条才出）。
 *
 * - 职责层：这条职责的对话按「今天 / 本周 / 更早」分组；
 * - 岗位层（岗位总览）：按职责分组列全部；
 * - 顶上「+ 新对话」，一格输入回车就交出去；可以按标题搜。
 */
import { Archive } from 'lucide-react'
import { type ReactNode, useEffect, useState } from 'react'
import { useConversationActions } from '@/components/conversations/actions'
import {
  byAttention,
  type ConvDuty,
  groupByTime,
  matchesQuery,
  useScopeConversations,
} from '@/components/conversations/conversation-data'
import {
  ConvRows,
  ConvSearch,
  NewConvButton,
  NewConversation,
} from '@/components/conversations/conversation-list'
import type { RailScope } from '@/components/rail/rail-scope'
import { useRailState } from '@/components/rail/rail-state'
import {
  type RailCardBodyProps,
  type RailPanelBodyProps,
  useCardTotal,
} from '@/components/rail/registry'
import { useApp } from '@/lib/app-context'

/** 新对话交给谁：职责层 = 这条职责（跳过岗位内路由）；岗位层 = 岗位自己分。 */
function composeTarget(scope: RailScope): { assignment: string; role_id?: string } | undefined {
  if (scope.assignment === undefined) return undefined
  return scope.tier === 'role'
    ? { assignment: scope.assignment, role_id: scope.scope_id }
    : { assignment: scope.assignment }
}

/** 新对话那一格开没开；外壳点名带了 `compose` 意图（左栏职责行的「+」）就先开着。 */
function useComposeOpen(): [boolean, (open: boolean) => void] {
  const rail = useRailState()
  const [open, setOpen] = useState(rail.intent === 'compose')
  useEffect(() => {
    if (rail.intent !== 'compose') return
    setOpen(true)
    rail.clearIntent()
  }, [rail])
  return [open, setOpen]
}

function ComposeBar({ scope }: { scope: RailScope }): ReactNode {
  const { t } = useApp()
  const [open, setOpen] = useComposeOpen()
  const target = composeTarget(scope)
  if (target === undefined) return null
  if (open)
    return (
      <NewConversation
        {...target}
        onDone={() => {
          setOpen(false)
        }}
      />
    )
  return (
    <NewConvButton
      label={t('conv.new.tip', { name: scope.name })}
      onClick={() => {
        setOpen(true)
      }}
    />
  )
}

function ArchivedLink({ scope, duty }: { scope: RailScope; duty: ConvDuty }): ReactNode {
  const { t } = useApp()
  const actions = useConversationActions()
  const position_id = scope.tier === 'role' ? scope.parent?.scope_id : scope.scope_id
  if (duty.archived === 0 || actions.openArchived === undefined || position_id === undefined)
    return null
  return (
    <button
      type="button"
      data-testid="conv-archived"
      className="ws-link-muted flex items-center gap-1 px-1.5 text-[12px]"
      onClick={() => {
        actions.openArchived?.({ position_id, role_id: duty.role_id })
      }}
    >
      <Archive aria-hidden className="size-3" />
      {t('conv.archived', { n: duty.archived })}
    </button>
  )
}

/** 卡身体：新对话 + 最多 5 条（要你看的排最上）。 */
export function ConversationsCard({ scope, limit, onTotal }: RailCardBodyProps): ReactNode {
  const { t } = useApp()
  const { duties, ready } = useScopeConversations(scope)
  const all = duties.flatMap((d) => d.matters).sort(byAttention)
  // WP433：卡上放不下的（更早的、已归档的）也算——完整一格里才看得到它们
  useCardTotal(onTotal, all.length + duties.reduce((n, d) => n + d.more + d.archived, 0))
  if (scope === undefined) return null
  return (
    <div className="flex flex-col gap-1.5" data-testid="conv-card">
      <ComposeBar scope={scope} />
      {all.length === 0 ? (
        ready ? (
          <p className="px-1.5 text-[12px] text-ws-muted-fg" data-testid="conv-empty">
            {t('conv.empty')}
          </p>
        ) : null
      ) : (
        <ConvRows matters={all.slice(0, limit)} />
      )}
    </div>
  )
}

/** 完整列表（「显示更多」开的那一格）：可搜、分组、每组底下「已归档 n」。 */
export function ConversationsPanel({ scope }: RailPanelBodyProps): ReactNode {
  const { t } = useApp()
  const { duties, ready } = useScopeConversations(scope)
  const [q, setQ] = useState('')
  if (scope === undefined) return null
  const target = composeTarget(scope)
  const total = duties.reduce((n, d) => n + d.matters.length, 0)
  return (
    <div className="flex flex-col gap-3" data-testid="conv-panel" data-tier={scope.tier}>
      <div className="flex items-center gap-1.5">
        <ConvSearch value={q} onChange={setQ} />
      </div>
      {target === undefined ? null : <ComposeBar scope={scope} />}
      {total === 0 && ready ? (
        <p className="px-1.5 text-[12px] text-ws-muted-fg" data-testid="conv-empty">
          {t('conv.empty')}
        </p>
      ) : scope.tier === 'role' ? (
        duties.map((d) => <TimeGroups key={d.role_id} scope={scope} duty={d} q={q} />)
      ) : (
        duties.map((d) => <DutyGroup key={d.role_id} scope={scope} duty={d} q={q} />)
      )}
    </div>
  )
}

function Heading({ children, testId }: { children: ReactNode; testId: string }): ReactNode {
  return (
    <h3 className="px-1.5 text-xs tracking-wider text-ws-muted-fg uppercase" data-testid={testId}>
      {children}
    </h3>
  )
}

function TimeGroups({
  scope,
  duty,
  q,
}: {
  scope: RailScope
  duty: ConvDuty
  q: string
}): ReactNode {
  const { t } = useApp()
  const groups = groupByTime(duty.matters.filter((m) => matchesQuery(m, q)))
  return (
    <div className="flex flex-col gap-3">
      {groups.length === 0 && q !== '' ? (
        <p className="px-1.5 text-[12px] text-ws-muted-fg">{t('conv.none_found')}</p>
      ) : null}
      {groups.map((g) => (
        <section
          key={g.group}
          className="flex flex-col gap-1"
          data-testid="conv-group"
          data-group={g.group}
        >
          <Heading testId="conv-group-title">{t(`conv.group.${g.group}`)}</Heading>
          <ConvRows matters={g.matters} />
        </section>
      ))}
      <Footer scope={scope} duty={duty} />
    </div>
  )
}

function DutyGroup({ scope, duty, q }: { scope: RailScope; duty: ConvDuty; q: string }): ReactNode {
  const matters = duty.matters.filter((m) => matchesQuery(m, q))
  if (matters.length === 0 && (q !== '' || duty.archived === 0)) return null
  return (
    <section className="flex flex-col gap-1" data-testid="conv-duty" data-duty={duty.role_id}>
      <Heading testId="conv-duty-title">{duty.name}</Heading>
      <ConvRows
        matters={[...matters].sort((a, b) => b.last_activity.localeCompare(a.last_activity))}
      />
      <Footer scope={scope} duty={duty} />
    </section>
  )
}

function Footer({ scope, duty }: { scope: RailScope; duty: ConvDuty }): ReactNode {
  const { t } = useApp()
  return (
    <div className="flex flex-wrap items-center gap-2">
      {duty.more > 0 ? (
        <span className="px-1.5 text-[12px] text-ws-muted-fg">
          {t('conv.older', { n: duty.more })}
        </span>
      ) : null}
      <ArchivedLink scope={scope} duty={duty} />
    </div>
  )
}
