/**
 * WP396（docs/106 §13）：Amazon 运营面板「Listing 体检」那一块（填进 WP395 留的空块）+ 每个 ASIN 一张体检卡。
 *
 * - 块上：最近一次的摘要（几个 ASIN、几处问题、最要紧的一条）+「现在体检」；还没体检过 / 读不了照实说。
 * - 点一个 ASIN 就地展开它的体检卡：每处问题写 哪条规则（带出处，过时的标出来）/ 现在是什么 / 建议；
 *   文案类有草稿（复制）；图片类有「向设计岗下需求单」；要看图的只提示人看一眼。
 * - 卡底固定一句「连上 Amazon 店铺后能查到更多」（前台看不到的不猜）。
 * - 数字照页面原样，读不到写「没读到」。只出建议，这里没有任何改 Amazon 的按钮。
 */
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { ChevronDown, ChevronRight, ExternalLink } from 'lucide-react'
import { type ReactNode, useState } from 'react'
import { AmazonEmpty, registerAmazonBlockBody } from '@/components/amazon/amazon-ops-board'
import { KeywordGapLine } from '@/components/amazon/keyword-gap-line'
import { Button } from '@/components/ui/button'
import { Hint } from '@/components/ui/hint'
import {
  amazonListingKey,
  getAmazonListing,
  type ListingCheckupItem,
  type ListingCheckupView,
  type ListingIssue,
  requestListingDesign,
  runAmazonListing,
  setAmazonOwnAsins,
} from '@/lib/amazon-listing-api'
import { useApp } from '@/lib/app-context'

const SEV_TONE: Record<ListingIssue['severity'], string> = {
  blocker: 'bg-ws-bad',
  search: 'bg-ws-warn',
  improve: 'bg-ws-muted-fg',
}

/**
 * 一处问题。WP420（自查 U21）：以前每处四行（规则名 / 出处 / 现在 / 建议），一张卡 8 处就是 30 多行；
 * 现在两行——规则名（出处收进问号）+「现在 → 建议」；向设计岗下需求单的按钮挪到卡底只放一个。
 */
function IssueRow({ issue }: { issue: ListingIssue }): ReactNode {
  const { t } = useApp()
  const [copied, setCopied] = useState(false)
  const sourceText =
    issue.source.kind === 'practice' && !issue.source.title.startsWith(t('alst.practice'))
      ? `${t('alst.practice')} · ${issue.source.title}`
      : issue.source.title
  return (
    <li
      className="flex flex-col gap-0.5 border-t border-border/60 pt-2"
      data-testid="alst-issue"
      data-rule={issue.rule_id}
    >
      <div className="flex flex-wrap items-center gap-x-1.5 gap-y-1">
        <span
          className={`inline-block size-2 shrink-0 rounded-full ${SEV_TONE[issue.severity]}`}
          title={t(`alst.sev.${issue.severity}`)}
        />
        <span className="text-sm font-medium">{issue.rule_name}</span>
        {issue.source.url === undefined ? (
          <Hint text={sourceText} testId="alst-source" />
        ) : (
          <a
            href={issue.source.url}
            target="_blank"
            rel="noreferrer"
            title={sourceText}
            aria-label={sourceText}
            className="inline-flex items-center text-muted-foreground hover:text-foreground"
            data-testid="alst-source"
          >
            <ExternalLink className="size-3" />
          </a>
        )}
        {issue.rule_stale ? (
          <span
            className="rounded-sm bg-ws-warn-bg px-1.5 text-xs text-ws-warn"
            data-testid="alst-stale"
            title={t('alst.stale.hint', { at: issue.rule_checked_at })}
          >
            {t('alst.stale')}
          </span>
        ) : null}
        {issue.needs_human === true ? (
          <span className="rounded-sm bg-muted px-1.5 text-xs text-muted-foreground">
            {t('alst.human')}
          </span>
        ) : null}
      </div>
      <p className="text-sm" data-testid="alst-now-fix">
        <span className="text-muted-foreground">{issue.now}</span>
        <span className="text-muted-foreground"> → </span>
        {issue.suggestion}
      </p>
      {issue.draft === undefined ? null : (
        <div
          className="flex items-start gap-2 rounded-md bg-muted/60 px-2 py-1.5 text-sm"
          data-testid="alst-draft"
        >
          <span className="shrink-0 text-muted-foreground">{t('alst.draft')}</span>
          <span className="min-w-0 flex-1 break-words">{issue.draft}</span>
          <Button
            size="xs"
            variant="ghost"
            onClick={() => {
              void navigator.clipboard?.writeText(issue.draft ?? '')
              setCopied(true)
            }}
          >
            {copied ? t('alst.copied') : t('alst.copy')}
          </Button>
        </div>
      )}
    </li>
  )
}

