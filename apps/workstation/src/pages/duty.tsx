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
 *
 * **WP412（真机 10-18 #12）**：职责页换成和岗位页**同一个样子、同一个对话框**——页头（图标 + 名字，
 * 一整段介绍在问号里；右边「⋯ 这条职责能做什么」）→ 岗位页那个对话框（`PositionHandoff`，钉到这条职责：
 * 服务端照样三分，当场答 / 会话 / 任务）+ 快捷按钮 →「要你拍板」的卡。原来那一行灰字输入框、版本号、
 * 「内置只读」胶囊、「N 个人在做」、折着的「高级」都不在中间栏了（能力说明、日历 / 看板入口收进「⋯」）。
 * 所有职责（外部版块、官方版块……）都走这一页，所以一处改完全部换新。
 *
 * **WP431（Luoye 10-19，照 Claude 桌面版）**：主区不再有面包屑与页头——「岗位 / 职责」进**顶栏左边**（岗位名淡一档、点了回岗位；
 * 职责名带下拉：回到岗位、职责设置、换一条职责；介绍在旁边的问号里），「职责设置」是顶栏右边那排里的一颗滑杆图标。
 */
import { useQuery } from '@tanstack/react-query'
import { ArrowLeft, SlidersHorizontal } from 'lucide-react'
import { useEffect, useState } from 'react'
import { Link, useNavigate, useParams } from 'react-router-dom'
import { CalendarLink } from '@/components/calendar/calendar-link'
import { DeckSection } from '@/components/deck'
import { InfoTip } from '@/components/design'
import { PositionHandoff } from '@/components/position/position-handoff'
import { PanelError } from '@/components/rail/panel-error'
import { useRailState } from '@/components/rail/rail-state'
import { dutyHasBoards, dutyHasWorkBoards } from '@/components/reports/scope-boards'
import { DutyIcon } from '@/components/role-icons/role-icon'
import { DOCK_PAGE } from '@/components/shell/composer-dock'
import {
  TitleMenu,
  TitleMenuItem,
  TitleMenuLabel,
  TitleMenuSeparator,
  TOPBAR_ICON,
  TOPBAR_ICON_ACTIVE,
  TOPBAR_ICON_IDLE,
  TopBarAction,
  TopBarTitle,
} from '@/components/shell/top-bar-slots'
import { Hint } from '@/components/ui/hint'
import { MarkdownInline } from '@/components/ui/safe-markdown'
import { Skeleton } from '@/components/ui/skeleton'
import { getPosition, getRoleDefinition, type RoleDetailView } from '@/lib/api'
import { useApp } from '@/lib/app-context'
import {
  actionLines,
  type CapabilityLine,
  connectorLines,
  scopeLines,
  skillLines,
  toolLines,
} from '@/lib/duty-capabilities'
import { dutyHref } from '@/lib/duty-href'
import { cn } from '@/lib/utils'
import { matterUrl } from '@/lib/work'

/**
 * WP238（Luoye 10-06 Windows 真机）：「这条职责能做什么」——四小组人话（能看什么 / 能做什么 / 技能 / 要的连接）；
 * 原始声明（`social_account · read / stage · assigned · internal`）只在停在那一行时出现。
 * WP412（真机 10-18 #12）：不再折在中间栏，收进页头右边「⋯」那一页（与岗位页「⋯ 岗位设置」同一个样子）。
 */
function DutyAdvanced({ view }: { view: RoleDetailView }): React.ReactNode {
  const { t, lang } = useApp()
  const groups: { id: string; title: string; lines: CapabilityLine[]; empty?: string }[] = [
    { id: 'scope', title: t('duty.scopes'), lines: scopeLines(view, t) },
    {
      id: 'action',
      title: t('duty.actions'),
      lines: actionLines(view, t),
      empty: t('duty.actions.none'),
    },
    // WP415：能查什么（没有执行器的标「还没接通」）
    { id: 'tool', title: t('duty.tools'), lines: toolLines(view, t) },
    { id: 'skill', title: t('duty.skills'), lines: skillLines(view, t) },
    { id: 'connector', title: t('duty.connectors.title'), lines: connectorLines(view, t, lang) },
  ]
  return (
    <section data-testid="duty-advanced">
      <p className="flex items-center gap-1 text-xs text-muted-foreground">
        {t('duty.about')}
        <Hint text={t('duty.advanced.hint')} />
      </p>
      <div className="mt-2 grid gap-4 text-sm sm:grid-cols-2" data-testid="duty-advanced-body">
        {groups.map((g) =>
          g.lines.length === 0 && g.empty === undefined ? null : (
            <div key={g.id} className="flex flex-col gap-1">
              <h4 className="text-xs text-muted-foreground">{g.title}</h4>
              {g.lines.length === 0 ? (
                <p className="text-muted-foreground">{g.empty}</p>
              ) : (
                <ul className="flex flex-col gap-0.5">
                  {g.lines.map((line) => (
                    <li
                      key={line.key}
                      data-testid={`duty-${g.id}`}
                      data-raw={line.raw}
                      data-not-wired={line.not_wired === true ? 'true' : undefined}
                      className={line.not_wired === true ? 'text-ws-muted-fg' : undefined}
                    >
                      <InfoTip text={line.raw}>{line.text}</InfoTip>
                    </li>
                  ))}
                </ul>
              )}
            </div>
          ),
        )}
      </div>
    </section>
  )
}

