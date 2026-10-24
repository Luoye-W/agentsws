/**
 * WP68（48 §5.1 / §5.4）：红人岗位页上那一块**能动手的**面板。
 *
 * WP67 之后红人那五块只能看（deck 的表格是只读投影）。这个组件补的是"动手"那一半：
 * 找人 → 点开详情 → 加联系方式 → 起开发信 → 推进阶段，外加导入与发起 campaign。
 *
 * 四条界面纪律：
 *
 * 1. **"拿不到"与"搜到 0 个"分得开**（36 §3）。搜索失败时出的是服务端那一句人话
 *    （没连 / 要审核 / 要申请 / 要买档 / 配额用完），不是一张空表。
 * 2. **联系方式永远只显示脱敏形态**。这个文件里没有一个地方拿得到明文——
 *    服务端的 `KolContactView` 上就没有那一格。
 * 3. **花钱之前先说数**。公共库那一档的 reveal 按钮上直接写着"扣 N 积分"，
 *    不是点完才知道。
 * 4. **灰着的东西要说得出为什么**。campaign 清单里本人没有那条职责的整组
 *    灰显 + 一句话，而不是悄悄少几行。
 */

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { ChevronRight, Coins, Megaphone, Search, Upload, Users } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'
import { Link, useNavigate, useSearchParams } from 'react-router-dom'
import { AutopilotStrip } from '@/components/autopilot/autopilot-strip'
import { useInRightPane } from '@/components/rail/in-right-pane'
import { useOpenConnect } from '@/components/setup/use-open-connect'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import { Skeleton } from '@/components/ui/skeleton'
import {
  acceptKolCampaign,
  addKolCreator,
  getKolCollaborations,
  getKolCreators,
  type KolCampaignData,
  type KolChannelId,
  type KolSearchData,
  planKolCampaign,
  revealKolContact,
  searchKolCreators,
} from '@/lib/api'
import { useApp } from '@/lib/app-context'
import { CollabThread } from './collab-thread'
import {
  COLLAB_GROUPS,
  GroupTitle,
  groupOfTier,
  jumpToCards,
  TierTag,
  tierRank,
} from './collab-tier'
import { CreatorCard, stepOpensThread } from './creator-card'
import { CreatorDetailView, openCreatorPane } from './creator-pane'
import { ALL_CHANNELS, atHandle, CHANNEL_SERVICE } from './kol-channel'
import { KolSandboxBar } from './kol-sandbox-bar'
import { errorText, KolError, KolReceipt, refreshCards } from './kol-shared'
import { KolSheetImport } from './kol-sheet-import'
import { CollabProgress } from './segmented-progress'

/** 职责 id → 渠道（`kol.youtube` → `youtube`）。不是红人职责就回 `undefined`。 */
export function channelOfRole(role_id: string | undefined): KolChannelId | undefined {
  if (role_id === undefined || !role_id.startsWith('kol.')) return undefined
  const id = role_id.slice('kol.'.length)
  return ALL_CHANNELS.find((c) => c === id)
}

export { atHandle }

export function entryHref(id: 'link_account' | 'byo', channel: KolChannelId): string {
  return id === 'link_account'
    ? '/settings/credits'
    : `/connections?service=${encodeURIComponent(CHANNEL_SERVICE[channel])}`
}

const num = (n: number | undefined): string =>
  n === undefined ? '—' : n >= 10_000 ? `${Math.round(n / 1000)}k` : String(n)

/* ── 找人 ─────────────────────────────────────────────────────────────── */

