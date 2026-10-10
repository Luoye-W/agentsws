/**
 * WP288（决策 326，Luoye 10-09）：**「记录」从岗位页 / 职责页的页签挪进第三栏**——
 * 「这个岗位或职责」那一组的一个图标面板，跟着当前岗位 / 职责走（面板头可切岗位层 / 职责层）。
 *
 * - 岗位层：本人在这个岗位下每条职责的记录合在一起（同一条只列一次），再加上 ① 个人模式下
 *   不出卡、只记在这里的复盘（WP287；有卡的那份已经是一行卡记录，不重复列）；
 * - 职责层：那一条职责的记录。
 * - WP291：岗位层再加上本人在这个岗位上的**当场问答**（问的那句 + 一句话回答，点了看那一问一答）——
 *   岗位页上同一时间只留最近一个回答，刷新后就到这里找。
 *
 * 原来两页各写了一份（岗位页 `RecordRows`、职责页 `RecordsTab`），这里合成一份。
 */
import { useQueries, useQuery } from '@tanstack/react-query'
import type { ReactNode } from 'react'
import { Link } from 'react-router-dom'
import type { RailPanelBodyProps } from '@/components/rail/registry'
import { Skeleton } from '@/components/ui/skeleton'
import { getPositionAnswers, getPositionRecords, listReviews } from '@/lib/api'
import { useApp } from '@/lib/app-context'
import { formatDate } from '@/lib/format'
import { approvalStateLabel } from '@/lib/humanize'

interface Row {
  id: string
  at: string
  kind: string
  title: string
  summary: string
  state?: string | undefined
  /** WP291：点了去哪儿（当场问答 → 那一问一答的线程） */
  href?: string | undefined
}

export function RecordsPanel({ scope }: RailPanelBodyProps): ReactNode {
  const { t, lang } = useApp()
  const assignments =
    scope === undefined
      ? []
      : scope.tier === 'position'
        ? [...(scope.assignments ?? (scope.assignment === undefined ? [] : [scope.assignment]))]
        : scope.assignment === undefined
          ? []
          : [scope.assignment]
  const records = useQueries({
    queries: assignments.map((a) => ({
      queryKey: ['records', a],
      queryFn: () => getPositionRecords(a),
    })),
  })
  /* WP287：复盘在 ① 个人模式下不出卡，只记在这里——只在岗位层列（复盘按人，不按职责） */
  const withReviews = scope?.tier === 'position'
  const reviews = useQuery({
    queryKey: ['reviews', 'day'],
    queryFn: listReviews,
    enabled: withReviews,
  })
  const answerOf = withAnswersOf(scope, assignments)
  const answers = useQuery({
    queryKey: ['position-answers', answerOf],
    queryFn: () => getPositionAnswers(answerOf as string),
    enabled: answerOf !== undefined,
  })
  if (records.some((r) => r.isPending)) return <Skeleton className="h-40 w-full" />

  const seen = new Set<string>()
  const recordRows: Row[] = records
    .flatMap((r) => r.data?.payload?.rows ?? [])
    .filter((row) => {
      if (seen.has(row.id)) return false
      seen.add(row.id)
      return true
    })
  const reviewRows: Row[] = withReviews
    ? (reviews.data?.reviews ?? [])
        .filter((r) => r.approval_item_id === undefined)
        .map((r) => ({
          id: r.id,
          at: r.created_at,
          kind: 'review',
          title: t('records.review.title', { you: r.cards.you_handled, ai: r.cards.ai_handled }),
          summary: t('records.review.summary', {
            done: r.todos.done,
            total: r.todos.total,
            meetings: r.meetings.count,
          }),
        }))
    : []
  const answerRows: Row[] = (answers.data?.answers ?? []).map((a) => ({
    id: `answer:${a.matter_id}`,
    at: a.at,
    kind: 'answer',
    title: a.question,
    summary: a.lead,
    href: `/matters/${a.matter_id}`,
  }))
  const rows = [...recordRows, ...reviewRows, ...answerRows].sort((a, b) =>
    b.at.localeCompare(a.at),
  )
  if (rows.length === 0)
    return (
      <p className="text-sm text-muted-foreground" data-testid="records-empty">
        —
      </p>
    )
  return (
    <ol className="flex flex-col gap-3" data-testid="records">
      {rows.map((row) => (
        <li key={row.id} className="border-l pl-3">
          <div className="flex flex-wrap items-baseline gap-2 text-xs text-muted-foreground">
            <time dateTime={row.at}>{formatDate(row.at, lang)}</time>
            <span>{t(`kind.${row.kind}`)}</span>
            {row.state === undefined ? null : <span>{approvalStateLabel(row.state, lang)}</span>}
          </div>
          {row.href === undefined ? (
            <div className="text-sm">{row.title}</div>
          ) : (
            <Link
              to={row.href}
              className="text-sm underline-offset-2 hover:underline"
              data-testid="records-answer"
            >
              {row.title}
            </Link>
          )}
          <p className="text-xs text-muted-foreground">{row.summary}</p>
        </li>
      ))}
    </ol>
  )
}

/** WP291：岗位层才列当场问答（按岗位查；拿本人在这个岗位的任一条分配当钥匙）。 */
function withAnswersOf(
  scope: RailPanelBodyProps['scope'],
  assignments: readonly string[],
): string | undefined {
  return scope?.tier === 'position' ? assignments[0] : undefined
}