/**
 * WP412（真机 10-18 #12）：页头「⋯ 这条职责能做什么」那一页——原来摊在中间栏的说明都收在这里：
 * 一整段介绍、几个人在做、四小组能力，以及日历 / 看板两个小入口。版本号、「内置只读」这类技术信息不再上屏。
 */
function DutyAbout({
  role_id,
  onBoards,
}: {
  role_id: string
  onBoards: () => void
}): React.ReactNode {
  const { t } = useApp()
  const role = useQuery({
    queryKey: ['role-definition', role_id],
    queryFn: () => getRoleDefinition(role_id),
  })
  if (role.isPending) return <Skeleton className="h-48 w-full" />
  if (role.error !== null || role.data === undefined) return <PanelError error={role.error} />
  const view = role.data
  return (
    <div className="flex flex-col gap-5" data-testid="duty-about">
      <div className="flex flex-col gap-1">
        <p className="text-sm" data-testid="duty-line">
          <MarkdownInline text={view.description} />
        </p>
      </div>
      <DutyAdvanced view={view} />
      {/* WP74：同一个日历，默认开着这条职责相关的那几层；WP372：这条职责的看板在右侧「报表」 */}
      <div className="flex flex-wrap items-center gap-3" data-testid="duty-rail-links">
        <CalendarLink role_id={role_id} />
        {dutyHasBoards(role_id) ? (
          <button
            type="button"
            data-testid="duty-boards-link"
            className="text-xs text-ws-muted-fg underline-offset-2 hover:text-foreground hover:underline"
            onClick={onBoards}
          >
            {t('duty.boards_moved')}
          </button>
        ) : null}
      </div>
    </div>
  )
}

