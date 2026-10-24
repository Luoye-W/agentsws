/**
 * WP450（docs/109 §5.2 #9–11、17；决策 1765「资料在右、决策在中」）：岗位第三栏「编辑日历」——三格：
 *
 * - **日历**：往后几周写什么（按天，总页 / 分页、回头改、排着 / 已开写 / 已发布）、哪篇该回头改、最近发布（一键「改写成社媒稿」）；
 *   「出一组主题」按钮写明大概花多少积分，出的卡在中栏批（这里只提一句「等你在中栏批」）；
 * - **外链**：每月一次（开关）、下次哪天、一次约多少积分、「现在体检一次」；上一次的来源域名 / 外链 / 权重（都是估算）、
 *   要看的、锚文本、可疑来源、竞品有我们没有的（已交公关就带「看那件事」）；
 * - **llms.txt**：体检里那一项（有没有、过不过时）、生成的那份（复制 / 交建站）、在 Shopify 上怎么放。
 *
 * 卡片列那张「编辑日历」卡（{@link SeoPlanCard}）只列往后几篇，点「显示更多」开这里。用户看得到的字里不提数据从哪来。
 */
import type {
  BacklinkAuditView,
  LlmsTxtView,
  SeoCalendarEntry,
  SeoCalendarView,
} from '@agentsws/contracts'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { CalendarDays, Copy, Link2, RefreshCw, Send, Sparkles } from 'lucide-react'
import { type ReactNode, useEffect, useState } from 'react'
import {
  CategoryTag,
  EmptyState,
  ListGroup,
  ListRow,
  NoticeLine,
  SectionHeader,
  SkeletonList,
  StatusPill,
} from '@/components/design'
import { Segmented } from '@/components/design/segmented'
import { PanelError } from '@/components/rail/panel-error'
import type { RailCardBodyProps, RailPanelBodyProps } from '@/components/rail/registry'
import { useCardTotal } from '@/components/rail/registry'
import { Button } from '@/components/ui/button'
import { Hint } from '@/components/ui/hint'
import { Switch } from '@/components/ui/switch'
import { useApp } from '@/lib/app-context'
import {
  generateLlmsTxt,
  getBacklinkAudit,
  getLlmsTxt,
  planSeoClusters,
  repurposePost,
  runBacklinkAudit,
  SEO_BACKLINKS_KEY,
  SEO_CALENDAR_KEY,
  SEO_LLMS_KEY,
  setBacklinkAudit,
} from '@/lib/seo-plan-api'
import { seoPlanAssignment, useSeoCalendar } from './seo-plan-status'

type Tab = 'calendar' | 'backlinks' | 'llms'

const STATUS_TONE = {
  scheduled: 'neutral',
  opened: 'info',
  published: 'good',
  skipped: 'neutral',
} as const

const SEV_TONE = { high: 'bad', medium: 'warn', low: 'neutral' } as const

/** `2026-10-26` → 「10-26 周一」/「Mon 10-26」。 */
function dayLabel(date: string, lang: 'zh' | 'en'): string {
  const d = new Date(`${date}T00:00:00Z`)
  const wd =
    lang === 'en'
      ? ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']
      : ['周日', '周一', '周二', '周三', '周四', '周五', '周六']
  const md = date.slice(5)
  const w = wd[d.getUTCDay()] ?? ''
  return lang === 'en' ? `${w} ${md}` : `${md} ${w}`
}

export function SeoPlanPanel(props: RailPanelBodyProps): ReactNode {
  const { t } = useApp()
  const [tab, setTab] = useState<Tab>(
    props.sub === 'backlinks' || props.sub === 'llms' ? props.sub : 'calendar',
  )
  const assignment = seoPlanAssignment(props)
  return (
    <div className="flex flex-col gap-3 p-3" data-testid="seo-plan-panel">
      <Segmented<Tab>
        kind="tabs"
        size="sm"
        label={t('seo_plan.tabs')}
        value={tab}
        onChange={setTab}
        testId="seo-plan-tabs"
        options={[
          { value: 'calendar', label: t('seo_plan.tab.calendar'), testId: 'seo-plan-tab-calendar' },
          {
            value: 'backlinks',
            label: t('seo_plan.tab.backlinks'),
            testId: 'seo-plan-tab-backlinks',
          },
          { value: 'llms', label: t('seo_plan.tab.llms'), testId: 'seo-plan-tab-llms' },
        ]}
      />
      {tab === 'calendar' ? (
        <CalendarTab assignment={assignment} />
      ) : tab === 'backlinks' ? (
        <BacklinksTab assignment={assignment} />
      ) : (
        <LlmsTab assignment={assignment} />
      )}
    </div>
  )
}

