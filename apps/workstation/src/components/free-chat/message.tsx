/**
 * WP188：随便聊里的一条话。
 *
 * 用户那句靠右、一个浅色气泡（带贴进来的图）；回复靠左、走现有的安全 markdown 渲染（WP157）。
 * 回复下面一行小字：用了哪个模型、花了多少（积分或 token）；再下面是来源（联网搜索）与出处（公司资料），
 * 以及两个小动作：复制、重新生成（只有最后一条）。
 *
 * WP343：「交给岗位去做」按钮去掉了——交代事情直接跟助理说（它交给岗位，回复下面一行「已交给 X」）；
 * 交出去的事回来报的那一句画成 {@link ReportNote}；用户那句 `@` 给谁的，气泡上方一个小标。
 */
import { splitGenuiReply } from '@agentsws/contracts'
import { AtSign, Check, Copy, Globe, Library, Loader2, RotateCcw } from 'lucide-react'
import { useState } from 'react'
import { DispatchLine, ReportNote } from '@/components/free-chat/assistant-bits'
import { ChoiceIcon, modelNameOf } from '@/components/free-chat/model-picker'
import { RecallCards } from '@/components/sidebar/recall-cards'
import { Button } from '@/components/ui/button'
import { SafeMarkdown } from '@/components/ui/safe-markdown'
import { useApp } from '@/lib/app-context'
import { type FreeChatMessage, type FreeChatSource, hideRememberTags } from '@/lib/free-chat'

export function UserBubble({ message }: { message: FreeChatMessage }): React.ReactNode {
  return (
    <div className="flex justify-end" data-testid="free-chat-user">
      <div className="flex max-w-[80%] flex-col items-end gap-1.5">
        {message.to === undefined ? null : (
          <span
            className="inline-flex items-center gap-1 text-[11px] text-ws-brand-ink"
            data-testid="free-chat-user-to"
          >
            <AtSign aria-hidden className="size-3" />
            {message.to}
          </span>
        )}
        {(message.images ?? []).length === 0 ? null : (
          <div className="flex flex-wrap justify-end gap-1.5">
            {(message.images ?? []).map((img, i) => (
              <img
                // biome-ignore lint/suspicious/noArrayIndexKey: 同一条话里的图没有 id，顺序就是身份
                key={i}
                src={`data:${img.mime};base64,${img.data}`}
                alt=""
                className="size-24 rounded-lg border object-cover"
              />
            ))}
          </div>
        )}
        {message.text === '' ? null : (
          <p className="rounded-2xl bg-ws-tint px-3.5 py-2 text-[14px] whitespace-pre-wrap text-foreground">
            {/* WP341：表单交上来的那句只显示摘要（数据段是给 AI 的） */}
            {splitGenuiReply(message.text).text}
          </p>
        )}
      </div>
    </div>
  )
}

/** 一行花费：积分那条写「约 N 积分」，其余写 token 数。 */
export function CostLine({ message }: { message: FreeChatMessage }): React.ReactNode {
  const { t } = useApp()
  const u = message.usage
  if (message.model === undefined) return null
  const cost =
    u === undefined
      ? ''
      : u.credits !== undefined
        ? t('free_chat.cost.credits', { n: u.credits })
        : t('free_chat.cost.tokens', { n: u.input_tokens + u.output_tokens })
  return (
    <p
      className="flex items-center gap-1.5 text-[11px] text-muted-foreground"
      data-testid="free-chat-cost"
      data-slot="status"
    >
      <ChoiceIcon choice={message.model} />
      <span>
        {message.model.label} · {modelNameOf(message.model.id)}
      </span>
      {cost === '' ? null : <span>· {cost}</span>}
      {message.stopped === true ? <span>· {t('free_chat.stopped')}</span> : null}
    </p>
  )
}