function Discovery({
  assignment,
  channel,
  onOpen,
  onThread,
  batch,
  onClearBatch,
}: {
  assignment: string
  channel: KolChannelId
  onOpen: (creator_id: string) => void
  /** WP302：卡上「下一步」落在合作线程里的那几步。 */
  onThread: (collaboration_id: string) => void
  /** WP131：插件「回作战室看这批」带来的采集批次——只列这一批。 */
  batch?: string
  onClearBatch?: () => void
}): React.ReactNode {
  const { t } = useApp()
  const openConnect = useOpenConnect()
  const client = useQueryClient()
  const [q, setQ] = useState('')
  const [found, setFound] = useState<KolSearchData | undefined>(undefined)
  const [error, setError] = useState<string | undefined>(undefined)
  const [receipt, setReceipt] = useState<string | undefined>(undefined)

  /*
   * WP295：外面搜不了（这条渠道没接数据来源）时，同一个关键词至少把**自己的库**筛一遍。
   * 以前搜「数码」只回一句「现在搜不了」，下面「我的红人库」照旧列全部——人得自己一行一行找。
   */
  const [libraryQ, setLibraryQ] = useState('')
  const library = useQuery({
    queryKey: ['kol-creators', assignment, channel, batch ?? '', libraryQ],
    queryFn: () =>
      getKolCreators(
        {
          channel,
          ...(batch === undefined ? {} : { batch }),
          ...(libraryQ === '' ? {} : { q: libraryQ }),
        },
        assignment,
      ),
  })

  const search = useMutation({
    mutationFn: () => searchKolCreators({ channel, q }, assignment),
    onSuccess: (out) => {
      setError(undefined)
      setFound(out)
      setLibraryQ(out.ok ? '' : q.trim())
    },
    // 66 断点：接口挂了要照实说，不许留在"搜索中"或者悄悄什么都不发生
    onError: (e: unknown) => {
      setError(errorText(e, '这次没搜成。'))
    },
  })

  const reveal = useMutation({
    mutationFn: (handle: string) => revealKolContact({ channel, handle }, assignment),
    onSuccess: (out) => {
      setError(undefined)
      setReceipt(
        out.contact === undefined
          ? '这一次没取到联系方式（积分没扣）。'
          : `取到了：${out.contact.masked}，已经进你的库。`,
      )
      void client.invalidateQueries({ queryKey: ['kol-creators'] })
      search.mutate()
    },
    onError: (e: unknown) => {
      setReceipt(undefined)
      setError(errorText(e, '这一次没取到（积分没扣）。'))
    },
  })

  const add = useMutation({
    mutationFn: (row: { display_name: string; handle: string; url: string }) =>
      addKolCreator({ ...row, channel }, assignment),
    onSuccess: (detail) => {
      setError(undefined)
      setReceipt(`${detail.creator.display_name} 进你的红人库了。`)
      void client.invalidateQueries({ queryKey: ['kol-creators'] })
      search.mutate()
    },
    onError: (e: unknown) => {
      setReceipt(undefined)
      setError(errorText(e, '这个人没加进库。'))
    },
  })

  return (
    <Card data-testid="kol-discovery">
      <CardHeader>
        <CardTitle className="flex items-center gap-1.5 text-sm">
          <Search className="size-4" aria-hidden />
          {t('kol.discovery.title')}
        </CardTitle>
      </CardHeader>
      <CardContent className="flex flex-col gap-3">
        <div className="flex items-center gap-2">
          <Input
            value={q}
            placeholder={t(`kol.search.placeholder.${channel}`)}
            data-testid="kol-search-input"
            onChange={(e) => {
              setQ(e.target.value)
            }}
            // 66 断点 #3：输关键词按回车没反应，非得去点「搜」
            onKeyDown={(e) => {
              if (e.key !== 'Enter' || q.trim() === '' || search.isPending) return
              e.preventDefault()
              search.mutate()
            }}
          />
          <Button
            size="sm"
            data-testid="kol-search-go"
            disabled={q.trim() === '' || search.isPending}
            onClick={() => {
              search.mutate()
            }}
          >
            {t('kol.search.go')}
          </Button>
        </div>

        <KolError error={error} testid="kol-discovery-error" />
        <KolReceipt text={receipt} testid="kol-discovery-receipt" />

        {/*
          36 §3：**"拿不到"与"搜到 0 个"分得开**。服务端把没连 / 要审核 / 要申请 /
          要买档 / 配额用完各说成一句人话，界面照它说，不画一张空表。
        */}
        {found !== undefined && !found.ok ? (
          <div className="flex flex-col gap-2" data-testid="kol-search-blocked-box">
            <p className="text-sm text-muted-foreground" data-testid="kol-search-blocked">
              {found.message}
            </p>
            {/* WP142（docs/78 第 15 步）：真正要做的两件事各是一个按钮，不埋在字里 */}
            {(found.entry_points ?? []).length === 0 ? null : (
              <div className="flex flex-wrap items-center gap-2">
                {(found.entry_points ?? []).map((entry) =>
                  /*
                   * WP324：接自己的数据接口 = 第三栏就地连那个渠道（不跳连接页）；
                   * WP334（决策 726）：关联官方账号也在第三栏就地关联（与设置页同一个注册 / 登录表单）
                   */
                  entry.id === 'byo' ? (
                    <Button
                      key={entry.id}
                      size="sm"
                      variant="outline"
                      title={entry.note}
                      data-testid={`kol-search-entry-${entry.id}`}
                      data-connect={CHANNEL_SERVICE[channel]}
                      onClick={() => {
                        openConnect(CHANNEL_SERVICE[channel])
                      }}
                    >
                      {entry.label}
                    </Button>
                  ) : (
                    <Button
                      key={entry.id}
                      size="sm"
                      variant="default"
                      title={entry.note}
                      data-testid={`kol-search-entry-${entry.id}`}
                      data-connect="workshop_account"
                      onClick={() => {
                        openConnect('workshop_account')
                      }}
                    >
                      {entry.label}
                    </Button>
                  ),
                )}
              </div>
            )}
          </div>
        ) : null}

        {found?.ok === true ? (
          <div className="flex flex-col gap-2" data-testid="kol-search-results">
            <p className="text-xs text-muted-foreground">
              {t(`kol.source.${found.source}`)}
              {found.reveal_price === undefined ? '' : ` · ${found.reveal_price.note}`}
            </p>
            {found.rows.length === 0 ? (
              <p className="text-sm text-muted-foreground">{t('kol.search.none')}</p>
            ) : null}
            {found.rows.map((row) => (
              <div
                key={`${row.channel}:${row.handle}`}
                className="flex items-center justify-between gap-2 border-b pb-2 text-sm"
                data-testid="kol-search-row"
              >
                <div className="min-w-0">
                  <div className="truncate font-medium">{row.display_name}</div>
                  <div className="text-xs text-muted-foreground">
                    {atHandle(row.handle)} · {t('kol.followers', { n: num(row.followers) })}
                    {row.in_library === true ? ` · ${t('kol.in_library')}` : ''}
                  </div>
                </div>
                <div className="flex shrink-0 items-center gap-1">
                  {found.source === 'public_library' && row.has_contact === true ? (
                    <Button
                      size="xs"
                      variant="outline"
                      data-testid="kol-reveal"
                      disabled={reveal.isPending}
                      onClick={() => {
                        reveal.mutate(row.handle)
                      }}
                    >
                      <Coins className="size-3" aria-hidden />
                      {t('kol.reveal', { n: found.reveal_price?.credits ?? 0 })}
                    </Button>
                  ) : null}
                  {row.in_library === true ? null : (
                    <Button
                      size="xs"
                      variant="ghost"
                      data-testid="kol-add"
                      disabled={add.isPending}
                      onClick={() => {
                        add.mutate({
                          display_name: row.display_name,
                          handle: row.handle,
                          url: row.url,
                        })
                      }}
                    >
                      {t('kol.add')}
                    </Button>
                  )}
                </div>
              </div>
            ))}
          </div>
        ) : null}

        <div className="mt-1">
          {batch === undefined ? (
            <div className="mb-1 flex items-center gap-2">
              <h4 className="text-xs font-medium text-muted-foreground">
                {libraryQ === '' ? t('kol.library') : t('kol.library.q', { q: libraryQ })}
              </h4>
              {libraryQ === '' ? null : (
                <Button
                  size="xs"
                  variant="ghost"
                  data-testid="kol-library-q-clear"
                  onClick={() => {
                    setLibraryQ('')
                  }}
                >
                  {t('kol.library.batch.all')}
                </Button>
              )}
            </div>
          ) : (
            /* WP131：从插件跳回来的「这一批」——说清楚现在只看这一批，一键回全部 */
            <div
              className="mb-1 flex items-center justify-between gap-2"
              data-testid="kol-library-batch"
            >
              <div className="min-w-0">
                <h4 className="text-xs font-medium text-foreground">
                  {t('kol.library.batch', { n: library.data?.rows.length ?? 0 })}
                </h4>
                <p className="text-xs text-muted-foreground">{t('kol.library.batch.hint')}</p>
              </div>
              <Button size="sm" variant="ghost" onClick={onClearBatch}>
                {t('kol.library.batch.all')}
              </Button>
            </div>
          )}
          {library.isPending ? <Skeleton className="h-16 w-full" /> : null}
          {/*
            36 §3 的同一条规矩，**查询这一侧**：取不回来不等于库里没人。
            这一条是拍演练截图时撞出来的——demo 的请求配额用完回了 429，
            界面上显示的却是"库里还没有人。先导一张表进来"，
            于是人会去导一张他早就导过的表。
          */}
          {library.error !== null ? (
            <KolError
              error={errorText(library.error, '红人库这次没取回来。')}
              testid="kol-library-error"
            />
          ) : null}
          {library.error === null &&
          (library.data?.rows ?? []).length === 0 &&
          !library.isPending ? (
            <p className="text-sm text-muted-foreground" data-testid="kol-library-empty">
              {batch === undefined ? t('kol.library.empty') : t('kol.library.batch.empty')}
            </p>
          ) : null}
          {/*
            WP302（决策 406）：一行一行的名单换成达人卡——分数、三格判断色块、合作走到哪、
            按阶段变的那一个按钮。testid `kol-library-row` 留在卡上点开详情的那一块（老脚本照用）。
          */}
          <ol
            className="grid grid-cols-1 gap-2 sm:grid-cols-2 xl:grid-cols-3"
            data-testid="kol-library"
          >
            {(library.data?.rows ?? []).map((row) => (
              <CreatorCard
                key={row.creator_id}
                row={row}
                handle={`${atHandle(row.handle)}`}
                onOpen={() => {
                  onOpen(row.creator_id)
                }}
                onNext={(step) => {
                  if (stepOpensThread(step) && row.collab !== undefined) onThread(row.collab.id)
                  else onOpen(row.creator_id)
                }}
              />
            ))}
          </ol>
        </div>
      </CardContent>
    </Card>
  )
}