/* ── 日历 ─────────────────────────────────────────────────────────── */

function EntryRow({ e, compact = false }: { e: SeoCalendarEntry; compact?: boolean }): ReactNode {
  const { t } = useApp()
  return (
    <ListRow
      data-testid="seo-plan-entry"
      data-status={e.status}
      {...(e.matter_id === undefined ? {} : { to: `/matters/${encodeURIComponent(e.matter_id)}` })}
      end={<StatusPill tone={STATUS_TONE[e.status]}>{t(`seo_plan.status.${e.status}`)}</StatusPill>}
    >
      <span className="flex min-w-0 flex-1 flex-col gap-0.5">
        <span className="truncate text-[13px] font-medium">{e.title}</span>
        {compact ? null : (
          <span className="flex min-w-0 items-center gap-1.5 text-xs text-ws-muted-fg">
            <CategoryTag>{t(`seo_plan.role.${e.role}`)}</CategoryTag>
            {e.kind === 'refresh' ? (
              <CategoryTag outline>{t('seo_plan.kind.refresh')}</CategoryTag>
            ) : null}
            <span className="truncate">{e.keyword}</span>
          </span>
        )}
      </span>
    </ListRow>
  )
}

function groupByDay(entries: readonly SeoCalendarEntry[]): [string, SeoCalendarEntry[]][] {
  const m = new Map<string, SeoCalendarEntry[]>()
  for (const e of entries) m.set(e.date, [...(m.get(e.date) ?? []), e])
  return [...m.entries()].sort((a, b) => a[0].localeCompare(b[0]))
}

