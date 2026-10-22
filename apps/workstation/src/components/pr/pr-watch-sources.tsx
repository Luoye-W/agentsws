/**
 * WP386：信息监控的**多条监控源**——连接页那张 Google Alerts 卡、对话里的连接卡、右栏连接卡共用这一块。
 *
 * 一句汇总（「17 条 · 1 条拉不到」）+ 每条一行（拉不到的亮红点、悬停看一句人话）+ 贴 RSS 的格子（一次可以贴一批）。
 * 界面少字：怎么建 Google 提醒只给「看教程」，步骤在教程里（`conn-google`）。
 */
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { X } from 'lucide-react'
import { type ReactNode, useState } from 'react'
import { TutorialLink } from '@/components/help/tutorial-link'
import { whenLabel } from '@/components/rail/card-status'
import { Button } from '@/components/ui/button'
import { Hint } from '@/components/ui/hint'
import { Textarea } from '@/components/ui/textarea'
import { getPositions } from '@/lib/api'
import { useApp } from '@/lib/app-context'
import {
  addPrWatchLinks,
  getPrWatch,
  monitorAssignmentOf,
  PR_WATCH_KEY,
  type PrWatchLinkResult,
  type PrWatchSourceRow,
  type PrWatchView,
  removePrWatchSource,
  runPrWatch,
} from '@/lib/pr-watch-api'
import { cn } from '@/lib/utils'
import { PrAlertsActions } from './pr-alerts-actions'

/** 本人「信息监控」那条职责的分配（给了岗位就只在那个岗位里找）。 */
export function useMonitorAssignment(position_id?: string): string | undefined {
  const positions = useQuery({ queryKey: ['positions'], queryFn: getPositions, staleTime: 60_000 })
  return monitorAssignmentOf(positions.data?.instances, position_id)
}

/** 信息监控那一块的数据（没担这条职责就不发请求）。 */
export function usePrWatch(assignment: string | undefined): PrWatchView | undefined {
  const q = useQuery({
    queryKey: [...PR_WATCH_KEY, assignment ?? ''],
    queryFn: () => getPrWatch(assignment as string),
    enabled: assignment !== undefined,
    retry: false,
    staleTime: 30_000,
  })
  return q.data
}

function SourceRow({ row, onRemove }: { row: PrWatchSourceRow; onRemove: () => void }): ReactNode {
  const { t } = useApp()
  const failed = row.status === 'failed' && row.paused !== true
  const meta =
    row.paused === true
      ? t('prwatch.paused')
      : failed
        ? t('prwatch.failed')
        : row.last_ok_at === undefined
          ? t('prwatch.unchecked')
          : t('prwatch.ok_at', { when: whenLabel(row.last_ok_at, t), n: row.last_fetched ?? 0 })
  return (
    <li
      className="group flex min-w-0 items-center gap-2 py-1 text-[13px]"
      data-testid="prwatch-source"
      data-status={failed ? 'failed' : row.status}
    >
      <i
        aria-hidden
        className={cn(
          'size-1.5 shrink-0 rounded-full',
          failed ? 'bg-ws-bad' : row.status === 'ok' ? 'bg-ws-good' : 'bg-ws-muted-fg/40',
        )}
      />
      <span className="shrink-0 text-xs text-ws-muted-fg">{t(`prwatch.group.${row.group}`)}</span>
      <span className="min-w-0 truncate text-ws-body">{row.label}</span>
      {row.every_hours < 24 ? (
        <span className="shrink-0 text-xs text-ws-muted-fg">{t('prwatch.boosted')}</span>
      ) : null}
      <span
        className={cn(
          'ml-auto shrink-0 text-xs ws-num',
          failed ? 'text-ws-bad' : 'text-ws-muted-fg',
        )}
      >
        {meta}
      </span>
      {failed && row.last_error !== undefined ? <Hint text={row.last_error} /> : null}
      <button
        type="button"
        className="shrink-0 rounded p-0.5 text-ws-muted-fg opacity-0 hover:text-ws-bad group-hover:opacity-100 focus:opacity-100"
        aria-label={t('prwatch.remove')}
        data-testid="prwatch-remove"
        onClick={onRemove}
      >
        <X className="size-3" />
      </button>
    </li>
  )
}

/**
 * 监控源清单 + 贴 RSS。`assignment` 是本人「信息监控」那条职责的分配；没有就照实说一句。
 * `compact`：右栏 / 对话卡里那一版（不出「现在拉一轮」）。
 */