/* ── 合作：阶段推进 ───────────────────────────────────────────────────── */

/**
 * 66 复测 #18：**每一行要看得出是谁。**
 *
 * 以前这张清单上一行只有阶段（「已找到 ›」「已建联 ›」），24 行长得一模一样——
 * 人点开之前根本不知道自己在点谁。现在一行有：**红人名 · @账号 · 渠道 · 档色那一句 ·
 * 迷你进度条 · 预算**（有的话），外加一排筛：按阶段、按名字搜。
 *
 * 两条小纪律：
 *
 * 1. **筛出 0 条与本来就没有合作是两句话**。筛没筛过界面自己知道，
 *    说"这个条件下没有"比说"还没有在谈的合作"准确得多（36 §3 的同一条）。
 * 2. WP302：「多久没动了」由档色那一句说（「等回复 · 已 5 天」），停满 7 天的那一段进度条标黄——
 *    不再另起一列「N 天前」（docs/96 P5，一件事只说一处）。
 */
const STAGE_FILTERS = [
  'all',
  'sourced',
  'contacted',
  'replied',
  'negotiating',
  'agreed',
  'sample_sent',
  'delivering',
  'delivered',
  'declined',
] as const

/** 「其他」那一组折起来时露几条。 */
const IDLE_PREVIEW = 3

