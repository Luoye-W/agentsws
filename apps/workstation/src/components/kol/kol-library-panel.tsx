/**
 * WP504（决策 1765、1777 A、1778 A、1761 A，设计稿 F1 / F2 / F3）：**红人库**——红人营销岗位第三栏「本岗位」组的库面板。
 *
 * 原来是整页 `/influencer/creators`（`KolPanel` 的候选池 / 活动 / 合作线程三个子视图）；现在照「资料在右、决策在中」
 * 搬进第三栏：红人 / 活动 / 合作三格（1778 A），多选 + 吸顶批量条（1777 A：发开发信出中栏确认卡，其余当场生效可撤销），
 * 点一个人详情**叠在库上**（1761 A：← 回来筛选、勾选、滚动位置都在），卡角悬停 ✦ 问 AI（1775 A）。
 *
 * 用的全是通用件（`components/library/library-kit.tsx`），这里只管红人这一种资料：怎么取、卡长什么样、
 * 批量动作各调哪个接口、一张卡交给 AI 时带哪几格。
 *
 * 面板不跟页面所在的岗位走（`scoped` 不标）：中栏卡里点红人名、旧地址跳过来，在哪一页都开得出——
 * 它自己去找本人名下的红人职责；一条都没有时照实说「还没有红人营销岗位」。
 */
