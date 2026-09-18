/**
 * WP113（63 §6 / §7）：写信 / 回复 / 全部回复 / 转发的那个框。
 *
 * 三条纪律写在这个组件里：
 *
 * 1. **人改完自己点发送**。回复建议点一下进的是这个框（`initialText`），
 *    不是直接发出去——非岗位信件永不自动发。
 * 2. **不出卡**。人自己按的发送不该再问他一遍（36「只有要人拍板的才是卡」）。
 * 3. **草稿自动保存**：停下打字 1.5 秒存一次。关掉窗口、刷新、换一台机器，
 *    写了一半的信都还在——这是普通邮箱的基本盘。
 */
import type { MessageAddress, MessageRecord } from '@agentsws/contracts'
import { Paperclip, Send, X } from 'lucide-react'
import { type ReactNode, useEffect, useRef, useState } from 'react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Textarea } from '@/components/ui/textarea'
import { useApp } from '@/lib/app-context'

export type ComposeMode = 'new' | 'reply' | 'reply_all' | 'forward'

export interface ComposeSeed {
  mode: ComposeMode
  account?: string
  thread_id?: string
  in_reply_to?: string
  to: string
  cc: string
  bcc: string
  subject: string
  text: string
}

/** 回复 / 全部回复 / 转发各自的初值（收件人从**被回的那封**来，不从模型来）。 */
export function seedFrom(
  mode: ComposeMode,
  message: MessageRecord | undefined,
  me: string,
): ComposeSeed {
  if (message === undefined || mode === 'new') {
    return { mode: 'new', to: '', cc: '', bcc: '', subject: '', text: '' }
  }
  const others = (list: readonly MessageAddress[]): string =>
    list
      .map((a) => a.email)
      .filter((e) => e !== me)
      .join(', ')
  const quoted = [
    '',
    '',
    `--- ${message.from.name ?? message.from.email} 写道 ---`,
    message.text,
  ].join('\n')
  const base = {
    ...(message.account === undefined ? {} : { account: message.account }),
    thread_id: message.thread_id,
    ...(message.message_id === undefined ? {} : { in_reply_to: message.message_id }),
  }
  if (mode === 'forward') {
    return {
      ...base,
      mode,
      to: '',
      cc: '',
      bcc: '',
      subject: /^fwd:/i.test(message.subject) ? message.subject : `Fwd: ${message.subject}`,
      text: quoted,
    }
  }
  return {
    ...base,
    mode,
    to: message.from.email,
    cc: mode === 'reply_all' ? others([...message.to, ...message.cc]) : '',
    bcc: '',
    subject: /^re:/i.test(message.subject) ? message.subject : `Re: ${message.subject}`,
    text: quoted,
  }
}

/** `a@b.c, d@e.f` → 地址数组（空的丢掉）。 */
export function parseAddresses(raw: string): { email: string }[] {
  return raw
    .split(/[,;]/)
    .map((s) => s.trim())
    .filter((s) => s !== '')
    .map((email) => ({ email }))
}