function Collaborations({
  assignment,
  channel,
  onOpen,
}: {
  assignment: string
  channel: KolChannelId
  onOpen: (collaboration_id: string) => void
}): React.ReactNode {
  const { t } = useApp()
  const navigate = useNavigate()
  const [stage, setStage] = useState<(typeof STAGE_FILTERS)[number]>('all')
  const [q, setQ] = useState('')
  /** 「其他」那一组（还没联系 / 谢绝了）默认只露几条——演练一开就是二十几条，压住了上面要紧的。 */
  const [idleOpen, setIdleOpen] = useState(false)

  const list = useQuery({
    queryKey: ['kol-collaborations', assignment, channel],
    queryFn: () => getKolCollaborations({ channel }, assignment),
  })
  // 名字与 @账号在红人库那一份里（合作记录上只有 creator_id）
  const library = useQuery({
    queryKey: ['kol-creators', assignment, channel],
    queryFn: () => getKolCreators({ channel }, assignment),
  })

  const who = new Map((library.data?.rows ?? []).map((r) => [r.creator_id, r]))
  const open = (list.data?.rows ?? []).filter((c) => c.stage !== 'closed')
  const needle = q.trim().toLowerCase()
  const rows = open
    .filter((c) => stage === 'all' || c.stage === stage)
    .filter((c) => {
      if (needle === '') return true
      const r = who.get(c.creator_id)
      return `${r?.display_name ?? c.creator_id} ${r?.handle ?? ''}`.toLowerCase().includes(needle)
    })
    // WP302：组内急的在前；同一档里停得久的在前，再按最近有动静的
    .sort(
      (a, b) =>
        tierRank(a.status?.tier) - tierRank(b.status?.tier) ||
        (b.dwell_days ?? -1) - (a.dwell_days ?? -1) ||
        Date.parse(b.last_activity_at ?? '') - Date.parse(a.last_activity_at ?? '') ||
        0,
    )
  const filtered = stage !== 'all' || needle !== ''

  return (
    <Card data-testid="kol-collaborations">
      <CardHeader>
        <CardTitle className="flex items-center gap-1.5 text-sm">
          <Users className="size-4" aria-hidden />
          {t('kol.collab.title')}
          <span
            className="font-normal text-xs text-muted-foreground"
            data-testid="kol-collab-count"
          >
            {filtered ? `${rows.length} / ${open.length}` : String(open.length)}
          </span>
        </CardTitle>
      </CardHeader>
      <CardContent className="flex flex-col gap-2 text-sm">
        {/* 筛：阶段一排胶囊 + 一个搜名字的框（24 行时没有它就没法用） */}
        <div className="flex flex-wrap items-center gap-1" data-testid="kol-collab-filters">
          {STAGE_FILTERS.map((s) => (
            <Button
              key={s}
              size="xs"
              variant={s === stage ? 'secondary' : 'ghost'}
              aria-pressed={s === stage}
              data-testid="kol-collab-filter"
              data-stage={s}
              onClick={() => {
                setStage(s)
              }}
            >
              {s === 'all' ? '全部' : t(`kol.stage.${s}`)}
            </Button>
          ))}
          <Input
            className="h-7 w-40"
            value={q}
            placeholder="搜红人名字 / @账号"
            data-testid="kol-collab-search"
            onChange={(e) => {
              setQ(e.target.value)
            }}
          />
        </div>

        {list.isPending ? <Skeleton className="h-16 w-full" /> : null}
        {/* 同上：取不回来不等于"没有在谈的合作" */}
        {list.error !== null ? (
          <KolError
            error={errorText(list.error, '合作清单这次没取回来。')}
            testid="kol-collab-list-error"
          />
        ) : null}
        {list.error === null && rows.length === 0 && !list.isPending ? (
          <p className="text-muted-foreground" data-testid="kol-collab-empty">
            {filtered ? '这个条件下没有合作。换个阶段或者清掉搜索词。' : t('kol.collab.empty')}
          </p>
        ) : null}
        {/*
          WP302（决策 406）：按急到缓分四组——要处理 / 等对方 / 进行中 / 其他，组里没人就不出组标题。
          每一行一个档色小标（那一句就是「现在怎么样」）+ 一根迷你进度条（走到哪了）。
          docs/96 P1：推进阶段、批卡都不在清单上——推进在线程里，批卡在卡片流里。
        */}
        {COLLAB_GROUPS.map((group) => {
          const inGroup = rows.filter((c) => groupOfTier(c.status?.tier) === group)
          if (inGroup.length === 0) return null
          // 筛过、或者自己点开了就全出；不然「其他」只露前 IDLE_PREVIEW 条
          const folded = group === 'idle' && !filtered && !idleOpen && inGroup.length > IDLE_PREVIEW
          const shown = folded ? inGroup.slice(0, IDLE_PREVIEW) : inGroup
          return (
            <section key={group} className="flex flex-col gap-1" data-group={group}>
              <GroupTitle group={group} n={inGroup.length} />
              {shown.map((c) => {
                const r = who.get(c.creator_id)
                const urgent = group === 'action' || group === 'waiting'
                return (
                  <div
                    key={c.id}
                    className="flex items-center gap-2 border-b pb-1.5"
                    data-testid="kol-collab-row"
                    data-stage={c.stage}
                    data-creator={c.creator_id}
                    data-tier={c.status?.tier}
                  >
                    <button
                      type="button"
                      className="flex min-w-0 flex-1 flex-col gap-1 rounded-sm px-1 py-0.5 text-left hover:bg-muted"
                      data-testid="kol-collab-open"
                      data-collab={c.id}
                      onClick={() => {
                        onOpen(c.id)
                      }}
                    >
                      <span className="flex min-w-0 flex-wrap items-baseline gap-x-2">
                        <span
                          className="truncate font-medium text-sm"
                          data-testid="kol-collab-name"
                        >
                          {r?.display_name ?? c.creator_id}
                        </span>
                        <span className="truncate text-xs text-muted-foreground">
                          {atHandle(r?.handle)} · {t(`kol.channel.${c.channel}`)}
                        </span>
                        {c.sandbox === true ? (
                          <span
                            className="rounded-sm bg-[var(--ws-warn-bg)] px-1 text-xs text-[var(--ws-ink)]"
                            data-testid="kol-collab-sandbox"
                          >
                            演练
                          </span>
                        ) : null}
                        {/* WP416：建合作那张卡还没人点头——点「不要」这一行就没了 */}
                        {c.awaiting_approval === true ? (
                          <span
                            className="rounded-sm bg-ws-surface px-1 text-xs text-ws-muted-fg"
                            data-testid="kol-collab-awaiting"
                          >
                            {t('kol.collab.awaiting')}
                          </span>
                        ) : null}
                      </span>
                      <span className="flex min-w-0 items-center gap-2 text-xs text-muted-foreground">
                        {c.segments === undefined ? null : (
                          <CollabProgress
                            segments={c.segments}
                            dwellDays={c.dwell_days}
                            className="max-w-40"
                          />
                        )}
                        {/* 档色那一句不说阶段时（等对方 / 要处理），阶段名在这儿；在做的那一句就是阶段名，不重复 */}
                        {urgent || c.status === undefined ? (
                          <span className="shrink-0" data-testid="kol-collab-stage">
                            {t(`kol.stage.${c.stage}`)}
                          </span>
                        ) : null}
                        {c.budget === undefined ? null : (
                          <span className="ws-num shrink-0" data-testid="kol-collab-budget">
                            {c.budget} {c.currency}
                          </span>
                        )}
                      </span>
                    </button>
                    {c.status === undefined ? null : (c.pending_cards ?? 0) > 0 ? (
                      <button
                        type="button"
                        className="shrink-0 hover:underline"
                        data-testid="kol-collab-cards"
                        title={t('kol.collab.to_cards')}
                        onClick={() => {
                          jumpToCards(navigate)
                        }}
                      >
                        <TierTag tier={c.status.tier} label={c.status.label} />
                      </button>
                    ) : (
                      <TierTag tier={c.status.tier} label={c.status.label} />
                    )}
                    <ChevronRight className="size-3 shrink-0 text-muted-foreground" aria-hidden />
                  </div>
                )
              })}
              {folded ? (
                <Button
                  size="xs"
                  variant="ghost"
                  className="self-start"
                  data-testid="kol-collab-more"
                  onClick={() => {
                    setIdleOpen(true)
                  }}
                >
                  {t('kol.collab.more', { n: inGroup.length - IDLE_PREVIEW })}
                </Button>
              ) : null}
            </section>
          )
        })}
      </CardContent>
    </Card>
  )
}