/** WP420（自查 U21）：一张卡里所有图片类问题合成一张设计需求单（第一处的标题，各处的需要逐条列）。 */
export function mergedDesignRequest(
  issues: readonly ListingIssue[],
): { title: string; need: string; n: number } | undefined {
  const reqs = issues.flatMap((i) => (i.design_request === undefined ? [] : [i.design_request]))
  const first = reqs[0]
  if (first === undefined) return undefined
  const needs = [...new Set(reqs.map((r) => r.need))]
  return {
    title: first.title,
    need: needs.length === 1 ? (needs[0] as string) : needs.map((n) => `- ${n}`).join('\n'),
    n: reqs.length,
  }
}

function DesignButton({
  issues,
  assignment,
}: {
  issues: readonly ListingIssue[]
  assignment: string
}): ReactNode {
  const { t } = useApp()
  const merged = mergedDesignRequest(issues)
  const design = useMutation({
    mutationFn: () =>
      requestListingDesign(assignment, {
        title: merged?.title ?? '',
        need: merged?.need ?? '',
      }),
  })
  if (merged === undefined) return null
  return (
    <div>
      <Button
        size="xs"
        variant="outline"
        disabled={design.isPending || design.isSuccess}
        onClick={() => design.mutate()}
        data-testid="alst-design"
      >
        {design.isSuccess
          ? t('alst.design.sent')
          : merged.n > 1
            ? t('alst.design.n', { n: merged.n })
            : t('alst.design')}
      </Button>
      {design.isError ? (
        <span className="ml-2 text-xs text-ws-bad">{String(design.error?.message ?? '')}</span>
      ) : null}
    </div>
  )
}

function Fact({ label, value }: { label: string; value: string | number | undefined }): ReactNode {
  const { t } = useApp()
  return (
    <span className="whitespace-nowrap">
      <span className="text-muted-foreground">{label} </span>
      {value === undefined ? (
        <span className="text-muted-foreground">{t('alst.not_read')}</span>
      ) : (
        value
      )}
    </span>
  )
}

/** 一个 ASIN 的体检卡（就地展开）。 */
export function ListingCheckupCard({
  item,
  assignment,
  footer,
}: {
  item: ListingCheckupItem
  assignment: string
  footer: string
}): ReactNode {
  const { t } = useApp()
  const f = item.facts
  return (
    <div
      className="flex flex-col gap-2 rounded-lg border border-border p-3"
      data-testid="alst-card"
      data-asin={item.asin}
    >
      {item.title === undefined ? null : <p className="text-sm">{item.title}</p>}
      {item.status === 'checked' ? (
        <div className="flex flex-wrap gap-x-3 gap-y-1 text-xs" data-testid="alst-facts">
          <Fact label={t('alst.fact.rating')} value={f?.rating} />
          <Fact label={t('alst.fact.reviews')} value={f?.reviews_count?.toLocaleString()} />
          <Fact label={t('alst.fact.price')} value={f?.price} />
          {f?.list_price === undefined ? null : (
            <Fact label={t('alst.fact.list_price')} value={f.list_price} />
          )}
          {f?.coupon === undefined ? null : <Fact label={t('alst.fact.coupon')} value={f.coupon} />}
          <Fact
            label={t('alst.fact.stock')}
            value={
              f?.availability === 'in_stock'
                ? t('alst.in_stock')
                : f?.availability === 'out_of_stock'
                  ? t('alst.out_of_stock')
                  : undefined
            }
          />
          <Fact label={t('alst.fact.buybox')} value={f?.buybox_seller} />
          <Fact label={t('alst.fact.images')} value={f?.image_count} />
        </div>
      ) : (
        <p className="text-sm text-muted-foreground">
          {item.message ?? t(`alst.status.${item.status}`)}
        </p>
      )}
      {/* WP398：这一款有几个竞品常用词你没写进标题 / 五点（还没有词库 / 没算过就不出） */}
      {item.status === 'checked' ? (
        <KeywordGapLine asin={item.asin} assignment={assignment} />
      ) : null}
      {item.previous === undefined ? null : (
        <p className="text-xs text-muted-foreground" data-testid="alst-previous">
          {t('alst.previous', { issues: item.previous.issues, fixed: item.previous.fixed })}
          {item.previous.added > 0 ? t('alst.previous.added', { added: item.previous.added }) : ''}
        </p>
      )}
      {item.issues.length === 0 ? null : (
        <ul className="flex flex-col gap-2">
          {item.issues.map((issue) => (
            <IssueRow key={`${issue.rule_id}|${issue.now}`} issue={issue} />
          ))}
        </ul>
      )}
      <DesignButton issues={item.issues} assignment={assignment} />
      {item.human_checks.length === 0 ? null : (
        <ul
          className="flex flex-col gap-1 border-t border-border/60 pt-2 text-sm"
          data-testid="alst-human"
        >
          {item.human_checks.map((h) => (
            <li key={h}>
              <span className="text-muted-foreground">{t('alst.look')}：</span>
              {h}
            </li>
          ))}
        </ul>
      )}
      <div className="flex flex-wrap items-center justify-between gap-2 border-t border-border/60 pt-2">
        <p className="text-xs text-muted-foreground" data-testid="alst-footer">
          {footer}
        </p>
        <a
          href={item.url}
          target="_blank"
          rel="noreferrer"
          className="inline-flex items-center gap-0.5 text-xs text-muted-foreground hover:underline"
        >
          {t('alst.open')}
          <ExternalLink className="size-3" />
        </a>
      </div>
    </div>
  )
}

