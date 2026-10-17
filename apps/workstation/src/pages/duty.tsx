/**
 * WP71（36 §10）**职责页**：`/positions/:assignment/duties/:role_id`。
 *
 * 只从两处进得来——左栏岗位展开层，或岗位页的职责折叠层。**首页上没有它**：
 * 职责太细，放在首页只会让人每天多读四行（54 §4 定的"开启任务主要在岗位里"）。
 *
 * 页面很薄，故意的：
 *
 * - 头部：面包屑「岗位 › 职责」、职责名、版本、"内置只读 / 从内置模板复制"pill、
 *   谁在做、范围，以及**「用这条职责开一件事」**（走 WP69 的 `entry: 'role'`）；
 * - 正文就是**概览**（一句人话；能看什么、能做什么、挂着哪些技能与连接器收在默认折叠的
 *   「高级」里，WP238 起翻成人话）。
 *
 * **记忆 / 技能 / 知识 / 额度 / 记录不在这一页上**——它们在第三栏（36 §9），跟着当前职责走。
 * WP288（决策 326）：原来的「概览 / 记录」两个页签去掉（记录进第三栏「记录」）；头部那四个
 * 「把右栏打开到那一格」的按钮也去掉——第三栏「设定」图标就在同一屏上，不说两遍。
 *
 * **WP372（决策 1019，Luoye 10-17）**：中间栏回到普通对话框形态——标题（+ 一句人话）+ 对话框 + 按状态现出的
 * 快捷按钮 +「要你拍板」的卡（这条职责的牌）。这条职责自己的看板（社媒内容日历与群发、B2B、投放素材、
 * AI 回答监测）搬进右侧面板「报表」的下半截（`components/reports/scope-boards.tsx`），头部留一个小链接。
 */
import { useMutation, useQuery } from '@tanstack/react-query'
import { ChevronDown, ChevronRight, Loader2, Play } from 'lucide-react'
import { useEffect, useState } from 'react'
import { Link, useNavigate, useParams } from 'react-router-dom'
import { CalendarLink } from '@/components/calendar/calendar-link'
import { DeckSection } from '@/components/deck'
import { InfoTip, WsTag } from '@/components/design'
import {
  LandingActions,
  type LandingPrompt,
  useLandingActions,
} from '@/components/position/landing-actions'
import { PanelError } from '@/components/rail/panel-error'
import { useRailState } from '@/components/rail/rail-state'
import { dutyHasBoards } from '@/components/reports/scope-boards'
import { DutyIcon } from '@/components/role-icons/role-icon'
import { Button } from '@/components/ui/button'
import { Hint } from '@/components/ui/hint'
import { Input } from '@/components/ui/input'
import { MarkdownInline } from '@/components/ui/safe-markdown'
import { Skeleton } from '@/components/ui/skeleton'
import { HandoffError } from '@/components/work/handoff-error'
import {
  createMatterWithRole,
  getPosition,
  getRoleDefinition,
  type RoleDetailView,
} from '@/lib/api'
import { useApp } from '@/lib/app-context'
import {
  actionLines,
  type CapabilityLine,
  connectorLines,
  scopeLines,
  skillLines,
} from '@/lib/duty-capabilities'
import { handoffInput, TASK_TEXT_MAX } from '@/lib/handoff'
import { firstSentence } from '@/lib/help'
import { matterUrl } from '@/lib/work'

/** 头部那一行「用这条职责开一件事」：54 §2 保留的从职责开启那条路。 */
function OpenHere({
  assignment,
  prompts = [],
}: {
  assignment: string
  /** WP372（决策 1019）：这条职责自己的快捷提示（点了直接发）。 */
  prompts?: readonly LandingPrompt[]
}): React.ReactNode {
  const { t } = useApp()
  const navigate = useNavigate()
  const [title, setTitle] = useState('')
  /** WP372：开始对话后快捷按钮收起。 */
  const [started, setStarted] = useState(false)
  const open = useMutation({
    // 54 §2 职责入口：用**这条职责的分配**建事项，跳过岗位内路由——
    // 权限、额度、动作面全是这一条的（不是岗位的并集）。
    // WP259：长文本拆成标题 + 完整原文；开完立刻用这条职责起首轮运行（原来只建不跑）
    mutationFn: (text: string) =>
      createMatterWithRole(assignment, { ...handoffInput(text), run: true }),
    onSuccess: (out) => {
      setTitle('')
      navigate(`/matters/${out.matter.id}`)
    },
  })
  const actions = useLandingActions(prompts, (prompt) => {
    setStarted(true)
    open.mutate(prompt.slice(0, TASK_TEXT_MAX))
  })
  return (
    <div className="flex flex-col gap-1" data-testid="duty-open">
      <div className="flex gap-2">
        <Input
          value={title}
          maxLength={TASK_TEXT_MAX}
          aria-label={t('duty.open')}
          placeholder={t('duty.open.placeholder')}
          data-testid="duty-open-text"
          onChange={(e) => {
            setTitle(e.target.value)
            if (open.error !== null) open.reset()
          }}
        />
        <Button
          size="sm"
          data-testid="duty-open-submit"
          data-busy={open.isPending ? 'true' : undefined}
          disabled={title.trim() === '' || open.isPending}
          onClick={() => {
            setStarted(true)
            open.mutate(title.trim())
          }}
        >
          {open.isPending ? (
            <Loader2 aria-hidden className="size-3.5 animate-spin" />
          ) : (
            <Play aria-hidden className="size-3.5" />
          )}
          {open.isPending ? t('handoff.sending') : t('duty.open')}
        </Button>
      </div>
      {/* WP259：没开成就说一句人话（含服务端那句），与「交给它」几个入口同一个口径 */}
      <HandoffError error={open.error} testId="duty-open-error" />
      {started ? null : <LandingActions actions={actions} />}
    </div>
  )
}

