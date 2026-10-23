/**
 * WP372（决策 1019，Luoye 10-17）：岗位 / 职责落地页对话框下面那一排**快捷按钮**——按当前状态现出，不写死。
 *
 * 参考 WP343 助理的快捷问题：最多 6 个，开始对话后收起。两类：
 * - **打开对应卡**（看状态生成，最多 3 个）：有新报表 →「看「周报」」；有对话等你看 →「看等你的 2 个对话」；
 *   必需的连接没连上 →「连上 Reddit」；计划等你点头 →「看等你点头的计划」；
 * - **直接发对话**：这个岗位 / 这条职责自己写的快捷提示（`quick_prompts`，如「今天新帖」「起草一条置顶」），
 *   点了就交出去（不再只是填进框里）。
 *
 * 数都从右侧面板那几张卡同一份缓存里读（同一组查询键），不另发请求。
 */
import { useQuery } from '@tanstack/react-query'
import { ArrowUpRight } from 'lucide-react'
import { type ReactNode, useState } from 'react'
import { useLocation, useNavigate } from 'react-router-dom'
import { useScopeConversations } from '@/components/conversations/conversation-data'
import { connectionNeedsYou, useScopeConnections } from '@/components/rail/card-status'
import { type RailScope, railContextOf } from '@/components/rail/rail-scope'
import { useRailState } from '@/components/rail/rail-state'
import { isListedSchedule, SCHEDULES_KEY, scheduleInScope } from '@/components/rail/schedule-count'
import { reportAddress, useScopeReports } from '@/components/reports/report-data'
import { useOpenConnect } from '@/components/setup/use-open-connect'
import { getMySchedules, getPositions, startKnowledgeLearn } from '@/lib/api'
import { useApp } from '@/lib/app-context'

/** 最多几个（决策 1019：4–6 个）。 */
export const LANDING_MAX = 6
/** WP456-T3（§3.1）：一排最多露 4 个，其余收进「更多」（点了就地展开）。 */
export const LANDING_VISIBLE = 4

/**
 * WP418（审计 U11）：中文模板「连上{name}」——名字是中文时紧挨着写（「连上店铺后台」），
 * 英文 / 数字开头才隔一个空格（「连上 Shopify」）。
 */
export const zhAfterVerb = (name: string): string => (/^[A-Za-z0-9]/.test(name) ? ` ${name}` : name)
/** WP488：客服那几条职责（岗位页上多一个「从过往邮件学」）。 */
export const KNOWLEDGE_LEARN_ROLES: readonly string[] = [
  'dtc.support',
  'amz.support',
  'dtc.live-chat',
]

/** 其中「打开卡」那一类最多几个（留位置给能直接发的提示）。 */
const OPEN_MAX = 3

export interface LandingPrompt {
  id: string
  label: string
  prompt: string
}

export interface LandingAction {
  id: string
  label: string
  kind: 'open' | 'send'
  run: () => void
}

/** WP419（自查 U1）：同一个岗位里几条职责的同名快捷按钮（FB、IG 都有「起草一条」）只留第一个。 */
export function uniqueByLabel<T extends { label: string }>(prompts: readonly T[]): T[] {
  const seen = new Set<string>()
  return prompts.filter((p) => {
    const k = p.label.trim()
    if (seen.has(k)) return false
    seen.add(k)
    return true
  })
}

/** 这一页对应的那一层（岗位页 = 岗位层；职责页 = 职责层），与右侧面板同一套算法。 */
export function usePageScope(): RailScope | undefined {
  const { lang, position } = useApp()
  const { pathname } = useLocation()
  const positions = useQuery({ queryKey: ['positions'], queryFn: getPositions, staleTime: 60_000 })
  const ctx = railContextOf(pathname, positions.data?.instances, position, lang)
  return ctx.preferred === 'role' ? (ctx.role ?? ctx.position) : ctx.position
}