function Summary({ view }: { view: ListingCheckupView }): ReactNode {
  const { t, lang } = useApp()
  const run = view.latest
  if (run === undefined) return null
  const s = run.summary
  return (
    <div className="flex flex-col gap-0.5" data-testid="alst-summary">
      <p className="text-sm">
        {s.issues === 0
          ? t('alst.summary.clean', { asins: s.asins })
          : t('alst.summary', { asins: s.asins, issues: s.issues })}
        <span className="ml-2 text-xs text-muted-foreground">
          {t('alst.when', {
            at: new Date(run.finished_at).toLocaleString(lang === 'en' ? 'en-US' : 'zh-CN', {
              month: 'numeric',
              day: 'numeric',
              hour: '2-digit',
              minute: '2-digit',
            }),
          })}
        </span>
      </p>
      {s.worst === undefined ? null : (
        <p className="text-xs text-muted-foreground" data-testid="alst-worst">
          {t('alst.worst', { asin: s.worst.asin, rule: s.worst.rule_name, now: s.worst.now })}
        </p>
      )}
      {run.stopped === 'blocked' || run.stopped === 'quota' ? (
        <p className="text-xs text-ws-warn">{t(`alst.stopped.${run.stopped}`)}</p>
      ) : null}
    </div>
  )
}

