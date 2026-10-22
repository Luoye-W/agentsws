/**
 * WP439（docs/108 §5.1.5 / §5.7 ②）：消息页右栏「规则」——**规则清单的骨架**。
 *
 * WP441（docs/108 §5.1）：顶上一个输入框「一句话写规则」（与对话里说的走同一条路：转规则 → 试跑 → 「要建吗」，
 * 点「建」才生效）；「消息规则」一组：能开关、改、删、看最近命中、拖动排序（顺序 = 优先级）；
 * 「系统规则」一组：今天的简报几点发。拿旧版本改的照实回「刚被 X 改过」。
 *
 * 现在只有一组「你教过的发件人」（勾「以后这个发件人都这样」写下的）：每行写发件人（地址或 @域）、类型、
 * 交给谁、最近 30 天命中几次；同事 / 公司模式再写谁教的。可删，删了当场生效（下一封那个发件人重新让 AI 判），
 * 回声「已删，下一封会重新判 · 撤回」。
 *
 * 后面三组的位置留好了：消息规则（108C）、AI 自己学的（108E，`source: 'ai'` 的发件人规则已经会落进这一组）、
 * 系统规则（回信跟进等，108D）。**空组不显示**。同事 / 公司模式（决策 243）谁都能删、留名、通知同岗位，
 * 「刚删的」那一组谁都能撤回。
 *
 * 少字：说明全进问号，行里只留名词和数字。面板头「← 规则」是外壳画的，这里不再写一遍标题。
 */
