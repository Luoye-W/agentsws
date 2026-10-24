/**
 * WP504（决策 1765、1778 A、1779 A，设计稿 F6）：**知识库**——客服岗位第三栏「本岗位」组的库面板；
 * B2B、网站运营用同一个面板、默认按本岗位筛（`knowledgeGroupsForPosition`，一个筛选签，可去掉）。
 *
 * 原来是整页 `/knowledge`（WP56 / WP209 / WP488）；搬进来之后：
 * - 公共 / 售前 / 售后三格（WP488），按类型分组、每条带状态（WP209 那一套原样用）；
 * - 「要复核 N」只是一个**筛选签**——复核本身是中栏「要你处理」里的卡（WP488 的过期卡），这里不定；
 * - 导入 / 导出 / 上传收进面板头的 ↑ 与 ⋯；从邮件学、不能说的话、答不上来的、要补的边界、这一层看得见什么——
 *   在 ⋯ 里，点了**叠一层**（← 回来筛选都在）；
 * - 每条悬停 ✦ 问 AI（1775 A）、多选后可批量停用（就地生效、可撤销，1777 A）。
 *
 * 通用件全在 `components/library/library-kit.tsx`，这里只管知识这一种资料。
 */
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import {
  ArrowRightLeft,
  BookOpen,
  Download,
  Eye,
  FileText,
  GraduationCap,
  MessageCircleQuestion,
  ShieldAlert,
  Trash2,
  Upload,
  UploadCloud,
} from 'lucide-react'
import { type DragEvent, type ReactNode, useEffect, useRef, useState } from 'react'
import { type ContextRef, REF_MIME } from '@/components/ask-ai/ask-ai-store'
import { registerRefSource } from '@/components/ask-ai/ref-sources'
import { Segmented, WsCard, WsTag } from '@/components/design'
import { ClaimRulesSection } from '@/components/knowledge/claim-rules'
import { GapRow } from '@/components/knowledge/gap-row'
import { LearnPanel } from '@/components/knowledge/learn-panel'
import { KnowledgeRow } from '@/components/library/knowledge-groups'
import { FilterChip, LibraryGroup, LibrarySearch } from '@/components/library/library-group'
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
  LibraryHead,
  LibraryItemFrame,
  type LibraryLayer,
  LibraryStack,
  LibraryToasts,
  MultiToggle,
  useSelection,
} from '@/components/library/library-kit'
import {
  fileAddress,
  isLegacyOfficeFile,
  officeKindOf,
} from '@/components/rail/panels/office/address'
import type { RailScope } from '@/components/rail/rail-scope'
import { useRailState } from '@/components/rail/rail-state'
import type { RailCardBodyProps, RailPanelBodyProps } from '@/components/rail/registry'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Hint } from '@/components/ui/hint'
import { Skeleton } from '@/components/ui/skeleton'
import {
  answerKnowledgeGap,
  deleteKnowledgeSource,
  exportKnowledgePack,
  getKnowledgeSourceFile,
  getPositions,
  importKnowledgePack,
  type KnowledgeCardRow,
  type KnowledgePackImportResult,
  type KnowledgeSource,
  type KnowledgeStageId,
  listKnowledgeBoundaries,
  listKnowledgeCards,
  listKnowledgeGaps,
  listKnowledgeRechecks,
  listKnowledgeSources,
  listRangeGroups,
  setKnowledgeCardStage,
  UPLOAD_ACCEPT,
  UPLOAD_EXTENSIONS,
  UPLOAD_MAX_BYTES,
  uploadKnowledgeSource,
} from '@/lib/api'
import { useApp } from '@/lib/app-context'
import {
  countByStatus,
  filterKnowledge,
  groupKnowledge,
  KNOWLEDGE_GROUPS,
  KNOWLEDGE_STATUSES,
  type KnowledgeGroupId,
  type KnowledgeStatus,
  knowledgeGroupOf,
  knowledgeGroupsForPosition,
  knowledgeOriginOf,
  knowledgeStatusOf,
  SCOPE_ALL,
  SCOPE_GENERAL,
  scopeLabel,
  scopeOptions,
} from '@/lib/library'
import { useMode } from '@/lib/mode'
import { cn } from '@/lib/utils'
import { KNOWLEDGE_LIBRARY, KNOWLEDGE_POSITIONS, positionOf } from './knowledge-library-status'

export { KNOWLEDGE_LIBRARY, KNOWLEDGE_POSITIONS } from './knowledge-library-status'

