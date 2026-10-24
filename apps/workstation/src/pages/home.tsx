/**
 * 首页（WP438，WP434 设计 §2，决策 1332 / 1333）：只回答三件事——今天要我定什么、几个关键数字怎么样、
 * 各岗位在不在正常干活。从上到下四块：
 *
 * ① 问候 + 一行概况（「AI 今天替你处理了 N 件，M 件等你定」）。输入框不在这里：首页用 WP437 的
 *    **简易对话框**（底部居中、半透明悬浮），这一页底下留出它的位置；
 * ② 收件箱那一行（WP459，决策 1497：首页不再列决策卡，原「要你定」那块与「全部 →」错链一并去掉）；
 * ③ 关键数字：一句话（这一段最值得知道的那件事，由数拼出来）+ 4 个数（按开着的岗位挑、每岗位最多 1 个、
 *    优先挑有数的；决策 1333 甲）。点一个在第三栏打开那份报表。缺连接只写一行，点了就地连；
 * ④ 岗位：每个岗位一张卡——状态、代表数字（这个岗位第一份固定报表的头条数）与走势、在做几件 · 等你几件。
 *
 * 去掉的（§2.3）：复盘四格、一堆去连接卡、按职责重复的数字、空的时间轴 / 到期、经营一页纸长文（归「产出」）。
 * 首页自己不产生数据：数字取自各岗位的固定报表（`/v1/reports/overview`），「要你定」取自卡片队列。
 *
 * 三种模式（决策 222）：同事互联 / 公司集体时，「正在进行」「待认领」照旧接在最下面（个人模式收起）。
 *
 * WP456-T8（WP456 §3.13，只改样子、不改数据口径）：节标题、分段切换、一行提醒、空状态、列表组都换成 T2 的共用件；
 * 岗位卡图标底色一律中性，「还没开工」那几张也是整卡可点（不再各放一颗「开工」主按钮、不再画描边）；
 * 字号都落在档位上。首页不出现任何决定卡（决策 1497）。
 */
import { useQuery } from '@tanstack/react-query'
import {
  BarChart3,
  CalendarDays,
  ChevronRight,
  HandHeart,
  Inbox,
  Plug,
  Plus,
  Sparkles,
  Users,
} from 'lucide-react'
import { type ReactNode, useState } from 'react'
import { Navigate, useNavigate } from 'react-router-dom'
import { useOpenTodos } from '@/components/cal-todo/use-todos'
import { connectServiceFor } from '@/components/connections/links'
import {
  BrandMark,
  EmptyState,
  ListGroup,
  ListRow,
  NoticeLine,
  SectionHeader,
  Segmented,
  SkeletonBar,
  StatusPill,
  WsCard,
} from '@/components/design'
import { SimpleComposer } from '@/components/free-chat/simple-composer'
import { useInbox } from '@/components/inbox/inbox-model'
import { deltaOf, fmtValue } from '@/components/reports/kit/format'
import { Delta, Sparkline, spaced } from '@/components/reports/kit/parts'
import { openRightPane } from '@/components/reports/right-pane'
import { PositionIcon } from '@/components/role-icons/role-icon'
import { useOpenConnect } from '@/components/setup/use-open-connect'
import { ComposerDock, DOCK_PAGE } from '@/components/shell/composer-dock'
import { ClaimPool } from '@/components/work/claim-pool'
import { InProgressList } from '@/components/work/in-progress-list'
import {
  ensureSession,
  getHome,
  getPositions,
  listClaimPool,
  listInProgress,
  type PositionInstanceData,
} from '@/lib/api'
import { useApp } from '@/lib/app-context'
import { clock, homeTodoLine } from '@/lib/cal-todo'
import { useMode } from '@/lib/mode'
import { getReportsOverview, REPORTS_QUERY, type ReportsOverview } from '@/lib/reports-api'
import { cn } from '@/lib/utils'

type KeyRange = '1d' | '7d' | '30d'
const KEY_RANGES: KeyRange[] = ['1d', '7d', '30d']

/** 「下午好」按本机时间（问候只是问候，不进任何数）。 */
function helloKey(now: Date): string {
  const h = now.getHours()
  if (h < 5) return 'home2.hello.evening'
  if (h < 11) return 'home2.hello.morning'
  if (h < 13) return 'home2.hello.noon'
  if (h < 18) return 'home2.hello.afternoon'
  return 'home2.hello.evening'
}