import type {
  DeletedSenderRule,
  MessageRuleList,
  MessageRuleProposal,
  MessageRuleView,
  SenderRuleList,
  SenderRuleView,
} from '@agentsws/contracts'
import { MESSAGE_RULE_UNDO_DAYS, SENDER_RULE_UNDO_DAYS } from '@agentsws/contracts'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { ChevronDown, GripVertical, Pencil, Sparkles, Trash2, Undo2 } from 'lucide-react'
import { type ReactNode, useEffect, useRef, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { positionName, useMessageOverview } from '@/components/messages/hand-actions'
import { type PendingRuleText, takePendingRuleText } from '@/components/messages/rule-draft-text'
import { RuleProposalView } from '@/components/messages/rule-proposal'
import { PanelError } from '@/components/rail/panel-error'
import { Button } from '@/components/ui/button'
import { Hint } from '@/components/ui/hint'
import { Skeleton } from '@/components/ui/skeleton'
import { Switch } from '@/components/ui/switch'
import {
  decideMessageRuleCard,
  deleteMessageRule,
  deleteMessageSenderRule,
  listMessageLabels,
  listMessageRules,
  listMessageSenderRules,
  proposeMessageRule,
  reorderMessageRules,
  restoreMessageRule,
  restoreMessageSenderRule,
  updateMessageRule,
} from '@/lib/api'
import { useApp } from '@/lib/app-context'
import { apiErrorText } from '@/lib/error-text'
import { cn } from '@/lib/utils'

/** 63 那三条分拣路对应的岗位（老规则只教过路由，没教过岗位）。 */
const POSITION_OF_ROUTE: Readonly<Record<string, string>> = {
  support: 'customer-care',
  kol: 'kol-marketing',
  b2b: 'b2b',
}

/** 清单里的几组（顺序就是画的顺序）。后面几单往这里加数据，组本身已经在了。 */
type GroupId = 'sender' | 'message' | 'ai' | 'system'

interface Group {
  id: GroupId
  rules: SenderRuleView[]
  hint?: string
}

export const RULES_QUERY_KEY = ['messages', 'rules'] as const
/** WP441：消息规则清单。 */
export const MESSAGE_RULES_QUERY_KEY = ['messages', 'message-rules'] as const

type Echo = {
  text: string
  tone: 'ok' | 'error'
  /** 撤回发件人规则（WP439）。 */
  undo?: string
  /** WP441：撤回刚删的消息规则。 */
  undoRule?: string
}

export function MessageRulesPanel(): ReactNode {
  const { t } = useApp()
  const client = useQueryClient()
  const list = useQuery({ queryKey: RULES_QUERY_KEY, queryFn: listMessageSenderRules })
  // WP441：消息规则（没装消息规则的老服务进程回 501：当它是空的，发件人规则照常看）
  const msgRules = useQuery({
    queryKey: MESSAGE_RULES_QUERY_KEY,
    queryFn: () => listMessageRules().catch((): MessageRuleList => ({ rules: [] })),
  })
  const overview = useMessageOverview()
  const [echo, setEcho] = useState<Echo | undefined>(undefined)
  /** WP441：清单里点「改」→ 原话带回顶上的输入框。 */
  const [seed, setSeed] = useState<(PendingRuleText & { n: number }) | undefined>()

  const refresh = (): void => {
    void client.invalidateQueries({ queryKey: ['messages'] })
  }
  const remove = useMutation({
    mutationFn: (id: string) => deleteMessageSenderRule(id),
    onSuccess: (r, id) => {
      setEcho(
        r.deleted
          ? { text: t('message_rules.deleted'), tone: 'ok', undo: id }
          : { text: t('message_rules.deleted'), tone: 'ok' },
      )
    },
    onError: (e) => {
      setEcho({ text: t('message_rules.error', { why: apiErrorText(e, t) }), tone: 'error' })
    },
    onSettled: refresh,
  })
  const restore = useMutation({
    mutationFn: (id: string) => restoreMessageSenderRule(id),
    onSuccess: (r) => {
      setEcho(
        r.restored
          ? { text: t('message_rules.restored'), tone: 'ok' }
          : {
              text: t('message_rules.restore.gone', { days: SENDER_RULE_UNDO_DAYS }),
              tone: 'error',
            },
      )
    },
    onError: (e) => {
      setEcho({ text: t('message_rules.error', { why: apiErrorText(e, t) }), tone: 'error' })
    },
    onSettled: refresh,
  })
  // WP441：撤回刚删的消息规则（7 天内，决策 243）
  const restoreRule = useMutation({
    mutationFn: (id: string) => restoreMessageRule(id),
    onSuccess: (r) => {
      setEcho(
        r.restored
          ? { text: t('message_rules.restored.message'), tone: 'ok' }
          : {
              text: t('message_rules.restore.gone.message', { days: MESSAGE_RULE_UNDO_DAYS }),
              tone: 'error',
            },
      )
    },
    onError: (e) => {
      setEcho({ text: t('message_rules.error', { why: apiErrorText(e, t) }), tone: 'error' })
    },
    onSettled: refresh,
  })
  const busy = remove.isPending || restore.isPending || restoreRule.isPending

  if (list.isPending) return <Skeleton className="m-3 h-40" />
  if (list.error !== null) return <PanelError error={list.error} />
  const data: SenderRuleList = list.data
  const groups = groupsOf(data, t)
  const deleted = data.shared === true ? (data.recently_deleted ?? []) : []
  const deletedRules = msgRules.data?.shared === true ? (msgRules.data.recently_deleted ?? []) : []
  const mrules = msgRules.data?.rules ?? []
  const userRules = mrules.filter((r) => r.system === undefined)
  const systemRules = mrules.filter((r) => r.system !== undefined)

  const renderGroup = (g: Group): ReactNode => (
    <section
      key={g.id}
      className="flex flex-col gap-1.5"
      data-testid="message-rules-group"
      data-group={g.id}
    >
      <h3 className="flex items-center gap-1.5 text-[12px] font-medium text-ws-muted-fg">
        {t(`message_rules.group.${g.id}`)}
        <span className="ws-num">{g.rules.length}</span>
        {g.hint === undefined ? null : <Hint text={g.hint} />}
      </h3>
      <ul className="flex flex-col divide-y divide-ws-line rounded-[12px] border border-ws-line bg-ws-card">
        {g.rules.map((rule) => (
          <RuleRow
            key={rule.id}
            rule={rule}
            shared={data.shared === true}
            positions={overview.data?.positions}
            busy={busy}
            onDelete={() => {
              remove.mutate(rule.id)
            }}
          />
        ))}
      </ul>
    </section>
  )

  return (
    <div className="flex flex-col gap-4 p-3" data-testid="message-rules-panel">
      <RuleComposer
        positions={overview.data?.positions}
        {...(seed === undefined ? {} : { seed })}
        onEcho={(text, tone) => {
          setEcho({ text, tone })
        }}
      />
      {echo === undefined ? null : (
        <div
          role={echo.tone === 'error' ? 'alert' : 'status'}
          data-testid="message-rules-echo"
          data-tone={echo.tone}
          className={cn(
            'flex items-center gap-2 rounded-lg border border-ws-line bg-ws-surface px-2.5 py-1.5 text-[12px]',
            echo.tone === 'error' && 'text-destructive',
          )}
        >
          <span className="min-w-0 flex-1">{echo.text}</span>
          {echo.undo === undefined && echo.undoRule === undefined ? null : (
            <button
              type="button"
              data-testid="message-rules-undo"
              disabled={busy}
              className="shrink-0 font-medium text-ws-brand hover:underline disabled:opacity-60"
              onClick={() => {
                if (echo.undoRule !== undefined) restoreRule.mutate(echo.undoRule)
                else if (echo.undo !== undefined) restore.mutate(echo.undo)
              }}
            >
              {t('message_rules.restore')}
            </button>
          )}
        </div>
      )}

      {groups.length === 0 && deleted.length === 0 && userRules.length === 0 ? (
        <p className="text-[12px] text-ws-muted-fg" data-testid="message-rules-empty">
          {t('message_rules.empty')}
        </p>
      ) : null}

      {groups.filter((g) => g.id === 'sender').map(renderGroup)}
      {userRules.length === 0 ? null : (
        <MessageRuleGroup
          rules={userRules}
          shared={msgRules.data?.shared === true}
          onEdit={(r) => {
            setSeed({ text: r.origin_text, rule_id: r.id, revision: r.revision, n: Date.now() })
          }}
          onEcho={(text, tone, undoRule) => {
            setEcho({ text, tone, ...(undoRule === undefined ? {} : { undoRule }) })
          }}
        />
      )}
      {groups.filter((g) => g.id !== 'sender').map(renderGroup)}

      {systemRules.length === 0 ? null : (
        <SystemRuleGroup
          rules={systemRules}
          onEcho={(text, tone) => {
            setEcho({ text, tone })
          }}
        />
      )}

      {deleted.length === 0 && deletedRules.length === 0 ? null : (
        <section
          className="flex flex-col gap-1.5"
          data-testid="message-rules-group"
          data-group="deleted"
        >
          <h3 className="flex items-center gap-1.5 text-[12px] font-medium text-ws-muted-fg">
            {t('message_rules.group.deleted')}
            <Hint text={t('message_rules.group.deleted.hint', { days: SENDER_RULE_UNDO_DAYS })} />
          </h3>
          <ul className="flex flex-col divide-y divide-ws-line rounded-[12px] border border-dashed border-ws-line">
            {deleted.map((d) => (
              <DeletedRow
                key={d.rule.id}
                row={d}
                busy={busy}
                onRestore={() => {
                  restore.mutate(d.rule.id)
                }}
              />
            ))}
            {deletedRules.map((r) => (
              <DeletedMessageRuleRow
                key={r.id}
                rule={r}
                busy={busy}
                onRestore={() => {
                  restoreRule.mutate(r.id)
                }}
              />
            ))}
          </ul>
        </section>
      )}
    </div>
  )
}

/** 发件人规则按来源分组；空组不画。消息规则 / 系统规则（WP441）各有自己的一组，画在下面。 */
function groupsOf(
  data: SenderRuleList,
  t: (key: string, vars?: Record<string, string | number>) => string,
): Group[] {
  const all: Group[] = [
    {
      id: 'sender',
      rules: data.rules.filter((r) => (r.source ?? 'user') === 'user'),
      hint: t('message_rules.group.sender.hint'),
    },
    {
      id: 'ai',
      rules: data.rules.filter((r) => r.source === 'ai'),
      hint: t('message_rules.group.ai.hint'),
    },
  ]
  return all.filter((g) => g.rules.length > 0)
}

function RuleRow({
  rule,
  shared,
  positions,
  busy,
  onDelete,
}: {
  rule: SenderRuleView
  shared: boolean
  positions: Parameters<typeof positionName>[0]
  busy: boolean
  onDelete(): void
}): ReactNode {
  const { t, lang } = useApp()
  const position =
    rule.position ?? (rule.route === undefined ? undefined : POSITION_OF_ROUTE[rule.route])
  const to =
    position !== undefined
      ? t('message_rules.to', { name: positionName(positions, position, lang) })
      : rule.route === 'inbox'
        ? t('message_rules.inbox')
        : undefined
  const hits = rule.hits_30d ?? 0
  const by =
    !shared || rule.source === 'ai'
      ? undefined
      : rule.by_me === true
        ? t('message_rules.by.me')
        : rule.by_name !== undefined
          ? t('message_rules.by.name', { name: rule.by_name })
          : t('message_rules.by.someone')
  return (
    <li
      className="flex items-start gap-2 px-3 py-2"
      data-testid="message-rule-row"
      data-sender={rule.sender}
    >
      <div className="min-w-0 flex-1">
        <div className="truncate text-[13px] font-medium" title={rule.sender}>
          {rule.sender}
        </div>
        <div className="mt-0.5 flex flex-wrap items-center gap-x-1.5 gap-y-0.5 text-[12px] text-ws-muted-fg">
          {rule.kind === undefined ? null : (
            <span
              className="rounded-full bg-ws-surface px-2 py-px text-xs text-foreground"
              data-testid="message-rule-kind"
            >
              {t(`messages.kind.${rule.kind}`)}
            </span>
          )}
          {to === undefined ? null : <span data-testid="message-rule-to">{to}</span>}
          <span className="ws-num" data-testid="message-rule-hits" data-hits={hits}>
            {hits === 0 ? t('message_rules.hits.none') : t('message_rules.hits', { n: hits })}
          </span>
          {by === undefined ? null : <span data-testid="message-rule-by">{by}</span>}
        </div>
      </div>
      <button
        type="button"
        data-testid="message-rule-delete"
        disabled={busy}
        aria-label={t('message_rules.delete.label', { sender: rule.sender })}
        title={t('message_rules.delete')}
        className="shrink-0 rounded-[8px] p-1.5 text-ws-muted-fg hover:bg-ws-surface hover:text-destructive disabled:opacity-60"
        onClick={onDelete}
      >
        <Trash2 aria-hidden className="size-3.5" />
      </button>
    </li>
  )
}

function DeletedRow({
  row,
  busy,
  onRestore,
}: {
  row: DeletedSenderRule
  busy: boolean
  onRestore(): void
}): ReactNode {
  const { t } = useApp()
  const who =
    row.deleted_by_me === true
      ? t('message_rules.deleted_by.me')
      : row.deleted_by_name !== undefined
        ? t('message_rules.deleted_by.name', { name: row.deleted_by_name })
        : t('message_rules.deleted_by.someone')
  return (
    <li
      className="flex items-center gap-2 px-3 py-2"
      data-testid="message-rule-deleted"
      data-sender={row.rule.sender}
    >
      <div className="min-w-0 flex-1">
        <div className="truncate text-[13px] text-ws-muted-fg line-through" title={row.rule.sender}>
          {row.rule.sender}
        </div>
        <div className="text-[12px] text-ws-muted-fg">{who}</div>
      </div>
      <button
        type="button"
        data-testid="message-rule-restore"
        disabled={busy}
        className="inline-flex shrink-0 items-center gap-1 rounded-[8px] px-2 py-1 text-[12px] font-medium text-ws-brand hover:bg-ws-surface disabled:opacity-60"
        onClick={onRestore}
      >
        <Undo2 aria-hidden className="size-3.5" />
        {t('message_rules.restore')}
      </button>
    </li>
  )
}

/* ── WP441：一句话写规则 ──────────────────────────────────────────────── */

type Positions = Parameters<typeof positionName>[0]

/**
 * 规则面板顶上那个输入框：一句话 → 草案 + 试跑 + 「要建这条规则吗」（同一张卡也进了卡片流）。
 * 「改」一条规则 / 卡片流里点「修改」带着原话回到这里。
 */
function RuleComposer({
  positions,
  seed,
  onEcho,
}: {
  positions: Positions
  /** 清单里点了「改」：带着原话与那条规则进来。 */
  seed?: PendingRuleText & { n: number }
  onEcho(text: string, tone: 'ok' | 'error'): void
}): ReactNode {
  const { t } = useApp()
  const client = useQueryClient()
  const [text, setText] = useState('')
  const [editing, setEditing] = useState<{ rule_id: string; revision: number } | undefined>()
  const [proposal, setProposal] = useState<MessageRuleProposal | undefined>()
  const [decided, setDecided] = useState<'built' | 'dropped' | undefined>()
  const input = useRef<HTMLTextAreaElement>(null)

  // 卡片流里点「修改」带回来的原话（取一次就没了）、清单里点「改」带进来的那一条
  const fill = (p: PendingRuleText): void => {
    setText(p.text)
    setProposal(undefined)
    setEditing(
      p.rule_id !== undefined && p.revision !== undefined
        ? { rule_id: p.rule_id, revision: p.revision }
        : undefined,
    )
    input.current?.focus()
  }
  const fillRef = useRef(fill)
  fillRef.current = fill
  useEffect(() => {
    const p = takePendingRuleText()
    if (p !== undefined) fillRef.current(p)
  }, [])
  const seedN = seed?.n
  const seedRef = useRef(seed)
  seedRef.current = seed
  useEffect(() => {
    // 按 seed.n 认「又点了一次改」
    if (seedN !== undefined && seedRef.current !== undefined) fillRef.current(seedRef.current)
  }, [seedN])

  const propose = useMutation({
    mutationFn: () =>
      proposeMessageRule({
        text: text.trim(),
        ...(editing === undefined ? {} : { rule_id: editing.rule_id, revision: editing.revision }),
      }),
    onSuccess: (r) => {
      setDecided(undefined)
      if (!r.ok) {
        setProposal(undefined)
        onEcho(r.message ?? t('message_rules.propose.failed'), 'error')
        return
      }
      setProposal(r)
    },
    onError: (e) => {
      onEcho(t('message_rules.error', { why: apiErrorText(e, t) }), 'error')
    },
  })
  const decide = useMutation({
    mutationFn: (pick: 'after' | 'after_past' | 'before') =>
      proposal?.card_id === undefined
        ? Promise.reject(new Error(t('message_rules.no_card')))
        : decideMessageRuleCard(proposal.card_id, pick),
    onSuccess: (_r, pick) => {
      setDecided(pick === 'before' ? 'dropped' : 'built')
      if (pick !== 'before') {
        setText('')
        setEditing(undefined)
        onEcho(t(editing === undefined ? 'message_rules.built' : 'message_rules.saved'), 'ok')
      }
    },
    onError: (e) => {
      onEcho(t('message_rules.error', { why: apiErrorText(e, t) }), 'error')
    },
    onSettled: () => {
      void client.invalidateQueries({ queryKey: ['messages'] })
      void client.invalidateQueries({ queryKey: ['deck'] })
    },
  })
  const busy = propose.isPending || decide.isPending

  return (
    <section className="flex flex-col gap-1.5" data-testid="message-rule-composer">
      <h3 className="flex items-center gap-1.5 text-[12px] font-medium text-ws-muted-fg">
        {t(editing === undefined ? 'message_rules.compose' : 'message_rules.compose.edit')}
        <Hint text={t('message_rules.compose.hint')} />
      </h3>
      <form
        className="flex flex-col gap-1.5"
        onSubmit={(e) => {
          e.preventDefault()
          if (text.trim() !== '' && !busy) propose.mutate()
        }}
      >
        <textarea
          ref={input}
          rows={2}
          data-testid="message-rule-input"
          value={text}
          placeholder={t('message_rules.compose.placeholder')}
          className="w-full resize-none rounded-lg border border-ws-line bg-ws-card px-2.5 py-1.5 text-[13px] outline-none focus-visible:border-ws-brand"
          onChange={(e) => {
            setText(e.target.value)
          }}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
              e.preventDefault()
              if (text.trim() !== '' && !busy) propose.mutate()
            }
          }}
        />
        <div className="flex items-center gap-1.5">
          <Button
            type="submit"
            size="sm"
            variant="outline"
            data-testid="message-rule-propose"
            disabled={busy || text.trim() === ''}
          >
            <Sparkles aria-hidden />
            {propose.isPending ? t('message_rules.proposing') : t('message_rules.propose')}
          </Button>
          {editing === undefined ? null : (
            <button
              type="button"
              className="text-[12px] text-ws-muted-fg hover:underline"
              onClick={() => {
                setEditing(undefined)
                setText('')
              }}
            >
              {t('message_rules.compose.cancel_edit')}
            </button>
          )}
        </div>
      </form>
      {proposal?.ok === true && proposal.draft !== undefined && proposal.trial !== undefined ? (
        <RuleProposalView
          name={proposal.draft.name}
          plain={proposal.plain ?? ''}
          trial={proposal.trial}
          editing={proposal.rule_id !== undefined}
          positions={positions}
          busy={busy}
          {...(decided === undefined ? {} : { decided })}
          onBuild={(past) => {
            decide.mutate(past ? 'after_past' : 'after')
          }}
          onEdit={() => {
            // 改一句再试：这张卡先作废（不留两张），原话留在框里
            if (proposal.card_id !== undefined) decide.mutate('before')
            setProposal(undefined)
            input.current?.focus()
          }}
          onDrop={() => {
            decide.mutate('before')
          }}
        />
      ) : null}
    </section>
  )
}

