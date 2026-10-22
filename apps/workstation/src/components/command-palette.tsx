/**
 * 36 §3 第三个对话入口：⌘K 命令面板——**搜索、跳转、加一个数字块**。
 *
 * 它不是聊天框：每一项都是一个确定的动作（跳到某张卡 / 某个岗位，或往首页加一个数字块），
 * 没有自由文本会被送去问模型。工作台**没有全局聊天框**（36 §3 A4）。
 *
 * WP70（54 §4）：**岗位名排在前**；职责名也搜得到，但结果显示成「岗位 › 职责」——
 * 搜"邮件营销"跳的还是网站运营那一页，只是这一行告诉你它归在哪个岗位下。
 * 没装岗位面的服务进程退回按分配列（老样子）。
 *
 * WP157：**教程也搜得到**（「教程」一组）——搜"百炼""浏览器插件"，回车在右栏打开那一篇
 * （与卡片上的「看教程」同一条路：`openAddress('agentsws://help/<slug>')`）。
 * 中英两种标题都进搜索词，界面是英文也能用中文名搜到。
 *
 * WP207 三处：
 * - **对话与任务也搜得到**（标题、摘要、正文，服务端全文搜），归档的标「已归档」；
 * - 最后一项「让 AI 找回『…』」：拿这句模糊的话去找归档的，给几张候选卡，**点一张才放回来**；
 * - 左栏职责行的「+」打开的是「写一句话」这一格（岗位与职责已经选好），回车就交出去。
 *   这三处都是确定的动作——⌘K 仍然不是聊天框。
 *
 * WP431（Luoye 10-19，照 Claude 桌面版的搜索弹窗）：左上角「搜索」图标与 ⌘K / Ctrl+K 打开的就是这里——
 * 居中、顶上一行大输入框、下面一张列表（每行左图标 + 标题 + 右边时间）、底下一行「↵ 打开 · Esc 关闭」；
 * **没打字时最上面是「最近」**（最近动过的事项 / 对话，同左栏原来那一串的接口 `/v1/work/rail`），
 * 打字后对话与任务走原来的全文搜（`/v1/work/search`）。后端一个没加。
 */