function dateLine(now: Date, lang: 'zh' | 'en'): string {
  if (lang === 'en')
    return now.toLocaleDateString('en-US', { month: 'short', day: 'numeric', weekday: 'short' })
  const wd = ['日', '一', '二', '三', '四', '五', '六'][now.getDay()]
  return `${now.getMonth() + 1} 月 ${now.getDate()} 日 周${wd}`
}

/** 一节的标题（WP456-T8：T2 的共用节标题，和上一节隔 24）。 */
function SectionHead({
  title,
  count,
  right,
}: {
  title: string
  count?: number
  right?: ReactNode
}): ReactNode {
  return <SectionHeader className="mt-6 mb-3" title={title} count={count} actions={right} />
}

// ── ② 收件箱那一行（WP459，决策 1497）────────────────────────────────

/**
 * 首页不再列决策卡（原「要你定」那一块去掉，连同指到待办的那条错链）：只留一行「收件箱里 N 件等你 →」，
 * 带「N 件要紧」和最急的那一件，点了去收件箱（v2 示意 `home-line`）。数和左栏徽标、收件箱是同一份。
 */
function InboxLine(): ReactNode {
  const { t } = useApp()
  const inbox = useInbox(true, 'mine')
  const view = inbox.data
  if (view === undefined) return null
  const n = view.counts.all
  return (
    <ListRow to="/inbox" className="py-3" data-testid="home-inbox-line">
      <span className="grid size-[30px] shrink-0 place-items-center rounded-lg bg-ws-tint text-ws-brand-ink">
        <Inbox aria-hidden className="size-4" />
      </span>
      <b className="shrink-0 text-[14px] font-semibold text-ws-ink" data-testid="home-inbox-count">
        {n === 0 ? t('inbox.home.empty') : t('inbox.home.line', { n })}
      </b>
      {view.counts.urgent > 0 ? (
        <StatusPill tone="bad" className="shrink-0" data-testid="home-inbox-urgent">
          {t('inbox.home.urgent', { n: view.counts.urgent })}
        </StatusPill>
      ) : null}
      {view.brief.top === undefined || view.brief.top === '' ? (
        <span className="min-w-0 flex-1" />
      ) : (
        <span className="min-w-0 flex-1 truncate text-[13px] text-ws-muted-fg">
          {t('inbox.home.top', { title: view.brief.top })}
        </span>
      )}
    </ListRow>
  )
}

/**
 * WP469（决策 1521）：收件箱那一行下面再一行「今天 3 件待办 · 下一件 15:00 … · 还有 7 件没排期 →」，
 * 点了去「日历与待办」（打开哪一面照那一页自己的记忆）。没有待办、也没有没排期的就不出这一行。
 */
function TodoLine(): ReactNode {
  const { t } = useApp()
  const open = useOpenTodos()
  const todos = open.data?.todos
  if (todos === undefined) return null
  const line = homeTodoLine(todos, new Date())
  if (line.today === 0 && line.unscheduled === 0) return null
  const rest = [
    ...(line.next === undefined
      ? []
      : [t('caltodo.home.next', { time: clock(new Date(line.next.at)), title: line.next.title })]),
    ...(line.unscheduled === 0 ? [] : [t('caltodo.home.undated', { n: line.unscheduled })]),
  ].join(' · ')
  return (
    <ListRow to="/planner" className="py-3" data-testid="home-todo-line">
      <span className="grid size-[30px] shrink-0 place-items-center rounded-lg bg-ws-tint text-ws-brand-ink">
        <CalendarDays aria-hidden className="size-4" />
      </span>
      <b className="shrink-0 text-[14px] font-semibold text-ws-ink" data-testid="home-todo-count">
        {line.today === 0 ? t('caltodo.home.empty') : t('caltodo.home.line', { n: line.today })}
      </b>
      <span className="min-w-0 flex-1 truncate text-[13px] text-ws-muted-fg">{rest}</span>
    </ListRow>
  )
}

// ── ③ 关键数字 ───────────────────────────────────────────────────────

/**
 * 关键数字对应的那个岗位。同一个岗位开了几份（「社媒运营 · 1 / · 2」）时报表那边只给模板 id，
 * 这时取第一份；都对不上就不写名字（WP456-T8：以前会把 `social-media` 这种内部 id 直接写出来）。
 */