/* ── WP441：消息规则一组（开关、改、删、看最近命中、拖动排序） ───────────── */

function MessageRuleGroup({
  rules,
  shared,
  onEdit,
  onEcho,
}: {
  rules: MessageRuleView[]
  shared: boolean
  onEdit(rule: MessageRuleView): void
  onEcho(text: string, tone: 'ok' | 'error', undoRule?: string): void
}): ReactNode {
  const { t } = useApp()
  const client = useQueryClient()
  const [order, setOrder] = useState<string[] | undefined>()
  const [dragging, setDragging] = useState<string | undefined>()
  const ids = order ?? rules.map((r) => r.id)
  const byId = new Map(rules.map((r) => [r.id, r]))
  const shown = ids.map((id) => byId.get(id)).filter((r): r is MessageRuleView => r !== undefined)

  const refresh = (): void => {
    void client.invalidateQueries({ queryKey: MESSAGE_RULES_QUERY_KEY })
  }
  const reorder = useMutation({
    mutationFn: (next: string[]) => reorderMessageRules(next),
    onSuccess: () => {
      onEcho(t('message_rules.reordered'), 'ok')
    },
    onError: (e) => {
      onEcho(t('message_rules.error', { why: apiErrorText(e, t) }), 'error')
    },
    onSettled: () => {
      setOrder(undefined)
      refresh()
    },
  })
  const move = (id: string, to: number): void => {
    const next = ids.filter((x) => x !== id)
    next.splice(Math.max(0, Math.min(next.length, to)), 0, id)
    if (next.join('|') === ids.join('|')) return
    setOrder(next)
    reorder.mutate(next)
  }

  return (
    <section
      className="flex flex-col gap-1.5"
      data-testid="message-rules-group"
      data-group="message"
    >
      <h3 className="flex items-center gap-1.5 text-[12px] font-medium text-ws-muted-fg">
        {t('message_rules.group.message')}
        <span className="ws-num">{rules.length}</span>
        <Hint text={t('message_rules.group.message.hint')} />
      </h3>
      <ul className="flex flex-col divide-y divide-ws-line rounded-[12px] border border-ws-line bg-ws-card">
        {shown.map((rule, i) => (
          <MessageRuleRow
            key={rule.id}
            rule={rule}
            index={i}
            total={shown.length}
            shared={shared}
            dragging={dragging === rule.id}
            onDragStart={() => {
              setDragging(rule.id)
            }}
            onDragEnd={() => {
              setDragging(undefined)
            }}
            onDropHere={() => {
              if (dragging !== undefined) move(dragging, i)
              setDragging(undefined)
            }}
            onMove={(to) => {
              move(rule.id, to)
            }}
            onEdit={() => {
              onEdit(rule)
            }}
            onEcho={onEcho}
          />
        ))}
      </ul>
    </section>
  )
}