import { useQuery, useQueryClient } from '@tanstack/react-query'
import {
  Ban,
  Download,
  Megaphone,
  Package,
  Search,
  Send,
  Tag,
  Upload,
  UserRound,
} from 'lucide-react'
import { type ReactNode, useEffect, useMemo, useRef, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { AskAiButton, AskAiSections } from '@/components/ask-ai/ask-ai'
import type { ContextRef } from '@/components/ask-ai/ask-ai-store'
import { registerRefSource } from '@/components/ask-ai/ref-sources'
import { AutopilotStrip } from '@/components/autopilot/autopilot-strip'
import { EmptyState, Segmented } from '@/components/design'
import { FilterChip, LibrarySearch } from '@/components/library/library-group'
import {
  consumeLibraryIntent,
  openLibrary,
  useLibraryIntent,
} from '@/components/library/library-intent'
import {
  BatchBar,
  HEAD_ICON,
  ItemCheck,
  type LibraryAction,
  type LibraryActionResult,
  LibraryHead,
  LibraryItemFrame,
  type LibraryLayer,
  LibraryStack,
  LibraryToasts,
  MultiToggle,
  useRunLibraryAction,
  useSelection,
} from '@/components/library/library-kit'
import { parsePositionPath } from '@/components/rail/rail-scope'
import type { RailCardBodyProps, RailPanelBodyProps } from '@/components/rail/registry'
import { requestCardJump } from '@/components/reports/position-bridge'
import { Skeleton } from '@/components/ui/skeleton'
import {
  batchKolOutreach,
  draftKolOutreach,
  getKolCollaborations,
  getKolCreators,
  getKolOutreachDefaults,
  getPositions,
  type KolChannelId,
  type KolCreatorRowData,
  type KolReviewFilter,
  reviewKolCreator,
  setKolCreatorTags,
} from '@/lib/api'
import { useApp } from '@/lib/app-context'
import { cn } from '@/lib/utils'
import { CollabThread } from './collab-thread'
import { CreatorCard, stepOpensThread } from './creator-card'
import { CreatorDetailView } from './creator-pane'
import { ALL_CHANNELS, atHandle } from './kol-channel'
import { KOL_LIBRARY, kolHomeOf, useKolCardHome } from './kol-library-status'
import { Collaborations, channelOfRole, Discovery, ImportAndCampaign } from './kol-panel'
import { KolSandboxBar } from './kol-sandbox-bar'
import { refreshCards } from './kol-shared'

export { KOL_LIBRARY, KOL_POSITION } from './kol-library-status'

export type KolTab = 'creators' | 'campaign' | 'collab'

/** 旧子视图名 / 地址参数 → 三格之一。 */
export function kolTabOf(raw: string | undefined): KolTab | undefined {
  if (raw === 'creators' || raw === 'pool') return 'creators'
  if (raw === 'campaign' || raw === 'setup') return 'campaign'
  if (raw === 'collab' || raw === 'threads') return 'collab'
  return undefined
}

/** 在谈的那几段（卡片列「在谈」那一行数它）。 */
const TALKING = new Set([
  'contacted',
  'replied',
  'negotiating',
  'agreed',
  'sample_sent',
  'delivering',
])

const WEEK_MS = 7 * 24 * 3600 * 1000

/** 卡片列那张「红人库」卡上的三个数（纯函数）。 */
export function kolSummary(
  rows: readonly KolCreatorRowData[],
  now: number = Date.now(),
): { total: number; talking: number; pending: number; fresh: number } {
  return {
    total: rows.length,
    talking: rows.filter((r) => r.collab !== undefined && TALKING.has(r.collab.stage)).length,
    pending: rows.filter((r) => r.review === undefined && r.blocked === undefined).length,
    fresh: rows.filter((r) => now - Date.parse(r.observed_at) < WEEK_MS).length,
  }
}

const num = (n: number | undefined): string =>
  n === undefined
    ? '—'
    : n >= 1_000_000
      ? `${(n / 1_000_000).toFixed(1)}M`
      : n >= 10_000
        ? `${Math.round(n / 1000)}k`
        : String(n)

/**
 * 一个红人 → 交给 AI 的引用小卡（1775 A：结构化摘要，不是截图）。纯函数，测试用。
 */
export function creatorRef(
  row: KolCreatorRowData,
  t: (k: string, v?: Record<string, string | number>) => string,
): ContextRef {
  const facts = [
    { k: t('kol.lib.fact.handle'), v: atHandle(row.handle) },
    { k: t('kol.lib.fact.channel'), v: t(`kol.channel.${row.channel}`) },
    { k: t('kol.lib.fact.score'), v: row.blocked === undefined ? String(row.score) : '—' },
    { k: t('kol.lib.fact.followers'), v: num(row.followers) },
    {
      k: t('kol.lib.fact.engagement'),
      v:
        row.engagement_judgement === undefined
          ? row.engagement_rate === undefined
            ? ''
            : `${row.engagement_rate}%`
          : `${row.engagement_judgement.value}%（同量级中位 ${row.engagement_judgement.median}%）`,
    },
    { k: t('kol.lib.fact.category'), v: row.category ?? '' },
    {
      k: t('kol.lib.fact.stage'),
      v: row.collab === undefined ? '' : t(`kol.stage.${row.collab.stage}`),
    },
    {
      k: t('kol.lib.fact.review'),
      v:
        row.review === undefined
          ? t('kol.lib.act.pending')
          : t(`kol.review.${row.review.decision}`),
    },
    { k: t('kol.lib.fact.tags'), v: (row.tags ?? []).join('、') },
    {
      k: t('kol.lib.fact.contact'),
      v: row.has_contact ? t('kol.lib.fact.contact.yes') : t('kol.lib.fact.contact.no'),
    },
    ...(row.blocked === undefined ? [] : [{ k: t('kol.lib.fact.blocked'), v: row.blocked }]),
    ...(row.factors ?? [])
      .filter((f) => f.why !== undefined && f.unknown !== true)
      .map((f) => ({ k: `${t('kol.lib.fact.score')} · ${f.id}`, v: `${f.score} · ${f.why}` })),
  ]
  const scored = row.blocked === undefined
  return {
    kind: 'creator',
    id: row.creator_id,
    label: row.display_name,
    sub: scored ? t('kol.lib.ref.sub', { score: row.score }) : t('kol.lib.ref.sub.noscore'),
    initial: row.display_name.slice(0, 1).toUpperCase(),
    facts,
    suggestions: [
      scored ? t('kol.lib.suggest.why', { score: row.score }) : t('kol.lib.suggest.why.noscore'),
      t('kol.lib.suggest.draft'),
      t('kol.lib.suggest.compare'),
    ],
  }
}

/** 选中的几个人 → 一张 CSV（导出）。纯函数。 */
export function creatorsCsv(rows: readonly KolCreatorRowData[]): string {
  const cell = (v: string | number | undefined): string => {
    const s = v === undefined ? '' : String(v)
    return /[",\n]/u.test(s) ? `"${s.replace(/"/gu, '""')}"` : s
  }
  const head = [
    'name',
    'channel',
    'handle',
    'url',
    'followers',
    'engagement',
    'category',
    'score',
    'tags',
  ]
  const lines = rows.map((r) =>
    [
      r.display_name,
      r.channel,
      atHandle(r.handle),
      r.url,
      r.followers,
      r.engagement_judgement?.value ?? r.engagement_rate,
      r.category,
      r.blocked === undefined ? r.score : '',
      (r.tags ?? []).join(' / '),
    ]
      .map(cell)
      .join(','),
  )
  return [head.join(','), ...lines].join('\n')
}

function download(name: string, text: string): void {
  const blob = new Blob([`﻿${text}`], { type: 'text/csv;charset=utf-8' })
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = name
  a.click()
  URL.revokeObjectURL(url)
}

/* ── 面板 ─────────────────────────────────────────────────────────── */

type Layer = { kind: 'creator'; id: string } | { kind: 'thread'; id: string } | { kind: 'find' }

export function KolLibraryPanel(props: RailPanelBodyProps): ReactNode {
  const { t, lang } = useApp()
  const positions = useQuery({ queryKey: ['positions'], queryFn: getPositions })
  const home = kolHomeOf(positions.data, lang)
  const intent = useLibraryIntent(KOL_LIBRARY)
  // 本页岗位里那几条渠道排前面（同一个人可能在两个岗位都有红人职责——少见，但先用眼前这个）
  const here = new Set((props.scope?.roles ?? []).map((r) => r.assignment))
  const ordered = [...home.channels].sort(
    (a, b) => Number(here.has(b.assignment)) - Number(here.has(a.assignment)),
  )
  const [channel, setChannel] = useState<KolChannelId | undefined>(undefined)
  const wanted = intent?.params?.channel
  // 深链 / 中栏点名带来的渠道记下来（intent 用掉之后也停在这条渠道）
  useEffect(() => {
    const hit = ALL_CHANNELS.find((c) => c === wanted)
    if (hit !== undefined) setChannel(hit)
  }, [wanted])
  const picked = ordered.find((c) => c.channel === (channel ?? wanted)) ?? ordered[0]

  if (positions.isPending)
    return (
      <div className="flex flex-col gap-2" data-testid="kol-library-loading">
        <Skeleton className="h-8 w-full" />
        <Skeleton className="h-40 w-full" />
      </div>
    )
  if (picked === undefined)
    return <EmptyState data-testid="kol-library-no-position" text={t('influencer.empty')} />
  return (
    <LibraryToasts>
      <KolLibraryBody
        key={picked.assignment}
        assignment={picked.assignment}
        channel={picked.channel}
        channels={ordered.map((c) => c.channel)}
        onChannel={setChannel}
        where={home.name}
        pathname={props.pathname}
      />
    </LibraryToasts>
  )
}

function KolLibraryBody({
  assignment,
  channel,
  channels,
  onChannel,
  where,
  pathname,
}: {
  assignment: string
  channel: KolChannelId
  channels: readonly KolChannelId[]
  onChannel: (c: KolChannelId) => void
  where: string | undefined
  pathname: string
}): ReactNode {
  const { t } = useApp()
  const navigate = useNavigate()
  const client = useQueryClient()
  const run = useRunLibraryAction()
  const [tab, setTab] = useState<KolTab>('creators')
  const [layer, setLayer] = useState<Layer | null>(null)
  const selection = useSelection()
  // 筛选（全部留在这一格里：叠一层再回来还在）
  const [q, setQ] = useState('')
  const [review, setReview] = useState<KolReviewFilter | 'all'>('all')
  const [tag, setTag] = useState('')
  const [top, setTop] = useState(false)
  const [batch, setBatch] = useState<string | undefined>(undefined)
  const [sort, setSort] = useState<'score' | 'followers' | 'new'>('score')
  /** 「移入活动」带过去的那批人。 */
  const [named, setNamed] = useState<{ creator_id: string; display_name: string }[]>([])
  /** 只为解析深链里的 handle：要整库那一份。 */
  const all = useQuery({
    queryKey: ['kol-creators', assignment, channel],
    queryFn: () => getKolCreators({ channel }, assignment),
  })
  const list = useQuery({
    queryKey: ['kol-creators', assignment, channel, 'library', batch ?? '', q, review, tag],
    queryFn: () =>
      getKolCreators(
        {
          channel,
          ...(batch === undefined ? {} : { batch }),
          ...(q.trim() === '' ? {} : { q: q.trim() }),
          ...(review === 'all' ? {} : { review }),
          ...(tag === '' ? {} : { tag }),
        },
        assignment,
      ),
    placeholderData: (prev) => prev,
  })
  const collabs = useQuery({
    queryKey: ['kol-collaborations', assignment, channel],
    queryFn: () => getKolCollaborations({ channel }, assignment),
  })

  // 旧地址 / 中栏点红人名带来的：开到哪一格、叠开谁、带什么筛
  const intent = useLibraryIntent(KOL_LIBRARY)
  const allRows = all.data?.rows
  useEffect(() => {
    if (intent === undefined) return
    const p = intent.params ?? {}
    // 深链的 `creator` 可能是 handle 也可能是 id：等整库那一份到了再认
    const raw = intent.item ?? p.creator
    if (raw !== undefined && allRows === undefined) return
    const next = kolTabOf(intent.tab)
    if (next !== undefined) setTab(next)
    if (p.batch !== undefined && p.batch !== '') {
      setBatch(p.batch)
      setTab('creators')
    }
    if (p.review === 'pending' || p.review === 'approved' || p.review === 'rejected')
      setReview(p.review)
    if (p.fresh === '1') setSort('new')
    if (raw !== undefined) {
      const needle = raw.trim().toLowerCase()
      const hit =
        (allRows ?? []).find((r) => r.creator_id.toLowerCase() === needle) ??
        (allRows ?? []).find(
          (r) => r.handle.replace(/^@+/u, '').toLowerCase() === needle.replace(/^@+/u, ''),
        )
      // 认不出就当没给——库照常开（比报错有用）；认得出的是 id 就直接叠开
      const id = hit?.creator_id ?? (intent.item !== undefined ? intent.item : undefined)
      if (id !== undefined) {
        setTab('creators')
        setLayer({ kind: 'creator', id })
      }
    }
    consumeLibraryIntent(KOL_LIBRARY, intent.nonce)
  }, [intent, allRows])

  // ✦ / 拖 / @：输入框里能搜到这个库的人
  const allRef = useRef(allRows)
  allRef.current = allRows
  useEffect(
    () =>
      registerRefSource({
        id: 'kol-creators',
        search: async (needle, lang) => {
          const rows =
            needle.trim() === ''
              ? (allRef.current ?? [])
              : (await getKolCreators({ channel, q: needle.trim() }, assignment)).rows
          return rows.map((r) => ({
            ref: creatorRef(r, t),
            type: lang === 'en' ? 'Creator' : '红人',
          }))
        },
      }),
    [assignment, channel, t],
  )

  const rows = useMemo(() => {
    const base = (list.data?.rows ?? []).filter(
      (r) => !top || (r.blocked === undefined && r.score >= 80),
    )
    const by = [...base]
    if (sort === 'score')
      by.sort(
        (a, b) =>
          (b.blocked === undefined ? b.score : -1) - (a.blocked === undefined ? a.score : -1),
      )
    else if (sort === 'followers') by.sort((a, b) => (b.followers ?? 0) - (a.followers ?? 0))
    else by.sort((a, b) => Date.parse(b.observed_at) - Date.parse(a.observed_at))
    return by
  }, [list.data?.rows, top, sort])
  const rowById = new Map(
    [...(allRows ?? []), ...(list.data?.rows ?? [])].map((r) => [r.creator_id, r]),
  )
  const refOf = (id: string): ContextRef => {
    const row = rowById.get(id)
    return row === undefined ? { kind: 'creator', id, label: id, facts: [] } : creatorRef(row, t)
  }
  const pagePosition = parsePositionPath(pathname)
  /** 页面上没有输入框时（不在岗位页）：去红人营销岗位，小卡在框里等着。 */
  const fallback = (): void => {
    void navigate(`/positions/${encodeURIComponent(assignment)}`)
  }
  /** 「去看」：中栏「要你处理」翻到那张卡（不在红人营销岗位页就先去）。 */
  const gotoCard = (card: string): void => {
    const target = pagePosition ?? assignment
    if (pagePosition === undefined) void navigate(`/positions/${encodeURIComponent(assignment)}`)
    requestCardJump(target, card)
  }
  const refresh = (): void => {
    void client.invalidateQueries({ queryKey: ['kol-creators'] })
    void client.invalidateQueries({ queryKey: ['kol-creator'] })
  }
  const namesOf = (ids: readonly string[]): { creator_id: string; display_name: string }[] =>
    ids.map((id) => ({ creator_id: id, display_name: rowById.get(id)?.display_name ?? id }))

  /* ── 动作（批量条与详情同一份，1777 A） ── */
  const reviewAction = (
    decision: 'approved' | 'rejected' | 'pending',
    id: string,
    label: string,
    icon: ReactNode,
    toast: string,
  ): LibraryAction => ({
    id,
    label,
    icon,
    kind: 'instant',
    ...(decision === 'rejected' ? { danger: true } : {}),
    run: async (ids) => {
      const before = ids.map((cid) => ({ cid, prev: rowById.get(cid)?.review }))
      await Promise.all(ids.map((cid) => reviewKolCreator(cid, { decision }, assignment)))
      refresh()
      return {
        text: t(toast, { n: ids.length }),
        undo: async () => {
          await Promise.all(
            before.map(({ cid, prev }) =>
              reviewKolCreator(
                cid,
                prev === undefined
                  ? { decision: 'pending' }
                  : {
                      decision: prev.decision,
                      ...(prev.reason === undefined ? {} : { reason: prev.reason }),
                    },
                assignment,
              ),
            ),
          )
          refresh()
        },
      }
    },
  })
  const tagAction: LibraryAction = {
    id: 'tag',
    label: t('kol.lib.act.tag'),
    icon: <Tag aria-hidden className="size-3.5" />,
    kind: 'instant',
    ask: { placeholder: t('kol.lib.act.tag.prompt'), go: t('kol.lib.act.tag.go') },
    run: async (ids, input) => {
      const name = (input ?? '').trim()
      if (name === '') return undefined
      const before = ids.map((cid) => ({ cid, prev: rowById.get(cid)?.tags ?? [] }))
      await Promise.all(
        before.map(({ cid, prev }) =>
          prev.some((x) => x.toLowerCase() === name.toLowerCase())
            ? Promise.resolve()
            : setKolCreatorTags(cid, [...prev, name], assignment),
        ),
      )
      refresh()
      return {
        text: t('kol.lib.toast.tag', { n: ids.length, tag: name }),
        undo: async () => {
          await Promise.all(before.map(({ cid, prev }) => setKolCreatorTags(cid, prev, assignment)))
          refresh()
        },
      }
    },
  }
  const campaignAction: LibraryAction = {
    id: 'campaign',
    label: t('kol.lib.act.campaign'),
    icon: <Megaphone aria-hidden className="size-3.5" />,
    kind: 'instant',
    run: async (ids) => {
      // 只是把这批人带到「活动」那一格当清单范围——真建合作照旧是清单卡（在中栏批）
      setNamed(namesOf(ids))
      setLayer(null)
      setTab('campaign')
      return { text: t('kol.lib.toast.campaign', { n: ids.length }) }
    },
  }
  const outreachAction: LibraryAction = {
    id: 'outreach',
    label: t('kol.lib.act.outreach'),
    icon: <Send aria-hidden className="size-3.5" />,
    kind: 'confirm',
    run: async (ids): Promise<LibraryActionResult> => {
      const out = await batchKolOutreach({ channel, creator_ids: [...ids] }, assignment)
      refresh()
      refreshCards(client)
      if (!out.ok || out.approval_item_id === undefined)
        return {
          text: t('kol.lib.toast.outreach.fail', { why: out.message ?? '' }),
          error: true,
        }
      const card = out.approval_item_id
      return {
        text: t('kol.lib.toast.outreach', { n: ids.length }),
        goto: () => {
          gotoCard(card)
        },
      }
    },
  }
  const exportAction: LibraryAction = {
    id: 'export',
    label: t('kol.lib.export'),
    icon: <Download aria-hidden className="size-3.5" />,
    kind: 'instant',
    run: async (ids) => {
      const picked = ids.flatMap((id) => {
        const r = rowById.get(id)
        return r === undefined ? [] : [r]
      })
      download(`creators-${channel}.csv`, creatorsCsv(picked))
      return { text: t('kol.lib.toast.export', { n: picked.length }) }
    },
  }
  const rejectAction = reviewAction(
    'rejected',
    'reject',
    t('kol.lib.act.reject'),
    <Ban aria-hidden className="size-3.5" />,
    'kol.lib.toast.reject',
  )
  const batchActions: LibraryAction[] = [
    tagAction,
    campaignAction,
    outreachAction,
    exportAction,
    rejectAction,
  ]

  /* ── 叠的那一层 ── */
  const layerOf = (): LibraryLayer | null => {
    if (layer === null) return null
    if (layer.kind === 'find')
      return {
        key: 'find',
        title: t('kol.lib.find'),
        node: (
          <Discovery
            assignment={assignment}
            channel={channel}
            searchOnly
            onOpen={(id) => {
              setLayer({ kind: 'creator', id })
            }}
            onThread={(id) => {
              setLayer({ kind: 'thread', id })
            }}
          />
        ),
      }
    if (layer.kind === 'thread')
      return {
        key: `thread:${layer.id}`,
        title:
          rowById.get(collabs.data?.rows.find((c) => c.id === layer.id)?.creator_id ?? '')
            ?.display_name ?? t('kol.lib.tab.collab'),
        node: (
          <CollabThread
            assignment={assignment}
            channel={channel}
            id={layer.id}
            onBack={() => {
              setLayer(null)
            }}
          />
        ),
      }
    const id = layer.id
    const row = rowById.get(id)
    return {
      key: `creator:${id}`,
      title: row?.display_name ?? '',
      actions: (
        <AskAiButton inline refs={() => [refOf(id)]} fallback={fallback} testId="kol-detail-ask" />
      ),
      node: (
        <div className="flex flex-col gap-3" data-ask-ai-source="">
          <CreatorActions
            id={id}
            row={row}
            draft={async () => {
              const defaults = await getKolOutreachDefaults(assignment)
              if (defaults.product.trim() === '')
                return { text: t('kol.lib.draft.no_product'), error: true }
              const out = await draftKolOutreach(
                { creator_id: id, channel, product: defaults.product },
                assignment,
              )
              refresh()
              refreshCards(client)
              if (!out.staged || out.approval_item_id === undefined)
                return { text: out.message ?? t('kol.lib.draft.failed'), error: true }
              const card = out.approval_item_id
              return {
                text: t('kol.lib.toast.draft'),
                goto: () => {
                  gotoCard(card)
                },
              }
            }}
            sample={() => {
              if (row?.collab !== undefined) setLayer({ kind: 'thread', id: row.collab.id })
            }}
            campaign={campaignAction}
            tag={tagAction}
            review={(d) =>
              reviewAction(
                d,
                `review-${d}`,
                t(
                  `kol.lib.act.${d === 'approved' ? 'approve' : d === 'rejected' ? 'reject' : 'pending'}`,
                ),
                null,
                `kol.lib.toast.${d === 'approved' ? 'approve' : d === 'rejected' ? 'reject' : 'pending'}`,
              )
            }
            run={run}
          />
          <AskAiSections base={() => refOf(id)} fallback={fallback}>
            <CreatorDetailView
              assignment={assignment}
              channel={channel}
              id={id}
              onRepoint={(next) => {
                setLayer({ kind: 'creator', id: next })
              }}
            />
          </AskAiSections>
        </div>
      ),
    }
  }

  const counts = {
    creators: all.data?.rows.length,
    collab: (collabs.data?.rows ?? []).filter((c) => c.stage !== 'closed').length,
  }
  const tags = [
    ...new Set([...(list.data?.tags ?? all.data?.tags ?? []), ...(tag === '' ? [] : [tag])]),
  ]

  const head = (
    <LibraryHead
      icon={<UserRound aria-hidden className="size-4" />}
      title={t('rail.panel.kol-library')}
      where={where}
      actions={
        <button
          type="button"
          className={HEAD_ICON}
          aria-label={t('kol.lib.import')}
          title={t('kol.lib.import')}
          data-testid="kol-library-import"
          onClick={() => {
            setLayer(null)
            setTab('campaign')
          }}
        >
          <Upload aria-hidden className="size-4" />
        </button>
      }
      menu={[
        {
          id: 'find',
          label: t('kol.lib.find'),
          icon: <Search aria-hidden className="size-4" />,
          onSelect: () => {
            setLayer({ kind: 'find' })
          },
        },
        {
          id: 'export',
          label: t('kol.lib.export'),
          icon: <Download aria-hidden className="size-4" />,
          onSelect: () => {
            download(`creators-${channel}.csv`, creatorsCsv(rows))
          },
        },
      ]}
    />
  )

  return (
    <div
      className="@container flex flex-col gap-3"
      data-testid="kol-library"
      data-channel={channel}
    >
      <LibraryStack
        rootTitle={t('rail.panel.kol-library')}
        head={head}
        layer={layerOf()}
        onBack={() => {
          setLayer(null)
        }}
      >
        <div className="flex items-center gap-2">
          <Segmented<KolTab>
            kind="tabs"
            size="sm"
            label={t('rail.panel.kol-library')}
            value={tab}
            testId="kol-library-tabs"
            onChange={(next) => {
              setTab(next)
              selection.setOn(false)
            }}
            options={[
              {
                value: 'creators',
                label: t('kol.lib.tab.creators'),
                ...(counts.creators === undefined ? {} : { count: counts.creators }),
                testId: 'kol-library-tab-creators',
              },
              {
                value: 'campaign',
                label: t('kol.lib.tab.campaign'),
                testId: 'kol-library-tab-campaign',
              },
              {
                value: 'collab',
                label: t('kol.lib.tab.collab'),
                count: counts.collab,
                testId: 'kol-library-tab-collab',
              },
            ]}
          />
          <span className="flex-1" />
          {tab === 'creators' ? <MultiToggle selection={selection} /> : null}
        </div>

        {tab === 'creators' ? (
          <>
            <LibrarySearch
              value={q}
              onChange={setQ}
              testId="kol-library-search"
              placeholder={t('kol.lib.search')}
              wide
            />
            <div className="flex flex-wrap items-center gap-1.5" data-testid="kol-library-filters">
              {channels.length > 1 ? (
                <select
                  value={channel}
                  aria-label={t('kol.lib.channel')}
                  data-testid="kol-library-channel"
                  className={SELECT}
                  onChange={(e) => {
                    onChannel(e.target.value as KolChannelId)
                  }}
                >
                  {ALL_CHANNELS.filter((c) => channels.includes(c)).map((c) => (
                    <option key={c} value={c}>
                      {t(`kol.channel.${c}`)}
                    </option>
                  ))}
                </select>
              ) : (
                <span className="inline-flex h-7 items-center rounded-full border border-ws-line px-2.5 text-xs text-ws-body">
                  {t(`kol.channel.${channel}`)}
                </span>
              )}
              <FilterChip
                active={top}
                testId="kol-library-top"
                onClick={() => {
                  setTop(!top)
                }}
              >
                {t('kol.lib.score80')}
              </FilterChip>
              <select
                value={review}
                aria-label={t('kol.lib.fact.review')}
                data-testid="kol-library-review"
                className={SELECT}
                onChange={(e) => {
                  setReview(e.target.value as KolReviewFilter | 'all')
                }}
              >
                {(['all', 'pending', 'approved', 'rejected'] as const).map((r) => (
                  <option key={r} value={r}>
                    {t(`kol.pool.review.${r}`)}
                  </option>
                ))}
              </select>
              {tags.length === 0 ? null : (
                <select
                  value={tag}
                  aria-label={t('kol.pool.tag')}
                  data-testid="kol-library-tag"
                  className={SELECT}
                  onChange={(e) => {
                    setTag(e.target.value)
                  }}
                >
                  <option value="">{t('kol.pool.tag.all')}</option>
                  {tags.map((x) => (
                    <option key={x} value={x}>
                      {x}
                    </option>
                  ))}
                </select>
              )}
              {batch === undefined ? null : (
                <FilterChip
                  active
                  testId="kol-library-batch"
                  onClick={() => {
                    setBatch(undefined)
                  }}
                >
                  {t('kol.lib.batch')} ×
                </FilterChip>
              )}
              <span className="flex-1" />
              <select
                value={sort}
                aria-label={t('kol.lib.sort')}
                data-testid="kol-library-sort"
                className={cn(SELECT, 'border-transparent')}
                onChange={(e) => {
                  setSort(e.target.value as 'score' | 'followers' | 'new')
                }}
              >
                <option value="score">{t('kol.lib.sort')}</option>
                <option value="followers">{t('kol.lib.sort.followers')}</option>
                <option value="new">{t('kol.lib.sort.new')}</option>
              </select>
            </div>
            <BatchBar
              selection={selection}
              actions={batchActions}
              visible={rows.map((r) => r.creator_id)}
              refsOf={(ids) => ids.map(refOf)}
              fallback={fallback}
            />
            {list.isPending ? <Skeleton className="h-40 w-full" /> : null}
            {!list.isPending && rows.length === 0 ? (
              <p className="text-sm text-ws-muted-fg" data-testid="kol-library-empty">
                {q !== '' || review !== 'all' || tag !== '' || top || batch !== undefined
                  ? t('kol.pool.filtered.empty')
                  : t('kol.library.empty')}
              </p>
            ) : null}
            <ol
              className="grid grid-cols-1 gap-2.5 @[34rem]:grid-cols-2 @[56rem]:grid-cols-3"
              data-testid="kol-library-grid"
            >
              {rows.map((row) => (
                <LibraryItemFrame
                  key={row.creator_id}
                  id={row.creator_id}
                  name={row.display_name}
                  selection={selection}
                  refOf={() => creatorRef(row, t)}
                  fallback={fallback}
                >
                  <CreatorCard
                    as="div"
                    row={row}
                    handle={atHandle(row.handle)}
                    assignment={assignment}
                    {...(selection.on
                      ? {
                          leading: (
                            <ItemCheck
                              id={row.creator_id}
                              name={row.display_name}
                              selection={selection}
                            />
                          ),
                        }
                      : {})}
                    onOpen={() => {
                      if (selection.on) selection.toggle(row.creator_id)
                      else setLayer({ kind: 'creator', id: row.creator_id })
                    }}
                    onNext={(step) => {
                      if (stepOpensThread(step) && row.collab !== undefined)
                        setLayer({ kind: 'thread', id: row.collab.id })
                      else setLayer({ kind: 'creator', id: row.creator_id })
                    }}
                  />
                </LibraryItemFrame>
              ))}
            </ol>
          </>
        ) : null}

        {tab === 'campaign' ? (
          <div className="flex flex-col gap-3">
            <KolSandboxBar assignment={assignment} channel={channel} />
            <AutopilotStrip assignment={assignment} />
            <ImportAndCampaign
              assignment={assignment}
              channel={channel}
              named={named}
              onClearNamed={() => {
                setNamed([])
              }}
              onGo={(v) => {
                setTab(v === 'threads' ? 'collab' : 'creators')
              }}
            />
          </div>
        ) : null}

        {tab === 'collab' ? (
          <Collaborations
            assignment={assignment}
            channel={channel}
            onOpen={(id) => {
              setLayer({ kind: 'thread', id })
            }}
          />
        ) : null}
      </LibraryStack>
    </div>
  )
}

const SELECT =
  'h-7 rounded-full border border-ws-line bg-ws-card px-2 text-xs text-ws-body outline-none hover:bg-ws-hover focus-visible:border-ws-brand'

/**
 * 详情头上那一排（F2）：起草开发信、寄样——出中栏决策卡（1777 A）；移入活动、加标签、通过 / 淘汰 / 待审——就地生效可撤销。
 */
function CreatorActions({
  id,
  row,
  draft,
  sample,
  campaign,
  tag,
  review,
  run,
}: {
  id: string
  row: KolCreatorRowData | undefined
  draft: () => Promise<LibraryActionResult>
  sample: () => void
  campaign: LibraryAction
  tag: LibraryAction
  review: (d: 'approved' | 'rejected' | 'pending') => LibraryAction
  run: (a: LibraryAction, ids: readonly string[], input?: string) => Promise<boolean>
}): ReactNode {
  const { t } = useApp()
  const [tagging, setTagging] = useState(false)
  const [tagText, setTagText] = useState('')
  const [busy, setBusy] = useState(false)
  const canSample =
    row?.collab !== undefined &&
    ['agreed', 'sample_sent', 'delivering', 'delivered'].includes(row.collab.stage)
  const decision = row?.review?.decision ?? 'pending'
  const btn =
    'inline-flex h-7 shrink-0 items-center gap-1 rounded-md px-2.5 text-xs font-medium disabled:opacity-50'
  return (
    <div className="flex flex-col gap-2" data-testid="kol-detail-actions">
      <div className="flex flex-wrap items-center gap-1.5">
        <button
          type="button"
          disabled={busy}
          data-testid="kol-detail-draft"
          data-kind="confirm"
          className={cn(btn, 'bg-ws-brand text-ws-brand-fg hover:opacity-90')}
          onClick={() => {
            setBusy(true)
            void run(
              {
                id: 'draft',
                label: '',
                kind: 'confirm',
                icon: <Send aria-hidden className="size-3.5" />,
                run: draft,
              },
              [id],
            ).then(() => {
              setBusy(false)
            })
          }}
        >
          <Send aria-hidden className="size-3.5" />
          {t('kol.lib.act.draft')}
        </button>
        <button
          type="button"
          disabled={!canSample}
          title={canSample ? undefined : t('kol.lib.act.sample.none')}
          data-testid="kol-detail-sample"
          data-kind="confirm"
          className={cn(btn, 'bg-ws-surface text-ws-body hover:bg-ws-hover')}
          onClick={sample}
        >
          <Package aria-hidden className="size-3.5" />
          {t('kol.lib.act.sample')}
        </button>
        <button
          type="button"
          data-testid="kol-detail-campaign"
          data-kind="instant"
          className={cn(btn, 'bg-ws-surface text-ws-body hover:bg-ws-hover')}
          onClick={() => {
            void run(campaign, [id])
          }}
        >
          <Megaphone aria-hidden className="size-3.5" />
          {t('kol.lib.act.campaign')}
        </button>
        <button
          type="button"
          aria-expanded={tagging}
          data-testid="kol-detail-tag"
          data-kind="instant"
          className={cn(btn, 'bg-ws-surface text-ws-body hover:bg-ws-hover')}
          onClick={() => {
            setTagging(!tagging)
          }}
        >
          <Tag aria-hidden className="size-3.5" />
          {t('kol.lib.act.tag')}
        </button>
        <span className="flex-1" />
        <Segmented<'approved' | 'rejected' | 'pending'>
          size="sm"
          label={t('kol.lib.fact.review')}
          value={decision}
          testId="kol-detail-review"
          onChange={(d) => {
            void run(review(d), [id])
          }}
          options={[
            {
              value: 'approved',
              label: t('kol.lib.act.approve'),
              testId: 'kol-detail-review-approved',
            },
            {
              value: 'rejected',
              label: t('kol.lib.act.reject'),
              testId: 'kol-detail-review-rejected',
            },
            {
              value: 'pending',
              label: t('kol.lib.act.pending'),
              testId: 'kol-detail-review-pending',
            },
          ]}
        />
      </div>
      {tagging ? (
        <form
          className="flex items-center gap-1.5"
          onSubmit={(e) => {
            e.preventDefault()
            const value = tagText.trim()
            if (value === '') return
            setTagging(false)
            setTagText('')
            void run(tag, [id], value)
          }}
        >
          <input
            // biome-ignore lint/a11y/noAutofocus: 点了「加标签」就是要马上打字
            autoFocus
            value={tagText}
            maxLength={40}
            placeholder={t('kol.lib.act.tag.prompt')}
            aria-label={t('kol.lib.act.tag.prompt')}
            data-testid="kol-detail-tag-field"
            className="h-7 min-w-0 flex-1 rounded-md border border-ws-line bg-ws-card px-2 text-xs outline-none focus-visible:border-ws-brand"
            onChange={(e) => {
              setTagText(e.target.value)
            }}
          />
          <button
            type="submit"
            disabled={tagText.trim() === ''}
            className={cn(btn, 'bg-ws-brand text-ws-brand-fg')}
          >
            {t('kol.lib.act.tag.go')}
          </button>
        </form>
      ) : null}
    </div>
  )
}

/* ── 卡片列那张「红人库」卡（1778 A） ── */

/** 卡身体：在谈 / 待审 / 本周新收三行，点一行在第三栏开库并筛好。 */
export function KolLibraryCard(props: RailCardBodyProps): ReactNode {
  const { t } = useApp()
  const assignment = useKolCardHome(props)
  const rows = useQuery({
    queryKey: ['kol-creators', assignment ?? '', 'all-channels'],
    queryFn: () => getKolCreators({}, assignment),
    enabled: assignment !== undefined,
  })
  const sum = kolSummary(rows.data?.rows ?? [])
  const line = (
    id: string,
    label: string,
    n: number,
    dot: string,
    params: Record<string, string>,
  ): ReactNode => (
    <li key={id}>
      <button
        type="button"
        data-testid={`kol-library-card-${id}`}
        className="flex h-8 w-full items-center gap-2 rounded-md px-2 text-left text-[13px] hover:bg-ws-hover"
        onClick={() => {
          openLibrary(KOL_LIBRARY, { tab: 'creators', params })
        }}
      >
        <i aria-hidden className={cn('size-1.5 shrink-0 rounded-full', dot)} />
        <span className="min-w-0 flex-1 truncate text-ws-body">{label}</span>
        <span className="ws-num text-xs text-ws-muted-fg">{n}</span>
      </button>
    </li>
  )
  return (
    <ul className="flex flex-col" data-testid="kol-library-card">
      {line('talking', t('rail.card.kol-library.talking'), sum.talking, 'bg-ws-info', {})}
      {line('pending', t('rail.card.kol-library.pending'), sum.pending, 'bg-ws-warn', {
        review: 'pending',
      })}
      {line('new', t('rail.card.kol-library.new'), sum.fresh, 'bg-ws-faint', { fresh: '1' })}
    </ul>
  )
}