/* ── 导入与 campaign ──────────────────────────────────────────────────── */

function ImportAndCampaign({
  assignment,
  channel,
}: {
  assignment: string
  channel: KolChannelId
}): React.ReactNode {
  const { t } = useApp()
  const client = useQueryClient()
  const [, setSearch] = useSearchParams()
  const [plan, setPlan] = useState<KolCampaignData | undefined>(undefined)
  /**
   * WP142（docs/78 第 17 步）：接受之后「一条都没新建」时，说清是**因为都已在合作里**，
   * 并给下一步（去合作线程看他们 / 找更多人）。以前只说「跳过 2 条」，接受等于什么都没发生。
   */
  const [allExisting, setAllExisting] = useState<number | undefined>(undefined)
  const goView = (view: 'threads' | 'pool'): void => {
    setSearch((prev) => {
      const next = new URLSearchParams(prev)
      next.set('kol', view)
      return next
    })
  }
  const [goal, setGoal] = useState('')
  const [budget, setBudget] = useState('1000')
  const [headcount, setHeadcount] = useState('5')
  /*
   * 一次 campaign **可以跨渠道**（48 §5.2）——所以这里是一排勾，不是只有当前这条。
   * 勾上一条本人没有职责的渠道，清单照样把人挑出来给他看，只是那一组灰着、
   * 点不动（05 §4「不做跨 Assignment 并集」）。看得见比悄悄少几行有用得多。
   */
  const [channels, setChannels] = useState<KolChannelId[]>([channel])
  const [error, setError] = useState<string | undefined>(undefined)
  const [receipt, setReceipt] = useState<string | undefined>(undefined)

  const doPlan = useMutation({
    mutationFn: () =>
      planKolCampaign(
        {
          goal,
          budget: Number(budget),
          channels,
          headcount: Number(headcount),
        },
        assignment,
      ),
    onSuccess: (out) => {
      setError(undefined)
      setReceipt(undefined)
      setAllExisting(undefined)
      setPlan(out)
    },
    onError: (e: unknown) => {
      setPlan(undefined)
      setError(errorText(e, '这份清单没出来。'))
    },
  })

  /*
   * 66 断点 #5：接口回 200，清单直接消失，**没有任何回执**——人不知道
   * "接受"之后发生了什么，也不知道下一步该去哪儿看。清单还是要收起来
   * （它已经被采纳了，留着会让人以为还能再点一次），但必须换成一句话：
   * 建了几条、去哪儿看。
   */
  const doAccept = useMutation({
    mutationFn: (id: string) => acceptKolCampaign(id, assignment),
    onSuccess: (out) => {
      setError(undefined)
      const picks = (plan?.by_channel ?? []).flatMap((g) => g.picks)
      setPlan(undefined)
      const created = out.created.length
      const skipped = out.skipped.length
      // 跳过的每一条都是「清单上就标着已在合作里」的那几位 → 不是出错，是本来就有
      const existing = out.skipped.filter(
        (x) =>
          x.creator_id !== undefined &&
          picks.some((p) => p.creator_id === x.creator_id && p.already),
      ).length
      if (created === 0 && skipped > 0 && existing === skipped) {
        setAllExisting(existing)
        setReceipt(undefined)
      } else {
        setAllExisting(undefined)
        setReceipt(
          created === 0
            ? `一条都没新建（跳过 ${skipped} 条：${out.skipped[0]?.reason ?? '库里已经有了'}）。`
            : `建了 ${created} 条合作，都在「合作线程」那一页里${skipped === 0 ? '' : `（跳过 ${skipped} 条）`}。`,
        )
      }
      void client.invalidateQueries({ queryKey: ['kol-collaborations'] })
      refreshCards(client)
    },
    onError: (e: unknown) => {
      setReceipt(undefined)
      setError(errorText(e, '这份清单没接受成，一条合作都没建。'))
    },
  })

  return (
    <Card data-testid="kol-tools">
      <CardHeader>
        <CardTitle className="text-sm">{t('kol.tools.title')}</CardTitle>
      </CardHeader>
      <CardContent className="flex flex-col gap-4 text-sm">
        {/* WP489：导入红人表（Excel / CSV / 在线表格链接，先预览再导）+ 用过往邮件更新阶段 */}
        <KolSheetImport assignment={assignment} />

        <section data-testid="kol-campaign">
          <h4 className="mb-1 text-xs font-medium text-muted-foreground">
            {t('kol.campaign.title')}
          </h4>
          <div className="flex flex-wrap items-center gap-2">
            <Input
              className="min-w-40 flex-1"
              value={goal}
              placeholder={t('kol.campaign.goal')}
              data-testid="kol-campaign-goal"
              onChange={(e) => {
                setGoal(e.target.value)
              }}
            />
            <Input
              className="w-24"
              value={budget}
              inputMode="numeric"
              aria-label={t('kol.campaign.budget')}
              data-testid="kol-campaign-budget"
              onChange={(e) => {
                setBudget(e.target.value)
              }}
            />
            <Input
              className="w-20"
              value={headcount}
              inputMode="numeric"
              aria-label={t('kol.campaign.headcount')}
              data-testid="kol-campaign-headcount"
              onChange={(e) => {
                setHeadcount(e.target.value)
              }}
            />
            <Button
              size="sm"
              data-testid="kol-campaign-go"
              disabled={goal.trim() === '' || channels.length === 0 || doPlan.isPending}
              onClick={() => {
                doPlan.mutate()
              }}
            >
              {t('kol.campaign.plan')}
            </Button>
          </div>
          <div className="mt-1 flex flex-wrap items-center gap-1">
            {ALL_CHANNELS.map((c) => (
              <Button
                key={c}
                size="xs"
                variant={channels.includes(c) ? 'secondary' : 'ghost'}
                aria-pressed={channels.includes(c)}
                data-testid="kol-campaign-channel"
                data-channel={c}
                onClick={() => {
                  setChannels((prev) =>
                    prev.includes(c) ? prev.filter((x) => x !== c) : [...prev, c],
                  )
                }}
              >
                {t(`kol.channel.${c}`)}
              </Button>
            ))}
          </div>
          <KolError error={error} testid="kol-campaign-error" />
          <KolReceipt text={receipt} testid="kol-campaign-receipt" />
          {allExisting === undefined ? null : (
            <div className="mt-1 flex flex-col gap-1.5" data-testid="kol-campaign-receipt">
              <p className="text-xs text-muted-foreground">
                {t('kol.campaign.all_existing', { n: allExisting })}
              </p>
              <div className="flex flex-wrap gap-2">
                <Button
                  size="xs"
                  variant="outline"
                  data-testid="kol-campaign-go-threads"
                  onClick={() => {
                    goView('threads')
                  }}
                >
                  {t('kol.campaign.go_threads')}
                </Button>
                <Button
                  size="xs"
                  variant="ghost"
                  data-testid="kol-campaign-go-pool"
                  onClick={() => {
                    goView('pool')
                  }}
                >
                  {t('kol.campaign.find_more')}
                </Button>
              </div>
            </div>
          )}
          {plan === undefined ? null : (
            <div className="mt-2 flex flex-col gap-2" data-testid="kol-campaign-plan">
              {plan.ready ? null : <p className="text-xs text-destructive">{plan.message}</p>}
              <CampaignShortfall
                plan={plan}
                want={Number(headcount)}
                onImport={() => {
                  // WP489：导入口子在 `KolSheetImport` 里（同一张卡上）
                  document
                    .querySelector<HTMLInputElement>('[data-testid="kol-import-file"]')
                    ?.click()
                }}
              />
              {plan.by_channel.map((group) => (
                <div
                  key={group.channel}
                  className={group.allowed ? '' : 'opacity-50'}
                  data-testid="kol-campaign-group"
                  data-channel={group.channel}
                  data-allowed={String(group.allowed)}
                >
                  <div className="text-xs font-medium">
                    {t(`kol.channel.${group.channel}`)} · {group.picks.length}
                  </div>
                  {/* 灰着的东西要说得出为什么（05 §4：一次 campaign 不并集权限） */}
                  {group.reason === undefined ? null : (
                    <p className="text-xs text-muted-foreground" data-testid="kol-campaign-why">
                      {group.reason}
                    </p>
                  )}
                  <ul className="text-xs text-muted-foreground">
                    {group.picks.map((p) => (
                      <li
                        key={p.creator_id}
                        data-testid="kol-campaign-pick"
                        data-already={p.already}
                      >
                        {p.display_name} · {t('kol.score', { n: p.score })}
                        {p.why[0] === undefined ? '' : ` · ${p.why[0]}`}
                        {/* WP142：已经在合作里的当场标出来——接受时不会再建 */}
                        {p.already ? ` · ${t('kol.campaign.already')}` : ''}
                      </li>
                    ))}
                  </ul>
                </div>
              ))}
              {plan.approval_item_id === undefined ? null : (
                <div>
                  <Button
                    size="sm"
                    data-testid="kol-campaign-accept"
                    disabled={doAccept.isPending}
                    onClick={() => {
                      doAccept.mutate(plan.approval_item_id as string)
                    }}
                  >
                    {t('kol.campaign.accept')}
                  </Button>
                </div>
              )}
            </div>
          )}
        </section>
      </CardContent>
    </Card>
  )
}

