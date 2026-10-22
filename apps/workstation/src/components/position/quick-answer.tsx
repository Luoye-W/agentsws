/**
 * WP291（决策 356）：岗位页输入框下面的**当场回答**——一句话 + 组件（docs/96 §4.2：表格清单、数字…）。
 *
 * - 正在查：一行灰字（问的那句）+ 三个点；
 * - 答了：一句话、组件、「依据」小链接（读了哪些数据）；下面「接着聊」「当成任务做」，右上角「关掉」；
 * - 没跑成：一句人话 +「重试」；
 * - 判成会话 / 任务：马上进它的线程（这里不画）。
 *
 * 界面少字：不加标题、不加说明段。同一时间只留最近一个；刷新后在岗位「记录」里找。
 */
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { X } from 'lucide-react'
import { type ReactNode, useEffect, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { AnswerComponents } from '@/components/answer/answer-view'
import { GenuiHostProvider } from '@/components/answer/genui/genui-host'
import { Button } from '@/components/ui/button'
import { SafeMarkdown } from '@/components/ui/safe-markdown'
import { HandoffError } from '@/components/work/handoff-error'
import { continueQuickAnswer, postMatterMessage, promoteAskMatter } from '@/lib/api'
import { useApp } from '@/lib/app-context'
import { RAIL_KEY } from '@/lib/work-archive'
import { askAtPosition, closeQuickAnswer, useQuickAnswer } from './quick-answer-store'

export function QuickAnswer({
  position,
  role_id,
}: {
  position: string
  /** WP412：职责页上只出在这条职责上问的那一条（岗位页不给 = 这个岗位上的都出）。 */
  role_id?: string
}): ReactNode {
  const { t } = useApp()
  const navigate = useNavigate()
  const client = useQueryClient()
  const here = useQuickAnswer(position)
  const entry = role_id === undefined || here?.role_id === role_id ? here : undefined
  /** 「依据」展开的是哪一条（换了一条回答就收起） */
  const [basisFor, setBasisFor] = useState<number | undefined>(undefined)

  // 判成会话 / 任务：马上进它的线程（不静默只加一行）
  useEffect(() => {
    // 答了：第三栏「记录」里多一条
    if (entry?.status === 'done') void client.invalidateQueries({ queryKey: ['position-answers'] })
    if (entry?.status !== 'thread' || entry.matter_id === undefined) return
    closeQuickAnswer(entry.nonce)
    void client.invalidateQueries({ queryKey: ['position-instance'] })
    void client.invalidateQueries({ queryKey: ['position-work'] })
    void client.invalidateQueries({ queryKey: RAIL_KEY })
    navigate(`/matters/${entry.matter_id}`)
  }, [entry, navigate, client])

  const goThread = (matter_id: string): void => {
    void client.invalidateQueries({ queryKey: RAIL_KEY })
    void client.invalidateQueries({ queryKey: ['position-instance'] })
    void client.invalidateQueries({ queryKey: ['position-work'] })
    closeQuickAnswer()
    navigate(`/matters/${matter_id}`)
  }
  const chat = useMutation({
    mutationFn: (matter_id: string) => continueQuickAnswer(matter_id),
    onSuccess: (_out, matter_id) => {
      goThread(matter_id)
    },
  })
  /** WP341（决策 847）：回答里「接着问」的按钮——转进这件事的线程、把那句话说进去，人接着在线程里看。 */
  const follow = useMutation({
    mutationFn: async ({ matter_id, text }: { matter_id: string; text: string }) => {
      await continueQuickAnswer(matter_id)
      await postMatterMessage(matter_id, text)
    },
    onSuccess: (_out, { matter_id }) => {
      goThread(matter_id)
    },
  })
  const task = useMutation({
    mutationFn: (matter_id: string) => promoteAskMatter(matter_id, { run: true }),
    onSuccess: (_out, matter_id) => {
      goThread(matter_id)
    },
  })

  if (entry === undefined || entry.status === 'thread' || entry.status === 'choice') return null
  const retry = (): void => {
    void askAtPosition({
      position,
      text: entry.question,
      ...(entry.summary === undefined ? {} : { summary: entry.summary }),
      ...(entry.role_id === undefined ? {} : { role_id: entry.role_id }),
      // 当场问答没跑成再来一次：不再判一次
      ...(entry.status === 'done' ? { mode: 'quick' as const } : {}),
    })
  }
  const close = (
    <button
      type="button"
      aria-label={t('answer.close')}
      title={t('answer.close')}
      data-testid="quick-answer-close"
      className="inline-flex size-6 shrink-0 items-center justify-center rounded-md text-ws-muted-fg hover:bg-ws-surface hover:text-ws-ink"
      onClick={() => {
        closeQuickAnswer(entry.nonce)
      }}
    >
      <X className="size-3.5" aria-hidden />
    </button>
  )
  const question = (
    <p className="min-w-0 flex-1 truncate text-xs text-ws-muted-fg" title={entry.question}>
      {entry.question}
    </p>
  )

  if (entry.status === 'pending')
    return (
      <div
        className="flex items-center gap-2 px-1"
        data-testid="quick-answer"
        data-state="pending"
        aria-live="polite"
        aria-busy="true"
      >
        {question}
        <span className="inline-flex gap-1" role="img" aria-label={t('answer.pending')}>
          {[0, 1, 2].map((i) => (
            <span
              key={i}
              className="size-1.5 animate-pulse rounded-full bg-ws-muted-fg"
              style={{ animationDelay: `${i * 150}ms` }}
            />
          ))}
        </span>
      </div>
    )

  if (entry.status === 'error')
    return (
      <div className="flex items-center gap-2 px-1" data-testid="quick-answer" data-state="error">
        <HandoffError error={entry.error} className="min-w-0 flex-1 text-xs text-destructive" />
        <Button size="xs" variant="outline" data-testid="quick-answer-retry" onClick={retry}>
          {t('answer.retry')}
        </Button>
        {close}
      </div>
    )

  const answer = entry.answer
  const failed = answer?.outcome === 'failed'
  const lead = answer?.lead ?? answer?.text ?? ''
  const components = answer?.components ?? []
  const sources = answer?.sources ?? []
  const matter_id = entry.matter_id
  const busy = chat.isPending || task.isPending
  const basis = basisFor === entry.nonce
  return (
    <section
      className="flex flex-col gap-3 rounded-xl bg-ws-card p-4 shadow-[inset_0_0_0_1px_var(--ws-line)]"
      data-testid="quick-answer"
      data-state={failed ? 'failed' : 'done'}
      aria-live="polite"
    >
      <div className="flex items-center gap-2">
        {question}
        {close}
      </div>
      {failed ? (
        <div className="flex items-center gap-2">
          <p className="min-w-0 flex-1 text-sm text-ws-bad" data-testid="quick-answer-failed">
            {t('answer.failed', { why: answer?.failure ?? '' })}
          </p>
          <Button size="xs" variant="outline" data-testid="quick-answer-retry" onClick={retry}>
            {t('answer.retry')}
          </Button>
        </div>
      ) : (
        <>
          {lead === '' ? null : (
            // WP295：回话里的站内链接（「导入一张表」等）要能点——同一份安全 markdown，不解析 HTML
            <SafeMarkdown
              text={lead}
              variant="reply"
              className="text-[14px] leading-[1.7] text-ws-ink"
              testId="quick-answer-lead"
            />
          )}
          <GenuiHostProvider
            value={
              matter_id === undefined
                ? {}
                : {
                    say: (text: string) => {
                      follow.mutate({ matter_id, text })
                    },
                    busy: busy || follow.isPending,
                  }
            }
          >
            <AnswerComponents components={components} />
          </GenuiHostProvider>
          {answer?.outcome === 'stopped' ? (
            <p className="text-xs text-ws-warn">{t('answer.stopped')}</p>
          ) : null}
        </>
      )}
      <div className="flex flex-wrap items-center gap-1.5">
        {sources.length === 0 || failed ? null : (
          <button
            type="button"
            aria-expanded={basis}
            data-testid="quick-answer-basis"
            className="text-xs text-ws-muted-fg underline-offset-2 hover:text-ws-ink hover:underline"
            onClick={() => {
              setBasisFor(basis ? undefined : entry.nonce)
            }}
          >
            {t('answer.basis')} · {sources.length}
          </button>
        )}
        <span className="flex-1" />
        {matter_id === undefined || failed ? null : (
          <>
            <Button
              size="xs"
              variant="ghost"
              data-testid="quick-answer-continue"
              disabled={busy}
              onClick={() => {
                chat.mutate(matter_id)
              }}
            >
              {t('answer.continue')}
            </Button>
            <Button
              size="xs"
              variant="ghost"
              data-testid="quick-answer-task"
              disabled={busy}
              onClick={() => {
                task.mutate(matter_id)
              }}
            >
              {t('answer.as_task')}
            </Button>
          </>
        )}
      </div>
      {basis ? (
        <ul
          className="flex flex-col gap-0.5 text-xs text-ws-muted-fg"
          data-testid="quick-answer-sources"
        >
          {sources.map((s) => (
            <li key={s}>· {s}</li>
          ))}
        </ul>
      ) : null}
      <HandoffError error={chat.error ?? task.error} />
    </section>
  )
}
