/**
 * 工具箱（40 §2.2 第 1 条）：公司里已经做出来的自动化，全在这一页。
 *
 * 一条一张卡：**谁建的、哪些岗位在用、上次跑是什么时候、跑了多少次、在哪一层**。
 * 按 kind 分组，疑似重复的成对高亮并给一个"合并"——合并不是立刻改，是出一张
 * `policy_change` 卡，批了才合（40 §2.2 第 4 条）。
 *
 * 搜索框与 ⌘K 同源：都打 `GET /v1/catalog?q=`，不是两套匹配规则。
 */
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useMemo, useState } from 'react'
import { SimilarChoiceCard } from '@/components/org/similar-choice'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import { Skeleton } from '@/components/ui/skeleton'
import {
  ApiClientError,
  type CatalogEntryView,
  type CatalogKind,
  createSchedule,
  type DuplicateAck,
  listCatalog,
  listCatalogDuplicates,
  mergeCatalogEntries,
  type SimilarExistsDetails,
  similarExists,
} from '@/lib/api'
import { useApp } from '@/lib/app-context'
import { cn } from '@/lib/utils'

/** 分组顺序：先"能跑的"，再"改行为的"。 */
const KIND_ORDER: CatalogKind[] = ['schedule', 'workflow', 'app', 'skill', 'custom_card', 'rule']

function shortDate(at: string | undefined): string | undefined {
  if (at === undefined) return undefined
  const ms = Date.parse(at)
  if (Number.isNaN(ms)) return at
  return new Date(ms).toISOString().slice(0, 16).replace('T', ' ')
}