function instanceOf(
  instances: readonly PositionInstanceData[],
  position: string,
): PositionInstanceData | undefined {
  return (
    instances.find((i) => i.position_id === position) ??
    instances.find((i) => i.position_id.startsWith(position))
  )
}

function KeyNumbers({
  data,
  range,
  onRange,
  instances,
}: {
  data: ReportsOverview | undefined
  range: KeyRange
  onRange: (r: KeyRange) => void
  instances: readonly PositionInstanceData[]
}): ReactNode {
  const { t, lang } = useApp()
  const openConnect = useOpenConnect()
  const nameOf = (position: string): string | undefined => {
    const inst = instanceOf(instances, position)
    return inst === undefined ? undefined : lang === 'en' ? inst.name.en : inst.name.zh
  }
  const sentence = data?.sentence
  return (
    <section data-testid="home-key">
      <SectionHead
        title={t('home2.key')}
        right={
          <Segmented
            size="sm"
            label={t('home2.key')}
            value={range}
            options={KEY_RANGES.map((r) => ({
              value: r,
              label: t(`home2.key.range.${r}`),
              data: { 'data-range': r },
            }))}
            onChange={onRange}
          />
        }
      />
      {sentence === undefined ? null : (
        <div
          className="mb-3 flex items-start gap-2.5 rounded-[12px] bg-ws-tint px-4 py-3 text-[13px] text-ws-brand-ink"
          data-testid="home-key-sentence"
        >
          <Sparkles aria-hidden className="mt-0.5 size-4 shrink-0" />
          <span className="min-w-0" data-slot="data">
            {sentence.text.split(/\*\*/).map((part, i) =>
              i % 2 === 1 ? (
                // biome-ignore lint/suspicious/noArrayIndexKey: 同一句里的几段
                <b key={i} className="font-semibold">
                  {part}
                </b>
              ) : (
                // biome-ignore lint/suspicious/noArrayIndexKey: 同上
                <span key={i}>{part}</span>
              ),
            )}
          </span>
          <button
            type="button"
            className="ml-auto inline-flex shrink-0 items-center gap-0.5 text-[13px] font-semibold whitespace-nowrap"
            data-testid="home-key-go"
            onClick={() => {
              openRightPane({ kind: 'report', id: sentence.report_id })
            }}
          >
            {t('home2.key.go', { title: sentence.title.replace(/数据报表$|报表$/, '报表') })}
            <ChevronRight aria-hidden className="size-3.5" />
          </button>
        </div>
      )}
      {data !== undefined && data.key.length === 0 ? (
        <EmptyState icon={BarChart3} text={t('home2.key.empty')} data-testid="home-key-empty" />
      ) : (
        <div className="grid grid-cols-1 gap-3 @md:grid-cols-2 @3xl:grid-cols-4">
          {(data?.key ?? []).map((k) => {
            const m = k.metric
            const d = deltaOf(m)
            const inst = instanceOf(instances, k.position)
            return (
              <button
                key={k.position}
                type="button"
                className="ws-card @container flex min-w-0 flex-col px-[18px] pt-4 pb-3.5 text-left transition-shadow hover:shadow-[var(--ws-shadow-hover)]"
                data-testid="home-key-card"
                data-position={k.position}
                onClick={() => {
                  openRightPane({ kind: 'report', id: k.report_id, position: k.position })
                }}
              >
                <span className="truncate text-[12px] text-ws-muted-fg">{m.label}</span>
                <span className="mt-1.5 flex items-end justify-between gap-2">
                  <span className="min-w-0">
                    <span
                      className="ws-display block text-[28px] leading-[1.15] text-ws-ink"
                      data-slot="data"
                    >
                      {fmtValue(m.value, m.format, m.currency ?? 'USD', { full: true })}
                    </span>
                    <span className="mt-1 block h-4 text-xs">
                      {d === undefined ? (
                        m.note === undefined ? null : (
                          <span className="text-ws-muted-fg">{m.note}</span>
                        )
                      ) : (
                        <Delta {...d} />
                      )}
                    </span>
                  </span>
                  {k.spark === undefined ? null : (
                    <span className="hidden @[15rem]:block">
                      <Sparkline data={k.spark} width={110} height={44} />
                    </span>
                  )}
                </span>
                <span className="mt-3 flex items-center gap-1.5 truncate text-xs text-ws-faint">
                  {inst === undefined ? null : (
                    <PositionIcon
                      position_id={inst.position_id}
                      icon={inst.icon}
                      role_ids={inst.roles.map((r) => r.role_id)}
                      size={13}
                    />
                  )}
                  {nameOf(k.position) ?? ''}
                  {range === '1d' && m.delta !== undefined ? ` · ${t('home2.key.compare.1d')}` : ''}
                </span>
              </button>
            )
          })}
        </div>
      )}
      {data?.missing === undefined ? null : (
        <NoticeLine
          className="mt-3"
          icon={Plug}
          data-testid="home-key-missing"
          action={{
            label: t('home2.missing.go'),
            onClick: () => {
              openConnect(connectServiceFor(data.missing?.source))
            },
          }}
        >
          {t('home2.missing', { label: spaced(data.missing.label), unlocks: data.missing.unlocks })}
        </NoticeLine>
      )}
    </section>
  )
}