/**
 * WP142（docs/78 第 17 步）：清单**不够数**时说一句为什么、给两个动作。
 *
 * 「要 5 个出了 2 个」以前没人提，接受完才发现没几个人。现在清单一出来就说：
 * 想要几个、库里合适的只有几个（其中几个已经在合作里），想要更多人就导入一张表
 * 或者关联官方数据接口。
 */
function CampaignShortfall({
  plan,
  want,
  onImport,
}: {
  plan: KolCampaignData
  want: number
  onImport: () => void
}): React.ReactNode {
  const { t } = useApp()
  const picks = plan.by_channel.filter((g) => g.allowed).flatMap((g) => g.picks)
  const fresh = picks.filter((p) => !p.already).length
  const already = picks.length - fresh
  if (!Number.isFinite(want) || want <= 0 || fresh >= want) return null
  return (
    <div
      className="flex flex-col gap-1.5 rounded-md border border-dashed p-2"
      data-testid="kol-campaign-short"
    >
      <p className="text-xs text-muted-foreground">
        {t('kol.campaign.short', { want, n: picks.length })}
        {already === 0 ? '' : ` ${t('kol.campaign.short.already', { n: already })}`}
      </p>
      <div className="flex flex-wrap gap-2">
        <Button
          size="xs"
          variant="outline"
          data-testid="kol-campaign-short-import"
          onClick={onImport}
        >
          <Upload className="size-3" aria-hidden />
          {t('kol.campaign.short.import')}
        </Button>
        <Button asChild size="xs" variant="ghost" data-testid="kol-campaign-short-link">
          <Link to="/settings/credits">{t('kol.campaign.short.link')}</Link>
        </Button>
      </div>
    </div>
  )
}

