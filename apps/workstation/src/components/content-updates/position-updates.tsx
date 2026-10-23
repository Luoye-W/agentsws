/**
 * WP406（私有 docs/107 §5）：第三栏「设定 · 岗位更新」——也是卡上「挑着看」开的那一页。
 *
 * 从上到下：三档设置（每次问我 / 没撞的自动应用 / 不再更新）→ 没订阅时一行小字 → 等着的几项（逐项勾、展开看
 * 按段 / 按条的改动；撞了的三栏「原来 / 新版 / 你的」+「用新版 / 保留我的 / 用 AI 合好的这版」）→「应用勾了的」
 * 「这次跳过」→ 用上的（单项退回、撞了先保留你的那几处还能再选）→ 整批退回上一批。
 *
 * 公司模式下不够格的人只看到「有更新，等负责人看」（服务端判，`view.can_apply`）。界面少字：解释进问号。
 */
import type {
  ContentAppliedItem,
  ContentClashChoice,
  ContentDigestItem,
  ContentPart,
  PositionUpdatePolicy,
} from '@agentsws/contracts'
import { contentChoiceKey, POSITION_UPDATE_POLICIES } from '@agentsws/contracts'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { ChevronDown, ChevronRight, X } from 'lucide-react'
import { type ReactNode, useState } from 'react'
import { StatusPill, WsTag } from '@/components/design'
import { Button } from '@/components/ui/button'
import { Hint } from '@/components/ui/hint'
import { Skeleton } from '@/components/ui/skeleton'
import { Textarea } from '@/components/ui/textarea'
import { useApp } from '@/lib/app-context'
import {
  aiMergePositionPart,
  applyPositionUpdates,
  dismissPositionNudge,
  getPositionUpdateDiff,
  getPositionUpdates,
  type PositionContentUpdatesView,
  positionUpdatesKey,
  rollbackPositionUpdates,
  setPositionUpdatePolicy,
  skipPositionUpdates,
  subscribeContentUpdates,
} from '@/lib/content-digest-api'
import { formatDate } from '@/lib/format'
import { cn } from '@/lib/utils'
import { MINE_TONE } from './digest-card-body'

type Choose = (key: string, choice: ContentClashChoice, text?: string) => void

const CHANGE_TONE: Record<ContentPart['change'], string> = {
  added: 'text-ws-good',
  changed: 'text-ws-info',
  removed: 'text-ws-bad',
}

function Column({
  label,
  text,
  tone,
}: {
  label: string
  text?: string | undefined
  tone?: string
}) {
  return (
    <div className="min-w-0 flex-1 rounded-md bg-ws-surface p-2">
      <p className={cn('mb-1 text-xs font-medium text-ws-muted-fg', tone)}>{label}</p>
      <p className="whitespace-pre-wrap break-words text-[12px] text-ws-body">{text ?? '—'}</p>
    </div>
  )
}

/** 撞了的一段 / 一条：三栏对照 + 三个选法（AI 那一版点了才出、可再改）。 */
function ClashChoice({
  part,
  chosen,
  onChoose,
  onAi,
}: {
  part: ContentPart
  chosen?: ContentClashChoice | undefined
  onChoose: Choose
  onAi: () => Promise<string | undefined>
}): ReactNode {
  const { t } = useApp()
  const [ai, setAi] = useState<string | undefined>(undefined)
  const [aiState, setAiState] = useState<'idle' | 'loading' | 'none'>('idle')
  const pick = chosen ?? part.chosen
  return (
    <div className="flex flex-col gap-1.5" data-testid="cd-clash">
      <div className="flex flex-wrap gap-1.5">
        {(['use_new', 'keep_mine'] as const).map((c) => (
          <Button
            key={c}
            size="sm"
            variant={pick === c ? 'default' : 'outline'}
            data-testid={`cd-choice-${c}`}
            onClick={() => onChoose(part.key, c)}
          >
            {t(`cd.choice.${c}`)}
          </Button>
        ))}
        {part.mergeable === true ? (
          <Button
            size="sm"
            variant={pick === 'use_ai' ? 'default' : 'outline'}
            data-testid="cd-choice-use_ai"
            disabled={aiState === 'loading'}
            onClick={async () => {
              setAiState('loading')
              const text = await onAi().catch(() => undefined)
              setAi(text)
              setAiState(text === undefined ? 'none' : 'idle')
            }}
          >
            {aiState === 'loading' ? t('cd.ai.loading') : t('cd.choice.use_ai')}
          </Button>
        ) : null}
      </div>
      {aiState === 'none' ? <p className="text-xs text-ws-muted-fg">{t('cd.ai.none')}</p> : null}
      {ai === undefined ? null : (
        <div className="flex flex-col gap-1.5" data-testid="cd-ai-text">
          <Textarea value={ai} onChange={(e) => setAi(e.target.value)} rows={4} />
          <Button
            size="sm"
            className="w-fit"
            data-testid="cd-ai-save"
            onClick={() => onChoose(part.key, 'use_ai', ai)}
          >
            {t('cd.choice.save')}
          </Button>
        </div>
      )}
    </div>
  )
}

