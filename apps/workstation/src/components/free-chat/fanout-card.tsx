/**
 * WP350（决策 900）：「我的助理」一次拆成多份——对话里的两张卡。
 *
 * - {@link FanoutCard}「我打算这样分」：按岗位分组，每组列要做的事、要记的口径；品牌公共、你的习惯、
 *   归属待定各一组。归属待定的那几条**一直**带一个「交给谁？」下拉（不挑不发）；「改一下」才给每条加上
 *   勾选、改归属、改文字。底部「就这样」「改一下」，「不用了」在旁边。不让人逐个岗位去点（与 WP348 方案卡同一个样子）。
 *   出现：助理这一轮拆出了东西。点过之后只读（标「已派出」/「没派」）。
 * - {@link FanoutSummary} 汇总：派了哪几个岗位几件事（点了进那件事）、各进了几条知识、
 *   记下你的几条习惯、没发几条。出现：方案卡点了「就这样」之后。WP357（决策 902）：知识点「就这样」就生效，
 *   不再「去确认」；右下角「撤销这 N 条知识」（点两下才撤：先变「确定撤销」）与「去知识库」，撤过的标「已撤销」。
 *
 * 界面少字：原文出处一行、灰字、超长截断（悬停看全文）。
 */
import { Building2, CheckCircle2, CircleHelp, FileText, KeyRound, User } from 'lucide-react'
import { useState } from 'react'
import { Link } from 'react-router-dom'
import { Button } from '@/components/ui/button'
import { useApp } from '@/lib/app-context'
import type {
  FreeChatFanout,
  FreeChatFanoutEdit,
  FreeChatFanoutItem,
  FreeChatFanoutSummary,
} from '@/lib/free-chat'
import { cn } from '@/lib/utils'

/** 人改过之后的这一条（归属 / 文字 / 勾掉）。 */
function effective(item: FreeChatFanoutItem, edit: FreeChatFanoutEdit | undefined) {
  const owner =
    item.kind === 'memory'
      ? 'mine'
      : item.secret === true
        ? 'secret'
        : edit?.brand === true
          ? 'brand'
          : edit?.position_id !== undefined
            ? `p:${edit.position_id}`
            : item.brand === true
              ? 'brand'
              : item.position_id !== undefined
                ? `p:${item.position_id}`
                : 'unsure'
  return { owner, text: edit?.text ?? item.text, dropped: edit?.drop === true }
}

const ORDER = (owner: string): number =>
  owner.startsWith('p:')
    ? 0
    : owner === 'brand'
      ? 1
      : owner === 'mine'
        ? 2
        : owner === 'unsure'
          ? 3
          : 4