function CalendarTab({ assignment }: { assignment: string | undefined }): ReactNode {
  const { t, lang } = useApp()
  const client = useQueryClient()
  const cal = useSeoCalendar(assignment)
  const [note, setNote] = useState<string | undefined>()
  const plan = useMutation({
    mutationFn: () => planSeoClusters(assignment),
    onSuccess: (r) => {
      setNote(r.approval_item_id === undefined ? r.skipped : t('seo_plan.plan.done'))
    },
    onSettled: () => {
      void client.invalidateQueries({ queryKey: [SEO_CALENDAR_KEY] })
    },
  })
  const repurpose = useMutation({
    mutationFn: (change_id: string) => repurposePost({ change_id }, assignment),
    onSuccess: (r) => {
      const base = t('seo_plan.repurpose.result', { n: r.drafts.length, m: r.matters.length })
      setNote(
        r.skipped.length === 0
          ? base
          : `${base}；${t('seo_plan.repurpose.skipped', { list: r.skipped.map((s) => t(`seo_plan.channel.${s.channel}`)).join('、') })}`,
      )
    },
    onSettled: () => {
      void client.invalidateQueries({ queryKey: [SEO_CALENDAR_KEY] })
    },
  })
  if (cal.isPending) return <SkeletonList rows={4} />
  if (cal.error !== null) return <PanelError error={cal.error} />
  const v: SeoCalendarView = cal.data
  const upcoming = v.entries.filter((e) => e.date >= v.today)
  const est = v.plan
  return (
    <div className="flex flex-col gap-3" data-testid="seo-plan-calendar">
      <div className="flex items-center gap-2">
        <span className="text-xs text-ws-muted-fg" data-testid="seo-plan-per-day">
          {t('seo_plan.per_day', { n: v.per_day })}
        </span>
        <span className="flex-1" />
        <Hint
          text={est.available ? t('seo_plan.plan.hint') : (est.reason ?? t('seo_plan.plan.hint'))}
        />
        <Button
          size="sm"
          variant="secondary"
          data-testid="seo-plan-plan"
          disabled={!est.available || plan.isPending}
          onClick={() => {
            plan.mutate()
          }}
        >
          <Sparkles aria-hidden />
          {t('seo_plan.plan')}
          {est.available && est.credits > 0 ? (
            <span className="text-ws-muted-fg">
              · {t('seo_plan.plan.cost', { credits: est.credits })}
            </span>
          ) : null}
        </Button>
      </div>
      {note === undefined ? null : (
        <NoticeLine tone="info" wrap data-testid="seo-plan-note">
          {note}
        </NoticeLine>
      )}
      {(v.pending ?? []).map((p) => (
        <NoticeLine key={p.approval_item_id} tone="info" data-testid="seo-plan-pending">
          {t('seo_plan.pending', { topic: p.topic })}
        </NoticeLine>
      ))}
      {upcoming.length === 0 ? (
        <EmptyState icon={CalendarDays} text={t('seo_plan.empty')} data-testid="seo-plan-empty" />
      ) : (
        groupByDay(upcoming).map(([date, list]) => (
          <section
            key={date}
            className="flex flex-col gap-1.5"
            data-testid="seo-plan-day"
            data-date={date}
          >
            <SectionHeader
              as="h3"
              title={
                date === v.today
                  ? `${t('seo_plan.today')} · ${dayLabel(date, lang)}`
                  : dayLabel(date, lang)
              }
              count={list.length}
            />
            <ListGroup as="ul">
              {list.map((e) => (
                <EntryRow key={e.id} e={e} />
              ))}
            </ListGroup>
          </section>
        ))
      )}
      {v.refresh.length === 0 ? null : (
        <section className="flex flex-col gap-1.5" data-testid="seo-plan-refresh">
          <SectionHeader as="h3" title={t('seo_plan.refresh')} count={v.refresh.length} />
          <ListGroup as="ul">
            {v.refresh.map((r) => (
              <ListRow key={`${r.page}|${r.query ?? ''}`} as="li">
                <span className="flex min-w-0 flex-1 flex-col gap-0.5">
                  <span className="truncate text-[13px]">
                    {r.page.replace(/^https?:\/\/[^/]+/, '')}
                  </span>
                  <span className="truncate text-xs text-ws-muted-fg">{r.reason}</span>
                </span>
              </ListRow>
            ))}
          </ListGroup>
        </section>
      )}
      {v.published.length === 0 ? null : (
        <section className="flex flex-col gap-1.5" data-testid="seo-plan-published">
          <SectionHeader
            as="h3"
            title={t('seo_plan.published')}
            count={v.published.length}
            actions={<Hint text={t('seo_plan.repurpose.hint')} />}
          />
          <ListGroup as="ul">
            {v.published.map((p) => (
              <ListRow
                key={p.change_id}
                as="li"
                data-testid="seo-plan-post"
                end={
                  p.repurposed_at === undefined ? (
                    <Button
                      size="xs"
                      variant="outline"
                      data-testid="seo-plan-repurpose"
                      disabled={repurpose.isPending}
                      onClick={() => {
                        repurpose.mutate(p.change_id)
                      }}
                    >
                      <Send aria-hidden />
                      {t('seo_plan.repurpose')}
                    </Button>
                  ) : (
                    <span className="text-xs text-ws-muted-fg" data-testid="seo-plan-repurposed">
                      {t('seo_plan.repurpose.done', { n: p.repurpose_matters?.length ?? 0 })}
                    </span>
                  )
                }
              >
                <span className="flex min-w-0 flex-1 flex-col gap-0.5">
                  <span className="truncate text-[13px]">{p.title}</span>
                  <span className="ws-num text-xs text-ws-muted-fg">
                    {p.published_at.slice(0, 10)}
                  </span>
                </span>
              </ListRow>
            ))}
          </ListGroup>
        </section>
      )}
    </div>
  )
}

/* ── 外链 ─────────────────────────────────────────────────────────── */

function Stat({
  label,
  value,
  delta,
}: {
  label: string
  value: number | undefined
  delta?: ReactNode
}): ReactNode {
  return (
    <div className="flex min-w-0 flex-col gap-0.5 rounded-ws-block bg-ws-surface px-3 py-2">
      <span className="truncate text-xs text-ws-muted-fg">{label}</span>
      <span className="ws-num text-base font-semibold">
        {value === undefined ? '—' : value.toLocaleString()}
      </span>
      {delta === undefined ? null : <span className="ws-num text-xs">{delta}</span>}
    </div>
  )
}

