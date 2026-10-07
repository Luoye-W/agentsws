/**
 * WP255（决策 144）：「回复」——自家版待处理每一条、社群线程列表每一条都有这一个按钮。
 *
 * 点开是一个小输入框：可以先让 AI 起草一句（人改），「出卡」走 `POST /v1/social/threads/:id/reply`
 * → 一张回帖卡进上面的卡片流，**不直接发**。承诺话术被服务端打回时，原因就地显示在框里。
 *
 * 界面少字：按钮一个词，说明进问号。对方的原话不在这里重复（行上已经有了）。
 */
import { useMutation } from '@tanstack/react-query'
import { Reply, Send, Sparkles } from 'lucide-react'
import { type ReactNode, useRef, useState } from 'react'
import { Button } from '@/components/ui/button'
import { Hint } from '@/components/ui/hint'
import { Textarea } from '@/components/ui/textarea'
import { ApiClientError } from '@/lib/api'
import { useApp } from '@/lib/app-context'
import { draftSocialReply, replySocialThread } from '@/lib/social-reply-api'

export function ReplyButton({
  threadId,
  resolveThread,
  assignment,
  disabled = false,
  onStaged,
}: {
  /** 社媒库里的线程 id（社群线程列表那一条就有）。 */
  threadId?: string
  /** 没有现成线程 id 时（自家版队列那一条）：第一次起草 / 出卡前取一次。 */
  resolveThread?: () => Promise<string>
  assignment: string
  disabled?: boolean
  onStaged?: () => void
}): ReactNode {
  const { t } = useApp()
  const [open, setOpen] = useState(false)
  const [text, setText] = useState('')
  const [template, setTemplate] = useState(false)
  const [warning, setWarning] = useState<string | undefined>(undefined)
  const [error, setError] = useState<string | undefined>(undefined)
  const [staged, setStaged] = useState(false)
  const resolved = useRef<string | undefined>(threadId)

  const idOf = async (): Promise<string> => {
    if (resolved.current !== undefined) return resolved.current
    if (resolveThread === undefined) throw new Error('no thread')
    resolved.current = await resolveThread()
    return resolved.current
  }
  const say = (e: unknown, key: 'reply.rejected' | 'reply.failed'): void => {
    const rejected = e instanceof ApiClientError && e.status === 400
    setError(
      t(rejected ? 'reply.rejected' : key, { message: e instanceof Error ? e.message : String(e) }),
    )
  }

  const draft = useMutation({
    mutationFn: async () => draftSocialReply(await idOf(), assignment),
    onSuccess: (res) => {
      setText(res.text)
      setTemplate(res.source === 'template')
      setWarning(res.warning)
      setError(undefined)
    },
    onError: (e) => {
      say(e, 'reply.failed')
    },
  })
  const submit = useMutation({
    mutationFn: async () => replySocialThread(await idOf(), text.trim(), assignment),
    onSuccess: (res) => {
      if (!res.staged) {
        setError(t('reply.failed', { message: res.message ?? '' }))
        return
      }
      setStaged(true)
      setOpen(false)
      onStaged?.()
    },
    onError: (e) => {
      say(e, 'reply.failed')
    },
  })

  if (staged)
    return (
      <span className="text-xs text-ws-muted-fg" data-testid="reply-staged">
        {t('reply.staged')}
      </span>
    )

  const busy = draft.isPending || submit.isPending
  return (
    <>
      <Button
        size="xs"
        variant={open ? 'secondary' : 'ghost'}
        disabled={disabled}
        aria-expanded={open}
        data-testid="reply-open"
        onClick={() => {
          setOpen((o) => !o)
        }}
      >
        <Reply className="size-3.5" aria-hidden />
        {t('reply.button')}
      </Button>
      {open ? (
        <div
          className="flex basis-full flex-col gap-1.5 rounded-md border bg-background p-2"
          data-testid="reply-box"
        >
          <Textarea
            className="min-h-16 text-sm"
            aria-label={t('reply.label')}
            placeholder={t('reply.placeholder')}
            value={text}
            maxLength={4000}
            data-testid="reply-text"
            onChange={(e) => {
              setText(e.target.value)
              setWarning(undefined)
              setError(undefined)
            }}
          />
          {template ? (
            <p className="text-xs text-ws-muted-fg" data-testid="reply-template">
              {t('reply.template')}
            </p>
          ) : null}
          {warning === undefined ? null : (
            <p className="text-xs text-ws-warn" data-testid="reply-warning">
              {t('reply.warning', { message: warning })}
            </p>
          )}
          {error === undefined ? null : (
            <p className="text-xs text-ws-bad" role="alert" data-testid="reply-error">
              {error}
            </p>
          )}
          <div className="flex flex-wrap items-center gap-1.5">
            <Button
              size="xs"
              variant="outline"
              disabled={busy}
              data-testid="reply-draft"
              onClick={() => {
                draft.mutate()
              }}
            >
              <Sparkles className="size-3.5" aria-hidden />
              {t('reply.draft')}
            </Button>
            <Button
              size="xs"
              disabled={busy || text.trim() === ''}
              data-testid="reply-submit"
              onClick={() => {
                submit.mutate()
              }}
            >
              <Send className="size-3.5" aria-hidden />
              {t('reply.submit')}
            </Button>
            <Button
              size="xs"
              variant="ghost"
              onClick={() => {
                setOpen(false)
              }}
            >
              {t('reply.cancel')}
            </Button>
            <Hint text={t('reply.hint')} />
          </div>
        </div>
      ) : null}
    </>
  )
}