function Row({
  item,
  plan,
  edit,
  editing,
  locked,
  onEdit,
}: {
  item: FreeChatFanoutItem
  plan: FreeChatFanout
  edit: FreeChatFanoutEdit | undefined
  editing: boolean
  locked: boolean
  onEdit: (next: FreeChatFanoutEdit) => void
}): React.ReactNode {
  const { t } = useApp()
  const now = effective(item, edit)
  const unsure = now.owner === 'unsure'
  const canMove = !locked && item.kind !== 'memory' && item.secret !== true && (editing || unsure)
  return (
    <li
      className={cn('flex flex-col gap-0.5 py-1.5', now.dropped && 'opacity-50')}
      data-testid="fanout-item"
      data-kind={item.kind}
      data-owner={now.owner}
      data-dropped={now.dropped}
    >
      <div className="flex items-start gap-2">
        {editing && !locked && item.secret !== true ? (
          <input
            type="checkbox"
            className="mt-1"
            checked={!now.dropped}
            aria-label={now.text}
            data-testid="fanout-item-keep"
            onChange={(e) => onEdit({ ...edit, id: item.id, drop: !e.target.checked })}
          />
        ) : null}
        <span
          className={cn(
            'mt-0.5 shrink-0 rounded-sm px-1.5 py-px text-xs',
            item.kind === 'task'
              ? 'bg-ws-tint text-ws-brand-ink'
              : 'bg-ws-surface text-ws-muted-fg',
          )}
        >
          {t(`fanout.kind.${item.kind}`)}
        </span>
        {editing && !locked && item.secret !== true ? (
          <input
            className="min-w-0 flex-1 rounded-sm border border-ws-line bg-transparent px-1.5 py-0.5 text-sm"
            value={now.text}
            data-testid="fanout-item-text"
            onChange={(e) => onEdit({ ...edit, id: item.id, text: e.target.value })}
          />
        ) : (
          <span
            className={cn(
              'min-w-0 flex-1 text-sm break-words text-ws-ink',
              (item.secret === true || now.dropped) && 'line-through',
            )}
          >
            {now.text}
          </span>
        )}
        {item.due === undefined ? null : (
          <span className="shrink-0 text-xs text-ws-warn">
            {t('fanout.due', { due: item.due })}
          </span>
        )}
        {canMove ? (
          <select
            className="max-w-[140px] shrink-0 rounded-sm border border-ws-line bg-transparent px-1 py-0.5 text-xs"
            value={now.owner === 'unsure' ? '' : now.owner}
            aria-label={t('fanout.unsure.pick')}
            data-testid="fanout-item-owner"
            onChange={(e) => {
              const v = e.target.value
              const { position_id: _p, brand: _b, ...rest } = edit ?? { id: item.id }
              if (v === 'brand') onEdit({ ...rest, id: item.id, brand: true })
              else if (v.startsWith('p:')) onEdit({ ...rest, id: item.id, position_id: v.slice(2) })
            }}
          >
            {now.owner === 'unsure' ? <option value="">{t('fanout.unsure.pick')}</option> : null}
            {plan.positions.map((p) => (
              <option key={p.position_id} value={`p:${p.position_id}`}>
                {p.name}
              </option>
            ))}
            {item.kind === 'note' ? <option value="brand">{t('fanout.brand')}</option> : null}
          </select>
        ) : null}
      </div>
      {item.quote === undefined || item.quote === now.text ? null : (
        <p
          className="truncate pl-10 text-[12px] text-ws-muted-fg"
          title={item.quote}
          data-testid="fanout-item-quote"
        >
          “{item.quote}”
        </p>
      )}
    </li>
  )
}