function OverviewTab({ role_id }: { role_id: string }): React.ReactNode {
  const role = useQuery({
    queryKey: ['role-definition', role_id],
    queryFn: () => getRoleDefinition(role_id),
  })
  if (role.isPending) return <Skeleton className="h-48 w-full" />
  if (role.error !== null || role.data === undefined) return <PanelError error={role.error} />
  const view = role.data
  const first = firstSentence(view.description)
  // 第一句要是把一对 ** 切成了半对，就不画粗体（免得露出星号）
  const line = (first.match(/\*\*/g)?.length ?? 0) % 2 === 1 ? first.replace(/\*\*/g, '') : first
  return (
    <div className="flex flex-col gap-4" data-testid="duty-overview">
      {/*
        WP157（36 §7）：职责模板的 description 常是两三句（建站那几条 80 字上下，还带 **粗体**）。
        顶上只留第一句（照样认粗体），整段原话进旁边的问号。
      */}
      <p className="flex items-center gap-1 text-sm text-muted-foreground" data-testid="duty-line">
        <span>
          <MarkdownInline text={line} />
        </span>
        {line === view.description.trim() ? null : (
          <Hint text={view.description} testId="duty-description" />
        )}
      </p>
      {/* WP238：权限 / 本体声明收进默认折叠的「高级」，翻成人话；原始 id 只进每一行的 tooltip */}
      <DutyAdvanced view={view} />
    </div>
  )
}

/**
 * WP238（Luoye 10-06 Windows 真机）：「高级 · 这条职责能做什么」。
 *
 * 默认收着——这是给想弄清楚「它到底被允许干什么」的人看的，不是每天要读的东西。
 * 展开后是四小组人话（能看什么 / 能做什么 / 技能 / 要的连接），不再是三张大卡；
 * 原始声明（`social_account · read / stage · assigned · internal`）只在停在那一行时出现。
 */
function DutyAdvanced({ view }: { view: RoleDetailView }): React.ReactNode {
  const { t, lang } = useApp()
  const [open, setOpen] = useState(false)
  const groups: { id: string; title: string; lines: CapabilityLine[]; empty?: string }[] = [
    { id: 'scope', title: t('duty.scopes'), lines: scopeLines(view, t) },
    {
      id: 'action',
      title: t('duty.actions'),
      lines: actionLines(view, t),
      empty: t('duty.actions.none'),
    },
    { id: 'skill', title: t('duty.skills'), lines: skillLines(view, t) },
    { id: 'connector', title: t('duty.connectors.title'), lines: connectorLines(view, t, lang) },
  ]
  return (
    <section data-testid="duty-advanced">
      <div className="flex items-center gap-1">
        <button
          type="button"
          className="flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground"
          aria-expanded={open}
          data-testid="duty-advanced-toggle"
          onClick={() => {
            setOpen(!open)
          }}
        >
          {open ? (
            <ChevronDown className="size-3.5" aria-hidden />
          ) : (
            <ChevronRight className="size-3.5" aria-hidden />
          )}
          {t('duty.advanced')}
        </button>
        <Hint text={t('duty.advanced.hint')} />
      </div>
      {open ? (
        <div
          className="mt-2 grid gap-4 pl-5 text-sm sm:grid-cols-2"
          data-testid="duty-advanced-body"
        >
          {groups.map((g) =>
            g.lines.length === 0 && g.empty === undefined ? null : (
              <div key={g.id} className="flex flex-col gap-1">
                <h4 className="text-xs text-muted-foreground">{g.title}</h4>
                {g.lines.length === 0 ? (
                  <p className="text-muted-foreground">{g.empty}</p>
                ) : (
                  <ul className="flex flex-col gap-0.5">
                    {g.lines.map((line) => (
                      <li key={line.key} data-testid={`duty-${g.id}`} data-raw={line.raw}>
                        <InfoTip text={line.raw}>{line.text}</InfoTip>
                      </li>
                    ))}
                  </ul>
                )}
              </div>
            ),
          )}
        </div>
      ) : null}
    </section>
  )
}