function BacklinksTab({ assignment }: { assignment: string | undefined }): ReactNode {
  const { t } = useApp()
  const client = useQueryClient()
  const view = useQuery({
    queryKey: [SEO_BACKLINKS_KEY, assignment ?? ''],
    queryFn: () => getBacklinkAudit(assignment),
    enabled: assignment !== undefined,
  })
  const refresh = (): void => {
    void client.invalidateQueries({ queryKey: [SEO_BACKLINKS_KEY] })
  }
  const toggle = useMutation({
    mutationFn: (enabled: boolean) => setBacklinkAudit({ enabled }, assignment),
    onSettled: refresh,
  })
  const run = useMutation({ mutationFn: () => runBacklinkAudit(assignment), onSettled: refresh })
  if (view.isPending) return <SkeletonList rows={4} />
  if (view.error !== null) return <PanelError error={view.error} />
  const v: BacklinkAuditView = view.data
  const last = v.last
  const ch = last?.change
  return (
    <div className="flex flex-col gap-3" data-testid="seo-plan-backlinks">
      <ListGroup>
        <ListRow
          end={
            <Switch
              aria-label={t('seo_plan.bl.enabled')}
              data-testid="seo-plan-bl-enabled"
              checked={v.settings.enabled}
              disabled={toggle.isPending}
              onCheckedChange={(on) => {
                toggle.mutate(on)
              }}
            />
          }
        >
          <span className="flex min-w-0 flex-1 flex-col gap-0.5">
            <span className="text-[13px] font-medium">{t('seo_plan.bl.enabled')}</span>
            <span className="truncate text-xs text-ws-muted-fg" data-testid="seo-plan-bl-cost">
              {[
                v.next_due === undefined ? undefined : t('seo_plan.bl.next', { date: v.next_due }),
                v.estimate.credits === undefined
                  ? t('seo_plan.bl.cost_unknown')
                  : t('seo_plan.bl.cost', { credits: v.estimate.credits }),
              ]
                .filter((x) => x !== undefined)
                .join(' · ')}
            </span>
          </span>
        </ListRow>
      </ListGroup>
      <div className="flex items-center gap-2">
        <span className="text-xs text-ws-muted-fg">
          {last === undefined
            ? t('seo_plan.bl.never')
            : t('seo_plan.bl.last', { date: last.at.slice(0, 10) })}
        </span>
        <span className="flex-1" />
        <Button
          size="sm"
          variant="secondary"
          data-testid="seo-plan-bl-run"
          disabled={!v.available || run.isPending}
          onClick={() => {
            run.mutate()
          }}
        >
          <RefreshCw aria-hidden />
          {t('seo_plan.bl.run')}
        </Button>
      </div>
      {!v.available && v.reason !== undefined ? (
        <NoticeLine tone="info" wrap>
          {v.reason}
        </NoticeLine>
      ) : null}
      {last === undefined ? null : (
        <>
          <div className="grid grid-cols-3 gap-2" data-testid="seo-plan-bl-stats">
            <Stat
              label={t('seo_plan.bl.domains')}
              value={last.ours?.referring_domains}
              {...(ch === undefined
                ? {}
                : {
                    delta: (
                      <span className={ch.referring_domains < 0 ? 'text-ws-bad' : 'text-ws-good'}>
                        {ch.referring_domains > 0 ? '+' : ''}
                        {ch.referring_domains}
                        {ch.pct === undefined ? '' : ` (${ch.pct > 0 ? '+' : ''}${ch.pct}%)`}
                      </span>
                    ),
                  })}
            />
            <Stat label={t('seo_plan.bl.backlinks')} value={last.ours?.backlinks} />
            <Stat label={t('seo_plan.bl.rank')} value={last.ours?.rank} />
          </div>
          <span className="flex items-center gap-1 text-xs text-ws-muted-fg">
            {t('seo_plan.bl.estimate')}
            <Hint text={t('seo_plan.bl.estimate.hint')} />
          </span>
          <section className="flex flex-col gap-1.5" data-testid="seo-plan-bl-issues">
            <SectionHeader as="h3" title={t('seo_plan.bl.issues')} count={last.issues.length} />
            {last.issues.length === 0 ? (
              <p className="text-xs text-ws-muted-fg">{t('seo_plan.bl.all_good')}</p>
            ) : (
              <ListGroup as="ul">
                {last.issues.map((i) => (
                  <ListRow key={i.rule} as="li" data-testid="seo-plan-bl-issue" data-rule={i.rule}>
                    <StatusPill tone={SEV_TONE[i.severity]}>
                      {t(`seo_plan.sev.${i.severity}`)}
                    </StatusPill>
                    <span className="min-w-0 flex-1 text-[13px]">{i.text}</span>
                  </ListRow>
                ))}
              </ListGroup>
            )}
          </section>
          {last.anchors.length === 0 ? null : (
            <section className="flex flex-col gap-1.5">
              <SectionHeader as="h3" title={t('seo_plan.bl.anchors')} />
              <ul className="flex flex-col gap-1.5" data-testid="seo-plan-bl-anchors">
                {last.anchors.slice(0, 5).map((a) => (
                  <li key={a.anchor} className="flex items-center gap-2 text-xs">
                    <span className="w-28 shrink-0 truncate">{a.anchor || '—'}</span>
                    <span className="h-1.5 flex-1 overflow-hidden rounded-full bg-ws-surface">
                      <span
                        className="block h-full rounded-full bg-ws-brand"
                        style={{ width: `${Math.round(a.share * 100)}%` }}
                      />
                    </span>
                    <span className="ws-num w-10 text-right">{Math.round(a.share * 100)}%</span>
                    <CategoryTag>{t(`seo_plan.bl.anchor.${a.kind}`)}</CategoryTag>
                  </li>
                ))}
              </ul>
            </section>
          )}
          {last.suspicious.length === 0 ? null : (
            <section className="flex flex-col gap-1.5" data-testid="seo-plan-bl-suspicious">
              <SectionHeader
                as="h3"
                title={t('seo_plan.bl.suspicious')}
                count={last.suspicious.length}
              />
              <ListGroup as="ul">
                {last.suspicious.map((s) => (
                  <ListRow key={s.domain} as="li">
                    <span className="min-w-0 flex-1 truncate text-[13px]">{s.domain}</span>
                    <span className="text-xs text-ws-muted-fg">{s.why}</span>
                  </ListRow>
                ))}
              </ListGroup>
            </section>
          )}
          {last.gap.length === 0 ? null : (
            <section className="flex flex-col gap-1.5" data-testid="seo-plan-bl-gap">
              <SectionHeader
                as="h3"
                title={t('seo_plan.bl.gap')}
                count={last.gap.length}
                {...(last.handed_to_pr === undefined
                  ? {}
                  : {
                      actions: (
                        <a
                          className="text-xs text-ws-brand hover:underline"
                          href={`/matters/${encodeURIComponent(last.handed_to_pr.matter_id)}`}
                          data-testid="seo-plan-bl-pr"
                        >
                          {t('seo_plan.bl.gap.handed')} · {t('seo_plan.open_matter')}
                        </a>
                      ),
                    })}
              />
              <ListGroup as="ul">
                {last.gap.map((g) => (
                  <ListRow key={g.domain} as="li" data-testid="seo-plan-bl-gap-row">
                    <Link2 aria-hidden className="size-3.5 shrink-0 text-ws-muted-fg" />
                    <span className="min-w-0 flex-1 truncate text-[13px]">{g.domain}</span>
                    <span className="truncate text-xs text-ws-muted-fg">
                      {g.competitors.join(' · ')}
                    </span>
                  </ListRow>
                ))}
              </ListGroup>
            </section>
          )}
          {last.notes.map((n) => (
            <NoticeLine key={n} tone="info" wrap>
              {n}
            </NoticeLine>
          ))}
        </>
      )}
    </div>
  )
}