export function FanoutCard({
  plan,
  onConfirm,
  onDismiss,
}: {
  plan: FreeChatFanout
  onConfirm?: (edits: FreeChatFanoutEdit[]) => Promise<void>
  onDismiss?: () => Promise<void>
}): React.ReactNode {
  const { t } = useApp()
  const [edits, setEdits] = useState<Record<string, FreeChatFanoutEdit>>({})
  const [editing, setEditing] = useState(false)
  const [saving, setSaving] = useState(false)
  const locked = plan.status !== 'proposed' || onConfirm === undefined
  const nameOf = (owner: string): string =>
    owner === 'brand'
      ? t('fanout.brand')
      : owner === 'mine'
        ? t('fanout.mine')
        : owner === 'unsure'
          ? t('fanout.unsure')
          : owner === 'secret'
            ? t('fanout.secret')
            : (plan.positions.find((p) => `p:${p.position_id}` === owner)?.name ??
              plan.items.find((i) => `p:${i.position_id}` === owner)?.position_name ??
              owner)
  const groups = new Map<string, FreeChatFanoutItem[]>()
  for (const item of plan.items) {
    const owner = effective(item, edits[item.id]).owner
    groups.set(owner, [...(groups.get(owner) ?? []), item])
  }
  const ordered = [...groups].sort((a, b) => ORDER(a[0]) - ORDER(b[0]))
  const live = plan.items.filter((i) => {
    const e = effective(i, edits[i.id])
    return !e.dropped && e.owner !== 'unsure' && e.owner !== 'secret'
  })
  const run = async (fn: () => Promise<void>): Promise<void> => {
    setSaving(true)
    try {
      await fn()
    } finally {
      setSaving(false)
    }
  }
  const Icon = (owner: string) =>
    owner === 'brand'
      ? Building2
      : owner === 'mine'
        ? User
        : owner === 'unsure'
          ? CircleHelp
          : owner === 'secret'
            ? KeyRound
            : null
  return (
    <div
      className="flex flex-col gap-2 rounded-xl border bg-ws-card p-3"
      data-testid="fanout-card"
      data-status={plan.status}
    >
      <div className="flex items-center gap-2">
        <p className="text-sm font-medium text-ws-ink">{t('fanout.title')}</p>
        <span className="inline-flex min-w-0 items-center gap-1 truncate text-[12px] text-ws-muted-fg">
          <FileText aria-hidden className="size-3.5 shrink-0" />
          <span className="truncate">{plan.title}</span>
        </span>
        {plan.status === 'proposed' ? null : (
          <span
            className="ml-auto shrink-0 rounded-full bg-ws-surface px-2 py-px text-xs text-ws-muted-fg"
            data-testid="fanout-status"
          >
            {t(plan.status === 'sent' ? 'fanout.sent' : 'fanout.dismissed')}
          </span>
        )}
      </div>
      <div className="flex flex-col gap-2">
        {ordered.map(([owner, items]) => {
          const GroupIcon = Icon(owner)
          return (
            <section key={owner} data-testid="fanout-group" data-owner={owner}>
              <p className="flex items-center gap-1 text-xs font-medium text-ws-body">
                {GroupIcon === null ? null : <GroupIcon aria-hidden className="size-3.5" />}
                {nameOf(owner)}
              </p>
              <ul className="divide-y divide-ws-line">
                {items.map((item) => (
                  <Row
                    key={item.id}
                    item={item}
                    plan={plan}
                    edit={edits[item.id]}
                    editing={editing}
                    locked={locked}
                    onEdit={(next) => setEdits((prev) => ({ ...prev, [item.id]: next }))}
                  />
                ))}
              </ul>
            </section>
          )
        })}
      </div>
      {locked ? null : (
        <div className="flex flex-wrap items-center gap-2 pt-1">
          <Button
            size="sm"
            disabled={saving || live.length === 0}
            data-testid="fanout-accept"
            onClick={() => {
              void run(() => onConfirm?.(Object.values(edits)) ?? Promise.resolve())
            }}
          >
            {t('fanout.ok')}
          </Button>
          <Button
            size="sm"
            variant={editing ? 'default' : 'outline'}
            disabled={saving}
            aria-pressed={editing}
            data-testid="fanout-edit"
            onClick={() => setEditing((v) => !v)}
          >
            {t('fanout.edit')}
          </Button>
          <Button
            size="sm"
            variant="ghost"
            disabled={saving}
            data-testid="fanout-dismiss"
            onClick={() => {
              void run(() => onDismiss?.() ?? Promise.resolve())
            }}
          >
            {t('fanout.dismiss')}
          </Button>
          <span className="ml-auto text-[12px] text-ws-muted-fg" data-testid="fanout-count">
            {t('fanout.count', {
              tasks: live.filter((i) => i.kind === 'task').length,
              notes: live.filter((i) => i.kind === 'note').length,
            })}
          </span>
        </div>
      )}
    </div>
  )
}