export function DutyPage(): React.ReactNode {
  const { t, lang, selectPosition, position } = useApp()
  const navigate = useNavigate()
  const rail = useRailState()
  const params = useParams<{ assignment: string; role_id: string }>()
  const assignment = params.assignment ?? ''
  const role_id = params.role_id ?? ''

  /*
   * 进职责页 = 把当前 Assignment 切到**这一条职责**（31 §3.1 一次请求一个 Assignment）。
   *
   * 与岗位页那条规矩（WP70：当前分配跟着岗位走、不被顶回第一条）不冲突——
   * 那一条说的是"点左栏岗位行不要动职责"，这一页是人**明确点了这条职责**。
   */
  useEffect(() => {
    if (assignment !== '' && assignment !== position) selectPosition(assignment)
  }, [assignment, position, selectPosition])

  const owner = useQuery({
    queryKey: ['position-instance', assignment],
    enabled: assignment !== '',
    queryFn: () => getPosition(assignment),
  })
  const role = useQuery({
    queryKey: ['role-definition', role_id],
    enabled: role_id !== '',
    queryFn: () => getRoleDefinition(role_id),
  })

  const instance = owner.data
  const here = instance?.roles.find((r) => r.role_id === role_id)
  const positionName =
    instance === undefined ? '' : lang === 'en' ? instance.name.en : instance.name.zh

  return (
    <div className="flex flex-col gap-4" data-testid="duty-page" data-duty={role_id}>
      {/* WP96 画布《职责页》：面包屑 → 标题 → 一行胶囊，与事项页同一套头 */}
      <nav className="flex items-center gap-1 text-xs text-ws-muted-fg" aria-label="breadcrumb">
        <Link to={`/positions/${encodeURIComponent(assignment)}`} data-testid="duty-breadcrumb">
          {positionName === '' ? t('nav.positions') : positionName}
        </Link>
        <span aria-hidden>›</span>
        <span>{here?.role_name ?? role_id}</span>
      </nav>

      <header className="flex flex-col gap-2">
        <div className="flex flex-wrap items-baseline gap-2">
          {/* WP213：职责页头的图标（渠道类带平台角标），点睛那一笔是品牌色 */}
          <DutyIcon role_id={role_id} size={24} selected className="self-center" />
          <h1 className="ws-display text-[26px]" data-testid="duty-name">
            {role.data?.name ?? here?.role_name ?? role_id}
          </h1>
          {role.data === undefined ? null : (
            <>
              <span className="ws-num text-xs text-ws-muted-fg">v{role.data.version}</span>
              <WsTag data-testid="duty-source">
                {role.data.source === 'bundled' ? t('duty.bundled') : t('duty.custom')}
              </WsTag>
            </>
          )}
        </div>
        <p className="text-xs text-ws-muted-fg" data-testid="duty-holders">
          {t('duty.holders', { count: role.data?.holders ?? 0 })}
        </p>
        {/* 一句人话（这条职责是干什么的）+ 默认折叠的「高级」 */}
        <OverviewTab role_id={role_id} />
        <OpenHere
          assignment={assignment}
          prompts={(here?.quick_prompts ?? []).map((q) => ({
            id: q.id,
            label: lang === 'en' ? q.label.en : q.label.zh,
            prompt: q.prompt,
          }))}
        />
        {/* WP74：进去的是同一个日历，只是默认开着与这条职责相关的那几层 */}
        <div className="flex flex-wrap items-center gap-2" data-testid="duty-rail-links">
          <CalendarLink role_id={role_id} />
          {/*
            WP372（决策 1019）：这条职责自己的看板（社媒内容日历与群发、B2B、投放素材、AI 回答监测）
            搬进右侧面板「报表」的下半截；这里留一个小链接，点了直接打开那一格。
          */}
          {dutyHasBoards(role_id) ? (
            <button
              type="button"
              data-testid="duty-boards-link"
              className="text-xs text-ws-muted-fg underline-offset-2 hover:text-foreground hover:underline"
              onClick={() => {
                rail.show('reports')
              }}
            >
              {t('duty.boards_moved')}
            </button>
          ) : null}
        </div>
      </header>

      {/*
        WP372（决策 1019）：中间栏 = 标题 + 对话框 + 快捷按钮 +「要你拍板」的卡（只放要决定的）。
        这条职责的牌（本人在这条职责上的分配），报表块不在这里（进右侧面板「报表」卡）。
      */}
      <div data-testid="duty-body">
        {assignment === '' ? null : (
          <DeckSection
            positionId={here?.my_assignment_id ?? assignment}
            positionIds={[here?.my_assignment_id ?? assignment]}
            withReports={false}
            onOpen={(card) => {
              navigate(matterUrl(card))
            }}
            title={
              <h3 className="flex min-w-0 items-center gap-2" data-testid="duty-deck-title">
                <span className="ws-display text-[17px]">{t('pos2.deck.title')}</span>
                <Hint text={t('pos2.deck.hint')} />
              </h3>
            }
          />
        )}
      </div>
    </div>
  )
}