import type { DeckCard, TileSpec } from '@agentsws/deck'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Command as CommandPrimitive } from 'cmdk'
import {
  Archive,
  BookOpen,
  CornerDownLeft,
  Home,
  MessageCircle,
  MessageSquareText,
  MessagesSquare,
  Search,
  Settings,
  Sparkles,
} from 'lucide-react'
import { useEffect, useRef, useState } from 'react'
import { useLocation, useNavigate } from 'react-router-dom'
import { useBrands } from '@/components/brand-switcher'
import { ComposerModelPicker } from '@/components/free-chat/model-picker'
import {
  SITE_CHAT_HREF,
  SITE_CHAT_SETTINGS_HREF,
  useHoldsSiteChat,
} from '@/components/messages/site-chat'
import type { ComposeTarget, Handoff } from '@/components/palette-context'
import { askAtPosition } from '@/components/position/quick-answer-store'
import { useRailState } from '@/components/rail/rail-state'
import { DutyIcon, PositionIcon } from '@/components/role-icons/role-icon'
import { settingsHref } from '@/components/settings-panel/route'
import { useSettingsCatalog } from '@/components/settings-panel/sections'
import { SHELL_PAGES, shellPageVisible } from '@/components/shell-pages'
import { RecallCards } from '@/components/sidebar/recall-cards'
import {
  Command,
  CommandDialog,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from '@/components/ui/command'
import { Input } from '@/components/ui/input'
import { HandoffError } from '@/components/work/handoff-error'
import {
  enterSwitchedBrand,
  listCatalog,
  type PositionInstanceData,
  type PositionSummary,
  switchBrand,
} from '@/lib/api'
import { useApp } from '@/lib/app-context'
import { openFeedback } from '@/lib/feedback'
import type { ReasoningEffort } from '@/lib/free-chat'
import { handoffInput, TASK_TEXT_MAX } from '@/lib/handoff'
import { HELP_SLUGS, helpAddress } from '@/lib/help'
import { translate } from '@/lib/i18n'
import { useMode } from '@/lib/mode'
import { myAssignments } from '@/lib/positions'
import { shortAgo } from '@/lib/short-ago'
import { cn } from '@/lib/utils'
import { findArchivedWork, getWorkRail, RAIL_KEY, searchWork } from '@/lib/work-archive'

// WP456-T3：挪到 lib（看板「对话」卡的行也用它），这里照旧 re-export
export { shortAgo } from '@/lib/short-ago'

/** 搜索弹窗里一行的样子（照 Claude：左图标、标题、右边灰字）。 */
// 最后那个是 cmdk 行自带的勾（这里用不着，不占位）
const ROW = 'gap-2.5 rounded-lg! px-2.5 py-2 text-[13.5px] [&>svg:last-child]:hidden'
const ROW_ICON = 'size-4 shrink-0 text-ws-muted-fg'
const ROW_RIGHT = 'ml-auto shrink-0 pl-3 text-[12px] text-ws-muted-fg'

/** WP213：⌘K 里高亮的那一项，岗位 / 职责图标的点睛那一笔换品牌色（docs/36 §8.3）。 */
const SELECTED_ACCENT = 'data-[selected=true]:[--ia:var(--ws-brand)]'

export function CommandPalette({
  open,
  onOpenChange,
  positions,
  instances,
  cards,
  tileLibrary,
  onAddTile,
  handoff,
  compose,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  /**
   * WP188：「交给岗位去做」带过来的那件事。给了就只列岗位——选一个，这件事就交过去
   * （与岗位页顶部「交给这个岗位一件事」同一条路），然后进事项页。
   */
  handoff?: Handoff
  /** WP207：左栏职责行的「+」——岗位与职责已经选好，只剩写一句话。 */
  compose?: ComposeTarget
  positions: PositionSummary[]
  /** WP70：按岗位聚合的那一份。有它就先列岗位、再列「岗位 › 职责」。 */
  instances?: PositionInstanceData[]
  cards: DeckCard[]
  tileLibrary: TileSpec[]
  onAddTile: (position_id: string, tile_id: string) => void
}): React.ReactNode {
  const { t, lang, position } = useApp()
  const holdsSiteChat = useHoldsSiteChat()
  // WP356：设置弹窗的目录（每一节每一项），⌘K 里搜得到
  const { sections: settingSections } = useSettingsCatalog()
  const navigate = useNavigate()
  // WP276：在一件事里打开 ⌘K 时，多一条「把这件事交给同事…」（② 才有）
  const here = useLocation()
  const { mode: usage, known: modeKnown } = useMode()
  const matterHere = /^\/matters\/([^/?#]+)/.exec(here.pathname)?.[1]
  const rail = useRailState()
  // 岗位面装着就按岗位列（岗位在前、职责跟在后面）；没装退回按分配列
  const byPosition = (instances ?? []).filter((p) => myAssignments(p).length > 0)
  /**
   * 40 §2.2 第 1 条：⌘K 里也搜工具箱——"建之前先查"不能只在建的时候才想得起来。
   * 与工具箱页同源：都打 `GET /v1/catalog`。面板没打开就不拉（它不是首页的一部分）。
   */
  const catalog = useQuery({
    queryKey: ['catalog', 'palette'],
    enabled: open,
    queryFn: () => listCatalog({}),
  })
  /**
   * 52 O2：⌘K 里可以搜品牌名切换。
   *
   * 与顶栏切换器同一个数据源、同一条判据——个人用户（一个人一个品牌）这一组不出，
   * 进不去的品牌也不出（服务端已经筛过）。
   */
  const { org_id, brands } = useBrands()
  const client = useQueryClient()
  /** WP207：面板里打的字（要拿去搜对话与任务、也要拿去让 AI 找回）。 */
  const [search, setSearch] = useState('')
  const [debounced, setDebounced] = useState('')
  /** WP207：点了「让 AI 找回」之后，面板换成候选卡那一屏。 */
  const [recall, setRecall] = useState<string | undefined>(undefined)
  const [sentence, setSentence] = useState('')
  /** WP342：⌘K 交给某个岗位时这次用哪个 AI（不选 = 品牌默认）。 */
  const [model, setModel] = useState<string | undefined>(undefined)
  /** WP370：连同模型一起选的思考程度（换模型就清掉）。 */
  const [effort, setEffort] = useState<ReasoningEffort | undefined>(undefined)
  useEffect(() => {
    if (!open) {
      setSearch('')
      setRecall(undefined)
      setSentence('')
      setModel(undefined)
    }
  }, [open])
  useEffect(() => {
    const h = setTimeout(() => {
      setDebounced(search.trim())
    }, 200)
    return () => {
      clearTimeout(h)
    }
  }, [search])
  const works = useQuery({
    queryKey: ['matter', 'search', debounced],
    enabled: open && debounced.length >= 2,
    queryFn: () => searchWork(debounced, 8),
    retry: false,
  })
  // WP431：没打字时列「最近」（左栏原来那一串的同一个接口与查询键，缓存共用）
  const recent = useQuery({
    queryKey: RAIL_KEY,
    queryFn: () => getWorkRail(),
    enabled: open,
    retry: false,
    staleTime: 30_000,
  })
  const recents = (recent.data?.positions ?? [])
    .flatMap((p) => p.duties.flatMap((d) => d.matters))
    .sort((a, b) => b.last_activity.localeCompare(a.last_activity))
    .slice(0, 8)
  /** 照 Claude：一打开高亮的是「最近」第一条（最近那一串是异步到的，到了再把高亮挪过去；人动过就不管）。 */
  const [picked, setPicked] = useState('')
  const seeded = useRef(false)
  const firstRecent = recents[0] === undefined ? '' : `recent ${recents[0].id} ${recents[0].title}`
  useEffect(() => {
    if (!open) {
      seeded.current = false
      return
    }
    if (seeded.current || firstRecent === '' || search !== '') return
    seeded.current = true
    setPicked(firstRecent)
  }, [open, firstRecent, search])
  const found = useQuery({
    queryKey: ['matter', 'recall', recall],
    enabled: open && recall !== undefined,
    queryFn: () => findArchivedWork(recall ?? ''),
    retry: false,
  })

  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'k' && (e.metaKey || e.ctrlKey)) {
        e.preventDefault()
        onOpenChange(!open)
      }
    }
    globalThis.document?.addEventListener('keydown', onKey)
    return () => {
      globalThis.document?.removeEventListener('keydown', onKey)
    }
  }, [open, onOpenChange])

  const go = (path: string): void => {
    onOpenChange(false)
    navigate(path)
  }

  /*
   * WP291（决策 356）：交给某个岗位 = 先到那个岗位页（输入框下面出「…」），服务端三分：
   * 当场问答就在岗位页上答；会话 / 任务马上进它的线程（岗位页那一块负责跳）。
   */
  const handOver = useMutation({
    mutationFn: async (input: {
      assignment: string
      handoff: Handoff
      role_id?: string
      model?: string | undefined
      effort?: ReasoningEffort | undefined
    }) => {
      void askAtPosition({
        position: input.assignment,
        ...(input.model === undefined ? {} : { model: input.model }),
        ...(input.model === undefined || input.effort === undefined
          ? {}
          : { effort: input.effort }),
        text: input.handoff.title,
        ...(input.handoff.summary === '' ? {} : { summary: input.handoff.summary }),
        // WP207：从职责行的「+」来的，职责已经定了（跳过岗位内路由，与快捷提示同一条路）
        ...(input.role_id === undefined ? {} : { role_id: input.role_id }),
      })
    },
    onSuccess: (_out, input) => {
      go(`/positions/${input.assignment}`)
    },
  })

  if (compose !== undefined) {
    return (
      <CommandDialog
        open={open}
        onOpenChange={onOpenChange}
        title={t('command.compose.title', { name: compose.label })}
      >
        <form
          className="flex flex-col gap-2 p-3"
          data-testid="command-compose"
          onSubmit={(e) => {
            e.preventDefault()
            const text = sentence.trim()
            if (text === '' || handOver.isPending) return
            // WP259：一大段也照收——标题取第一句…，完整原文作描述、交给 AI（原来截到 200 字）
            const split = handoffInput(text)
            handOver.mutate(
              {
                assignment: compose.assignment,
                handoff: { title: split.title, summary: split.summary ?? '' },
                role_id: compose.role_id,
                model,
                effort,
              },
              {
                onSuccess: () => {
                  void client.invalidateQueries({ queryKey: RAIL_KEY })
                },
              },
            )
          }}
        >
          <span className="flex items-center gap-2 text-[12px] text-muted-foreground">
            <span className="min-w-0 flex-1 truncate">
              {t('command.compose.title', { name: compose.label })}
            </span>
            {/* WP342：这次用哪个 AI（选了只管这一件） */}
            <ComposerModelPicker
              value={model}
              onChange={(next) => {
                setModel(next)
                setEffort(undefined)
              }}
              effort={effort}
              onEffortChange={(next, picked) => {
                setModel(picked)
                setEffort(next)
              }}
              placement="down"
            />
          </span>
          <Input
            autoFocus
            value={sentence}
            maxLength={TASK_TEXT_MAX}
            placeholder={t('command.compose.placeholder')}
            aria-label={t('command.compose.placeholder')}
            data-testid="command-compose-input"
            onChange={(e) => {
              setSentence(e.target.value)
              if (handOver.error !== null) handOver.reset()
            }}
          />
          {handOver.isPending ? (
            <p className="text-xs text-muted-foreground" data-testid="handoff-sending">
              {t('handoff.sending')}
            </p>
          ) : null}
          <HandoffError error={handOver.error} />
        </form>
      </CommandDialog>
    )
  }

  if (recall !== undefined) {
    return (
      <CommandDialog open={open} onOpenChange={onOpenChange} title={t('command.recall.title')}>
        <div className="flex flex-col gap-2 p-3" data-testid="command-recall">
          <span className="flex items-center gap-1.5 text-[12px] text-muted-foreground">
            <Sparkles aria-hidden className="size-3.5" />
            {t('command.recall', { q: recall })}
          </span>
          {found.data === undefined ? (
            <p className="text-[13px] text-muted-foreground">{t('command.recall.loading')}</p>
          ) : found.data.candidates.length === 0 ? (
            <p className="text-[13px] text-muted-foreground">{t('archive.ai.none')}</p>
          ) : (
            <>
              <p className="text-[12px] text-muted-foreground">
                {t('archive.ai.pick')}
                {found.data.semantic ? ` · ${t('archive.ai.semantic')}` : ''}
              </p>
              <RecallCards
                compact
                candidates={found.data.candidates}
                onRestored={() => {
                  onOpenChange(false)
                }}
              />
            </>
          )}
        </div>
      </CommandDialog>
    )
  }

  if (handoff !== undefined) {
    const targets =
      byPosition.length > 0
        ? byPosition.map((p) => ({
            key: p.position_id,
            assignment: myAssignments(p)[0] as string,
            name: lang === 'en' ? p.name.en : p.name.zh,
            icon: (
              <PositionIcon
                position_id={p.position_id}
                icon={p.icon}
                role_ids={p.roles.map((r) => r.role_id)}
              />
            ),
          }))
        : positions.map((p) => ({
            key: p.position_id,
            assignment: p.position_id,
            name: p.role_name,
            icon: <PositionIcon position_id={p.position_id} role_ids={[p.role_id]} />,
          }))
    return (
      <CommandDialog open={open} onOpenChange={onOpenChange} title={t('command.handoff.title')}>
        <Command>
          <CommandInput placeholder={t('command.handoff.placeholder')} />
          <CommandList>
            <CommandEmpty>{t('command.empty')}</CommandEmpty>
            <CommandGroup heading={t('command.handoff.title')}>
              {targets.map((target) => (
                <CommandItem
                  key={target.key}
                  value={`${target.name} ${target.key}`}
                  data-testid="command-handoff"
                  className={SELECTED_ACCENT}
                  disabled={handOver.isPending}
                  onSelect={() => {
                    handOver.mutate({ assignment: target.assignment, handoff })
                  }}
                >
                  {target.icon}
                  {target.name}
                </CommandItem>
              ))}
            </CommandGroup>
          </CommandList>
          {handOver.isPending ? (
            <p className="px-3 pb-2 text-xs text-muted-foreground" data-testid="handoff-sending">
              {t('handoff.sending')}
            </p>
          ) : null}
          <HandoffError error={handOver.error} className="px-3 pb-2 text-xs text-destructive" />
        </Command>
      </CommandDialog>
    )
  }

  return (
    <CommandDialog
      open={open}
      onOpenChange={onOpenChange}
      title={t('command.placeholder')}
      className="top-[14%] gap-0 sm:max-w-[640px]"
    >
      <Command
        className="rounded-xl! p-0"
        data-testid="search-dialog"
        value={picked}
        onValueChange={setPicked}
      >
        {/* 照 Claude：顶上一行大输入框（不套框），下面一条细线 */}
        <div className="flex h-12 items-center gap-2.5 border-b border-ws-line px-4">
          <Search aria-hidden className="size-4 shrink-0 text-ws-muted-fg" />
          <CommandPrimitive.Input
            data-slot="command-input"
            placeholder={t('search.placeholder')}
            value={search}
            onValueChange={setSearch}
            className="h-full w-full bg-transparent text-[15px] outline-hidden placeholder:text-ws-muted-fg"
          />
        </div>
        <CommandList className="max-h-[min(60vh,440px)] p-1.5">
          <CommandEmpty>{t('command.empty')}</CommandEmpty>
          {search.trim() !== '' || recents.length === 0 ? null : (
            <CommandGroup heading={t('search.recent')}>
              {recents.map((m) => (
                <CommandItem
                  key={m.id}
                  value={`recent ${m.id} ${m.title}`}
                  data-testid="command-recent"
                  className={ROW}
                  onSelect={() => {
                    go(`/matters/${encodeURIComponent(m.id)}`)
                  }}
                >
                  <MessagesSquare aria-hidden className={ROW_ICON} />
                  <span className="min-w-0 truncate">{m.title}</span>
                  <span className={ROW_RIGHT}>{shortAgo(m.last_activity, t, lang)}</span>
                </CommandItem>
              ))}
            </CommandGroup>
          )}
          {/* WP207：对话与任务（服务端全文搜；归档的也在，标出来） */}
          {debounced.length < 2 || (works.data ?? []).length === 0 ? null : (
            <CommandGroup forceMount heading={t('command.group.work')}>
              {(works.data ?? []).map((m) => (
                <CommandItem
                  key={m.id}
                  forceMount
                  value={`work ${m.id} ${m.title}`}
                  data-testid="command-work"
                  data-archived={m.archived_at === undefined ? undefined : 'true'}
                  className={ROW}
                  onSelect={() => {
                    go(`/matters/${encodeURIComponent(m.id)}`)
                  }}
                >
                  <MessagesSquare aria-hidden className={ROW_ICON} />
                  <span className="min-w-0 truncate">{m.title}</span>
                  {m.archived_at === undefined ? (
                    <span className={ROW_RIGHT}>{shortAgo(m.last_activity, t, lang)}</span>
                  ) : (
                    <span className={cn(ROW_RIGHT, 'flex items-center gap-1')}>
                      <Archive aria-hidden className="size-3" />
                      {t('archive.badge')}
                    </span>
                  )}
                </CommandItem>
              ))}
            </CommandGroup>
          )}
          <CommandGroup heading={t('command.group.go')}>
            {usage === 'solo' || matterHere === undefined ? null : (
              <CommandItem
                value={`${t('palette.handoff')} handoff`}
                data-testid="command-handoff"
                onSelect={() => {
                  go(`/matters/${matterHere}?handoff=1`)
                }}
              >
                {t('palette.handoff')}
              </CommandItem>
            )}
            {/* WP188：⌘K 里开一段新的随便聊 */}
            <CommandItem
              value={`${t('command.new_chat')} ${t('nav.free_chat')} new chat`}
              data-testid="command-new-chat"
              className={ROW}
              onSelect={() => {
                go('/assistant?new=1')
              }}
            >
              <MessageCircle aria-hidden className={ROW_ICON} />
              {t('command.new_chat')}
            </CommandItem>
            <CommandItem
              className={ROW}
              onSelect={() => {
                go('/')
              }}
            >
              <Home aria-hidden className={ROW_ICON} />
              {t('nav.home')}
            </CommandItem>
            {/* WP475：⌘K 里也能找到「反馈」 */}
            <CommandItem
              value={`${t('command.feedback')} feedback bug 反馈 问题 建议`}
              data-testid="command-feedback"
              className={ROW}
              onSelect={() => {
                onOpenChange(false)
                openFeedback('new')
              }}
            >
              <MessageSquareText aria-hidden className={ROW_ICON} />
              {t('command.feedback')}
            </CommandItem>
            {/* WP70：岗位排在职责前面 */}
            {byPosition.map((p) => {
              const first = myAssignments(p)[0] as string
              return (
                <CommandItem
                  key={p.position_id}
                  value={`${lang === 'en' ? p.name.en : p.name.zh} ${p.position_id}`}
                  data-testid="command-position"
                  className={cn(ROW, SELECTED_ACCENT)}
                  onSelect={() => {
                    go(`/positions/${first}`)
                  }}
                >
                  <PositionIcon
                    position_id={p.position_id}
                    icon={p.icon}
                    role_ids={p.roles.map((r) => r.role_id)}
                  />
                  {lang === 'en' ? p.name.en : p.name.zh}
                </CommandItem>
              )
            })}
            {byPosition.flatMap((p) =>
              p.roles
                .filter((r) => r.my_assignment_id !== undefined)
                .map((r) => (
                  <CommandItem
                    key={`${p.position_id}/${r.role_id}`}
                    value={`${r.role_name} ${r.role_id}`}
                    data-testid="command-duty"
                    className={cn(ROW, SELECTED_ACCENT)}
                    onSelect={() => {
                      go(`/positions/${r.my_assignment_id as string}`)
                    }}
                  >
                    <DutyIcon role_id={r.role_id} />
                    {t('duty.of_position', {
                      position: lang === 'en' ? p.name.en : p.name.zh,
                      duty: r.role_name,
                    })}
                  </CommandItem>
                )),
            )}
            {byPosition.length > 0
              ? null
              : positions.map((p) => (
                  <CommandItem
                    key={p.position_id}
                    value={`${p.role_name} ${p.role_id}`}
                    data-testid="command-position"
                    className={SELECTED_ACCENT}
                    onSelect={() => {
                      go(`/positions/${p.position_id}`)
                    }}
                  >
                    <PositionIcon position_id={p.position_id} role_ids={[p.role_id]} />
                    {p.role_name}
                  </CommandItem>
                ))}
            {/*
              WP342（决策 853）：左栏下半那几页收进了账号菜单，⌘K 里照样一搜就到
              （会议 / 知识库 / 技能；WP361 起 ② ③ 多一页「进行中」）
            */}
            {SHELL_PAGES.filter((p) =>
              shellPageVisible(p, { known: modeKnown, solo: usage === 'solo' }),
            ).map((p) => (
              <CommandItem
                key={p.to}
                value={`${t(p.key)} ${p.to}`}
                data-testid="command-page"
                data-to={p.to}
                className={ROW}
                onSelect={() => {
                  go(p.to)
                }}
              >
                <p.icon aria-hidden className={ROW_ICON} />
                {t(p.key)}
              </CommandItem>
            ))}
            {/*
              WP351：原「聊天窗」拆成两处，⌘K 两处都搜得到——访客对话（消息 → 网站聊天）、
              挂件设置（消息渠道 → 网站聊天窗）。名下有网站在线客服才出。
            */}
            {holdsSiteChat
              ? [
                  { to: SITE_CHAT_HREF, label: t('messages.source.site_chat'), id: 'site-chat' },
                  {
                    to: SITE_CHAT_SETTINGS_HREF,
                    label: t('nav.chat_window'),
                    id: 'site-chat-settings',
                  },
                ].map((x) => (
                  <CommandItem
                    key={x.id}
                    value={`${x.label} ${t('nav.chat_window')} chat widget ${x.id}`}
                    data-testid="command-page"
                    data-to={x.to}
                    onSelect={() => {
                      go(x.to)
                    }}
                  >
                    {x.label}
                  </CommandItem>
                ))
              : null}
          </CommandGroup>
          {/*
            WP356（决策 923）：设置的每一节、每一项都搜得到（同设置弹窗里那个搜索，一份清单）；
            选了打开设置弹窗并定位到那一项。没打字时不列（五十来行会把别的挤下去），只留一行「设置」。
          */}
          <CommandGroup heading={t('sp.title')}>
            {search.trim() === '' ? (
              <CommandItem
                value={`${t('nav.settings')} settings`}
                data-testid="command-setting"
                data-to="/settings"
                className={ROW}
                onSelect={() => {
                  go('/settings')
                }}
              >
                <Settings aria-hidden className={ROW_ICON} />
                {t('nav.settings')}
              </CommandItem>
            ) : (
              settingSections.flatMap((sec) =>
                sec.items.map((i) => (
                  <CommandItem
                    key={`${sec.def.id}:${i.def.id}`}
                    value={`${i.haystack} ${sec.def.id}:${i.def.id}`}
                    data-testid="command-setting"
                    data-to={settingsHref(sec.def.id, i.def.id)}
                    className={ROW}
                    onSelect={() => {
                      go(settingsHref(sec.def.id, i.def.id))
                    }}
                  >
                    <Settings aria-hidden className={ROW_ICON} />
                    <span className="min-w-0 truncate">{i.title}</span>
                    {i.title === sec.title ? null : <span className={ROW_RIGHT}>{sec.title}</span>}
                  </CommandItem>
                )),
              )
            )}
          </CommandGroup>
          {/* WP271：一人多品牌也要能搜品牌——只看品牌数，不看 solo */}
          {org_id === undefined || brands.length <= 1 ? null : (
            <CommandGroup heading={t('command.group.brands')}>
              {brands.map((b) => (
                <CommandItem
                  key={b.workspace_id}
                  value={`${b.name} ${t('brand.switch')}`}
                  disabled={b.current}
                  onSelect={() => {
                    onOpenChange(false)
                    if (b.current) return
                    // 切过去之后整站重载（与顶栏切换器同一条路）
                    switchBrand(org_id, b.workspace_id)
                      .then(() => {
                        enterSwitchedBrand()
                      })
                      .catch(() => undefined)
                  }}
                >
                  {b.name}
                  {b.current ? (
                    <span className="ml-2 text-xs text-muted-foreground">
                      {t('org.brands.current')}
                    </span>
                  ) : null}
                </CommandItem>
              ))}
            </CommandGroup>
          )}
          {cards.length === 0 ? null : (
            <CommandGroup heading={t('command.group.cards')}>
              {cards.slice(0, 20).map((card) => (
                <CommandItem
                  key={card.id}
                  value={`${card.title} ${card.summary}`}
                  onSelect={() => {
                    go(`/positions/${card.position_id}?card=${card.id}`)
                  }}
                >
                  {card.title}
                </CommandItem>
              ))}
            </CommandGroup>
          )}
          {(catalog.data ?? []).length === 0 ? null : (
            <CommandGroup heading={t('command.group.toolbox')}>
              {(catalog.data ?? []).slice(0, 20).map((entry) => (
                <CommandItem
                  key={entry.id}
                  value={`${entry.title} ${entry.summary}`}
                  onSelect={() => {
                    go(`/org?tab=toolbox&q=${encodeURIComponent(entry.title)}`)
                  }}
                >
                  {entry.title}
                  <span className="ml-2 text-xs text-muted-foreground">
                    {t(`toolbox.kind.${entry.kind}`)} · {t('toolbox.owner', { who: entry.owner })}
                  </span>
                </CommandItem>
              ))}
            </CommandGroup>
          )}
          <CommandGroup heading={t('command.group.help')}>
            {HELP_SLUGS.map((slug) => (
              <CommandItem
                key={slug}
                value={`${translate('zh', `help.${slug}.title`)} ${translate('en', `help.${slug}.title`)} ${slug}`}
                data-testid="command-help"
                data-slug={slug}
                className={ROW}
                onSelect={() => {
                  onOpenChange(false)
                  // 右栏不在（极少：单测里只渲染面板）就开不出来，跳去设置页也没意义——只关面板
                  rail.openAddress(helpAddress(slug))
                }}
              >
                <BookOpen aria-hidden className={ROW_ICON} />
                {t(`help.${slug}.title`)}
              </CommandItem>
            ))}
          </CommandGroup>
          {/* WP207：让 AI 找回——只给候选，点一张才放回来 */}
          {search.trim().length < 2 ? null : (
            <CommandGroup forceMount heading={t('command.archived')}>
              <CommandItem
                forceMount
                value={`recall ${search}`}
                data-testid="command-recall-item"
                className={ROW}
                onSelect={() => {
                  setRecall(search.trim())
                }}
              >
                <Sparkles aria-hidden className={ROW_ICON} />
                {t('command.recall', { q: search.trim() })}
              </CommandItem>
            </CommandGroup>
          )}
          {position === null ? null : (
            <CommandGroup heading={t('command.group.tiles')}>
              {tileLibrary.map((tile) => (
                <CommandItem
                  key={tile.id}
                  value={`${t('home.tiles.add')} ${tile.label}`}
                  onSelect={() => {
                    onOpenChange(false)
                    onAddTile(position, tile.id)
                  }}
                >
                  {tile.label}
                </CommandItem>
              ))}
            </CommandGroup>
          )}
        </CommandList>
        {/* 照 Claude：底下一行按键提示 */}
        <div
          className="flex items-center justify-end gap-3 border-t border-ws-line px-3 py-2 text-xs text-ws-muted-fg"
          data-testid="search-footer"
        >
          <span className="inline-flex items-center gap-1">
            <kbd className="inline-flex h-5 min-w-5 items-center justify-center rounded border border-ws-line px-1 font-sans">
              <CornerDownLeft aria-hidden className="size-3" />
            </kbd>
            {t('search.open')}
          </span>
          <span className="inline-flex items-center gap-1">
            <kbd className="inline-flex h-5 items-center justify-center rounded border border-ws-line px-1 font-sans text-ws-tiny">
              Esc
            </kbd>
            {t('search.close')}
          </span>
        </div>
      </Command>
    </CommandDialog>
  )
}