// ── ④ 岗位 ───────────────────────────────────────────────────────────

function PositionTile({
  inst,
  headline,
}: {
  inst: PositionInstanceData
  headline: ReportsOverview['positions'][number] | undefined
}): ReactNode {
  const { t, lang } = useApp()
  const navigate = useNavigate()
  const to = inst.roles.map((r) => r.my_assignment_id).find((x) => x !== undefined)
  const go = (): void => {
    if (to !== undefined) navigate(`/positions/${to}`)
  }
  const m = headline?.headline
  const hasNumber = m?.status === 'ok'
  const idle = !hasNumber && inst.open_matters === 0 && inst.pending_cards === 0
  const name = lang === 'en' ? inst.name.en : inst.name.zh
  const d = m === undefined ? undefined : deltaOf(m)
  const icon = (
    // WP456-T8（§3.13）：岗位靠图标区分，底色一律中性
    <span className="grid size-[30px] shrink-0 place-items-center rounded-lg bg-ws-secondary text-ws-body">
      <PositionIcon
        position_id={inst.position_id}
        icon={inst.icon}
        role_ids={inst.roles.map((r) => r.role_id)}
        size={16}
      />
    </span>
  )
  // 整卡可点（键盘回车也行）；卡上不再放按钮（§3.13：8 张卡 8 颗一样的按钮去掉）
  const clickable =
    to === undefined
      ? {}
      : {
          role: 'link',
          tabIndex: 0,
          onClick: go,
          onKeyDown: (e: React.KeyboardEvent) => {
            if (e.key === 'Enter') go()
          },
        }
  if (idle)
    return (
      <WsCard
        className={cn(
          'flex min-h-[168px] flex-col gap-2.5 px-[18px] pt-4 pb-3.5',
          to !== undefined && 'cursor-pointer hover:shadow-[var(--ws-shadow-hover)]',
        )}
        data-testid="position-card"
        data-position={inst.position_id}
        data-state="idle"
        {...clickable}
      >
        <div className="flex items-center gap-2.5">
          {icon}
          <b className="truncate text-[14px] font-semibold">{name}</b>
          <StatusPill tone="neutral" className="ml-auto">
            {t('home2.pos.idle')}
          </StatusPill>
        </div>
        <p className="text-[13px] text-ws-muted-fg">{t('home2.pos.idle.line')}</p>
      </WsCard>
    )
  return (
    <WsCard
      className="@container flex min-h-[168px] cursor-pointer flex-col gap-2.5 px-[18px] pt-4 pb-3.5 hover:shadow-[var(--ws-shadow-hover)]"
      data-testid="position-card"
      data-position={inst.position_id}
      data-state={inst.pending_cards > 0 && inst.open_matters === 0 ? 'waiting' : 'running'}
      {...clickable}
    >
      <div className="flex items-center gap-2.5">
        {icon}
        <b className="truncate text-[14px] font-semibold">{name}</b>
        {inst.open_matters === 0 && inst.pending_cards > 0 ? (
          // WP459：「等你 N 件」点了去收件箱、筛好这个岗位
          <button
            type="button"
            className="ml-auto"
            data-testid="position-card-waiting"
            onClick={(e) => {
              e.stopPropagation()
              navigate(`/inbox?position=${encodeURIComponent(inst.position_id)}`)
            }}
          >
            <StatusPill tone="warn">{t('home2.pos.waiting', { n: inst.pending_cards })}</StatusPill>
          </button>
        ) : (
          <StatusPill tone="good" className="ml-auto">
            {t('home2.pos.running')}
          </StatusPill>
        )}
      </div>
      {hasNumber && m !== undefined && headline !== undefined ? (
        <div className="flex items-end justify-between gap-2.5">
          <div className="min-w-0">
            <p className="truncate text-xs text-ws-muted-fg">{headline.headline_label}</p>
            <p className="flex items-baseline gap-1.5">
              <span className="ws-display text-[22px] leading-tight text-ws-ink" data-slot="data">
                {fmtValue(m.value, m.format, m.currency ?? 'USD')}
              </span>
              {d === undefined ? null : <Delta {...d} />}
            </p>
          </div>
          {headline.spark === undefined ? null : (
            <span className="hidden @[17rem]:block">
              <Sparkline data={headline.spark} width={132} height={46} />
            </span>
          )}
        </div>
      ) : (
        <p className="text-[13px] text-ws-muted-fg">{headline?.headline.note ?? ''}</p>
      )}
      <p
        className="mt-auto border-t border-ws-line pt-2.5 text-[12px] text-ws-muted-fg"
        data-slot="data"
      >
        {t('home2.pos.foot', { doing: inst.open_matters, waiting: inst.pending_cards })}
      </p>
    </WsCard>
  )
}