/* ── 岗位页上那一块：三个子视图 ───────────────────────────────────────── */

/**
 * 66 断点 #10：以前导入、campaign、找人、合作、红人库、漏斗、交付物、归因
 * **全挤在「面板」tab 的一长条里**，没有"一件事的界面"这种东西。
 *
 * 现在切成三个子视图，切分的依据是**红人营销干活时脑子里的三个阶段**，
 * 不是接口的分组：
 *
 * | 视图 | 这一阶段在想什么 |
 * |---|---|
 * | 候选池 | 还没定人：找、导、看资料、加联系方式、起第一封信 |
 * | 活动 | 定了一批人：出清单、接受、按渠道分组 |
 * | 合作线程 | 定了一个人：这条合作到哪一步了，交付物验没验，链接带来多少单 |
 *
 * 为什么是岗位页里的子视图而不是三条路由：这三样都只对"当前这条渠道职责"
 * 有意义，离开这个岗位它们没有独立存在的理由（对照 `/chat` 那条真路由——
 * 在线聊天试用场确实是一件独立的事）。子视图的状态跟着 `?kol=` 走，
 * 与岗位页 `?tab=` 同一套，刷新与分享链接都还在原地。
 */
const SUBVIEWS = [
  { id: 'pool', zh: '候选池', icon: Search },
  { id: 'campaign', zh: '活动', icon: Megaphone },
  { id: 'threads', zh: '合作线程', icon: Users },
] as const

