/**
 * WP459：收件箱第三栏（v2 示意 `inbox-open` / `inbox-open-edit` / `inbox-guess`）。
 *
 * - **回信这类带草稿的卡**（客服回信、催一下、规则起草的回信）：原信 + 草稿 + 通过 / 改 / 不要。
 *   决策 1502 甲：点「改」先**直接改字**，下面一行「或者跟 AI 说怎么改」+ 三颗常用说法；改过字按钮变
 *   「改好了，通过」（`approve` + 改过的那一版，同催促卡就地改）；改的地方记给那个岗位（学习回路照旧）。
 * - **别的卡**（改价、广告改动、挑图、选一个……）：就是岗位卡片流里那张卡（`DeckCardView`），按钮、
 *   排版一模一样——同一个审批项，批了两边一起消失。
 * - **一封要你判断的信**：AI 摘要、类型胶囊（能改判）、原信、三个建议（交给 X ▾ / 只是通知 / 我自己回）。
 * - **AI 猜着交给岗位的**（决策 1498）：列出今天交给了谁、几成把握；展开一封改判：
 *   改给别的岗位 / 我自己处理 / 只是通知，原岗位没批的卡撤掉；「以后都交给 X」默认不勾（决策 1504）。
 */
import type { DeckCard, InboxItem } from '@agentsws/deck'
import { useMutation, useQuery } from '@tanstack/react-query'
import { Sparkles, X } from 'lucide-react'
import { type ReactNode, useEffect, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { deckActionLabel } from '@/components/deck/deck-action-bar'
import { DeckCardView, type DeckDecideRequest } from '@/components/deck/deck-card'
import { DEFAULT_CONTENT_MODE } from '@/components/deck/deck-filters'
import { CategoryTag, StatusPill, WsAvatar } from '@/components/design'
import { HandActions, useMessageOverview } from '@/components/messages/hand-actions'
import { KindChip } from '@/components/messages/kind-chip'
import { closeRightPane } from '@/components/rail/right-pane'
import { type DecideInput, getMessageThread, rehandMessage } from '@/lib/api'
import { useApp } from '@/lib/app-context'
import { apiErrorText } from '@/lib/error-text'
import { useMode } from '@/lib/mode'
import { cn } from '@/lib/utils'
import { matterUrl } from '@/lib/work'
import { type InboxNotice, replySelfUrl } from './inbox-actions'
import {
  draftOf,
  editedPayload,
  itemTitle,
  originalOf,
  positionLabel,
  pushInboxNotice,
  setInboxOpen,
  useDecideCard,
  useInbox,
  useInboxOpen,
  useInboxRefresh,
} from './inbox-model'
import { ItemGlyph, rowPill, rowTag } from './inbox-row'
import { handledByOther, handledText, TeamLine } from './inbox-team'

/** 一张卡带不带「原信 + 草稿」那种排版（有草稿、能批、不是去插件发的）。 */
export function isDraftCard(item: InboxItem): boolean {
  const card = item.card
  return (
    card !== undefined &&
    item.tag !== 'post' &&
    card.layout === 'outbound' &&
    card.available_actions.includes('approve') &&
    draftOf(card) !== undefined
  )
}

function PaneHead({
  icon,
  title,
  onClose,
}: {
  icon: ReactNode
  title: ReactNode
  onClose?: (() => void) | undefined
}): ReactNode {
  const { t } = useApp()
  return (
    <div className="flex items-center gap-2.5 pb-3">
      {icon}
      <h2
        className="min-w-0 flex-1 truncate text-[16px] font-semibold text-ws-ink"
        data-slot="title"
      >
        {title}
      </h2>
      {onClose === undefined ? null : (
        <button
          type="button"
          aria-label={t('inbox.pane.close')}
          data-testid="inbox-pane-close"
          className="grid size-7 place-items-center rounded-[8px] text-ws-muted-fg hover:bg-ws-surface"
          onClick={onClose}
        >
          <X aria-hidden className="size-4" />
        </button>
      )}
    </div>
  )
}

/** 第三栏的身体：按现在开的是哪一件画（宿主是外壳第三栏，或页面里的退路那一栏）。 */
export function InboxPane({
  onNotice,
  inline = false,
}: {
  onNotice(n: InboxNotice): void
  /** 页面里自己画的那一栏（外壳第三栏开不出来时）：头上带一个 ×。 */
  inline?: boolean
}): ReactNode {
  const { t } = useApp()
  const open = useInboxOpen()
  const inbox = useInbox()
  const close = (): void => {
    setInboxOpen(null)
    if (!inline) closeRightPane()
  }
  if (open === null) return null
  if (open.kind === 'guessed')
    return (
      <div data-testid="inbox-pane" data-kind="guessed" className="flex flex-col">
        <GuessPane
          focus={open.message_id}
          onNotice={onNotice}
          onClose={inline ? close : undefined}
        />
      </div>
    )
  const item = inbox.data?.items.find((i) => i.id === open.id)
  if (item === undefined)
    return (
      <div data-testid="inbox-pane" data-kind="gone" className="flex flex-col">
        <PaneHead icon={null} title="" onClose={inline ? close : undefined} />
        <p className="text-[13px] text-ws-muted-fg" data-testid="inbox-pane-gone">
          {inbox.isPending ? '' : goneText(inbox.data, open.id, t)}
        </p>
      </div>
    )
  const head = (
    <PaneHead
      icon={<ItemGlyph item={item} positions={inbox.data?.positions} />}
      title={itemTitle(item)}
      onClose={inline ? close : undefined}
    />
  )
  return (
    <div
      data-testid="inbox-pane"
      data-kind={item.type}
      data-id={item.id}
      className="flex min-h-0 flex-col"
    >
      {head}
      <TeamLine item={item} className="-mt-1 pb-3" />
      {isDraftCard(item) && item.card !== undefined ? (
        <DraftPane
          item={item}
          card={item.card}
          edit={open.edit === true}
          onNotice={onNotice}
          onDone={close}
        />
      ) : (
        <InboxPaneItem item={item} onNotice={onNotice} onDone={close} />
      )}
    </div>
  )
}

/** 开着的这一件没了：同事处理掉的写他的名字（WP510），否则照旧「已经处理完了」。 */
function goneText(
  view: Parameters<typeof handledByOther>[0],
  id: string,
  t: (k: string, v?: Record<string, string | number>) => string,
): string {
  const by = handledByOther(view, id)
  return by === undefined ? t('inbox.pane.gone') : handledText(by, t)
}

/** 一件的身体（不带草稿排版的卡 = 岗位里那张卡；信 = 三个建议那一套）。一张一张里也用它。 */
export function InboxPaneItem({
  item,
  onNotice,
  onDone,
}: {
  item: InboxItem
  onNotice(n: InboxNotice): void
  onDone(): void
}): ReactNode {
  if (item.card === undefined) return <MailPane item={item} onNotice={onNotice} onDone={onDone} />
  return <CardPane card={item.card} onNotice={onNotice} onDone={onDone} />
}

/** 卡头一行：岗位 · 类别 + 状态药丸 +（AI 猜的 · 改）。 */
function CardMeta({ item }: { item: InboxItem }): ReactNode {
  const { t, lang } = useApp()
  const inbox = useInbox()
  const pill = rowPill(item, t)
  const name = positionLabel(inbox.data?.positions, item.position, lang)
  return (
    <div className="flex flex-wrap items-center gap-1.5">
      {name === undefined ? null : <CategoryTag>{name}</CategoryTag>}
      <CategoryTag>{rowTag(item, t)}</CategoryTag>
      {pill === undefined ? (
        <StatusPill tone="warn">{t('inbox.pill.waiting_you')}</StatusPill>
      ) : (
        <StatusPill tone={pill.tone}>{pill.text}</StatusPill>
      )}
      {item.guessed === undefined ? null : (
        <button
          type="button"
          data-testid="inbox-pane-guess"
          className="border-b border-dashed border-ws-faint text-xs text-ws-muted-fg hover:text-ws-ink"
          onClick={() => {
            setInboxOpen({ kind: 'guessed', message_id: item.guessed?.message_id })
          }}
        >
          {t('inbox.guess')}
        </button>
      )}
    </div>
  )
}

/** 1502 甲：原信 + 草稿；「改」先直接改字，下面一行跟 AI 说怎么改。 */
export function DraftPane({
  item,
  card,
  edit,
  onNotice,
  onDone,
  compact = false,
}: {
  item: InboxItem
  card: DeckCard
  edit: boolean
  onNotice(n: InboxNotice): void
  onDone(): void
  /** 一张一张里用：原信和草稿并排、按钮交给外面那一排。 */
  compact?: boolean
}): ReactNode {
  const { t, lang } = useApp()
  const { t: modeT } = useMode()
  const inbox = useInbox()
  const draft = draftOf(card)?.text ?? ''
  const [text, setText] = useState(draft)
  const [editing, setEditing] = useState(edit)
  const [ask, setAsk] = useState('')
  // biome-ignore lint/correctness/useExhaustiveDependencies: 换卡就回到这张卡的草稿
  useEffect(() => {
    setText(draft)
    setEditing(edit)
    setAsk('')
  }, [card.id])
  const decide = useDecideCard()
  const edited = text.trim() !== draft.trim()
  const original = originalOf(card)
  const name = positionLabel(inbox.data?.positions, item.position, lang) ?? ''
  const send = (body: DecideInput, done: string | undefined): void => {
    decide.mutate(
      { card, body },
      {
        onSuccess: () => {
          if (done !== undefined) onNotice({ tone: 'ok', text: done })
          onDone()
        },
        onError: (e) => {
          onNotice({ tone: 'error', text: apiErrorText(e, t) })
        },
      },
    )
  }
  const approve = (): void => {
    send(
      {
        action: 'approve',
        version: card.version,
        ...(edited ? { edited_payload: editedPayload(card, text.trim()) } : {}),
      } as DecideInput,
      undefined,
    )
  }
  const instruct = (words: string): void => {
    if (words.trim() === '') return
    send(
      {
        action: 'instruct',
        version: card.version,
        instruction: { scope: 'single_reply', text: words.trim() },
      },
      t('inbox.pane.asked'),
    )
  }
  const block =
    'rounded-[12px] bg-ws-surface p-3 text-[13px] leading-6 whitespace-pre-wrap text-ws-body'
  return (
    <div
      className="flex flex-col gap-3"
      data-testid="inbox-draft"
      data-editing={editing ? 'true' : 'false'}
    >
      {compact ? null : <CardMeta item={item} />}
      {compact ? null : (
        <p className="text-[16px] font-semibold text-ws-ink" data-testid="inbox-draft-summary">
          {card.summary}
        </p>
      )}
      <div className={cn('grid gap-3', compact && 'md:grid-cols-2')}>
        {original === undefined ? null : (
          <section className="flex min-w-0 flex-col gap-1.5">
            <h3 className="text-xs font-semibold text-ws-muted-fg">
              {t(item.tag === 'nudge' ? 'inbox.pane.last_sent' : 'inbox.pane.original')}
            </h3>
            <p className={block} data-testid="inbox-draft-original">
              {original}
            </p>
          </section>
        )}
        <section className="flex min-w-0 flex-col gap-1.5">
          <h3 className="flex items-center text-xs font-semibold text-ws-muted-fg">
            {t('inbox.pane.draft')}
            {editing ? (
              <span className="ml-auto font-normal">{t('inbox.pane.editing')}</span>
            ) : null}
          </h3>
          {editing ? (
            <textarea
              aria-label={t('inbox.pane.draft')}
              data-testid="inbox-draft-text"
              rows={Math.max(5, text.split('\n').length + 1)}
              className="min-h-32 w-full rounded-[12px] border border-ws-brand bg-ws-card p-3 text-[13px] leading-6 text-ws-body outline-none"
              value={text}
              onChange={(e) => {
                setText(e.target.value)
              }}
            />
          ) : (
            <p
              className={cn(block, 'bg-ws-card shadow-[inset_0_0_0_1px_var(--ws-line)]')}
              data-testid="inbox-draft-view"
            >
              {text}
            </p>
          )}
        </section>
      </div>
      {editing ? (
        <div className="flex flex-col gap-2" data-testid="inbox-draft-ask">
          <div className="flex items-center gap-2 rounded-[12px] bg-ws-card px-3 py-1.5 shadow-[inset_0_0_0_1px_var(--ws-line)]">
            <Sparkles aria-hidden className="size-3.5 shrink-0 text-ws-muted-fg" />
            <input
              data-testid="inbox-draft-ask-input"
              className="min-w-0 flex-1 bg-transparent text-[13px] outline-none placeholder:text-ws-faint"
              placeholder={t('inbox.pane.ask_ai')}
              value={ask}
              onChange={(e) => {
                setAsk(e.target.value)
              }}
              onKeyDown={(e) => {
                if (e.key === 'Enter') instruct(ask)
              }}
            />
            <button
              type="button"
              data-testid="inbox-draft-ask-send"
              className="ws-link shrink-0 text-xs"
              disabled={ask.trim() === '' || decide.isPending}
              onClick={() => {
                instruct(ask)
              }}
            >
              {t('inbox.pane.ask_ai.send')}
            </button>
          </div>
          <div className="flex flex-wrap gap-1.5">
            {(['shorter', 'formal', 'discount'] as const).map((k) => (
              <button
                key={k}
                type="button"
                data-testid={`inbox-draft-chip-${k}`}
                className="ws-btn ws-btn-secondary ws-btn-sm"
                disabled={decide.isPending}
                onClick={() => {
                  instruct(t(`inbox.pane.chip.${k}`))
                }}
              >
                {t(`inbox.pane.chip.${k}`)}
              </button>
            ))}
          </div>
        </div>
      ) : null}
      <div className="mt-1 flex flex-wrap items-center gap-2" data-testid="inbox-draft-actions">
        <button
          type="button"
          data-testid="inbox-draft-approve"
          data-focus-act="approve"
          className="ws-btn ws-btn-primary"
          disabled={decide.isPending || text.trim() === ''}
          onClick={approve}
        >
          {edited ? t('inbox.pane.approve_edited') : deckActionLabel(card, 'approve', modeT)}
        </button>
        <button
          type="button"
          data-testid="inbox-draft-edit"
          data-focus-act="edit"
          className="ws-btn ws-btn-secondary"
          disabled={decide.isPending}
          onClick={() => {
            if (editing) setText(draft)
            setEditing((v) => !v)
          }}
        >
          {editing ? t('inbox.pane.cancel') : t('inbox.menu.edit')}
        </button>
        {card.available_actions.includes('reject') ? (
          <button
            type="button"
            data-testid="inbox-draft-reject"
            data-focus-act="reject"
            className="ws-btn ws-btn-ghost"
            disabled={decide.isPending}
            onClick={() => {
              send({ action: 'reject', version: card.version }, undefined)
            }}
          >
            {deckActionLabel(card, 'reject', modeT)}
          </button>
        ) : null}
        {edited && name !== '' ? (
          <span className="ml-auto text-xs text-ws-faint" data-testid="inbox-draft-note">
            {t('inbox.pane.edit_note', { name })}
          </span>
        ) : null}
      </div>
    </div>
  )
}

/** 别的卡：就是岗位卡片流里那张卡。 */
function CardPane({
  card,
  onNotice,
  onDone,
}: {
  card: DeckCard
  onNotice(n: InboxNotice): void
  onDone(): void
}): ReactNode {
  const { t } = useApp()
  const navigate = useNavigate()
  const decide = useDecideCard()
  const [error, setError] = useState('')
  return (
    <div data-testid="inbox-card" className="min-w-0">
      <DeckCardView
        card={card}
        mode={DEFAULT_CONTENT_MODE}
        busy={decide.isPending}
        error={error}
        onOpen={(c) => {
          navigate(matterUrl(c))
        }}
        onDecide={(req: DeckDecideRequest) => {
          decide.mutate(
            {
              card,
              body: {
                action: req.action,
                version: req.version,
                ...(req.selected_option_id === undefined
                  ? {}
                  : { selected_option_id: req.selected_option_id }),
                ...(req.instruction === undefined ? {} : { instruction: req.instruction }),
                ...(req.reason === undefined ? {} : { reason: req.reason }),
              },
            },
            {
              onSuccess: () => {
                setError('')
                onDone()
              },
              onError: (e) => {
                setError(apiErrorText(e, t))
                onNotice({ tone: 'error', text: apiErrorText(e, t) })
              },
            },
          )
        }}
      />
    </div>
  )
}

/** 一封要你判断的信。 */
function MailPane({
  item,
  onNotice,
  onDone,
}: {
  item: InboxItem
  onNotice(n: InboxNotice): void
  onDone(): void
}): ReactNode {
  const { t } = useApp()
  const navigate = useNavigate()
  const mail = item.mail
  const thread = useQuery({
    queryKey: ['messages', 'thread', mail?.thread_id],
    queryFn: () => getMessageThread(mail?.thread_id ?? ''),
    enabled: mail !== undefined,
  })
  if (mail === undefined) return null
  const latest = thread.data?.messages.find((m) => m.id === mail.message_id)
  return (
    <div className="flex flex-col gap-3" data-testid="inbox-mail">
      <div className="flex flex-wrap items-center gap-1.5">
        <CategoryTag>{rowTag(item, t)}</CategoryTag>
        {mail.kind === undefined ? null : (
          <KindChip
            messageId={mail.message_id}
            kind={mail.kind as never}
            confidence={mail.kind_confidence}
            about={{ from: mail.from.name ?? mail.from.email, subject: mail.subject }}
            onDone={(text, tone) => {
              onNotice({ text, tone })
            }}
          />
        )}
      </div>
      <p className="flex items-start gap-1.5 text-[16px] font-semibold text-ws-ink">
        <Sparkles aria-hidden className="mt-1 size-3.5 shrink-0 text-ws-brand" />
        {mail.summary ?? mail.subject}
      </p>
      <section className="flex flex-col gap-1.5">
        <h3 className="flex items-center text-xs font-semibold text-ws-muted-fg">
          {t('inbox.pane.original')}
          <span className="ml-auto truncate font-normal">{mail.from.email}</span>
        </h3>
        <p
          className="max-h-72 overflow-y-auto rounded-[12px] bg-ws-surface p-3 text-[13px] leading-6 whitespace-pre-wrap text-ws-body"
          data-testid="inbox-mail-text"
        >
          {latest?.text ?? mail.subject}
        </p>
      </section>
      <HandActions
        messageId={mail.message_id}
        kind={mail.kind as never}
        suggest={mail.suggest}
        onDone={(n) => {
          onNotice(n)
          if (n.tone !== 'error') onDone()
        }}
        onSelf={() => {
          navigate(replySelfUrl(mail.thread_id))
        }}
      />
      <button
        type="button"
        className="ws-link w-fit text-xs"
        data-testid="inbox-mail-original"
        onClick={() => {
          navigate(`/messages?view=all&thread=${encodeURIComponent(mail.thread_id)}`)
        }}
      >
        {t('inbox.menu.original')}
      </button>
    </div>
  )
}

/** 1498 / 1504：AI 猜着交给岗位的那几封，展开一封改判。 */
function GuessPane({
  focus,
  onNotice,
  onClose,
}: {
  focus: string | undefined
  onNotice(n: InboxNotice): void
  onClose: (() => void) | undefined
}): ReactNode {
  const { t, lang } = useApp()
  const inbox = useInbox()
  const overview = useMessageOverview()
  const refresh = useInboxRefresh()
  const rows = inbox.data?.guessed ?? []
  const [openId, setOpenId] = useState<string | undefined>(focus ?? rows[0]?.message_id)
  useEffect(() => {
    if (focus !== undefined) setOpenId(focus)
  }, [focus])
  const name = (id: string): string =>
    positionLabel(inbox.data?.positions, id, lang) ??
    overview.data?.positions.find((p) => p.id === id)?.[lang === 'en' ? 'name_en' : 'name_zh'] ??
    id
  return (
    <div className="flex flex-col gap-3">
      <PaneHead
        icon={<Sparkles aria-hidden className="size-4 text-ws-brand" />}
        title={
          <>
            {t('inbox.guess.title')}
            <span className="ml-2 text-[13px] font-normal text-ws-faint">
              {t('inbox.guess.today', { n: inbox.data?.brief.guessed ?? rows.length })}
            </span>
          </>
        }
        onClose={onClose}
      />
      {rows.length === 0 ? (
        <p className="text-[13px] text-ws-muted-fg">{t('inbox.guess.empty')}</p>
      ) : (
        <div className="ws-group" data-testid="inbox-guess-list">
          {rows.map((g) => {
            const who = g.from.name ?? g.from.email
            const expanded = openId === g.message_id
            return (
              <div
                key={g.message_id}
                className="border-t border-ws-line first:border-t-0"
                data-testid="inbox-guess-row"
                data-id={g.message_id}
              >
                <button
                  type="button"
                  className="flex w-full items-center gap-3 px-4 py-3 text-left hover:bg-ws-surface"
                  aria-expanded={expanded}
                  onClick={() => {
                    setOpenId(expanded ? undefined : g.message_id)
                  }}
                >
                  <WsAvatar name={who} id={g.from.email} className="size-7 shrink-0" />
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-[13px] font-semibold text-ws-ink">
                      {who} · {g.subject}
                    </span>
                    <span className="block truncate text-xs text-ws-muted-fg">
                      → {name(g.position)} · {Math.round(g.confidence * 100)}%
                    </span>
                  </span>
                  <span className="ws-link text-xs">{t('inbox.guess.change')}</span>
                </button>
                {expanded ? (
                  <Rehand
                    row={g}
                    current={g.position}
                    who={who}
                    name={name}
                    onDone={(n) => {
                      onNotice(n)
                      refresh()
                    }}
                  />
                ) : null}
              </div>
            )
          })}
        </div>
      )}
      <p className="text-xs text-ws-faint">{t('inbox.guess.learn_note')}</p>
    </div>
  )
}

function Rehand({
  row,
  current,
  who,
  name,
  onDone,
}: {
  row: { message_id: string }
  current: string
  who: string
  name(id: string): string
  onDone(n: InboxNotice): void
}): ReactNode {
  const { t } = useApp()
  const overview = useMessageOverview()
  const targets = (overview.data?.positions ?? []).filter((p) => p.open && p.id !== current)
  type Choice = { to: 'position'; id: string } | { to: 'me' } | { to: 'notice' }
  const [choice, setChoice] = useState<Choice | undefined>(
    targets[0] === undefined ? { to: 'me' } : { to: 'position', id: targets[0].id },
  )
  const [remember, setRemember] = useState(false)
  useEffect(() => {
    if (choice === undefined && targets[0] !== undefined)
      setChoice({ to: 'position', id: targets[0].id })
  }, [choice, targets])
  const mutation = useMutation({
    mutationFn: (c: Choice) =>
      rehandMessage(row.message_id, {
        to: c.to,
        ...(c.to === 'position' ? { position_id: c.id } : {}),
        ...(c.to === 'position' && remember ? { remember_sender: true } : {}),
      }),
    onSuccess: (out, c) => {
      if (!out.handed_off) {
        onDone({ tone: 'warn', text: out.refused ?? t('error.generic') })
        return
      }
      const text =
        c.to === 'position'
          ? t('inbox.guess.done', { name: name(c.id), n: out.withdrawn })
          : t('inbox.guess.done_self', { n: out.withdrawn })
      onDone({
        tone: 'ok',
        text:
          out.learned === true && c.to === 'position'
            ? `${text}。${t('inbox.guess.learned', { name: name(c.id) })}`
            : text,
      })
    },
    onError: (e) => {
      onDone({ tone: 'error', text: apiErrorText(e, t) })
    },
  })
  const opt = (
    key: string,
    on: boolean,
    label: ReactNode,
    note: ReactNode,
    pick: () => void,
  ): ReactNode => (
    // biome-ignore lint/a11y/useSemanticElements: 和 `OptionGroup` 同一种单选行（整行可点、带说明），不是原生单选框
    <button
      key={key}
      type="button"
      role="radio"
      aria-checked={on}
      data-testid={`inbox-rehand-${key}`}
      data-on={on ? 'true' : 'false'}
      className="ws-opt text-left"
      onClick={pick}
    >
      <span className="ws-opt-radio" data-on={on ? 'true' : 'false'} />
      <span className="flex-1 text-[13px]">{label}</span>
      {note === null ? null : <span className="text-xs text-ws-faint">{note}</span>}
    </button>
  )
  const submitName =
    choice?.to === 'position'
      ? name(choice.id)
      : choice?.to === 'notice'
        ? t('inbox.guess.notice')
        : t('inbox.guess.self')
  return (
    <div className="flex flex-col gap-2.5 px-4 pb-4 pl-14" data-testid="inbox-rehand">
      <p className="text-xs text-ws-muted-fg">{t('inbox.guess.to')}</p>
      <div role="radiogroup" className="ws-opts flex flex-col">
        {targets.map((p) =>
          opt(p.id, choice?.to === 'position' && choice.id === p.id, name(p.id), null, () => {
            setChoice({ to: 'position', id: p.id })
          }),
        )}
        {opt('me', choice?.to === 'me', t('inbox.guess.self'), t('inbox.guess.self.note'), () => {
          setChoice({ to: 'me' })
        })}
        {opt('notice', choice?.to === 'notice', t('inbox.guess.notice'), null, () => {
          setChoice({ to: 'notice' })
        })}
      </div>
      {choice?.to === 'position' ? (
        <label className="flex items-center gap-2 text-[13px] text-ws-body">
          <input
            type="checkbox"
            data-testid="inbox-rehand-remember"
            checked={remember}
            onChange={(e) => {
              setRemember(e.target.checked)
            }}
          />
          {t('inbox.guess.remember', { who, name: name(choice.id) })}
        </label>
      ) : null}
      <div className="flex flex-wrap items-center gap-2">
        <button
          type="button"
          data-testid="inbox-rehand-submit"
          className="ws-btn ws-btn-primary ws-btn-sm"
          disabled={choice === undefined || mutation.isPending}
          onClick={() => {
            if (choice !== undefined) mutation.mutate(choice)
          }}
        >
          {choice?.to === 'position' ? t('inbox.guess.submit', { name: submitName }) : submitName}
        </button>
        <span className="text-xs text-ws-faint">
          {t('inbox.guess.withdraw_note', { name: name(current) })}
        </span>
      </div>
    </div>
  )
}

/** 外壳第三栏里那一格（`builtin-panels.tsx` 注册）；没开着哪一件就把自己收起。 */
export function InboxPaneBody(): ReactNode {
  const open = useInboxOpen()
  useEffect(() => {
    if (open === null) closeRightPane()
  }, [open])
  // 那一句话交给收件箱页底下的提示条（第三栏里不另放）
  return <InboxPane onNotice={pushInboxNotice} />
}
