/**
 * WP332（决策 762）：社媒岗位页「没发出去」提醒条——Reddit（插件「填好等人点」）那一条没发出去时出一行：
 * 哪一条 + 照实一句原因 +「再填一次」（同一份已批的草稿再交给插件，不用重批）+ 收起。
 *
 * 出现规则（docs/96 提醒条）：只在出问题时出；同一条写只一行（再填一次不另起一行）；人收起了不再出，
 * 再填又没发出去会重新出；七天前的不出（进度里还在）。正常时一个字都不画。
 *
 * WP432：批过、等你在浏览器插件里发的，顶上一行（插件不自己开页面）；
 * 浏览器里的插件不是新版 / 这几分钟没看到它，就地出「插件要重新加载一下」。
 * WP445（决策 1322）：AI 起草的 Reddit 回帖 / 发帖不在工坊出卡——这一行是「插件里 N 条等你发」（还没审的 + 主管批过的），
 * 点了提示去浏览器插件里发；不是卡。
 * 按钮一排：主按钮「再填一次」+ 灰底「修改」；× 就是「不发了」（悬停说）。
 * WP491（Luoye 10-23）：
 * -「修改」不再就地摊开改字框（WP478）——还原成当初那张审核卡（卡片流里，同一个卡面，带上次的字），这一行收起；
 *   人在卡上改字、批 → 按选路发；卡上不发了 = 不发。
 * -「再填一次」与出卡同一个选路（ego 能用工坊自己在 ego 里发，不能用交给插件并照实说一句）；点了按钮进「在发…」，
 *   这一行接着显示正在用哪条路发，发出去 / 又没发出去照实变。
 */

import { redditWriteNotices } from '@agentsws/contracts'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Loader2, RotateCcw, SendHorizontal, X } from 'lucide-react'
import { type ReactNode, useState } from 'react'
import { ExtensionReloadPrompt } from '@/components/connections/extension-reload'
import { NoticeLine } from '@/components/design/kit'
import { requestCardJump } from '@/components/reports/position-bridge'
import { Button } from '@/components/ui/button'
import { Hint } from '@/components/ui/hint'
import { useApp } from '@/lib/app-context'
import {
  dismissRedditWrite,
  listRedditWrites,
  REDDIT_WRITES_KEY,
  type RedditWriteView,
  refillRedditWrite,
  reviseRedditWrite,
} from '@/lib/reddit-write-api'

/** 用哪一条社媒职责的分配去问（担 Reddit 的那条优先）。 */
export function redditWriteAssignment(
  duties: readonly { role_id: string; assignment_id: string }[],
): string | undefined {
  return (
    duties.find((d) => d.role_id === 'social.reddit') ??
    duties.find((d) => d.role_id.startsWith('social.'))
  )?.assignment_id
}

/** WP491：正在 ego 里发那一行的图标（转圈）。 */
function Spinning({ className }: { className?: string }): ReactNode {
  return <Loader2 className={`${className ?? ''} animate-spin`} />
}

/** 服务端「在 ego 里发」那一句（这一行已经说了走 ego，不再重复）。 */
const EGO_RUNNING = '工坊正在 ego 里发'

/** 最多出几行（再多的进度里看）。 */
const MAX_ROWS = 3