type SubviewId = (typeof SUBVIEWS)[number]['id']

export function KolPanel({
  assignment,
  channel,
  /** WP119c：深链 ?creator= 带进来的人（已是 creator_id），进面板就点开。 */
  initialOpenCreator,
  /** WP119c：深链默认落在哪个子视图（/influencer/setup → 'campaign'）。 */
  defaultSubview,
}: {
  assignment: string
  channel: KolChannelId
  initialOpenCreator?: string
  defaultSubview?: SubviewId
}): React.ReactNode {
  const [search, setSearch] = useSearchParams()
  const raw = search.get('kol') ?? defaultSubview ?? 'pool'
  const view: SubviewId = SUBVIEWS.some((v) => v.id === raw) ? (raw as SubviewId) : 'pool'
  /**
   * 点开的那一个人（候选池里）。WP500：平常开在第三栏（{@link openCreatorPane}）；这里只记
   * 「开不出第三栏时就地画」与「我自己已经在第三栏里、叠一层」那两种。
   */
  const inPane = useInRightPane()
  const [openCreator, setOpenCreator] = useState<string | undefined>(
    inPane ? initialOpenCreator : undefined,
  )
  const openDetail = (id: string): void => {
    if (inPane || !openCreatorPane({ assignment, channel, id })) setOpenCreator(id)
  }
  // WP119c 深链 ?creator= 带进来的人：进面板就点开（第三栏开不出来就就地画）
  const deepLinked = useRef(false)
  useEffect(() => {
    if (deepLinked.current || inPane || initialOpenCreator === undefined) return
    deepLinked.current = true
    if (!openCreatorPane({ assignment, channel, id: initialOpenCreator }))
      setOpenCreator(initialOpenCreator)
  }, [assignment, channel, inPane, initialOpenCreator])
  /** 点开的那一条合作（合作线程里）。 */
  const [openCollab, setOpenCollab] = useState<string | undefined>(undefined)
  /** WP131：插件深链 `?batch=` 带来的采集批次（候选池只列这一批）。 */
  const batch = search.get('batch') ?? undefined
  const clearBatch = (): void => {
    setSearch((prev) => {
      const params = new URLSearchParams(prev)
      params.delete('batch')
      return params
    })
  }

  const go = (next: SubviewId): void => {
    setSearch((prev) => {
      const params = new URLSearchParams(prev)
      params.set('kol', next)
      return params
    })
  }

  return (
    <div className="flex flex-col gap-4" data-testid="kol-panel" data-channel={channel}>
      {/* 演练开关 + 状态带：三个视图共用一条，永远在最上面 */}
      <KolSandboxBar assignment={assignment} channel={channel} />
      {/* WP428（决策 1244 改）：够条件后可以交给 AI 全自动（开着 / 够条件了才出这一条） */}
      <AutopilotStrip assignment={assignment} />

      <nav className="flex flex-wrap items-center gap-1" data-testid="kol-subviews">
        {SUBVIEWS.map((v) => (
          <Button
            key={v.id}
            size="sm"
            variant={v.id === view ? 'secondary' : 'ghost'}
            aria-pressed={v.id === view}
            data-testid="kol-subview"
            data-view={v.id}
            onClick={() => {
              go(v.id)
            }}
          >
            <v.icon className="size-4" aria-hidden />
            {v.zh}
          </Button>
        ))}
      </nav>

      {view === 'pool' ? (
        <>
          {/* 已经在第三栏里时，详情叠在候选池上面（← 返回），不去换掉第三栏自己 */}
          {inPane && openCreator !== undefined ? null : (
            <Discovery
              assignment={assignment}
              channel={channel}
              onOpen={openDetail}
              onThread={(collab) => {
                setOpenCollab(collab)
                go('threads')
              }}
              {...(batch === undefined || batch === '' ? {} : { batch, onClearBatch: clearBatch })}
            />
          )}
          {openCreator === undefined ? null : (
            <CreatorDetailView
              key={openCreator}
              assignment={assignment}
              channel={channel}
              id={openCreator}
              onBack={() => {
                setOpenCreator(undefined)
              }}
              onRepoint={setOpenCreator}
            />
          )}
        </>
      ) : null}

      {view === 'campaign' ? <ImportAndCampaign assignment={assignment} channel={channel} /> : null}

      {view === 'threads' ? (
        openCollab === undefined ? (
          <Collaborations assignment={assignment} channel={channel} onOpen={setOpenCollab} />
        ) : (
          <CollabThread
            assignment={assignment}
            channel={channel}
            id={openCollab}
            onBack={() => {
              setOpenCollab(undefined)
            }}
          />
        )
      ) : null}
    </div>
  )
}