function MessageRuleRow({
  rule,
  index,
  total,
  shared,
  dragging,
  onDragStart,
  onDragEnd,
  onDropHere,
  onMove,
  onEdit,
  onEcho,
}: {
  rule: MessageRuleView
  index: number
  total: number
  shared: boolean
  dragging: boolean
  onDragStart(): void
  onDragEnd(): void
  onDropHere(): void
  onMove(to: number): void
  onEdit(): void
  onEcho(text: string, tone: 'ok' | 'error', undoRule?: string): void
}): ReactNode {
  const { t, lang } = useApp()
  const client = useQueryClient()
  const navigate = useNavigate()
  const overview = useMessageOverview()
  const labels = useQuery({ queryKey: ['messages', 'labels'], queryFn: listMessageLabels })
  const [open, setOpen] = useState(false)
  const refresh = (): void => {
    void client.invalidateQueries({ queryKey: MESSAGE_RULES_QUERY_KEY })
  }
  const toggle = useMutation({
    mutationFn: (enabled: boolean) =>
      updateMessageRule(rule.id, { revision: rule.revision, enabled }),
    onError: (e) => {
      onEcho(t('message_rules.error', { why: apiErrorText(e, t) }), 'error')
    },
    onSettled: refresh,
  })
  const remove = useMutation({
    mutationFn: () => deleteMessageRule(rule.id),
    onSuccess: () => {
      onEcho(t('message_rules.message.deleted', { name: rule.name }), 'ok', rule.id)
    },
    onError: (e) => {
      onEcho(t('message_rules.error', { why: apiErrorText(e, t) }), 'error')
    },
    onSettled: refresh,
  })
  const hits = rule.hits_30d ?? 0
  const by = !shared
    ? undefined
    : rule.by_me === true
      ? t('message_rules.by.me.wrote')
      : rule.by_name !== undefined
        ? t('message_rules.by.name.wrote', { name: rule.by_name })
        : undefined
  const recent = rule.recent_hits ?? []
  return (
    <li
      className={cn('flex flex-col gap-1 px-2 py-2', dragging && 'opacity-50')}
      data-testid="message-rule-item"
      data-rule={rule.id}
      data-enabled={rule.enabled}
      onDragOver={(e) => {
        e.preventDefault()
      }}
      onDrop={(e) => {
        e.preventDefault()
        onDropHere()
      }}
    >
      <div className="flex items-start gap-1.5">
        <button
          type="button"
          draggable
          data-testid="message-rule-drag"
          aria-label={t('message_rules.drag', { name: rule.name })}
          title={t('message_rules.drag.title')}
          className="mt-0.5 shrink-0 cursor-grab rounded-sm p-0.5 text-ws-muted-fg hover:bg-ws-surface active:cursor-grabbing"
          onDragStart={(e) => {
            e.dataTransfer.effectAllowed = 'move'
            e.dataTransfer.setData('text/plain', rule.id)
            onDragStart()
          }}
          onDragEnd={onDragEnd}
          onKeyDown={(e) => {
            if (e.key === 'ArrowUp' && index > 0) {
              e.preventDefault()
              onMove(index - 1)
            }
            if (e.key === 'ArrowDown' && index < total - 1) {
              e.preventDefault()
              onMove(index + 1)
            }
          }}
        >
          <GripVertical aria-hidden className="size-3.5" />
        </button>
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-1.5">
            <span className="ws-num text-ws-tiny text-ws-muted-fg">{index + 1}</span>
            <span className="truncate text-[13px] font-medium" title={rule.origin_text}>
              {rule.name}
            </span>
          </div>
          <div
            className={cn(
              'mt-0.5 line-clamp-2 text-[12px] text-ws-muted-fg',
              !rule.enabled && 'line-through',
            )}
            data-testid="message-rule-plain"
          >
            {ruleLine(rule, t, overview.data?.positions, lang, (id) => {
              const l = labels.data?.labels.find((x) => x.id === id)
              return l === undefined ? id : lang === 'en' ? l.name_en : l.name_zh
            })}
          </div>
          <div className="mt-0.5 flex flex-wrap items-center gap-x-1.5 text-[12px] text-ws-muted-fg">
            <button
              type="button"
              data-testid="message-rule-hits"
              data-hits={hits}
              disabled={recent.length === 0}
              aria-expanded={open}
              className="ws-num inline-flex items-center gap-0.5 enabled:hover:text-foreground"
              onClick={() => {
                setOpen((v) => !v)
              }}
            >
              {hits === 0 ? t('message_rules.hits.none') : t('message_rules.hits', { n: hits })}
              {recent.length === 0 ? null : (
                <ChevronDown aria-hidden className={cn('size-3', open && 'rotate-180')} />
              )}
            </button>
            {by === undefined ? null : <span>{by}</span>}
          </div>
        </div>
        <Switch
          size="sm"
          className="mt-1"
          data-testid="message-rule-toggle"
          checked={rule.enabled}
          disabled={toggle.isPending}
          aria-label={t('message_rules.toggle', { name: rule.name })}
          onCheckedChange={(v) => {
            toggle.mutate(v)
          }}
        />
        <button
          type="button"
          data-testid="message-rule-edit"
          aria-label={t('message_rules.edit.label', { name: rule.name })}
          title={t('message_rules.edit')}
          className="shrink-0 rounded-[8px] p-1.5 text-ws-muted-fg hover:bg-ws-surface hover:text-foreground"
          onClick={onEdit}
        >
          <Pencil aria-hidden className="size-3.5" />
        </button>
        <button
          type="button"
          data-testid="message-rule-remove"
          disabled={remove.isPending}
          aria-label={t('message_rules.delete.rule', { name: rule.name })}
          title={t('message_rules.delete')}
          className="shrink-0 rounded-[8px] p-1.5 text-ws-muted-fg hover:bg-ws-surface hover:text-destructive disabled:opacity-60"
          onClick={() => {
            remove.mutate()
          }}
        >
          <Trash2 aria-hidden className="size-3.5" />
        </button>
      </div>
      {open && recent.length > 0 ? (
        <ul className="ml-6 flex flex-col gap-0.5 text-[12px]" data-testid="message-rule-recent">
          {recent.map((h) => (
            <li key={h.message_id}>
              <button
                type="button"
                className="flex w-full min-w-0 gap-1.5 text-left hover:underline"
                onClick={() => {
                  navigate(`/messages?view=all&thread=${encodeURIComponent(h.thread_id)}`)
                }}
              >
                <span className="min-w-0 flex-1 truncate">{h.subject || h.from}</span>
                <span className="shrink-0 text-ws-muted-fg">{h.from}</span>
              </button>
            </li>
          ))}
        </ul>
      ) : null}
    </li>
  )
}