/** 按状态现出的那几个（「打开卡」在前），再接上能直接发的提示，一共不超过 {@link LANDING_MAX}。 */
export function useLandingActions(
  prompts: readonly LandingPrompt[],
  send: (prompt: string) => void,
): LandingAction[] {
  const { t, lang } = useApp()
  const navigate = useNavigate()
  const rail = useRailState()
  const openConnect = useOpenConnect()
  const scope = usePageScope()
  const { reports } = useScopeReports(scope)
  const { duties } = useScopeConversations(scope)
  const { items } = useScopeConnections(scope)
  const schedules = useQuery({
    queryKey: SCHEDULES_KEY,
    queryFn: getMySchedules,
    enabled: scope !== undefined,
    retry: false,
  })

  const open: LandingAction[] = []
  const latest = reports[0]
  if (latest !== undefined)
    open.push({
      id: 'report',
      kind: 'open',
      label: t('landing.report', { title: latest.title }),
      run: () => {
        rail.openAddress(reportAddress(latest.id))
      },
    })
  const waiting = duties
    .flatMap((d) => d.matters)
    .filter((m) => m.state === 'awaiting' || m.state === 'ready').length
  if (waiting > 0)
    open.push({
      id: 'conversations',
      kind: 'open',
      label: t('landing.waiting', { n: waiting }),
      run: () => {
        rail.openCard('conversations')
      },
    })
  const missing = items.find(connectionNeedsYou)
  if (missing !== undefined)
    open.push({
      id: 'connect',
      kind: 'open',
      label: t('landing.connect', {
        name: lang === 'en' ? missing.name.en : zhAfterVerb(missing.name.zh),
      }),
      run: () => {
        if (missing.connect_service === undefined) rail.openCard('connections')
        else openConnect(missing.connect_service)
      },
    })
  const planWaiting =
    scope === undefined
      ? 0
      : (schedules.data ?? []).filter(
          (r) =>
            isListedSchedule(r) &&
            scheduleInScope(r, scope) &&
            r.params?.awaiting_approval === true,
        ).length
  if (planWaiting > 0)
    open.push({
      id: 'plans',
      kind: 'open',
      label: t('landing.plans', { n: planWaiting }),
      run: () => {
        rail.openCard('plans')
      },
    })

  const shown = open.slice(0, OPEN_MAX)
  /*
   * WP488（决策 1680）：客服岗位「从过往邮件学」——直接开一次（默认回看 12 个月），跳到那件事看进度；
   * 没接邮箱时服务端在那件事里出连接卡（决策 690）。
   */
  const learnRole = scope?.roles?.find((r) => KNOWLEDGE_LEARN_ROLES.includes(r.role_id))
  if (learnRole !== undefined)
    shown.push({
      id: 'learn_email',
      kind: 'open',
      label: t('landing.learn_email'),
      run: () => {
        void startKnowledgeLearn({ source: 'email' }, learnRole.assignment)
          .then((job) => {
            if (job.matter_id !== undefined) navigate(`/matters/${job.matter_id}`)
            else navigate('/knowledge')
          })
          .catch(() => {
            navigate('/knowledge')
          })
      },
    })
  const sends: LandingAction[] = uniqueByLabel(prompts).map((p) => ({
    id: `prompt:${p.id}`,
    kind: 'send',
    label: p.label,
    run: () => {
      send(p.prompt)
    },
  }))
  return [...shown, ...sends].slice(0, LANDING_MAX)
}

const CHIP =
  'inline-flex h-[26px] items-center gap-1 rounded-full border border-ws-line-strong bg-ws-card px-2.5 text-xs text-ws-body hover:bg-ws-hover hover:text-ws-ink'

export function LandingActions({ actions }: { actions: readonly LandingAction[] }): ReactNode {
  const { t } = useApp()
  // WP456-T3（§3.1）：最多露 4 个、一行排得下；多的收进「更多」
  const [all, setAll] = useState(false)
  if (actions.length === 0) return null
  const folded = !all && actions.length > LANDING_VISIBLE
  const shown = folded ? actions.slice(0, LANDING_VISIBLE) : actions
  return (
    <div className="flex flex-wrap items-center gap-1.5" data-testid="landing-actions">
      {shown.map((a) => (
        <button
          key={a.id}
          type="button"
          className={CHIP}
          data-testid="landing-action"
          data-kind={a.kind}
          data-action={a.id}
          onClick={a.run}
        >
          {a.label}
          {a.kind === 'open' ? <ArrowUpRight aria-hidden className="size-3" /> : null}
        </button>
      ))}
      {folded ? (
        <button
          type="button"
          className={`${CHIP} text-ws-muted-fg`}
          data-testid="landing-more"
          aria-expanded={false}
          onClick={() => {
            setAll(true)
          }}
        >
          {t('landing.more')}
        </button>
      ) : null}
    </div>
  )
}