/** 一项展开：按段 / 按条的改动。 */
function ItemDiff({
  positionId,
  itemId,
  choices,
  onChoose,
}: {
  positionId: string
  itemId: string
  choices: Record<string, ContentClashChoice>
  onChoose: Choose
}): ReactNode {
  const { t } = useApp()
  const diff = useQuery({
    queryKey: [...positionUpdatesKey(positionId), 'diff', itemId],
    queryFn: () => getPositionUpdateDiff(positionId, itemId),
  })
  if (diff.isPending)
    return <p className="px-3 py-2 text-xs text-ws-muted-fg">{t('cd.diff.loading')}</p>
  const parts = diff.data?.parts ?? []
  if (parts.length === 0)
    return <p className="px-3 py-2 text-xs text-ws-muted-fg">{t('cd.diff.none')}</p>
  return (
    <ul className="flex flex-col gap-2 px-3 pb-3" data-testid="cd-parts">
      {parts.map((p) => (
        <li
          key={p.key}
          className="flex flex-col gap-1.5"
          data-testid="cd-part"
          data-clash={p.clash === true}
        >
          <p className="flex items-center gap-2 text-[12px]">
            <span className={cn('font-medium', CHANGE_TONE[p.change])}>
              {t(`cd.part.${p.change}`)}
            </span>
            <span className="truncate text-ws-ink">{p.label}</span>
            {p.clash === true ? (
              <StatusPill tone="warn" className="h-5 px-2">
                {t('cd.mine.clash')}
              </StatusPill>
            ) : p.edited === true ? (
              <StatusPill tone="info" className="h-5 px-2">
                {t('cd.mine.kept')}
              </StatusPill>
            ) : null}
          </p>
          <div className="flex gap-1.5">
            {p.before === undefined ? null : <Column label={t('cd.part.before')} text={p.before} />}
            {p.after === undefined ? null : (
              <Column label={t('cd.part.after')} text={p.after} tone="text-ws-good" />
            )}
            {p.clash === true ? (
              <Column label={t('cd.part.mine')} text={p.mine} tone="text-ws-warn" />
            ) : null}
          </div>
          {p.clash === true ? (
            <ClashChoice
              part={p}
              chosen={choices[contentChoiceKey(itemId, p.key)]}
              onChoose={onChoose}
              onAi={async () => (await aiMergePositionPart(positionId, itemId, p.key)).text}
            />
          ) : null}
        </li>
      ))}
    </ul>
  )
}

function ItemRow({
  title,
  right,
  checked,
  onCheck,
  children,
  testId,
}: {
  title: string
  right: ReactNode
  checked?: boolean
  onCheck?: (v: boolean) => void
  children?: ReactNode
  testId: string
}): ReactNode {
  const [open, setOpen] = useState(false)
  return (
    <li className="border-b last:border-b-0" data-testid={testId}>
      <div className="flex items-center gap-2 px-3 py-2 text-[13px]">
        {onCheck === undefined ? null : (
          <input
            type="checkbox"
            className="size-3.5 accent-[var(--ws-brand)]"
            checked={checked === true}
            onChange={(e) => onCheck(e.target.checked)}
            data-testid="cd-check"
            aria-label={title}
          />
        )}
        <button
          type="button"
          className="ws-disclosure -mx-1 flex min-w-0 flex-1 items-center gap-1 px-1 text-left text-ws-ink"
          onClick={() => setOpen((o) => !o)}
          data-testid="cd-expand"
        >
          {open ? (
            <ChevronDown className="size-3.5 shrink-0" />
          ) : (
            <ChevronRight className="size-3.5 shrink-0" />
          )}
          <span className="truncate">{title}</span>
        </button>
        {right}
      </div>
      {open ? children : null}
    </li>
  )
}