/** 清单里那一行白话（服务端没给，就按条件 / 动作拼一句短的）。 */
function ruleLine(
  rule: MessageRuleView,
  t: (key: string, vars?: Record<string, string | number>) => string,
  positions: Positions,
  lang: string,
  labelName: (id: string) => string,
): string {
  const cond = rule.when.conditions
    .map((c) =>
      c.type === 'from'
        ? t('message_rules.cond.from', { v: c.value.replace(/^@/, '') })
        : c.type === 'subject_has'
          ? t('message_rules.cond.subject', { v: c.value })
          : c.type === 'body_has'
            ? t('message_rules.cond.body', { v: c.value })
            : c.type === 'kind'
              ? t('message_rules.cond.kind', { v: t(`messages.kind.${c.value}`) })
              : c.type === 'ai'
                ? t('message_rules.cond.ai', { v: c.value })
                : c.type === 'to_account'
                  ? t('message_rules.cond.to', { v: c.value })
                  : c.type === 'source'
                    ? t(`message_rules.cond.source.${c.value}`)
                    : t(c.value ? 'message_rules.cond.attach' : 'message_rules.cond.no_attach'),
    )
    .join(rule.when.match === 'all' ? t('message_rules.cond.and') : t('message_rules.cond.or'))
  const acts = rule.actions
    .map((a) =>
      a.type === 'label'
        ? t('message_rules.act.label', { v: labelName(a.label) })
        : a.type === 'record'
          ? t('message_rules.act.record', { v: a.sink_name ?? '' })
          : a.type === 'hand_to'
            ? t('message_rules.act.hand_to', { v: positionName(positions, a.position_id, lang) })
            : a.type === 'draft'
              ? t('message_rules.act.draft')
              : t(`message_rules.act.${a.type}`),
    )
    .join(t('message_rules.cond.and'))
  return `${cond} → ${acts}`
}