/* ── llms.txt ─────────────────────────────────────────────────────── */

const LLMS_TONE = {
  missing: 'warn',
  current: 'good',
  stale: 'warn',
  invalid: 'bad',
  unknown: 'neutral',
} as const

function LlmsTab({ assignment }: { assignment: string | undefined }): ReactNode {
  const { t } = useApp()
  const client = useQueryClient()
  const view = useQuery({
    queryKey: [SEO_LLMS_KEY, assignment ?? ''],
    queryFn: () => getLlmsTxt(assignment),
    enabled: assignment !== undefined,
  })
  const [copied, setCopied] = useState(false)
  useEffect(() => {
    if (!copied) return
    const id = setTimeout(() => {
      setCopied(false)
    }, 1500)
    return () => {
      clearTimeout(id)
    }
  }, [copied])
  const gen = useMutation({
    mutationFn: (handoff: boolean) => generateLlmsTxt({ handoff }, assignment),
    onSuccess: (v) => {
      client.setQueryData([SEO_LLMS_KEY, assignment ?? ''], v)
    },
  })
  if (view.isPending) return <SkeletonList rows={3} />
  if (view.error !== null) return <PanelError error={view.error} />
  const v: LlmsTxtView = view.data
  const live = v.live
  return (
    <div className="flex flex-col gap-3" data-testid="seo-plan-llms">
      <ListGroup>
        <ListRow
          data-testid="seo-plan-llms-live"
          data-state={live?.state ?? 'none'}
          end={
            live === undefined ? null : (
              <StatusPill tone={LLMS_TONE[live.state]}>
                {t(`seo_plan.llms.state.${live.state}`)}
              </StatusPill>
            )
          }
        >
          <span className="flex min-w-0 flex-1 flex-col gap-0.5">
            <span className="text-[13px] font-medium">
              {live === undefined ? t('seo_plan.llms.state.none') : (live.url ?? '/llms.txt')}
            </span>
            {live?.generated_by === 'shopify' ? (
              <span className="text-xs text-ws-muted-fg">{t('seo_plan.llms.shopify')}</span>
            ) : null}
            {(live?.reasons ?? []).map((r) => (
              <span key={r} className="text-xs text-ws-muted-fg">
                {r}
              </span>
            ))}
          </span>
        </ListRow>
      </ListGroup>
      <div className="flex flex-wrap items-center gap-2">
        <Button
          size="sm"
          variant="secondary"
          data-testid="seo-plan-llms-generate"
          disabled={gen.isPending}
          onClick={() => {
            gen.mutate(false)
          }}
        >
          <Sparkles aria-hidden />
          {t('seo_plan.llms.generate')}
        </Button>
        {v.draft === undefined ? null : (
          <>
            <Button
              size="sm"
              variant="outline"
              data-testid="seo-plan-llms-copy"
              onClick={() => {
                void navigator.clipboard?.writeText(v.draft?.content ?? '').then(() => {
                  setCopied(true)
                })
              }}
            >
              <Copy aria-hidden />
              {copied ? t('seo_plan.llms.copied') : t('seo_plan.llms.copy')}
            </Button>
            {v.handed_to_site === undefined ? (
              <Button
                size="sm"
                variant="outline"
                data-testid="seo-plan-llms-handoff"
                disabled={gen.isPending}
                onClick={() => {
                  gen.mutate(true)
                }}
              >
                <Send aria-hidden />
                {t('seo_plan.llms.handoff')}
              </Button>
            ) : (
              <a
                className="text-xs text-ws-brand hover:underline"
                href={`/matters/${encodeURIComponent(v.handed_to_site.matter_id)}`}
                data-testid="seo-plan-llms-handed"
              >
                {t('seo_plan.llms.handed')} · {t('seo_plan.open_matter')}
              </a>
            )}
          </>
        )}
      </div>
      {gen.error === null ? null : <PanelError error={gen.error} />}
      {v.draft === undefined ? (
        <p className="text-xs text-ws-muted-fg">{t('seo_plan.llms.empty')}</p>
      ) : (
        <pre
          className="max-h-80 overflow-auto rounded-ws-block bg-ws-surface p-3 text-xs leading-5 whitespace-pre-wrap"
          data-testid="seo-plan-llms-draft"
        >
          {v.draft.content}
        </pre>
      )}
      <details className="text-xs text-ws-muted-fg" data-testid="seo-plan-llms-how">
        <summary className="cursor-pointer">{t('seo_plan.llms.how')}</summary>
        <ol className="mt-1.5 flex list-decimal flex-col gap-1 pl-4">
          {v.placement.map((p) => (
            <li key={p}>{p}</li>
          ))}
        </ol>
      </details>
    </div>
  )
}

/* ── 卡片列那张卡 ─────────────────────────────────────────────────── */

export function SeoPlanCard(props: RailCardBodyProps): ReactNode {
  const { t } = useApp()
  const cal = useSeoCalendar(seoPlanAssignment(props))
  const upcoming = (cal.data?.entries ?? []).filter(
    (e) => cal.data !== undefined && e.date >= cal.data.today && e.status !== 'published',
  )
  useCardTotal(props.onTotal, upcoming.length)
  if (cal.isPending) return <SkeletonList rows={2} />
  if (cal.error !== null) return <PanelError error={cal.error} />
  if (upcoming.length === 0)
    return <p className="px-1 text-xs text-ws-muted-fg">{t('seo_plan.empty')}</p>
  return (
    <ListGroup as="ul" data-testid="seo-plan-card">
      {upcoming.slice(0, props.limit).map((e) => (
        <EntryRow key={e.id} e={e} compact />
      ))}
    </ListGroup>
  )
}