export function RedditWriteNotice({
  duties,
  position,
}: {
  duties: readonly { role_id: string; assignment_id: string }[]
  /** WP491：「修改」还原出来的卡在这个岗位的卡片流里翻到它。 */
  position?: string
}): ReactNode {
  const { t } = useApp()
  const qc = useQueryClient()
  const [go, setGo] = useState(false)
  const assignment = redditWriteAssignment(duties)
  const key = [...REDDIT_WRITES_KEY, assignment ?? '']
  /** WP491：点过「再填一次」的那几条（审批项 → 新那件活），接着在这一行显示走哪条路、发没发出去。 */
  const [tracked, setTracked] = useState<Record<string, string>>({})
  const writes = useQuery({
    queryKey: key,
    queryFn: () => listRedditWrites(assignment ?? ''),
    enabled: assignment !== undefined,
    retry: false,
    // 有正在发的就勤着看（ego 那一趟几十秒就有结局）
    refetchInterval: (q) =>
      (q.state.data?.rows ?? []).some(
        (w) =>
          tracked[w.approval_item_id] === w.job_id && w.state !== 'failed' && w.state !== 'sent',
      )
        ? 5_000
        : 60_000,
  })
  const settle = (): void => void qc.invalidateQueries({ queryKey: key })
  const refill = useMutation({
    mutationFn: (job_id: string) => refillRedditWrite(assignment ?? '', job_id),
    onSuccess: (view) => setTracked((m) => ({ ...m, [view.approval_item_id]: view.job_id })),
    onSettled: settle,
  })
  const revise = useMutation({
    mutationFn: (job_id: string) => reviseRedditWrite(assignment ?? '', job_id),
    onSuccess: (out) => {
      // 牌堆与页头 / 左栏的数一起刷新（同 deck-section 的 refresh；空岗位那一格看的是岗位视图的数）
      for (const k of ['deck', 'home', 'positions', 'position-instance', 'approval'])
        void qc.invalidateQueries({ queryKey: [k] })
      if (position !== undefined) requestCardJump(position, out.approval_item_id)
    },
    onSettled: settle,
  })
  const dismiss = useMutation({
    mutationFn: (job_id: string) => dismissRedditWrite(assignment ?? '', job_id),
    onSettled: settle,
  })
  if (assignment === undefined || writes.data === undefined) return null
  const rows = redditWriteNotices(writes.data.rows, new Date().toISOString())
  // WP491：点过「再填一次」、还没又失败的那几条（失败了回到上面那几行里）
  const going = writes.data.rows.filter(
    (w) => tracked[w.approval_item_id] === w.job_id && w.state !== 'failed',
  )
  // WP445：插件里等你发的（还没审的卡 + 批过、等你打开的；同一张卡只算一条）。老服务没有 `in_plugin` 就数批过的
  const awaiting =
    writes.data.in_plugin ??
    new Set(writes.data.rows.filter((w) => w.state === 'awaiting').map((w) => w.approval_item_id))
      .size
  if (rows.length === 0 && going.length === 0 && awaiting === 0) return null

  const label = (w: RedditWriteView): string =>
    w.label ?? t(`redditw.notice.kind.${w.kind}`, { sub: w.subreddit })
  const busy = refill.isPending || revise.isPending
  const error = refill.error ?? revise.error
  return (
    <div className="flex flex-col gap-1" data-testid="reddit-write-notice">
      {awaiting === 0 ? null : (
        <div
          className="flex flex-col gap-1 rounded-lg bg-ws-surface px-3 py-2 text-sm"
          data-testid="reddit-write-awaiting"
          data-slot="status"
        >
          <div className="flex flex-wrap items-center gap-2">
            <SendHorizontal className="size-4 shrink-0 text-ws-brand" aria-hidden />
            <button
              type="button"
              className="min-w-0 flex-1 truncate text-left hover:underline"
              onClick={() => setGo((v) => !v)}
              data-testid="reddit-write-awaiting-go"
            >
              {t('redditw.awaiting', { n: awaiting })}
            </button>
            <Hint text={t('redditw.awaiting.hint')} />
          </div>
          {go ? (
            <p className="text-xs text-ws-muted-fg" data-testid="reddit-write-awaiting-tip">
              {t('redditw.awaiting.go')}
            </p>
          ) : null}
        </div>
      )}
      {awaiting === 0 ? null : <ExtensionReloadPrompt waiting />}
      {going.map((w) => {
        const sent = w.state === 'sent'
        const ego = w.route === 'ego' && w.state !== 'awaiting'
        const note = sent
          ? undefined
          : (w.route_note ?? (w.message === EGO_RUNNING ? undefined : w.message))
        return (
          <NoticeLine
            key={`go-${w.approval_item_id}`}
            icon={ego && !sent ? Spinning : SendHorizontal}
            tone="info"
            data-testid="reddit-write-going"
            data-route={ego ? 'ego' : 'plugin'}
            data-state={w.state}
            end={
              <button
                type="button"
                className="shrink-0 rounded-md p-1 text-ws-muted-fg hover:bg-ws-hover"
                aria-label={t('redditw.notice.close')}
                onClick={() =>
                  setTracked((m) => {
                    const { [w.approval_item_id]: _drop, ...rest } = m
                    return rest
                  })
                }
                data-testid="reddit-write-going-close"
              >
                <X className="size-3.5" aria-hidden />
              </button>
            }
          >
            {/* 交给插件且有原因（ego 用不了）：那一句已经说了交给插件，不再加前缀 */}
            {!sent && !ego && note !== undefined
              ? `${label(w)} · ${note}`
              : t(
                  sent
                    ? 'redditw.notice.sent'
                    : ego
                      ? 'redditw.notice.via.ego'
                      : 'redditw.notice.via.plugin',
                  {
                    what: label(w),
                  },
                )}
            {note === undefined || (!sent && !ego) ? null : (
              <span className="text-ws-muted-fg"> · {note}</span>
            )}
          </NoticeLine>
        )
      })}
      {rows.slice(0, MAX_ROWS).map((w) => {
        const canEdit = w.can_refill === true && w.text !== undefined
        const mine = refill.isPending && refill.variables === w.job_id
        return (
          // WP456-T2：一行提醒（浅底、黄图标），不再铺一整条黄
          <NoticeLine
            key={w.approval_item_id}
            icon={SendHorizontal}
            data-testid="reddit-write-notice-row"
            data-outcome={w.outcome}
            end={
              <>
                {w.can_refill === true ? (
                  <>
                    <Hint text={t('redditw.notice.refill.hint')} />
                    <Button
                      size="xs"
                      className="gap-1"
                      disabled={busy}
                      onClick={() => refill.mutate(w.job_id)}
                      data-testid="reddit-write-refill"
                    >
                      {mine ? (
                        <Loader2 className="size-3.5 animate-spin" aria-hidden />
                      ) : (
                        <RotateCcw className="size-3.5" aria-hidden />
                      )}
                      {t(mine ? 'redditw.notice.sending' : 'redditw.notice.refill')}
                    </Button>
                    {canEdit ? (
                      <Button
                        size="xs"
                        variant="secondary"
                        disabled={busy}
                        title={t('redditw.notice.edit.hint')}
                        onClick={() => revise.mutate(w.job_id)}
                        data-testid="reddit-write-edit"
                      >
                        {t('redditw.notice.edit')}
                      </Button>
                    ) : null}
                  </>
                ) : null}
                <button
                  type="button"
                  className="shrink-0 rounded-md p-1 text-ws-muted-fg hover:bg-ws-hover"
                  aria-label={t('redditw.notice.dismiss')}
                  title={t('redditw.notice.dismiss.hint')}
                  disabled={dismiss.isPending}
                  onClick={() => dismiss.mutate(w.job_id)}
                  data-testid="reddit-write-dismiss"
                >
                  <X className="size-3.5" aria-hidden />
                </button>
              </>
            }
          >
            {t('redditw.notice.title', { what: label(w) })}
            {w.message === undefined ? null : (
              <span className="text-ws-muted-fg"> · {w.message}</span>
            )}
          </NoticeLine>
        )
      })}
      {rows.length > MAX_ROWS ? (
        <p className="px-1 text-xs text-ws-muted-fg">
          {t('redditw.notice.more', { n: rows.length - MAX_ROWS })}
        </p>
      ) : null}
      {error === null ? null : (
        <p role="alert" className="px-1 text-xs text-destructive" data-testid="reddit-write-error">
          {error.message}
        </p>
      )}
    </div>
  )
}