/* ── WP441：系统规则（今天的简报几点发） ───────────────────────────────── */

function SystemRuleGroup({
  rules,
  onEcho,
}: {
  rules: MessageRuleView[]
  onEcho(text: string, tone: 'ok' | 'error'): void
}): ReactNode {
  const { t } = useApp()
  return (
    <section
      className="flex flex-col gap-1.5"
      data-testid="message-rules-group"
      data-group="system"
    >
      <h3 className="flex items-center gap-1.5 text-[12px] font-medium text-ws-muted-fg">
        {t('message_rules.group.system')}
        <Hint text={t('message_rules.group.system.hint')} />
      </h3>
      <ul className="flex flex-col divide-y divide-ws-line rounded-[12px] border border-ws-line bg-ws-card">
        {rules.map((r) => (
          <SystemRuleRow key={r.id} rule={r} onEcho={onEcho} />
        ))}
      </ul>
    </section>
  )
}

function SystemRuleRow({
  rule,
  onEcho,
}: {
  rule: MessageRuleView
  onEcho(text: string, tone: 'ok' | 'error'): void
}): ReactNode {
  const { t } = useApp()
  const client = useQueryClient()
  const save = useMutation({
    mutationFn: (patch: { enabled?: boolean; time?: string }) =>
      updateMessageRule(rule.id, { revision: rule.revision, ...patch }),
    onSuccess: () => {
      onEcho(t('message_rules.saved'), 'ok')
    },
    onError: (e) => {
      onEcho(t('message_rules.error', { why: apiErrorText(e, t) }), 'error')
    },
    onSettled: () => {
      void client.invalidateQueries({ queryKey: MESSAGE_RULES_QUERY_KEY })
    },
  })
  return (
    <li
      className="flex items-center gap-2 px-3 py-2"
      data-testid="message-rule-system"
      data-system={rule.system}
    >
      <div className="min-w-0 flex-1 text-[13px]">
        {t(`message_rules.system.${rule.system ?? 'digest_time'}`)}
      </div>
      {rule.system === 'digest_time' ? (
        <input
          type="time"
          data-testid="message-rule-digest-time"
          defaultValue={rule.time ?? '09:00'}
          aria-label={t('message_rules.system.digest_time.at')}
          className="ws-num rounded-[8px] border border-ws-line bg-ws-card px-1.5 py-0.5 text-[12px]"
          onBlur={(e) => {
            const v = e.target.value
            if (/^\d{2}:\d{2}$/.test(v) && v !== rule.time) save.mutate({ time: v })
          }}
        />
      ) : null}
      <Switch
        size="sm"
        data-testid="message-rule-system-toggle"
        checked={rule.enabled}
        disabled={save.isPending}
        aria-label={t(`message_rules.system.${rule.system ?? 'digest_time'}`)}
        onCheckedChange={(v) => {
          save.mutate({ enabled: v })
        }}
      />
    </li>
  )
}