// ── 公司 / 同事模式：正在进行、待认领（决策 222；个人模式收起） ───────────────

const IN_PROGRESS_KEY = ['todos', 'in-progress', 'position'] as const

function TeamSections({ solo }: { solo: boolean }): ReactNode {
  const { t } = useApp()
  const claimPool = useQuery({ queryKey: ['home', 'claim-pool'], queryFn: () => listClaimPool() })
  const board = useQuery({
    queryKey: IN_PROGRESS_KEY,
    queryFn: () => listInProgress('position'),
    enabled: !solo,
  })
  const showClaimPool = !solo || (claimPool.data?.pool.length ?? 0) > 0
  const busy = (board.data?.items.length ?? 0) > 0
  if (solo && !showClaimPool) return null
  return (
    <div className="mt-6 grid gap-3 lg:grid-cols-2">
      {solo ? null : (
        <WsCard className="p-4" data-testid="home-inprogress">
          <SectionHeader
            as="h3"
            className="mb-2"
            data-testid="home-inprogress-title"
            title={
              <>
                <Users className="size-4 text-ws-muted-fg" aria-hidden />
                {t('home.inprogress')}
                {busy ? <BrandMark size={14} motion="breathe" label={t('brand.busy')} /> : null}
              </>
            }
          />
          {board.isPending ? (
            <SkeletonBar className="h-12 w-full" />
          ) : board.error !== null ? (
            <EmptyState text={t('inprogress.empty')} />
          ) : (
            <InProgressList items={board.data.items} />
          )}
        </WsCard>
      )}
      {showClaimPool ? (
        <WsCard className="p-4" data-testid="home-claim-pool">
          <SectionHeader
            as="h3"
            className="mb-2"
            title={
              <>
                <HandHeart className="size-4 text-ws-muted-fg" aria-hidden />
                {t('home.claim_pool')}
              </>
            }
          />
          <ClaimPool />
        </WsCard>
      ) : null}
    </div>
  )
}

