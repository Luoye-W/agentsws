/**
 * WP439（docs/108 §5.1.5 / §5.7 ②）：消息页右栏「规则」——**规则清单的骨架**。
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
import type { DeletedSenderRule, SenderRuleList, SenderRuleView } from '@agentsws/contracts'
import { SENDER_RULE_UNDO_DAYS } from '@agentsws/contracts'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Trash2, Undo2 } from 'lucide-react'
import { type ReactNode, useState } from 'react'
import { positionName, useMessageOverview } from '@/components/messages/hand-actions'
import { PanelError } from '@/components/rail/panel-error'
import { Hint } from '@/components/ui/hint'
import { Skeleton } from '@/components/ui/skeleton'
import {
  deleteMessageSenderRule,
  listMessageSenderRules,
  restoreMessageSenderRule,
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

type Echo = { text: string; tone: 'ok' | 'error'; undo?: string }

export function MessageRulesPanel(): ReactNode {
  const { t } = useApp()
  const client = useQueryClient()
  const list = useQuery({ queryKey: RULES_QUERY_KEY, queryFn: listMessageSenderRules })
  const overview = useMessageOverview()
  const [echo, setEcho] = useState<Echo | undefined>(undefined)

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
  const busy = remove.isPending || restore.isPending

  if (list.isPending) return <Skeleton className="m-3 h-40" />
  if (list.error !== null) return <PanelError error={list.error} />
  const data: SenderRuleList = list.data
  const groups = groupsOf(data, t)
  const deleted = data.shared === true ? (data.recently_deleted ?? []) : []

  return (
    <div className="flex flex-col gap-4 p-3" data-testid="message-rules-panel">
      {echo === undefined ? null : (
        <div
          role={echo.tone === 'error' ? 'alert' : 'status'}
          data-testid="message-rules-echo"
          data-tone={echo.tone}
          className={cn(
            'flex items-center gap-2 rounded-[10px] border border-ws-line bg-ws-surface px-2.5 py-1.5 text-[12px]',
            echo.tone === 'error' && 'text-destructive',
          )}
        >
          <span className="min-w-0 flex-1">{echo.text}</span>
          {echo.undo === undefined ? null : (
            <button
              type="button"
              data-testid="message-rules-undo"
              disabled={busy}
              className="shrink-0 font-medium text-ws-brand hover:underline disabled:opacity-60"
              onClick={() => {
                const id = echo.undo
                if (id !== undefined) restore.mutate(id)
              }}
            >
              {t('message_rules.restore')}
            </button>
          )}
        </div>
      )}

      {groups.length === 0 && deleted.length === 0 ? (
        <p className="text-[12px] text-ws-muted-fg" data-testid="message-rules-empty">
          {t('message_rules.empty')}
        </p>
      ) : null}

      {groups.map((g) => (
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
      ))}

      {deleted.length === 0 ? null : (
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
          </ul>
        </section>
      )}
    </div>
  )
}

/** 按来源分组；空组不画。消息规则 / 系统规则还没有数据（后面几单接上），这里先留好位置。 */
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
    { id: 'message', rules: [] },
    {
      id: 'ai',
      rules: data.rules.filter((r) => r.source === 'ai'),
      hint: t('message_rules.group.ai.hint'),
    },
    { id: 'system', rules: [] },
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