export function PositionUpdates({
  positionId,
  assignment,
}: {
  positionId: string
  assignment?: string | undefined
}): ReactNode {
  const { t, lang } = useApp()
  const qc = useQueryClient()
  const key = positionUpdatesKey(positionId)
  const view = useQuery({
    queryKey: key,
    queryFn: () => getPositionUpdates(positionId, assignment),
  })
  const [checked, setChecked] = useState<Record<string, boolean>>({})
  const [choices, setChoices] = useState<Record<string, ContentClashChoice>>({})
  const [aiTexts, setAiTexts] = useState<Record<string, string>>({})
  const [showTitles, setShowTitles] = useState(false)
  const [note, setNote] = useState<string | undefined>(undefined)
  const done = (v: PositionContentUpdatesView): void => {
    qc.setQueryData(key, v)
    void qc.invalidateQueries({ queryKey: key })
    void qc.invalidateQueries({ queryKey: ['deck'] })
    void qc.invalidateQueries({ queryKey: ['approval'] })
  }
  const run = useMutation({
    mutationFn: (f: () => Promise<PositionContentUpdatesView>) => f(),
    onSuccess: done,
    onError: (e) => setNote(t('cd.failed', { reason: e instanceof Error ? e.message : '' })),
  })
  const subscribe = useMutation({
    mutationFn: subscribeContentUpdates,
    onSuccess: () => {
      setNote(t('cd.subscribed'))
      void qc.invalidateQueries({ queryKey: key })
    },
    onError: (e) => setNote(t('cd.failed', { reason: e instanceof Error ? e.message : '' })),
  })

  if (view.isPending) return <Skeleton className="h-24 w-full" />
  const v = view.data
  if (v === undefined) return null
  const name = (x: { zh: string; en: string }): string => (lang === 'zh' ? x.zh : x.en)
  const pendingIds = v.pending.map((p) => p.item_id)
  const picked = pendingIds.filter((id) => checked[id] !== false)
  const can = v.can_apply

  /** 撞了那一处选了：等着的那一项跟着「应用」一起交；已经用上的那一项当场落。 */
  const choose =
    (item_id: string, applied: boolean): Choose =>
    (part, choice, text) => {
      const k = contentChoiceKey(item_id, part)
      if (applied) {
        run.mutate(() =>
          applyPositionUpdates(
            positionId,
            {
              item_ids: [],
              choices: { [k]: choice },
              ...(text === undefined ? {} : { ai_texts: { [k]: text } }),
            },
            assignment,
          ),
        )
        return
      }
      setChoices((c) => ({ ...c, [k]: choice }))
      if (text !== undefined) setAiTexts((a) => ({ ...a, [k]: text }))
    }

  const pendingRight = (i: ContentDigestItem) => (
    <>
      {i.urgent === true ? <WsTag className="text-ws-bad">{t('cd.urgent')}</WsTag> : null}
      {i.added === true ? (
        <WsTag>{t('cd.added')}</WsTag>
      ) : (
        <StatusPill tone={MINE_TONE[i.mine]} className="h-5 px-2">
          {t(`cd.mine.${i.mine}`)}
        </StatusPill>
      )}
    </>
  )
  const appliedRight = (a: ContentAppliedItem) => (
    <>
      {a.kept_clashes === undefined ? null : (
        <StatusPill tone="warn" className="h-5 px-2" data-testid="cd-kept">
          {t('cd.kept_clashes', { n: String(a.kept_clashes) })}
        </StatusPill>
      )}
      {can ? (
        <Button
          size="sm"
          variant="ghost"
          className="h-6 px-2 text-xs"
          data-testid="cd-rollback-item"
          title={
            a.previous_version === undefined
              ? t('cd.rollback.bundled')
              : t('cd.rollback.tip', { version: a.previous_version })
          }
          onClick={() =>
            run.mutate(() => rollbackPositionUpdates(positionId, a.item_id, assignment))
          }
        >
          {t('cd.rollback')}
        </Button>
      ) : null}
    </>
  )

  return (
    <div
      className="flex flex-col gap-3 text-sm"
      data-testid="position-updates"
      data-can-apply={can}
    >
      <div className="flex flex-wrap items-center gap-1" data-testid="cd-policy">
        {POSITION_UPDATE_POLICIES.map((p: PositionUpdatePolicy) => (
          <button
            key={p}
            type="button"
            aria-pressed={v.policy === p}
            disabled={!can}
            data-testid={`cd-policy-${p}`}
            className={cn(
              'rounded-md px-2 py-0.5 text-xs',
              v.policy === p
                ? 'bg-secondary font-medium text-secondary-foreground'
                : 'text-muted-foreground hover:bg-accent disabled:hover:bg-transparent',
            )}
            onClick={() => run.mutate(() => setPositionUpdatePolicy(positionId, p, assignment))}
          >
            {t(`cd.policy.${p}`)}
          </button>
        ))}
        <Hint text={t('cd.policy.tip')} />
      </div>

      {v.subscription.note === undefined ? null : (
        <p className="text-xs text-ws-warn" data-testid="cd-sub-note">
          {v.subscription.note}
        </p>
      )}

      {v.nudge === undefined ? null : (
        <div className="rounded-md bg-ws-surface px-3 py-2" data-testid="cd-nudge">
          <div className="flex items-center gap-2 text-xs text-ws-muted-fg">
            <span className="flex-1">{t('cd.nudge', { n: String(v.nudge.count) })}</span>
            <button
              type="button"
              className="text-ws-muted-fg hover:text-ws-ink"
              aria-label={t('cd.nudge.close')}
              title={t('cd.nudge.close')}
              data-testid="cd-nudge-close"
              onClick={() => run.mutate(() => dismissPositionNudge(positionId, assignment))}
            >
              <X className="size-3.5" />
            </button>
          </div>
          <div className="mt-1.5 flex flex-wrap items-center gap-2">
            <button
              type="button"
              className="text-xs text-ws-brand hover:underline"
              data-testid="cd-nudge-look"
              onClick={() => setShowTitles((s) => !s)}
            >
              {t('cd.nudge.look')}
            </button>
            <Button
              size="sm"
              variant="outline"
              className="h-6 px-2 text-xs"
              data-testid="cd-subscribe"
              disabled={subscribe.isPending}
              onClick={() => subscribe.mutate()}
            >
              {v.subscription.credits_per_month === undefined
                ? t('cd.subscribe')
                : t('cd.subscribe.price', { credits: String(v.subscription.credits_per_month) })}
            </Button>
            <Hint text={t('cd.subscribe.tip')} />
          </div>
          {showTitles ? (
            <ul
              className="mt-1.5 list-disc pl-4 text-xs text-ws-body"
              data-testid="cd-nudge-titles"
            >
              {v.nudge.titles.map((x) => (
                <li key={`${x.zh}|${x.en}`}>{name(x)}</li>
              ))}
            </ul>
          ) : null}
        </div>
      )}

      {v.pending.length === 0 ? (
        <p className="text-xs text-ws-muted-fg" data-testid="cd-none">
          {v.skipped_this_week === true ? t('cd.skipped') : t('cd.pending.none')}
        </p>
      ) : (
        <section className="flex flex-col gap-2">
          <h4 className="text-xs font-medium text-ws-muted-fg">
            {can ? t('cd.pending.title', { n: String(v.pending.length) }) : t('cd.wait_owner')}
          </h4>
          <ul className="rounded-md border" data-testid="cd-pending">
            {v.pending.map((i) => (
              <ItemRow
                key={i.item_id}
                testId="cd-pending-item"
                title={name(i.title)}
                right={pendingRight(i)}
                {...(can
                  ? {
                      checked: checked[i.item_id] !== false,
                      onCheck: (on: boolean) => setChecked((c) => ({ ...c, [i.item_id]: on })),
                    }
                  : {})}
              >
                <ItemDiff
                  positionId={positionId}
                  itemId={i.item_id}
                  choices={choices}
                  onChoose={can ? choose(i.item_id, false) : () => undefined}
                />
              </ItemRow>
            ))}
          </ul>
          {can ? (
            <div className="flex flex-wrap items-center gap-2">
              <Button
                size="sm"
                data-testid="cd-apply"
                disabled={picked.length === 0 || run.isPending}
                onClick={() =>
                  run.mutate(() =>
                    applyPositionUpdates(
                      positionId,
                      { item_ids: picked, choices, ai_texts: aiTexts },
                      assignment,
                    ),
                  )
                }
              >
                {t('cd.apply_picked', { n: String(picked.length) })}
              </Button>
              <Button
                size="sm"
                variant="ghost"
                data-testid="cd-skip"
                disabled={run.isPending}
                onClick={() => run.mutate(() => skipPositionUpdates(positionId, assignment))}
              >
                {t('cd.skip')}
              </Button>
            </div>
          ) : null}
        </section>
      )}

      {v.applied.length === 0 ? null : (
        <section className="flex flex-col gap-2">
          <h4 className="flex items-center gap-2 text-xs font-medium text-ws-muted-fg">
            <span className="flex-1">{t('cd.applied.title')}</span>
            {can && v.last_batch !== undefined ? (
              <Button
                size="sm"
                variant="ghost"
                className="h-6 px-2 text-xs"
                data-testid="cd-rollback-batch"
                title={t('cd.rollback_batch.tip', {
                  n: String(v.last_batch.item_ids.length),
                  at: formatDate(v.last_batch.applied_at, lang),
                })}
                onClick={() =>
                  run.mutate(() => rollbackPositionUpdates(positionId, undefined, assignment))
                }
              >
                {t('cd.rollback_batch')}
              </Button>
            ) : null}
          </h4>
          <ul className="rounded-md border" data-testid="cd-applied">
            {v.applied.map((a) => (
              <ItemRow
                key={a.item_id}
                testId="cd-applied-item"
                title={name(a.title)}
                right={appliedRight(a)}
              >
                <ItemDiff
                  positionId={positionId}
                  itemId={a.item_id}
                  choices={{}}
                  onChoose={can ? choose(a.item_id, true) : () => undefined}
                />
              </ItemRow>
            ))}
          </ul>
        </section>
      )}

      {note === undefined ? null : (
        <p className="text-xs text-ws-muted-fg" data-testid="cd-note">
          {note}
        </p>
      )}
    </div>
  )
}