export function DutyPage(): React.ReactNode {
  const { t, lang, selectPosition, position } = useApp()
  const navigate = useNavigate()
  const rail = useRailState()
  const params = useParams<{ assignment: string; role_id: string }>()
  const assignment = params.assignment ?? ''
  const role_id = params.role_id ?? ''
  /** WP412：中间栏看对话框（`work`）还是「这条职责能做什么」（`about`，页头「⋯」）。 */
  const [view, setView] = useState<'work' | 'about'>('work')

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
  // 问号里是纯文字：markdown 的一对 ** 去掉（整段原话照留，粗体在「⋯」那一页里照样认）
  const description = role.data?.description.trim().replace(/\*\*/g, '') ?? ''
  const dutyName = role.data?.name ?? here?.role_name ?? role_id
  /** 同一个岗位里本人做的别的几条职责（顶栏下拉「换一条职责」）。 */
  const siblings = (instance?.roles ?? []).filter(
    (r) => r.my_assignment_id !== undefined && r.role_id !== role_id,
  )

  return (
    <div
      className={cn(DOCK_PAGE, 'mx-auto w-full max-w-[780px] gap-4')}
      data-testid="duty-page"
      data-duty={role_id}
      data-view={view}
    >
      {/* ── 顶栏：岗位 / 职责 + 下拉（WP431，照 Claude；没有外壳时就地画） ── */}
      <TopBarTitle>
        <div className="flex min-w-0 items-center gap-0.5" data-testid="duty-header">
          <TitleMenu
            before={
              <>
                <Link
                  to={`/positions/${encodeURIComponent(assignment)}`}
                  data-testid="duty-breadcrumb"
                  className="shrink-0 truncate rounded-md px-1.5 py-1 text-[13.5px] text-ws-muted-fg hover:bg-foreground/[0.06] hover:text-foreground"
                >
                  {positionName === '' ? t('nav.positions') : positionName}
                </Link>
                <span aria-hidden className="shrink-0 text-[13px] text-ws-muted-fg/70">
                  /
                </span>
              </>
            }
            title={dutyName}
            testId="duty-name"
            menuTestId="duty-title-menu"
            menuLabel={t('topbar.menu.duty', { name: dutyName })}
            menu={(close) => (
              <>
                {/*
                  WP456-T3（§3.2）：职责介绍不再是标题旁边挤着下拉箭头的问号——进下拉菜单第一行（最多三行，
                  整段在悬停里）。
                */}
                {description === '' ? null : (
                  <>
                    <p
                      className="line-clamp-3 px-2 pt-1.5 pb-1 text-xs leading-[18px] text-ws-muted-fg"
                      data-testid="duty-description"
                      title={description}
                    >
                      {description}
                    </p>
                    <TitleMenuSeparator />
                  </>
                )}
                <TitleMenuItem
                  icon={ArrowLeft}
                  label={t('topbar.duty.back', {
                    name: positionName === '' ? t('nav.positions') : positionName,
                  })}
                  testId="duty-menu-back"
                  onSelect={() => {
                    close()
                    navigate(`/positions/${encodeURIComponent(assignment)}`)
                  }}
                />
                <TitleMenuItem
                  icon={SlidersHorizontal}
                  label={t(view === 'about' ? 'topbar.settings.close' : 'topbar.duty.about')}
                  testId="duty-menu-about"
                  onSelect={() => {
                    close()
                    setView(view === 'about' ? 'work' : 'about')
                  }}
                />
                {siblings.length === 0 ? null : (
                  <>
                    <TitleMenuSeparator />
                    <TitleMenuLabel>{t('topbar.duty.switch')}</TitleMenuLabel>
                    {siblings.map((r) => (
                      <TitleMenuItem
                        key={r.role_id}
                        label={
                          <span className="inline-flex items-center gap-1.5">
                            <DutyIcon role_id={r.role_id} size={14} />
                            {r.role_name}
                          </span>
                        }
                        testId="duty-menu-switch"
                        onSelect={() => {
                          close()
                          navigate(dutyHref(r.my_assignment_id ?? '', r.role_id))
                        }}
                      />
                    ))}
                  </>
                )}
              </>
            )}
          />
        </div>
      </TopBarTitle>
      {/* WP431：「职责设置」进顶栏右边那排图标（滑杆）；在里面再点一次回到对话框 */}
      <TopBarAction>
        <button
          type="button"
          data-testid="duty-about-link"
          aria-pressed={view === 'about'}
          title={t(view === 'about' ? 'pos2.settings.back' : 'topbar.duty.about')}
          className={cn(TOPBAR_ICON, view === 'about' ? TOPBAR_ICON_ACTIVE : TOPBAR_ICON_IDLE)}
          onClick={() => {
            setView(view === 'about' ? 'work' : 'about')
          }}
        >
          <SlidersHorizontal aria-hidden className="size-4" />
          <span className="sr-only">
            {t(view === 'about' ? 'pos2.settings.back' : 'topbar.duty.about')}
          </span>
        </button>
      </TopBarAction>

      {view === 'about' ? (
        <DutyAbout
          role_id={role_id}
          // WP433：排期 / 流水线类看板在「计划」里，看数的那几块在「报表」里
          onBoards={() => rail.show(dutyHasWorkBoards(role_id) ? 'schedules' : 'reports')}
        />
      ) : (
        /*
          WP372（决策 1019）→ WP412（#12）：中间栏 = 标题 + 对话框 + 快捷按钮 +「要你拍板」的卡，
          对话框就是岗位页那一个（钉到这条职责）。WP437：对话框挪到底部居中悬浮（内容最后）。
        */
        <div className="flex flex-1 flex-col gap-7" data-testid="duty-body">
          {instance === undefined ? <Skeleton className="h-24 w-full" /> : null}
          {assignment === '' ? null : (
            <DeckSection
              positionId={here?.my_assignment_id ?? assignment}
              positionIds={[here?.my_assignment_id ?? assignment]}
              withReports={false}
              onOpen={(card) => {
                navigate(matterUrl(card))
              }}
              // WP456-T3：和岗位页同一种节标题（14/600 + 灰色计数），方向键的说明在卡底最右边
              title={(total) => (
                <h3 className="ws-sec-title min-w-0" data-testid="duty-deck-title">
                  {t('pos2.deck.title')}
                  {total === undefined || total === 0 ? null : (
                    <span className="ws-sec-count ws-num">{total}</span>
                  )}
                </h3>
              )}
            />
          )}
          {/* WP437：对话框在中栏底部居中、悬浮在内容之上（放在内容最后） */}
          {instance === undefined ? null : (
            <PositionHandoff id={assignment} view={instance} role_id={role_id} />
          )}
        </div>
      )}
    </div>
  )
}