export function PrWatchSources({
  assignment,
  compact = false,
}: {
  assignment: string | undefined
  compact?: boolean
}): ReactNode {
  const { t } = useApp()
  const qc = useQueryClient()
  const view = usePrWatch(assignment)
  const [text, setText] = useState('')
  const [results, setResults] = useState<PrWatchLinkResult[]>([])
  const [note, setNote] = useState<string | undefined>()
  const key = [...PR_WATCH_KEY, assignment ?? '']
  const refresh = (next: PrWatchView): void => {
    qc.setQueryData(key, next)
    void qc.invalidateQueries({ queryKey: ['position-connections'] })
  }
  const add = useMutation({
    mutationFn: () => addPrWatchLinks(assignment as string, { links: text }),
    onSuccess: (r) => {
      setResults(r.results)
      if (r.results.every((x) => x.ok)) setText('')
      refresh(r.view)
    },
  })
  const run = useMutation({
    mutationFn: () => runPrWatch(assignment as string),
    onSuccess: (r) => {
      setNote(r.message)
      refresh(r.view)
    },
  })
  const remove = useMutation({
    mutationFn: (id: string) => removePrWatchSource(assignment as string, id),
    onSuccess: refresh,
  })
  if (assignment === undefined)
    return <p className="text-xs text-ws-muted-fg">{t('prwatch.not_held')}</p>
  const sources = view?.sources ?? []
  return (
    <div className="flex flex-col gap-2" data-testid="prwatch-sources">
      <div className="flex items-center gap-2 text-[13px]">
        {view?.failed !== undefined && view.failed > 0 ? (
          <i
            aria-hidden
            className="size-1.5 rounded-full bg-ws-bad"
            data-testid="prwatch-red-dot"
          />
        ) : null}
        <span className="font-medium text-ws-body" data-testid="prwatch-summary">
          {view?.summary ?? t('prwatch.empty')}
        </span>
        {view?.next_run_at === undefined ? null : (
          <span className="text-xs text-ws-muted-fg">
            {t('prwatch.next', { when: whenLabel(view.next_run_at, t) })}
          </span>
        )}
        {/* 连接页那张卡头上已经有「看教程」；右栏 / 对话卡里这一版自己带一个 */}
        {compact ? <TutorialLink slug="conn-google" className="ml-auto" /> : null}
      </div>
      {sources.length === 0 ? null : (
        <ul className="flex max-h-56 flex-col overflow-y-auto">
          {sources.map((s) => (
            <SourceRow
              key={s.id}
              row={s}
              onRemove={() => {
                remove.mutate(s.id)
              }}
            />
          ))}
        </ul>
      )}
      <Textarea
        value={text}
        rows={compact ? 2 : 3}
        placeholder={t('prwatch.paste.placeholder')}
        data-testid="prwatch-paste"
        onChange={(e) => {
          setText(e.target.value)
        }}
      />
      <div className="flex items-center gap-2">
        <Button
          size="sm"
          disabled={text.trim() === '' || add.isPending}
          data-testid="prwatch-add"
          onClick={() => {
            add.mutate()
          }}
        >
          {add.isPending ? t('prwatch.paste.adding') : t('prwatch.paste.add')}
        </Button>
        {compact || sources.length === 0 ? null : (
          <Button
            size="sm"
            variant="outline"
            disabled={run.isPending}
            data-testid="prwatch-run"
            onClick={() => {
              run.mutate()
            }}
          >
            {run.isPending ? t('prwatch.running') : t('prwatch.run')}
          </Button>
        )}
      </div>
      {/* WP387：让工坊替你建 / 读一遍我已有的（你的浏览器去做，建之前再问一次） */}
      <PrAlertsActions assignment={assignment} />
      {results.length === 0 && note === undefined ? null : (
        <ul className="flex flex-col gap-0.5 text-xs" data-testid="prwatch-results">
          {results.map((r, i) => (
            <li
              // biome-ignore lint/suspicious/noArrayIndexKey: 一次贴一批，回执按顺序
              key={i}
              className={r.ok ? 'text-ws-good' : 'text-ws-bad'}
              data-ok={r.ok ? 'true' : 'false'}
            >
              {r.message}
            </li>
          ))}
          {note === undefined ? null : <li className="text-ws-muted-fg">{note}</li>}
        </ul>
      )}
    </div>
  )
}

/** S5：Google 账号这一步（连接卡上那一块）。登在用户自己的浏览器里，服务端看不见——登好了点「接着做」。 */
export function GoogleAccountStep(): ReactNode {
  const { t } = useApp()
  return (
    <div className="flex flex-col gap-1.5 text-xs" data-testid="google-account-step">
      <p className="text-ws-body">{t('google_account.line')}</p>
      <div className="flex items-center gap-3">
        <a
          href="https://accounts.google.com/"
          target="_blank"
          rel="noreferrer"
          className="text-ws-brand underline-offset-4 hover:underline"
        >
          {t('google_account.open')}
        </a>
        <TutorialLink slug="conn-google" />
      </div>
    </div>
  )
}
