/**
 * WP188：随便聊里的一条话。
 *
 * 用户那句靠右、一个浅色气泡（带贴进来的图）；回复靠左、走现有的安全 markdown 渲染（WP157）。
 * 回复下面一行小字：用了哪个模型、花了多少（积分或 token）；再下面是来源（联网搜索）与出处（公司资料），
 * 以及两个小动作：复制、重新生成（只有最后一条）。
 *
 * WP343：「交给岗位去做」按钮去掉了——交代事情直接跟助理说（它交给岗位，回复下面一行「已交给 X」）；
 * 交出去的事回来报的那一句画成 {@link ReportNote}；用户那句 `@` 给谁的，气泡上方一个小标。
 *
 * WP350：用户那句附的资料在气泡上方一排小签（名字 · 字数；读不出的那句、抹掉了口令也标出来）；
 * 回复里拆出来的方案卡（{@link FanoutCard}）与点过之后的汇总（{@link FanoutSummary}）。
 */
import { splitGenuiReply } from '@agentsws/contracts'
import {
  ArrowRightLeft,
  AtSign,
  Check,
  Copy,
  FileText,
  Globe,
  Library,
  Loader2,
  RotateCcw,
} from 'lucide-react'
import { useState } from 'react'
import { DispatchLine, ReportNote } from '@/components/free-chat/assistant-bits'
import { FanoutCard, FanoutSummary } from '@/components/free-chat/fanout-card'
import { ChoiceIcon, modelNameOf } from '@/components/free-chat/model-picker'
import { RecallCards } from '@/components/sidebar/recall-cards'
import { Button } from '@/components/ui/button'
import { SafeMarkdown } from '@/components/ui/safe-markdown'
import { setModelDefaults } from '@/lib/api'
import { useApp } from '@/lib/app-context'
import {
  type FreeChatFanoutEdit,
  type FreeChatMessage,
  type FreeChatSource,
  hideRememberTags,
} from '@/lib/free-chat'

export function UserBubble({ message }: { message: FreeChatMessage }): React.ReactNode {
  const { t } = useApp()
  return (
    <div className="flex justify-end" data-testid="free-chat-user">
      <div className="flex max-w-[80%] flex-col items-end gap-1.5">
        {message.to === undefined ? null : (
          <span
            className="inline-flex items-center gap-1 text-xs text-ws-brand-ink"
            data-testid="free-chat-user-to"
          >
            <AtSign aria-hidden className="size-3" />
            {message.to}
          </span>
        )}
        {(message.attachments ?? []).length === 0 ? null : (
          <div className="flex flex-wrap justify-end gap-1.5" data-testid="free-chat-user-docs">
            {(message.attachments ?? []).map((a) => (
              <span
                key={a.name}
                className="inline-flex max-w-[260px] items-center gap-1.5 rounded-md border bg-ws-card px-2 py-1 text-xs"
                data-testid="free-chat-user-doc"
                title={a.unreadable}
              >
                <FileText aria-hidden className="size-3.5 shrink-0 text-muted-foreground" />
                <span className="truncate">{a.name}</span>
                <span className="shrink-0 text-muted-foreground">
                  {a.chars === 0 ? (a.unreadable ?? '') : t('assistant.doc.chars', { n: a.chars })}
                  {a.redacted === undefined ? '' : ` · ${t('assistant.doc.redacted')}`}
                </span>
              </span>
            ))}
          </div>
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
      className="flex items-center gap-1.5 text-xs text-muted-foreground"
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
          className="max-w-[220px] truncate rounded-full border px-2 py-0.5 text-xs text-muted-foreground hover:text-foreground"
          data-testid="free-chat-source"
        >
          {i + 1}. {s.title ?? new URL(s.url).hostname}
        </a>
      ))}
    </div>
  )
}

/**
 * WP425：自己的 AI 用不了、开关「自己的用不了时用工坊积分接着做」关着时的那张卡。
 * 点一下 = 打开开关 + 重答这一轮（以后再遇到也自动切，设置 → 模型里随时关）。
 */