export function Sources({ sources }: { sources: FreeChatSource[] }): React.ReactNode {
  const { t } = useApp()
  if (sources.length === 0) return null
  return (
    <div className="flex flex-wrap items-center gap-1.5" data-testid="free-chat-sources">
      <Globe aria-label={t('free_chat.sources')} className="size-3.5 text-muted-foreground" />
      {sources.map((s, i) => (
        <a
          key={s.url}
          href={s.url}
          target="_blank"
          rel="noopener noreferrer"
          className="max-w-[220px] truncate rounded-full border px-2 py-0.5 text-[11px] text-muted-foreground hover:text-foreground"
          data-testid="free-chat-source"
        >
          {i + 1}. {s.title ?? new URL(s.url).hostname}
        </a>
      ))}
    </div>
  )
}

export function AssistantMessage({
  message,
  live,
  status,
  last,
  onRegenerate,
}: {
  message: FreeChatMessage
  /** 还在往外吐字。 */
  live?: boolean
  /** 正在做什么（"正在搜：…"）。 */
  status?: string
  last: boolean
  onRegenerate: () => void
}): React.ReactNode {
  const { t } = useApp()
  const [copied, setCopied] = useState(false)
  // WP343：交出去的事回来报的一句——不是模型答的，画成一条小通知
  if (message.report !== undefined) return <ReportNote message={message} />
  const text = hideRememberTags(message.text)
  return (
    <div
      className="flex flex-col gap-1.5"
      data-testid="free-chat-assistant"
      data-live={live === true}
    >
      {text === '' && live === true ? (
        <p className="flex items-center gap-2 text-sm text-muted-foreground">
          <Loader2 aria-hidden className="size-3.5 animate-spin" />
          {status ?? t('free_chat.thinking')}
        </p>
      ) : (
        <SafeMarkdown text={text} className="text-[14px] leading-6" testId="free-chat-reply" />
      )}
      {live === true && text !== '' && status !== undefined ? (
        <p className="text-xs text-muted-foreground">{status}</p>
      ) : null}
      {message.error === undefined ? null : (
        <p className="text-sm text-destructive" data-testid="free-chat-error">
          {message.error}
        </p>
      )}
      <DispatchLine dispatches={message.dispatches ?? []} />
      <Sources sources={message.sources ?? []} />
      {/* WP207：找回归档的候选卡——点一张放回左栏；不点什么都不恢复 */}
      {(message.archived_candidates ?? []).length === 0 ? null : (
        <div className="flex flex-col gap-1.5" data-testid="free-chat-recall">
          <p className="text-xs text-muted-foreground">{t('free_chat.recall.title')}</p>
          <RecallCards candidates={message.archived_candidates ?? []} />
        </div>
      )}
      {(message.citations ?? []).length === 0 ? null : (
        <ol
          className="flex flex-col gap-0.5 text-[11px] text-muted-foreground"
          data-testid="free-chat-citations"
        >
          {(message.citations ?? []).map((c) => (
            <li key={c.fact_card_id} className="flex gap-1">
              <Library aria-hidden className="mt-0.5 size-3 shrink-0" />
              <span>
                [{c.n}] {c.text}
                {c.source === undefined ? '' : ` — ${c.source}`}
              </span>
            </li>
          ))}
        </ol>
      )}
      {live === true ? null : (
        <div className="flex flex-wrap items-center gap-1">
          <CostLine message={message} />
          <span className="ml-auto flex items-center gap-0.5">
            <Button
              size="icon-xs"
              variant="ghost"
              aria-label={t('free_chat.copy')}
              title={t('free_chat.copy')}
              data-testid="free-chat-copy"
              onClick={() => {
                void globalThis.navigator?.clipboard?.writeText(text).then(() => {
                  setCopied(true)
                  setTimeout(() => setCopied(false), 1500)
                })
              }}
            >
              {copied ? <Check aria-hidden /> : <Copy aria-hidden />}
            </Button>
            {last ? (
              <Button
                size="icon-xs"
                variant="ghost"
                aria-label={t('free_chat.regenerate')}
                title={t('free_chat.regenerate')}
                data-testid="free-chat-regenerate"
                onClick={onRegenerate}
              >
                <RotateCcw aria-hidden />
              </Button>
            ) : null}
          </span>
        </div>
      )}
    </div>
  )
}