export function FanoutSummary({
  summary,
  onUndo,
}: {
  summary: FreeChatFanoutSummary
  /** WP357：撤销这一批写进知识库的口径。不给 = 只读。 */
  onUndo?: () => Promise<void>
}): React.ReactNode {
  const { t } = useApp()
  const [arming, setArming] = useState(false)
  const [undoing, setUndoing] = useState(false)
  const skipped = summary.skipped.dropped + summary.skipped.unsure + summary.skipped.secret
  const noteIds = summary.note_card_ids ?? []
  return (
    <div
      className="flex flex-col gap-2 rounded-xl border bg-ws-card p-3"
      data-testid="fanout-summary"
    >
      <p className="flex items-center gap-1.5 text-sm font-medium text-ws-ink">
        <CheckCircle2 aria-hidden className="size-4 text-ws-brand" />
        {t('fanout.summary.title')}
        <span className="truncate text-[12px] font-normal text-ws-muted-fg">
          {t('fanout.batch', { title: summary.title })}
        </span>
      </p>
      <ul className="flex flex-col gap-1.5">
        {summary.groups.map((g) => (
          <li
            key={g.position_id}
            className="flex flex-wrap items-center gap-1.5 text-[13px]"
            data-testid="fanout-summary-group"
            data-position={g.position_id}
          >
            <span className="w-24 shrink-0 font-medium text-ws-body">{g.name}</span>
            {g.tasks.map((m) => (
              <Link
                key={m.matter_id}
                to={`/matters/${encodeURIComponent(m.matter_id)}`}
                className="max-w-[220px] truncate rounded-full border border-ws-brand/40 bg-ws-tint px-2 py-px text-xs text-ws-brand-ink hover:border-ws-brand"
                data-testid="fanout-summary-task"
              >
                {m.title}
              </Link>
            ))}
            {g.notes === 0 ? null : (
              <span className="rounded-full bg-ws-surface px-2 py-px text-xs text-ws-muted-fg">
                {t('fanout.summary.notes', { n: g.notes })}
              </span>
            )}
          </li>
        ))}
        {summary.brand_notes === 0 ? null : (
          <li className="flex items-center gap-1.5 text-[13px]">
            <span className="w-24 shrink-0 font-medium text-ws-body">{t('fanout.brand')}</span>
            <span className="rounded-full bg-ws-surface px-2 py-px text-xs text-ws-muted-fg">
              {t('fanout.summary.notes', { n: summary.brand_notes })}
            </span>
          </li>
        )}
      </ul>
      <div className="flex flex-wrap items-center gap-2 text-[12px] text-ws-muted-fg">
        {summary.memories === 0 ? null : (
          <span>{t('fanout.summary.memories', { n: summary.memories })}</span>
        )}
        {skipped === 0 ? null : (
          <span data-testid="fanout-summary-skipped">
            {t('fanout.summary.skipped', { n: skipped })}
          </span>
        )}
        {(summary.failed ?? []).map((f) => (
          <span key={f} className="text-destructive">
            {f}
          </span>
        ))}
        {summary.knowledge_card_id === undefined ? null : (
          <Link
            to={`/cards/${encodeURIComponent(summary.knowledge_card_id)}`}
            className="ml-auto text-ws-brand hover:underline"
            data-testid="fanout-summary-confirm"
          >
            {t('fanout.summary.confirm')}
          </Link>
        )}
        {noteIds.length === 0 ? null : (
          <span className="ml-auto flex items-center gap-2">
            {summary.notes_undone_at !== undefined ? (
              <span data-testid="fanout-summary-undone">
                {t('fanout.summary.undone', { n: summary.notes_undone ?? 0 })}
              </span>
            ) : onUndo === undefined ? null : (
              <button
                type="button"
                className={cn(
                  'hover:underline disabled:opacity-50',
                  arming ? 'text-destructive' : 'text-ws-muted-fg',
                )}
                disabled={undoing}
                data-testid="fanout-summary-undo"
                data-armed={arming}
                onClick={() => {
                  if (!arming) {
                    setArming(true)
                    return
                  }
                  setUndoing(true)
                  void onUndo().finally(() => {
                    setUndoing(false)
                    setArming(false)
                  })
                }}
              >
                {arming
                  ? t('fanout.summary.undo_confirm')
                  : t('fanout.summary.undo', { n: noteIds.length })}
              </button>
            )}
            <Link
              to="/knowledge"
              className="text-ws-brand hover:underline"
              data-testid="fanout-summary-knowledge"
            >
              {t('fanout.summary.knowledge')}
            </Link>
          </span>
        )}
      </div>
    </div>
  )
}