function BackupCard({ onDone }: { onDone: () => void }): React.ReactNode {
  const { t } = useApp()
  const [busy, setBusy] = useState(false)
  const [failed, setFailed] = useState<string | undefined>(undefined)
  return (
    <div
      className="flex flex-wrap items-center justify-between gap-2 rounded-md border bg-ws-card px-3 py-2"
      data-testid="free-chat-backup-card"
    >
      <span className="text-xs text-muted-foreground">
        {failed ?? t('free_chat.backup_card.text')}
      </span>
      <Button
        size="sm"
        disabled={busy}
        data-testid="free-chat-backup-use"
        onClick={() => {
          setBusy(true)
          setFailed(undefined)
          setModelDefaults({ fallback_to_cloud: true })
            .then(() => {
              onDone()
            })
            .catch((e: unknown) => {
              setFailed(e instanceof Error ? e.message : String(e))
            })
            .finally(() => {
              setBusy(false)
            })
        }}
      >
        {t('free_chat.backup_card.use')}
      </Button>
    </div>
  )
}

export function AssistantMessage({
  message,
  live,
  status,
  last,
  onRegenerate,
  onFanout,
  onUndoNotes,
}: {
  message: FreeChatMessage
  /** 还在往外吐字。 */
  live?: boolean
  /** 正在做什么（"正在搜：…"）。 */
  status?: string
  last: boolean
  onRegenerate: () => void
  /** WP350：方案卡上点了「就这样」（带改动）/「不用了」。不给 = 只读。 */
  onFanout?: (
    batch_id: string,
    body: { items?: FreeChatFanoutEdit[]; dismiss?: boolean },
  ) => Promise<void>
  /** WP357（决策 902）：汇总卡上「撤销」那一批写进知识库的口径。不给 = 只读。 */
  onUndoNotes?: (batch_id: string) => Promise<void>
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
      {/* WP425：这一轮从自己的 AI 切到了工坊积分——照实一行 */}
      {message.source_switch === undefined ? null : (
        <p
          className="flex items-center gap-1.5 text-xs text-muted-foreground"
          data-testid="free-chat-source-switch"
        >
          <ArrowRightLeft aria-hidden className="size-3.5" />
          {message.source_switch}
        </p>
      )}
      {text === '' && live === true ? (
        <p className="flex items-center gap-2 text-sm text-muted-foreground">
          <Loader2 aria-hidden className="size-3.5 animate-spin" />
          {status ?? t('free_chat.thinking')}
        </p>
      ) : message.fanout_summary !== undefined ? null : (
        // WP350：汇总那一条的字给 AI 看（下一轮记得派了什么），屏上只出汇总卡（界面少字）
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
      {/* WP425：开关关着停下了——就地一张卡「用工坊积分接着做」（决策 690：配置在对话流里完成） */}
      {message.source_fallback_off === true && last && live !== true ? (
        <BackupCard onDone={onRegenerate} />
      ) : null}
      {message.fanout === undefined ? null : (
        <FanoutCard
          plan={message.fanout}
          {...(onFanout === undefined || live === true
            ? {}
            : {
                onConfirm: (items: FreeChatFanoutEdit[]) =>
                  onFanout(message.fanout?.batch_id ?? '', { items }),
                onDismiss: () => onFanout(message.fanout?.batch_id ?? '', { dismiss: true }),
              })}
        />
      )}
      {message.fanout_summary === undefined ? (
        <DispatchLine dispatches={message.dispatches ?? []} />
      ) : (
        <FanoutSummary
          summary={message.fanout_summary}
          {...(onUndoNotes === undefined
            ? {}
            : { onUndo: () => onUndoNotes(message.fanout_summary?.batch_id ?? '') })}
        />
      )}
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
          className="flex flex-col gap-0.5 text-xs text-muted-foreground"
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