/** 「Listing 体检」那一块的身体（注册进 WP395 的面板）。 */
export function ListingCheckupBlock({ assignment }: { assignment: string }): ReactNode {
  const { t, lang } = useApp()
  const client = useQueryClient()
  const [open, setOpen] = useState<string | undefined>(undefined)
  const view = useQuery({
    queryKey: amazonListingKey(assignment),
    queryFn: () => getAmazonListing(assignment),
  })
  const run = useMutation({
    mutationFn: () => runAmazonListing(assignment),
    onSettled: () => client.invalidateQueries({ queryKey: amazonListingKey(assignment) }),
  })
  const v = view.data
  if (v === undefined || v === null)
    return <AmazonEmpty text={t('amzops.listing.empty')} testId="amzops-empty-listing" />
  const footer = lang === 'en' ? v.footer.en : v.footer.zh
  const items = v.latest?.items ?? []
  return (
    <div className="flex flex-col gap-2" data-testid="alst-block">
      {v.latest === undefined ? (
        <AmazonEmpty
          text={v.own_asins === 0 ? t('alst.no_asins') : t('amzops.listing.empty')}
          testId="amzops-empty-listing"
        />
      ) : (
        <Summary view={v} />
      )}
      {v.reader_ready ? null : (
        <p className="text-xs text-muted-foreground">{t('alst.no_reader')}</p>
      )}
      {v.own === undefined ? null : <OwnAsinsRow assignment={assignment} own={v.own} />}
      {items.length === 0 ? null : (
        <ul className="flex flex-col gap-1.5">
          {items.map((item) => {
            const key = `${item.marketplace}:${item.asin}`
            const isOpen = open === key
            return (
              <li key={key} className="flex flex-col gap-1.5">
                <button
                  type="button"
                  className="flex w-full min-w-0 items-center gap-1.5 text-left text-sm hover:underline"
                  onClick={() => setOpen(isOpen ? undefined : key)}
                  data-testid="alst-asin"
                  aria-expanded={isOpen}
                >
                  {isOpen ? (
                    <ChevronDown className="size-3.5" />
                  ) : (
                    <ChevronRight className="size-3.5" />
                  )}
                  <span className="font-mono text-xs">{item.asin}</span>
                  <span className="text-xs text-muted-foreground">{item.marketplace}</span>
                  <span className="min-w-0 flex-1 truncate">{item.label ?? item.title ?? ''}</span>
                  <span
                    className={
                      item.status === 'checked'
                        ? 'shrink-0 text-xs'
                        : 'shrink-0 text-xs text-muted-foreground'
                    }
                  >
                    {item.status === 'checked'
                      ? t('alst.issues', { n: item.issues.length })
                      : t(`alst.status.${item.status}`)}
                  </span>
                </button>
                {isOpen ? (
                  <ListingCheckupCard item={item} assignment={assignment} footer={footer} />
                ) : null}
              </li>
            )
          })}
        </ul>
      )}
      {v.own_asins > 0 && v.reader_ready ? (
        <div className="flex items-center gap-2">
          <Button
            size="xs"
            variant="outline"
            disabled={run.isPending}
            onClick={() => run.mutate()}
            data-testid="alst-run"
          >
            {run.isPending ? t('alst.running') : t('alst.run')}
          </Button>
          <Hint text={footer} />
        </div>
      ) : null}
    </div>
  )
}

/**
 * WP420（自查 B15）：自家商品那一行——在 Amazon 运营面板上就能看、能改（以前只在「内容与搜索」的关注设置里，
 * 只做 Amazon 的公司看不到也改不了）。点「改」就地一个输入框：ASIN 或商品链接，逗号 / 换行隔开。
 */
function OwnAsinsRow({
  assignment,
  own,
}: {
  assignment: string
  own: NonNullable<ListingCheckupView['own']>
}): ReactNode {
  const { t } = useApp()
  const client = useQueryClient()
  const [editing, setEditing] = useState(false)
  const [value, setValue] = useState('')
  const [error, setError] = useState<string | undefined>(undefined)
  const save = useMutation({
    mutationFn: () => setAmazonOwnAsins(assignment, value),
    onSuccess: async (r) => {
      if (!r.ok) {
        setError(r.message)
        return
      }
      setError(undefined)
      setEditing(false)
      await client.invalidateQueries({ queryKey: amazonListingKey(assignment) })
    },
  })
  return (
    <div className="flex flex-col gap-1 text-xs" data-testid="alst-own">
      <div className="flex min-w-0 items-center gap-2">
        <span className="shrink-0 text-muted-foreground">{t('alst.own')}</span>
        <span className="min-w-0 flex-1 truncate font-mono" data-testid="alst-own-list">
          {own.length === 0 ? t('alst.own.none') : own.map((o) => o.asin).join('、')}
        </span>
        {editing ? null : (
          <button
            type="button"
            className="shrink-0 rounded-md border border-ws-line px-1.5 py-0.5 text-xs text-ws-muted-fg hover:bg-ws-surface"
            data-testid="alst-own-edit"
            onClick={() => {
              setValue(own.map((o) => o.asin).join('，'))
              setEditing(true)
            }}
          >
            {t('alst.own.edit')}
          </button>
        )}
      </div>
      {editing ? (
        <div className="flex items-center gap-1.5">
          <input
            className="min-w-0 flex-1 rounded-md border border-ws-line bg-transparent px-2 py-1 font-mono text-xs"
            value={value}
            placeholder={t('alst.own.placeholder')}
            onChange={(e) => setValue(e.target.value)}
            data-testid="alst-own-input"
          />
          <Button
            size="xs"
            disabled={save.isPending}
            onClick={() => save.mutate()}
            data-testid="alst-own-save"
          >
            {t('alst.own.save')}
          </Button>
        </div>
      ) : null}
      {error === undefined ? null : <p className="text-ws-bad">{error}</p>}
    </div>
  )
}

// WP395 留的「Listing 体检」空块换上真内容
registerAmazonBlockBody('listing', ListingCheckupBlock)