/** WP441：刚删的一条消息规则（同事 / 公司模式「能撤回」那一格）。 */
function DeletedMessageRuleRow({
  rule,
  busy,
  onRestore,
}: {
  rule: MessageRuleView
  busy: boolean
  onRestore(): void
}): ReactNode {
  const { t } = useApp()
  const who =
    rule.deleted_by_me === true
      ? t('message_rules.deleted_by.me')
      : rule.deleted_by_name !== undefined
        ? t('message_rules.deleted_by.name', { name: rule.deleted_by_name })
        : t('message_rules.deleted_by.someone')
  return (
    <li
      className="flex items-center gap-2 px-3 py-2"
      data-testid="message-rule-deleted"
      data-rule={rule.id}
    >
      <div className="min-w-0 flex-1">
        <div
          className="truncate text-[13px] text-ws-muted-fg line-through"
          title={rule.origin_text}
        >
          {rule.name}
        </div>
        <div className="text-[12px] text-ws-muted-fg">{who}</div>
      </div>
      <button
        type="button"
        data-testid="message-rule-restore"
        disabled={busy}
        className="inline-flex shrink-0 items-center gap-1 rounded-[8px] px-2 py-1 text-[12px] font-medium text-ws-brand hover:bg-ws-surface disabled:opacity-60"
        onClick={onRestore}
      >
        <Undo2 aria-hidden className="size-3.5" />
        {t('message_rules.restore')}
      </button>
    </li>
  )
}