export function HomePage(): ReactNode {
  const { t, lang } = useApp()
  const { solo } = useMode()
  const [range, setRange] = useState<KeyRange>('1d')
  const home = useQuery({ queryKey: ['home', 'yesterday'], queryFn: () => getHome('yesterday') })
  const inbox = useInbox(true, 'mine')
  const positions = useQuery({ queryKey: ['positions'], queryFn: getPositions })
  const session = useQuery({ queryKey: ['session'], queryFn: ensureSession, retry: false })
  const overview = useQuery({
    queryKey: [...REPORTS_QUERY, 'overview', range],
    queryFn: () => getReportsOverview(range),
    retry: false,
  })
  const overview30 = useQuery({
    queryKey: [...REPORTS_QUERY, 'overview', '30d'],
    queryFn: () => getReportsOverview('30d'),
    retry: false,
    enabled: range !== '30d',
  })

  /*
   * WP69（54 §4）：一个人只有一个岗位时，首页直接就是那个岗位页（等岗位清单真回来了才判）。
   */
  const instances = positions.data?.instances
  const only = instances?.length === 1 ? instances[0] : undefined
  const onlyTo = only?.roles.map((r) => r.my_assignment_id).find((x) => x !== undefined)

  // 加载中：和真内容一样排（问候一行 + 两行列表），不铺一整块灰
  if (home.isPending)
    return (
      <div
        className="mx-auto flex w-full max-w-[1040px] flex-col gap-3 pt-2"
        data-testid="home-loading"
      >
        <SkeletonBar className="h-7 w-56" />
        <SkeletonBar className="h-4 w-80" />
        <div className="mt-6 flex flex-col gap-3">
          <SkeletonBar className="h-[104px] w-full rounded-2xl" />
          <SkeletonBar className="h-32 w-full rounded-2xl" />
        </div>
      </div>
    )
  if (onlyTo !== undefined) return <Navigate to={`/positions/${onlyTo}`} replace />
  if (home.error !== null) {
    return (
      <p role="alert" className="text-sm text-destructive">
        {t('error.generic')}：{home.error.message}
      </p>
    )
  }
  const data = home.data
  const now = new Date()
  const name = session.data?.person.name ?? ''
  const insts = instances ?? []
  // 岗位卡的代表数一律看近 30 天（和看板那一行同一个数）
  const cards = (range === '30d' ? overview.data : overview30.data)?.positions
  const done = data.battle_report.ai_handled + data.battle_report.auto_sent

  return (
    <div className={cn(DOCK_PAGE, '@container mx-auto w-full max-w-[1040px]')} data-testid="home">
      {/* ① 问候 + 一行概况（输入框换成 WP437 的简易对话框，悬浮在页面底部居中） */}
      <header className="pt-2" data-testid="home-header">
        <h1 className="ws-display text-ws-big text-ws-ink">
          {name === '' ? t('home.headline') : t(helloKey(now), { name })}
        </h1>
        <p className="mt-1 text-[13px] text-ws-muted-fg" data-testid="home-line">
          {t('home2.line', {
            date: dateLine(now, lang),
            done,
            // WP459：「几件等你定」和收件箱、左栏徽标同一个数
            waiting: inbox.data?.counts.all ?? data.counts.total,
          })
            .split(/(\d+)/)
            .map((part, i) =>
              /^\d+$/.test(part) && i > 0 ? (
                // biome-ignore lint/suspicious/noArrayIndexKey: 一句话里的几段
                <b key={i} className="font-semibold text-ws-ink">
                  {part}
                </b>
              ) : (
                // biome-ignore lint/suspicious/noArrayIndexKey: 同上
                <span key={i}>{part}</span>
              ),
            )}
        </p>
      </header>

      {/* ② 收件箱那一行（WP459：首页不再列决策卡）+ 今天的待办那一行（WP469） */}
      <ListGroup className="mt-6" data-testid="home-lines">
        <InboxLine />
        <TodoLine />
      </ListGroup>

      {/* ③ 关键数字：一句话 + 4 个数（点了在第三栏打开那份报表） */}
      <KeyNumbers data={overview.data} range={range} onRange={setRange} instances={insts} />

      {/* ④ 岗位：每个岗位一张卡 */}
      {insts.length === 0 ? null : (
        <section data-testid="position-cards">
          <SectionHead
            title={t('home2.positions')}
            right={
              <button
                type="button"
                className="inline-flex h-7 items-center gap-1 rounded-md px-2 text-[12px] text-ws-muted-fg hover:bg-ws-hover hover:text-ws-ink"
                onClick={() => {
                  document
                    .querySelector<HTMLButtonElement>('[data-testid="rail-new-position-plus"]')
                    ?.click()
                }}
              >
                <Plus aria-hidden className="size-3.5" />
                {t('home2.positions.add')}
              </button>
            }
          />
          <div className="grid grid-cols-1 gap-3 @xl:grid-cols-2 @4xl:grid-cols-3">
            {insts.map((inst) => (
              <PositionTile
                key={inst.position_id}
                inst={inst}
                headline={cards?.find((c) => c.position === inst.position_id)}
              />
            ))}
          </div>
        </section>
      )}

      <TeamSections solo={solo} />

      {/* WP437：简易对话框——底部居中、半透明悬浮；回车交给「我的助理」（输入框只有这一个） */}
      <ComposerDock variant="simple" testId="home-composer">
        <SimpleComposer />
      </ComposerDock>
    </div>
  )
}