export function ToolboxTab({
  assignment,
  initialQuery,
}: {
  /** 制度这一层是所有者的事；这一页跟公司页用同一条 Assignment。 */
  assignment: string
  /** ⌘K 跳过来时带的搜索词。 */
  initialQuery?: string
}): React.ReactNode {
  const { t } = useApp()
  const client = useQueryClient()
  const [kind, setKind] = useState<CatalogKind | null>(null)
  const [query, setQuery] = useState(initialQuery ?? '')
  const [merged, setMerged] = useState<string | undefined>(undefined)
  const [failure, setFailure] = useState<string | undefined>(undefined)
  // 新建定时任务：标题 + cron；查到像的就把 409 的候选存下来出选择题卡
  const [draft, setDraft] = useState<{ title: string; expr: string } | null>(null)
  const [similar, setSimilar] = useState<SimilarExistsDetails | null>(null)

  const catalog = useQuery({
    queryKey: ['org', 'catalog', query],
    queryFn: () => listCatalog({ q: query }, assignment),
  })
  const dupes = useQuery({
    queryKey: ['org', 'catalog-duplicates'],
    queryFn: () => listCatalogDuplicates(assignment),
  })
  const entries = catalog.data ?? []
  const duplicates = dupes.data ?? []

  const refresh = async (): Promise<void> => {
    await client.invalidateQueries({ queryKey: ['org', 'catalog'] })
    await client.invalidateQueries({ queryKey: ['org', 'catalog-duplicates'] })
  }

  const say = (err: unknown): void => {
    setFailure(err instanceof ApiClientError ? err.message : t('error.generic'))
  }

  const merge = useMutation({
    mutationFn: (input: { keep: string; drop: string }) => mergeCatalogEntries(input, assignment),
    onSuccess: async (_out, input) => {
      setFailure(undefined)
      setMerged(`${input.keep}|${input.drop}`)
      await refresh()
    },
    onError: say,
  })

  const create = useMutation({
    mutationFn: (input: { title: string; expr: string; ack?: DuplicateAck }) =>
      createSchedule(
        {
          title: input.title,
          trigger: { kind: 'cron', expr: input.expr, tz: 'Asia/Shanghai' },
          ...(input.ack === undefined ? {} : { duplicate_ack: input.ack }),
        },
        assignment,
      ),
    onSuccess: async () => {
      setFailure(undefined)
      setSimilar(null)
      setDraft(null)
      await refresh()
    },
    onError: (err) => {
      // 40 §2.2：查到像的**不直接建**，出一张选择题卡
      const details = similarExists(err)
      if (details !== undefined) {
        setFailure(undefined)
        setSimilar(details)
        return
      }
      say(err)
    },
  })

  const merging = merge.isPending
  const error = failure

  /** 疑似重复里出现过的条目：卡片上打一个角标。 */
  const flagged = useMemo(() => {
    const ids = new Set<string>()
    for (const d of duplicates) {
      ids.add(d.a.id)
      ids.add(d.b.id)
    }
    return ids
  }, [duplicates])

  const groups = useMemo(() => {
    const byKind = new Map<CatalogKind, CatalogEntryView[]>()
    for (const e of entries) {
      if (kind !== null && e.kind !== kind) continue
      const list = byKind.get(e.kind) ?? []
      list.push(e)
      byKind.set(e.kind, list)
    }
    return KIND_ORDER.filter((k) => (byKind.get(k)?.length ?? 0) > 0).map((k) => ({
      kind: k,
      items: byKind.get(k) ?? [],
    }))
  }, [entries, kind])

  return (
    <div className="flex flex-col gap-4" data-testid="toolbox">
      <p className="text-xs text-muted-foreground">{t('toolbox.subtitle')}</p>

      <div className="flex flex-wrap items-center gap-2">
        <Input
          value={query}
          placeholder={t('toolbox.search')}
          className="h-8 max-w-72"
          data-testid="toolbox-search"
          onChange={(e) => {
            setQuery(e.target.value)
          }}
        />
        <div className="flex flex-wrap gap-1">
          <Button
            size="sm"
            variant={kind === null ? 'secondary' : 'ghost'}
            onClick={() => {
              setKind(null)
            }}
          >
            {t('org.tab.toolbox')}
          </Button>
          {KIND_ORDER.map((k) => (
            <Button
              key={k}
              size="sm"
              variant={kind === k ? 'secondary' : 'ghost'}
              data-testid={`toolbox-kind-${k}`}
              onClick={() => {
                setKind(kind === k ? null : k)
              }}
            >
              {t(`toolbox.kind.${k}`)}
            </Button>
          ))}
        </div>
      </div>

      {error === undefined ? null : (
        <p className="text-xs text-destructive" data-testid="toolbox-error">
          {error}
        </p>
      )}

      {/* 40 §2.2 第 2 条：建之前先查。建的入口就摆在"别人做过什么"旁边，顺序才对 */}
      {draft === null ? (
        <div>
          <Button
            size="sm"
            variant="outline"
            data-testid="toolbox-new"
            onClick={() => {
              setSimilar(null)
              setDraft({ title: '', expr: '0 9 * * *' })
            }}
          >
            {t('toolbox.new')}
          </Button>
        </div>
      ) : (
        <Card data-testid="toolbox-new-form">
          <CardHeader>
            <CardTitle className="text-sm">{t('toolbox.new')}</CardTitle>
          </CardHeader>
          <CardContent className="flex flex-col gap-2">
            <Input
              value={draft.title}
              placeholder={t('toolbox.new.title')}
              data-testid="toolbox-new-title"
              onChange={(e) => {
                setDraft({ ...draft, title: e.target.value })
              }}
            />
            <Input
              value={draft.expr}
              placeholder={t('toolbox.new.cron')}
              data-testid="toolbox-new-cron"
              onChange={(e) => {
                setDraft({ ...draft, expr: e.target.value })
              }}
            />
            <div className="flex gap-2">
              <Button
                size="sm"
                disabled={create.isPending || draft.title.trim() === ''}
                data-testid="toolbox-new-save"
                onClick={() => {
                  setSimilar(null)
                  create.mutate({ title: draft.title.trim(), expr: draft.expr.trim() })
                }}
              >
                {t('org.save')}
              </Button>
              <Button
                size="sm"
                variant="ghost"
                onClick={() => {
                  setDraft(null)
                  setSimilar(null)
                }}
              >
                {t('org.cancel')}
              </Button>
            </div>
          </CardContent>
        </Card>
      )}

      {similar === null || draft === null ? null : (
        <SimilarChoiceCard
          details={similar}
          busy={create.isPending}
          onReuse={() => {
            // 复用别人那条：什么都不建，回到列表并把它搜出来
            setSimilar(null)
            setDraft(null)
            setQuery(similar.candidates[0]?.entry.title ?? '')
          }}
          onMerge={(entry_id) => {
            // 还没有自己那条，"合并进它"就是复用它 + 把它标出来给人看
            setSimilar(null)
            setDraft(null)
            setQuery(entries.find((e) => e.id === entry_id)?.title ?? '')
          }}
          onForceNew={(reason, similar_to) => {
            create.mutate({
              title: draft.title.trim(),
              expr: draft.expr.trim(),
              ack: { decision: 'new', reason, similar_to },
            })
          }}
          onCancel={() => {
            setSimilar(null)
            setDraft(null)
          }}
        />
      )}

      {duplicates.length === 0 ? null : (
        <Card className="border-amber-400/60" data-testid="toolbox-duplicates">
          <CardHeader>
            <CardTitle className="text-sm">{t('toolbox.dupes')}</CardTitle>
          </CardHeader>
          <CardContent className="flex flex-col gap-2">
            <p className="text-xs text-muted-foreground">{t('toolbox.dupes.hint')}</p>
            {duplicates.map((d) => {
              const key = `${d.a.id}|${d.b.id}`
              return (
                <div
                  key={key}
                  className="flex flex-wrap items-center justify-between gap-2 rounded border px-2 py-1.5"
                >
                  <div className="flex flex-col">
                    <span className="text-sm">
                      {t('toolbox.dupes.pair', { a: d.a.title, b: d.b.title })}
                    </span>
                    <span className="text-xs text-muted-foreground">
                      {t('toolbox.dupes.similarity', { pct: Math.round(d.similarity * 100) })}
                      {d.reasons.length === 0 ? '' : ` · ${d.reasons.join('；')}`}
                    </span>
                  </div>
                  {merged === key ? (
                    <span className="text-xs text-muted-foreground">
                      {t('toolbox.dupes.merged')}
                    </span>
                  ) : (
                    <Button
                      size="sm"
                      disabled={merging}
                      data-testid="toolbox-merge"
                      onClick={() => {
                        merge.mutate({ keep: d.a.id, drop: d.b.id })
                      }}
                    >
                      {t('toolbox.dupes.merge')}
                    </Button>
                  )}
                </div>
              )
            })}
          </CardContent>
        </Card>
      )}

      {catalog.isPending ? (
        <Skeleton className="h-40 w-full" />
      ) : groups.length === 0 ? (
        <p className="text-sm text-muted-foreground" data-testid="toolbox-empty">
          {query.trim() === '' && kind === null ? t('toolbox.empty') : t('toolbox.empty.filtered')}
        </p>
      ) : (
        groups.map((g) => (
          <div key={g.kind} className="flex flex-col gap-2">
            <h2 className="text-xs font-semibold text-muted-foreground">
              {t(`toolbox.kind.${g.kind}`)}
            </h2>
            <div className="grid gap-2 md:grid-cols-2">
              {g.items.map((e) => (
                <div
                  key={e.id}
                  data-testid="toolbox-entry"
                  className={cn(
                    'flex flex-col gap-1 rounded border px-3 py-2',
                    flagged.has(e.id) && 'border-amber-400/60 bg-amber-50/40',
                  )}
                >
                  <div className="flex items-center justify-between gap-2">
                    <span className="text-sm font-medium">{e.title}</span>
                    <div className="flex shrink-0 items-center gap-1">
                      {flagged.has(e.id) ? (
                        <Badge variant="outline">{t('toolbox.dupe.badge')}</Badge>
                      ) : null}
                      <Badge variant="secondary">{t(`toolbox.layer.${e.layer}`)}</Badge>
                    </div>
                  </div>
                  {e.summary === '' ? null : (
                    <span className="text-xs text-muted-foreground">{e.summary}</span>
                  )}
                  <span className="text-xs text-muted-foreground">
                    {t('toolbox.owner', { who: e.owner })} ·{' '}
                    {e.used_by_positions.length === 0
                      ? t('toolbox.positions.none')
                      : t('toolbox.positions', { n: e.used_by_positions.length })}
                  </span>
                  <span className="text-xs text-muted-foreground">
                    {e.last_run_at === undefined
                      ? t('toolbox.last_run.never')
                      : t('toolbox.last_run', { at: shortDate(e.last_run_at) ?? '' })}{' '}
                    · {t('toolbox.runs', { n: e.runs_30d })}
                  </span>
                  {e.reason_for_duplicate === undefined ? null : (
                    <span className="text-xs text-amber-700">
                      {t('toolbox.reason', { reason: e.reason_for_duplicate })}
                    </span>
                  )}
                </div>
              ))}
            </div>
          </div>
        ))
      )}
    </div>
  )
}