export function Composer({
  seed,
  busy,
  onSend,
  onSaveDraft,
  onClose,
}: {
  seed: ComposeSeed
  busy: boolean
  onSend(input: {
    account?: string
    thread_id?: string
    in_reply_to?: string
    to: { email: string }[]
    cc: { email: string }[]
    bcc: { email: string }[]
    subject: string
    text: string
  }): void
  onSaveDraft(input: { subject: string; text: string; to: { email: string }[] }): void
  onClose(): void
}): ReactNode {
  const { t } = useApp()
  const [to, setTo] = useState(seed.to)
  const [cc, setCc] = useState(seed.cc)
  const [bcc, setBcc] = useState(seed.bcc)
  const [subject, setSubject] = useState(seed.subject)
  const [text, setText] = useState(seed.text)
  const [showCc, setShowCc] = useState(seed.cc !== '' || seed.bcc !== '')
  const saved = useRef<string>('')

  // 建议点进来时正文会被换掉：跟着 seed 走（seed 的身份由调用方的 key 决定）
  useEffect(() => {
    setText(seed.text)
  }, [seed.text])

  /** 草稿自动保存：停下打字 1.5 秒存一次，内容没变就不存。 */
  useEffect(() => {
    const snapshot = JSON.stringify({ to, subject, text })
    if (snapshot === saved.current) return
    if (text.trim() === '' && subject.trim() === '') return
    const timer = setTimeout(() => {
      saved.current = snapshot
      onSaveDraft({ subject, text, to: parseAddresses(to) })
    }, 1500)
    return () => {
      clearTimeout(timer)
    }
  }, [to, subject, text, onSaveDraft])

  const canSend = parseAddresses(to).length > 0 && text.trim() !== ''

  return (
    <div
      data-testid="composer"
      data-mode={seed.mode}
      className="flex flex-col gap-2 rounded-[14px] border border-ws-line bg-ws-card p-3 shadow-ws"
    >
      <div className="flex items-center gap-2">
        <span className="text-[13px] font-medium">{t(`messages.compose.${seed.mode}`)}</span>
        <button
          type="button"
          className="ml-auto rounded p-1 text-ws-muted-fg hover:bg-ws-surface"
          aria-label={t('messages.compose.close')}
          data-testid="composer-close"
          onClick={onClose}
        >
          <X aria-hidden className="size-4" />
        </button>
      </div>
      <Input
        aria-label={t('messages.compose.to')}
        data-testid="composer-to"
        placeholder={t('messages.compose.to')}
        value={to}
        onChange={(e) => {
          setTo(e.target.value)
        }}
      />
      {showCc ? (
        <>
          <Input
            aria-label={t('messages.compose.cc')}
            data-testid="composer-cc"
            placeholder={t('messages.compose.cc')}
            value={cc}
            onChange={(e) => {
              setCc(e.target.value)
            }}
          />
          <Input
            aria-label={t('messages.compose.bcc')}
            data-testid="composer-bcc"
            placeholder={t('messages.compose.bcc')}
            value={bcc}
            onChange={(e) => {
              setBcc(e.target.value)
            }}
          />
        </>
      ) : (
        <button
          type="button"
          data-testid="composer-show-cc"
          className="w-fit text-[12px] text-ws-muted-fg hover:text-foreground"
          onClick={() => {
            setShowCc(true)
          }}
        >
          {t('messages.compose.add_cc')}
        </button>
      )}
      <Input
        aria-label={t('messages.compose.subject')}
        data-testid="composer-subject"
        placeholder={t('messages.compose.subject')}
        value={subject}
        onChange={(e) => {
          setSubject(e.target.value)
        }}
      />
      <Textarea
        aria-label={t('messages.compose.body')}
        data-testid="composer-body"
        rows={8}
        value={text}
        onChange={(e) => {
          setText(e.target.value)
        }}
      />
      <div className="flex items-center gap-2">
        <Button
          size="sm"
          data-testid="composer-send"
          disabled={!canSend || busy}
          onClick={() => {
            onSend({
              ...(seed.account === undefined ? {} : { account: seed.account }),
              ...(seed.thread_id === undefined ? {} : { thread_id: seed.thread_id }),
              ...(seed.in_reply_to === undefined ? {} : { in_reply_to: seed.in_reply_to }),
              to: parseAddresses(to),
              cc: parseAddresses(cc),
              bcc: parseAddresses(bcc),
              subject,
              text,
            })
          }}
        >
          <Send aria-hidden className="mr-1 size-3.5" />
          {t('messages.compose.send')}
        </Button>
        {/* 附件收发：发这一侧留在下一波（收那一侧已经能看能下） */}
        <span className="flex items-center gap-1 text-[12px] text-ws-muted-fg">
          <Paperclip aria-hidden className="size-3.5" />
          {t('messages.compose.attach_soon')}
        </span>
        <span className="ml-auto text-[11px] text-ws-muted-fg" data-testid="composer-autosave">
          {t('messages.compose.autosave')}
        </span>
      </div>
    </div>
  )
}