function nameOfSource(source: Pick<KnowledgeSource, 'ref' | 'filename'>): string {
  if (source.filename !== undefined && source.filename !== '') return source.filename
  const parts = source.ref.split(/[/\\]/)
  return parts[parts.length - 1] ?? source.ref
}

interface UploadItem {
  name: string
  state: 'waiting' | 'sending' | 'done' | 'failed'
  error?: string
}

/** 一条知识 → 交给 AI 的引用小卡（结构化摘要）。纯函数，测试用。 */
export function knowledgeRef(
  card: KnowledgeCardRow,
  t: (k: string, v?: Record<string, string | number>) => string,
): ContextRef {
  const status = knowledgeStatusOf(card)
  const label = card.statement.replace(/^#\s*/u, '').split('\n')[0]?.slice(0, 60) ?? card.id
  return {
    kind: 'knowledge',
    id: card.id,
    label,
    sub: t('kl.lib.ref.kind'),
    initial: '知',
    facts: [
      { k: t('kl.lib.fact.statement'), v: card.statement },
      { k: t('kl.lib.fact.group'), v: t(`knowledge.group.${knowledgeGroupOf(card)}`) },
      { k: t('kl.lib.fact.status'), v: t(`knowledge.status.${status}`) },
      { k: t('kl.lib.fact.stage'), v: t(`kl.tab.${card.stage ?? 'both'}`) },
      { k: t('kl.lib.fact.source'), v: t(`knowledge.origin.${knowledgeOriginOf(card)}`) },
      { k: t('kl.lib.fact.updated'), v: card.updated_at.slice(0, 10) },
    ],
    suggestions: [
      t('kl.lib.suggest.explain'),
      t('kl.lib.suggest.check'),
      t('kl.lib.suggest.reply'),
    ],
  }
}

type Layer = 'learn' | 'claims' | 'gaps' | 'boundaries' | 'scope'

export function KnowledgeLibraryPanel(props: RailPanelBodyProps): ReactNode {
  return (
    <LibraryToasts>
      <KnowledgeLibraryBody {...props} />
    </LibraryToasts>
  )
}

function KnowledgeLibraryBody({ scope }: RailPanelBodyProps): ReactNode {
  const { t, lang } = useApp()
  const { t: tm } = useMode()
  const client = useQueryClient()
  const rail = useRailState()
  const fileInput = useRef<HTMLInputElement>(null)
  const uploadInput = useRef<HTMLInputElement>(null)
  const selection = useSelection()
  const [layer, setLayer] = useState<Layer | null>(null)
  const [imported, setImported] = useState<KnowledgePackImportResult | null>(null)
  const [failed, setFailed] = useState<string | null>(null)
  const [queue, setQueue] = useState<UploadItem[]>([])
  const [dragging, setDragging] = useState(false)
  const [busy, setBusy] = useState(false)
  const [query, setQuery] = useState('')
  const [scopeFilter, setScopeFilter] = useState<string>(SCOPE_ALL)
  const [status, setStatus] = useState<KnowledgeStatus | 'all'>('all')
  const [stageTab, setStageTab] = useState<KnowledgeStageId>('both')
  const [recheckOnly, setRecheckOnly] = useState(false)
  // 1779 A：B2B / 网站运营进来默认只看本岗位用的那几类（一个筛选签，去掉就是整库）
  const here = positionOf(scope)
  const narrowable =
    here !== undefined && here !== 'customer-care' && KNOWLEDGE_POSITIONS.includes(here)
  const [narrow, setNarrow] = useState(narrowable)

  const positions = useQuery({ queryKey: ['positions'], queryFn: getPositions })
  const home = positions.data?.instances?.find((i) => i.position_id === (here ?? 'customer-care'))
  const where = home === undefined ? scope?.name : lang === 'en' ? home.name.en : home.name.zh

  const cards = useQuery({ queryKey: ['knowledge-cards'], queryFn: () => listKnowledgeCards() })
  const rechecks = useQuery({
    queryKey: ['knowledge-rechecks'],
    queryFn: () => listKnowledgeRechecks(),
  })
  const gaps = useQuery({ queryKey: ['knowledge-gaps'], queryFn: () => listKnowledgeGaps() })
  const boundaries = useQuery({
    queryKey: ['knowledge-boundaries'],
    queryFn: () => listKnowledgeBoundaries(),
    enabled: layer === 'boundaries',
  })
  const sources = useQuery({
    queryKey: ['knowledge-sources'],
    queryFn: () => listKnowledgeSources(),
  })
  const rangeGroups = useQuery({
    queryKey: ['knowledge-range-groups'],
    queryFn: () => listRangeGroups(),
    retry: false,
  })

  // 旧地址 / 卡片列那张卡带来的：开到哪一格、要不要只看要复核
  const intent = useLibraryIntent(KNOWLEDGE_LIBRARY)
  useEffect(() => {
    if (intent === undefined) return
    const tab = intent.tab
    if (tab === 'both' || tab === 'presales' || tab === 'postsales') setStageTab(tab)
    if (intent.params?.recheck === '1') setRecheckOnly(true)
    if (intent.params?.layer === 'gaps') setLayer('gaps')
    consumeLibraryIntent(KNOWLEDGE_LIBRARY, intent.nonce)
  }, [intent])

  // `@` 能搜到知识条目
  const cardsRef = useRef(cards.data)
  cardsRef.current = cards.data
  useEffect(
    () =>
      registerRefSource({
        id: 'knowledge',
        search: async (needle, l) => {
          const all = cardsRef.current ?? (await listKnowledgeCards())
          return filterKnowledge(all, { query: needle })
            .filter((c) => c.status !== 'retired')
            .slice(0, 8)
            .map((c) => ({ ref: knowledgeRef(c, t), type: l === 'en' ? 'Knowledge' : '知识' }))
        },
      }),
    [t],
  )

  const refresh = (): void => {
    void client.invalidateQueries({ queryKey: ['knowledge-cards'] })
    void client.invalidateQueries({ queryKey: ['knowledge-rechecks'] })
    void client.invalidateQueries({ queryKey: ['knowledge-gaps'] })
  }
  const refreshSources = (): Promise<void> =>
    client.invalidateQueries({ queryKey: ['knowledge-sources'] })

  const precheck = (file: File): string | undefined => {
    const dot = file.name.lastIndexOf('.')
    const ext = dot < 0 ? '' : file.name.slice(dot + 1).toLowerCase()
    if (!(UPLOAD_EXTENSIONS as readonly string[]).includes(ext))
      return t('knowledge.upload.bad_kind', { kinds: UPLOAD_EXTENSIONS.join(' / ') })
    if (file.size === 0) return t('knowledge.upload.empty')
    if (file.size > UPLOAD_MAX_BYTES)
      return t('knowledge.upload.too_large', { limit: Math.floor(UPLOAD_MAX_BYTES / 1024 / 1024) })
    return undefined
  }

  /** 一份一份传（WP99：哪一份没上去、为什么，要分得开）。 */
  const upload = async (files: readonly File[]): Promise<void> => {
    if (files.length === 0) return
    const start = queue.length
    setQueue((prev) => [
      ...prev,
      ...files.map((f) => ({ name: f.name, state: 'waiting' as const })),
    ])
    setBusy(true)
    const patch = (i: number, next: Partial<UploadItem>): void => {
      setQueue((prev) => prev.map((it, k) => (k === start + i ? { ...it, ...next } : it)))
    }
    for (const [i, file] of files.entries()) {
      const bad = precheck(file)
      if (bad !== undefined) {
        patch(i, { state: 'failed', error: bad })
        continue
      }
      patch(i, { state: 'sending' })
      try {
        await uploadKnowledgeSource(file)
        patch(i, { state: 'done' })
        await refreshSources()
      } catch (e: unknown) {
        patch(i, { state: 'failed', error: e instanceof Error ? e.message : String(e) })
      }
    }
    setBusy(false)
  }

  const remove = useMutation({
    mutationFn: (id: string) => deleteKnowledgeSource(id),
    onSuccess: () => {
      void refreshSources()
    },
  })
  const answer = useMutation({
    mutationFn: (input: { id: string; answer: string }) =>
      answerKnowledgeGap(input.id, input.answer),
    onSuccess: refresh,
  })
  const doImport = useMutation({
    mutationFn: (file: File) => importKnowledgePack(file),
    onSuccess: (result) => {
      setImported(result)
      setFailed(null)
      refresh()
    },
    onError: (e: unknown) => {
      setFailed(e instanceof Error ? e.message : String(e))
    },
  })
  const doExport = async (): Promise<void> => {
    const blob = await exportKnowledgePack()
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = 'knowledge-pack.zip'
    a.click()
    URL.revokeObjectURL(url)
  }
  const openFile = (source_id: string, name: string): void => {
    if (rail.openAddress(fileAddress(source_id, name))) return
    void (async () => {
      const got = await getKnowledgeSourceFile(source_id, { limit: Number.POSITIVE_INFINITY })
      if (got.blob === undefined) return
      const url = URL.createObjectURL(got.blob)
      const a = document.createElement('a')
      a.href = url
      a.download = got.filename === '' ? name : got.filename
      a.click()
      URL.revokeObjectURL(url)
    })()
  }

  /* ── 列表 ── */
  const uploads = (sources.data ?? []).filter((s) => s.kind === 'upload')
  const everyCard = cards.data ?? []
  const stageOf = (c: { stage?: KnowledgeStageId }): KnowledgeStageId => c.stage ?? 'both'
  const live = everyCard.filter((c) => c.status !== 'retired')
  const stageCounts = {
    both: live.filter((c) => stageOf(c) === 'both').length,
    presales: live.filter((c) => stageOf(c) === 'presales').length,
    postsales: live.filter((c) => stageOf(c) === 'postsales').length,
  }
  const openRechecks = (rechecks.data ?? []).filter((r) => r.status === 'open')
  const recheckIds = new Set(openRechecks.map((r) => r.card_id))
  const groupsHere: KnowledgeGroupId[] = narrow
    ? knowledgeGroupsForPosition(here)
    : [...KNOWLEDGE_GROUPS]
  const inTab = everyCard
    .filter((c) => stageOf(c) === stageTab)
    .filter((c) => groupsHere.includes(knowledgeGroupOf(c)))
    .filter((c) => !recheckOnly || recheckIds.has(c.id))
  const filtering =
    query.trim() !== '' || scopeFilter !== SCOPE_ALL || status !== 'all' || recheckOnly
  const shownCards = filterKnowledge(inTab, { query, scope: scopeFilter, status })
  const statusCounts = countByStatus(filterKnowledge(inTab, { query, scope: scopeFilter }))
  const scopes = scopeOptions(inTab)
  const scopeName = (ref: { kind: string; id: string }): string =>
    scopeLabel(ref, rangeGroups.data ?? [], tm)
  const shownUploads =
    status !== 'all' ||
    scopeFilter !== SCOPE_ALL ||
    stageTab !== 'both' ||
    recheckOnly ||
    !groupsHere.includes('uploads')
      ? []
      : uploads.filter((u) => nameOfSource(u).toLowerCase().includes(query.trim().toLowerCase()))
  const byId = new Map(everyCard.map((c) => [c.id, c]))
  const refOf = (id: string): ContextRef => {
    const c = byId.get(id)
    return c === undefined ? { kind: 'knowledge', id, label: id, facts: [] } : knowledgeRef(c, t)
  }

  /** 批量：移到公共 / 售前 / 售后（当场生效，撤销 = 各回原来那一格，1777 A）。 */
  const moveTo = (stage: KnowledgeStageId): LibraryAction => ({
    id: `stage-${stage}`,
    label: t('kl.lib.act.move', { tab: t(`kl.tab.${stage}`) }),
    icon: <ArrowRightLeft aria-hidden className="size-3.5" />,
    kind: 'instant',
    disabled: stage === stageTab,
    run: async (ids) => {
      const before = ids.map((id) => ({ id, prev: stageOf(byId.get(id) ?? {}) }))
      await Promise.all(ids.map((id) => setKnowledgeCardStage(id, stage)))
      refresh()
      return {
        text: t('kl.lib.toast.move', { n: ids.length, tab: t(`kl.tab.${stage}`) }),
        undo: async () => {
          await Promise.all(before.map((b) => setKnowledgeCardStage(b.id, b.prev)))
          refresh()
        },
      }
    },
  })

  const groups = groupKnowledge(shownCards)
  const list = cards.isLoading ? (
    <Skeleton className="h-24 w-full" />
  ) : shownCards.length === 0 && shownUploads.length === 0 ? (
    filtering ? (
      <p className="text-sm text-ws-muted-fg" data-testid="knowledge-no-match">
        {t('library.no_match')}
      </p>
    ) : null
  ) : (
    <div className="flex flex-col gap-4" data-testid="knowledge-groups">
      {KNOWLEDGE_GROUPS.map((id) => {
        if (id === 'uploads') {
          if (shownUploads.length === 0) return null
          return (
            <LibraryGroup
              key={id}
              id={id}
              title={t('knowledge.group.uploads')}
              count={shownUploads.length}
              forceOpen={filtering}
            >
              <ul className="flex flex-col gap-2 text-sm">
                {shownUploads.map((source) => {
                  const name = nameOfSource(source)
                  const previewable = officeKindOf(name) !== undefined
                  const legacy = !previewable && isLegacyOfficeFile(name)
                  return (
                    <li key={source.id}>
                      <WsCard className="flex items-center gap-1 p-0">
                        <button
                          type="button"
                          className="flex min-w-0 flex-1 items-center gap-2 px-3 py-2.5 text-left"
                          data-testid={`knowledge-source-${source.id}`}
                          onClick={() => {
                            openFile(source.id, name)
                          }}
                        >
                          <FileText aria-hidden className="size-4 shrink-0 text-ws-muted-fg" />
                          <span className="min-w-0 flex-1 truncate">{name}</span>
                          <WsTag>
                            {previewable
                              ? t('knowledge.sources.preview')
                              : legacy
                                ? t('knowledge.sources.legacy_only')
                                : t('knowledge.sources.download_only')}
                          </WsTag>
                        </button>
                        <Button
                          size="sm"
                          variant="ghost"
                          className="mr-1 shrink-0"
                          disabled={remove.isPending}
                          aria-label={t('knowledge.sources.remove')}
                          data-testid={`knowledge-source-remove-${source.id}`}
                          onClick={() => {
                            remove.mutate(source.id)
                          }}
                        >
                          <Trash2 aria-hidden className="size-4" />
                        </Button>
                      </WsCard>
                    </li>
                  )
                })}
              </ul>
            </LibraryGroup>
          )
        }
        const group = groups.find((g) => g.id === id)
        if (group === undefined) return null
        return (
          <LibraryGroup
            key={id}
            id={id}
            title={t(`knowledge.group.${id}`)}
            count={group.cards.length}
            forceOpen={filtering}
          >
            <ul className="ws-card flex flex-col divide-y divide-ws-line px-3">
              {group.cards.map((c) => (
                <LibraryItemFrame
                  key={c.id}
                  id={c.id}
                  name={c.statement.slice(0, 40)}
                  selection={selection}
                  refOf={() => knowledgeRef(c, t)}
                  className="rounded-none"
                >
                  <div className="flex min-w-0 items-start gap-2">
                    {selection.on ? (
                      <span className="pt-3">
                        <ItemCheck
                          id={c.id}
                          name={c.statement.slice(0, 40)}
                          selection={selection}
                        />
                      </span>
                    ) : null}
                    <ul className="min-w-0 flex-1">
                      <KnowledgeRow card={c} scopeName={scopeName} />
                    </ul>
                    {recheckIds.has(c.id) ? (
                      <span className="shrink-0 pt-2.5" data-testid="knowledge-recheck-mark">
                        <WsTag className="text-ws-warn">{t('kl.lib.recheck.mark')}</WsTag>
                      </span>
                    ) : null}
                  </div>
                </LibraryItemFrame>
              ))}
            </ul>
          </LibraryGroup>
        )
      })}
    </div>
  )

  const layerOf = (): LibraryLayer | null => {
    if (layer === null) return null
    const titles: Record<Layer, string> = {
      learn: t('kl.lib.learn'),
      claims: t('kl.lib.claims'),
      gaps: t('kl.lib.gaps'),
      boundaries: t('kl.lib.boundaries'),
      scope: t('kl.lib.scope'),
    }
    const node = ((): ReactNode => {
      switch (layer) {
        case 'learn':
          return <LearnPanel />
        case 'claims':
          return <ClaimRulesSection />
        case 'gaps':
          return (gaps.data ?? []).length === 0 ? (
            <p className="text-sm text-muted-foreground">{t('knowledge.gaps.empty')}</p>
          ) : (
            <ul data-testid="knowledge-gaps">
              {(gaps.data ?? []).map((gap) => (
                <GapRow
                  key={gap.id}
                  gap={gap}
                  busy={answer.isPending}
                  onAnswer={(text) => {
                    answer.mutate({ id: gap.id, answer: text })
                  }}
                />
              ))}
            </ul>
          )
        case 'boundaries':
          return (
            <div className="flex flex-col gap-2" data-testid="knowledge-boundaries">
              <p className="text-xs text-muted-foreground">{t('knowledge.boundaries.note')}</p>
              <ul className="divide-y text-sm">
                {(boundaries.data ?? []).map((b) => (
                  <li key={b.id} className="flex items-center gap-2 py-2">
                    <span className="min-w-0 flex-1 truncate">{b.label}</span>
                    <Badge variant={b.answered ? 'secondary' : 'outline'}>
                      {b.answered
                        ? t('knowledge.boundaries.answered')
                        : t('knowledge.boundaries.open')}
                    </Badge>
                  </li>
                ))}
              </ul>
            </div>
          )
        case 'scope':
          return scope === undefined ? null : <ScopeKnowledge scope={scope} />
      }
    })()
    return { key: layer, title: titles[layer], node }
  }

  const head = (
    <LibraryHead
      icon={<BookOpen aria-hidden className="size-4" />}
      title={t('rail.panel.knowledge-library')}
      where={where}
      actions={
        <button
          type="button"
          className={HEAD_ICON}
          aria-label={t('library.upload')}
          title={t('library.upload')}
          data-testid="knowledge-upload"
          disabled={busy}
          onClick={() => uploadInput.current?.click()}
        >
          <Upload aria-hidden className="size-4" />
        </button>
      }
      menu={[
        {
          id: 'import',
          label: t('kl.lib.import'),
          icon: <Upload aria-hidden className="size-4" />,
          onSelect: () => fileInput.current?.click(),
        },
        {
          id: 'export',
          label: t('kl.lib.export'),
          icon: <Download aria-hidden className="size-4" />,
          onSelect: () => {
            void doExport()
          },
        },
        {
          id: 'learn',
          label: t('kl.lib.learn'),
          icon: <GraduationCap aria-hidden className="size-4" />,
          onSelect: () => {
            setLayer('learn')
          },
        },
        {
          id: 'gaps',
          label: `${t('kl.lib.gaps')}${(gaps.data ?? []).length === 0 ? '' : ` ${(gaps.data ?? []).length}`}`,
          icon: <MessageCircleQuestion aria-hidden className="size-4" />,
          onSelect: () => {
            setLayer('gaps')
          },
        },
        {
          id: 'claims',
          label: t('kl.lib.claims'),
          icon: <ShieldAlert aria-hidden className="size-4" />,
          onSelect: () => {
            setLayer('claims')
          },
        },
        {
          id: 'boundaries',
          label: t('kl.lib.boundaries'),
          icon: <BookOpen aria-hidden className="size-4" />,
          onSelect: () => {
            setLayer('boundaries')
          },
        },
        ...(scope === undefined
          ? []
          : [
              {
                id: 'scope',
                label: t('kl.lib.scope'),
                icon: <Eye aria-hidden className="size-4" />,
                onSelect: () => {
                  setLayer('scope')
                },
              },
            ]),
      ]}
    />
  )

  /** 拖的是一张库里的卡（要进输入框的），不是文件——这一块不接。 */
  const isRef = (e: DragEvent<HTMLDivElement>): boolean =>
    [...(e.dataTransfer?.types ?? [])].includes(REF_MIME)
  const onDrop = (e: DragEvent<HTMLDivElement>): void => {
    if (isRef(e)) return
    e.preventDefault()
    setDragging(false)
    void upload([...(e.dataTransfer?.files ?? [])])
  }

  return (
    <div className="flex flex-col gap-3" data-testid="knowledge-library-panel">
      <input
        ref={fileInput}
        type="file"
        accept=".zip"
        className="hidden"
        data-testid="knowledge-import-input"
        onChange={(e) => {
          const file = e.target.files?.[0]
          if (file !== undefined) doImport.mutate(file)
          e.target.value = ''
        }}
      />
      <input
        ref={uploadInput}
        type="file"
        multiple
        accept={UPLOAD_ACCEPT}
        className="hidden"
        data-testid="knowledge-upload-input"
        onChange={(e) => {
          void upload([...(e.target.files ?? [])])
          e.target.value = ''
        }}
      />
      <LibraryStack
        rootTitle={t('rail.panel.knowledge-library')}
        head={head}
        layer={layerOf()}
        onBack={() => {
          setLayer(null)
        }}
      >
        <section className="flex flex-col gap-3" data-testid="knowledge-library">
          <div className="flex items-center gap-1">
            <Segmented<KnowledgeStageId>
              kind="tabs"
              size="sm"
              label={t('kl.stage.label')}
              value={stageTab}
              testId="knowledge-stage-tabs"
              onChange={setStageTab}
              options={(['both', 'presales', 'postsales'] as const).map((v) => ({
                value: v,
                label: t(`kl.tab.${v}`),
                count: stageCounts[v],
                testId: `knowledge-stage-${v}`,
              }))}
            />
            <Hint text={t('kl.tabs.hint')} />
            <span className="flex-1" />
            <MultiToggle selection={selection} />
          </div>
          <LibrarySearch
            value={query}
            onChange={setQuery}
            testId="knowledge-search"
            placeholder={t('kl.lib.search')}
            wide
          />
          <div className="flex flex-wrap items-center gap-1.5" data-testid="knowledge-toolbar">
            {scopes.length === 0 ? null : (
              <select
                value={scopeFilter}
                data-testid="knowledge-scope"
                aria-label={t('knowledge.scope.label')}
                className="h-7 rounded-full border border-ws-line bg-ws-card px-2 text-xs text-ws-body"
                onChange={(e) => {
                  setScopeFilter(e.target.value)
                }}
              >
                <option value={SCOPE_ALL}>{t('knowledge.scope.all')}</option>
                <option value={SCOPE_GENERAL}>{t('knowledge.scope.general')}</option>
                {scopes.map((ref) => (
                  <option key={`${ref.kind}:${ref.id}`} value={`${ref.kind}:${ref.id}`}>
                    {scopeName(ref)}
                  </option>
                ))}
              </select>
            )}
            {narrowable ? (
              <FilterChip
                active={narrow}
                testId="knowledge-position-filter"
                onClick={() => {
                  setNarrow(!narrow)
                }}
              >
                {t('kl.lib.position', { name: where ?? '' })}
              </FilterChip>
            ) : null}
            {/* 要复核只是筛选——复核本身是中栏「要你处理」里的卡（F6） */}
            {openRechecks.length === 0 && !recheckOnly ? null : (
              <FilterChip
                active={recheckOnly}
                testId="knowledge-recheck-filter"
                onClick={() => {
                  setRecheckOnly(!recheckOnly)
                }}
              >
                {t('kl.lib.recheck', { n: openRechecks.length })}
              </FilterChip>
            )}
          </div>
          <div className="flex flex-wrap gap-1.5" data-testid="knowledge-status-filter">
            <FilterChip
              active={status === 'all'}
              testId="knowledge-status-all"
              onClick={() => {
                setStatus('all')
              }}
            >
              {t('knowledge.status.all')}
            </FilterChip>
            {KNOWLEDGE_STATUSES.map((s) => (
              <FilterChip
                key={s}
                active={status === s}
                count={statusCounts[s]}
                testId={`knowledge-status-${s}`}
                onClick={() => {
                  setStatus(status === s ? 'all' : s)
                }}
              >
                {t(`knowledge.status.${s}`)}
              </FilterChip>
            ))}
          </div>
          <BatchBar
            selection={selection}
            actions={(['both', 'presales', 'postsales'] as const).map(moveTo)}
            visible={shownCards.map((c) => c.id)}
            refsOf={(ids) => ids.map(refOf)}
          />
          {imported === null ? null : (
            <p className="text-xs" data-testid="knowledge-import-result">
              {t('knowledge.import_result', {
                imported: imported.imported,
                activated: imported.activated,
                proposed: imported.proposed,
              })}
            </p>
          )}
          {failed === null ? null : <p className="text-xs text-destructive">{failed}</p>}
          {list}
          {/* 上传：拖到这一块，或点头上的 ↑（一份一份传，没传上去的说为什么） */}
          {/* biome-ignore lint/a11y/noStaticElementInteractions: 这一块只接拖拽；点击走头上的 ↑ */}
          <div
            data-testid="knowledge-upload-drop"
            data-dragging={dragging ? 'yes' : 'no'}
            className={cn(
              'flex flex-col items-center gap-1 rounded-ws-card border border-dashed px-3 py-3 text-center',
              dragging ? 'border-ws-brand bg-ws-tint' : 'border-ws-line',
            )}
            onDragOver={(e) => {
              if (isRef(e)) return
              e.preventDefault()
              setDragging(true)
            }}
            onDragLeave={() => {
              setDragging(false)
            }}
            onDrop={onDrop}
          >
            <UploadCloud aria-hidden className="size-5 text-ws-muted-fg" />
            <p className="text-xs text-ws-body">{t('knowledge.upload.hint')}</p>
            <p className="text-xs text-ws-muted-fg" data-testid="knowledge-upload-kinds">
              {t('knowledge.upload.kinds', {
                kinds: UPLOAD_EXTENSIONS.join(' / '),
                limit: Math.floor(UPLOAD_MAX_BYTES / 1024 / 1024),
              })}
            </p>
            {sources.isLoading ? null : uploads.length === 0 ? (
              <p className="text-xs text-ws-muted-fg" data-testid="knowledge-sources-empty">
                {t('knowledge.sources.empty')}
              </p>
            ) : null}
          </div>
          {queue.length === 0 ? null : (
            <ul className="space-y-1 text-xs" data-testid="knowledge-upload-queue">
              {queue.map((item, i) => (
                <li
                  // biome-ignore lint/suspicious/noArrayIndexKey: 队列只往后追加、不排序不删——序号就是这一格的身份
                  key={`${item.name}-${i}`}
                  className="flex flex-wrap items-center gap-2"
                  data-testid={`knowledge-upload-item-${i}`}
                  data-state={item.state}
                >
                  <span className="min-w-0 max-w-[16rem] truncate text-ws-body">{item.name}</span>
                  <WsTag>{t(`knowledge.upload.state.${item.state}`)}</WsTag>
                  {item.error === undefined ? null : (
                    <span className="text-destructive" data-testid={`knowledge-upload-error-${i}`}>
                      {item.error}
                    </span>
                  )}
                </li>
              ))}
            </ul>
          )}
        </section>
      </LibraryStack>
    </div>
  )
}

/** ⋯「这一层看得见什么」：原「设定 → 知识」那一格（知识域、范围、敏感级 + 助理记下的那几条）。 */
function ScopeKnowledge({ scope }: { scope: RailScope }): ReactNode {
  const [Body, setBody] = useState<null | ((p: { scope: RailScope }) => ReactNode)>(null)
  useEffect(() => {
    let live = true
    void import('@/components/rail/panels/knowledge-panel').then((m) => {
      if (live) setBody(() => m.KnowledgePanel)
    })
    return () => {
      live = false
    }
  }, [])
  return Body === null ? <Skeleton className="h-16 w-full" /> : <Body scope={scope} />
}

/* ── 卡片列那张「知识库」卡（1778 A） ── */

export function KnowledgeLibraryCard(_props: RailCardBodyProps): ReactNode {
  const { t } = useApp()
  const cards = useQuery({ queryKey: ['knowledge-cards'], queryFn: () => listKnowledgeCards() })
  const rechecks = useQuery({
    queryKey: ['knowledge-rechecks'],
    queryFn: () => listKnowledgeRechecks(),
  })
  const gaps = useQuery({ queryKey: ['knowledge-gaps'], queryFn: () => listKnowledgeGaps() })
  const live = (cards.data ?? []).filter((c) => c.status !== 'retired')
  const n = (s: KnowledgeStageId): number => live.filter((c) => (c.stage ?? 'both') === s).length
  const open = (params: Record<string, string>): void => {
    openLibrary(KNOWLEDGE_LIBRARY, { params })
  }
  const row = (
    id: string,
    label: string,
    value: string,
    dot: string,
    params: Record<string, string>,
  ): ReactNode => (
    <li key={id}>
      <button
        type="button"
        data-testid={`knowledge-library-card-${id}`}
        className="flex h-8 w-full items-center gap-2 rounded-md px-2 text-left text-[13px] hover:bg-ws-hover"
        onClick={() => {
          open(params)
        }}
      >
        <i aria-hidden className={cn('size-1.5 shrink-0 rounded-full', dot)} />
        <span className="min-w-0 flex-1 truncate text-ws-body">{label}</span>
        <span className="ws-num text-xs text-ws-muted-fg">{value}</span>
      </button>
    </li>
  )
  return (
    <ul className="flex flex-col" data-testid="knowledge-library-card">
      {row(
        'stages',
        t('rail.card.knowledge-library.stages'),
        `${n('both')} · ${n('presales')} · ${n('postsales')}`,
        'bg-ws-faint',
        {},
      )}
      {row(
        'recheck',
        t('rail.card.knowledge-library.recheck'),
        String((rechecks.data ?? []).filter((r) => r.status === 'open').length),
        'bg-ws-warn',
        { recheck: '1' },
      )}
      {row(
        'gaps',
        t('rail.card.knowledge-library.gaps'),
        String((gaps.data ?? []).length),
        'bg-ws-faint',
        { layer: 'gaps' },
      )}
    </ul>
  )
}
