/**
 * WP414（Luoye 10-19 真机，Reddit 回信卡）：决定之后卡流顶上那一两行。
 *
 * 1. **「不要」之后的可选理由**：点「不要」一下就生效，这里出一行快捷理由 chip（不相关 / 时机不对 /
 *    不想回 / 其他…）——填不填都行；点了就补记在那张卡上（跟着处理的那几张一起补），用于学习。
 * 2. **同类卡跟着处理了**：「按你刚才对〈X〉的决定，另外 N 张也一并〈不发〉了 · 看是哪几张 · 撤回」，
 *    展开是每张的标题 + 一句为什么算同类；撤回把那几张整批放回待处理。
 * 3. **同类卡要一起发吗**（对外动作绝不自动做）：「这 N 张和刚才那张类似，要一起发吗？」——
 *    「一起发」要再点一次确认（与超额再确认同一个做法），「逐张看」翻到第一张。
 */
import type { DeckCard } from '@agentsws/deck'
import { createContext, useContext, useState } from 'react'
import { deckActionLabel } from '@/components/deck/deck-action-bar'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import {
  addDecisionReason,
  approveBatch,
  type DecideFollowData,
  type FollowedCardData,
  undoFollow,
} from '@/lib/api'
import { useMode } from '@/lib/mode'

/** 刚做完的那一次决定（卡、点的是什么、带回来的同类）。 */
export interface DeckAfter {
  card: DeckCard
  action: 'approve' | 'reject' | 'snooze' | 'instruct'
  follow?: DecideFollowData
}

/**
 * 卡身里自己带主按钮的卡（Reddit「发出去」卡的「发送」在卡身里）决定完，把回包里的同类卡交给牌堆那一行。
 * 不在牌堆里渲染（独立的聊天窗、插件）时没有提供者，什么都不做。
 */
export const DeckAfterContext = createContext<((after: DeckAfter) => void) | undefined>(undefined)

/** 卡身里用：决定完报一声（没有同类就不报）。 */
export function useReportDeckAfter(): (after: DeckAfter) => void {
  const report = useContext(DeckAfterContext)
  return (after) => {
    const f = after.follow
    if (f === undefined || (f.applied.length === 0 && f.suggested.length === 0)) return
    report?.(after)
  }
}

/** 快捷理由（「其他…」开一个输入框）。回信类说「不想回」，别的卡说「不需要」。 */
function quickReasons(card: DeckCard): string[] {
  return [
    'deck.reason.irrelevant',
    'deck.reason.timing',
    card.layout === 'outbound' ? 'deck.reason.no_reply' : 'deck.reason.not_needed',
  ]
}

/** 每张为什么算同类（按钥匙出中英文；来源名原样）。 */
export function followWhy(
  f: FollowedCardData,
  t: (k: string, v?: Record<string, string>) => string,
): string {
  return f.basis
    .map((b) =>
      b === 'same_source'
        ? t('deck.follow.why.same_source', { source: f.source ?? '' })
        : t(`deck.follow.why.${b}`),
    )
    .join(t('deck.follow.why.sep'))
}

const chip =
  'rounded-full border border-ws-line bg-ws-card px-2.5 py-0.5 text-xs text-ws-ink hover:bg-ws-surface disabled:opacity-50'

export function DeckFollowStrip({
  after,
  onJump,
  onChanged,
}: {
  after: DeckAfter
  /** 「逐张看」：翻到那一张 */
  onJump: (card_id: string) => void
  /** 撤回 / 一起发之后刷新牌堆 */
  onChanged: () => void
}): React.ReactNode {
  const { t } = useMode()
  const { card, action, follow } = after
  const applied = follow?.applied ?? []
  const suggested = follow?.suggested ?? []
  const [reason, setReason] = useState<string | undefined>(undefined)
  const [other, setOther] = useState<string | undefined>(undefined)
  const [list, setList] = useState(false)
  const [undone, setUndone] = useState<number | undefined>(undefined)
  const [armed, setArmed] = useState(false)
  const [sent, setSent] = useState<number | undefined>(undefined)
  const [closed, setClosed] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')

  const verb = deckActionLabel(card, action === 'instruct' ? 'reject' : action, t)
  const assignment = card.position_id

  const run = async (job: () => Promise<void>): Promise<void> => {
    setBusy(true)
    setError('')
    try {
      await job()
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setBusy(false)
    }
  }

  const saveReason = (text: string): void => {
    void run(async () => {
      await addDecisionReason(
        card.id,
        { reason: text, follower_ids: undone === undefined ? applied.map((a) => a.id) : [] },
        assignment,
      )
      setReason(text)
      setOther(undefined)
    })
  }

  return (
    <div className="flex flex-col gap-2 text-xs" data-testid="deck-follow-strip">
      {/* 1. 「不要」之后：可选的快捷理由 */}
      {action === 'reject' ? (
        <div className="flex flex-wrap items-center gap-1.5" data-testid="deck-drop-reasons">
          <span className="text-ws-good">{t('deck.drop.done', { verb })}</span>
          {reason !== undefined ? (
            <span className="text-ws-muted-fg" data-testid="deck-drop-reason-saved">
              {t('deck.drop.reason_saved', { reason })}
            </span>
          ) : (
            <>
              <span className="text-ws-muted-fg">{t('deck.drop.why')}</span>
              {quickReasons(card).map((k) => (
                <button
                  key={k}
                  type="button"
                  className={chip}
                  data-reason={k}
                  disabled={busy}
                  onClick={() => {
                    saveReason(t(k))
                  }}
                >
                  {t(k)}
                </button>
              ))}
              {other === undefined ? (
                <button
                  type="button"
                  className={chip}
                  data-reason="other"
                  disabled={busy}
                  onClick={() => {
                    setOther('')
                  }}
                >
                  {t('deck.reason.other')}
                </button>
              ) : (
                <form
                  className="flex items-center gap-1.5"
                  onSubmit={(e) => {
                    e.preventDefault()
                    if (other.trim() !== '') saveReason(other.trim())
                  }}
                >
                  <Input
                    autoFocus
                    className="h-7 w-52 text-xs"
                    aria-label={t('deck.reason.other')}
                    placeholder={t('deck.reason.placeholder')}
                    value={other}
                    onChange={(e) => {
                      setOther(e.target.value)
                    }}
                  />
                  <Button
                    size="sm"
                    variant="outline"
                    type="submit"
                    disabled={busy || other.trim() === ''}
                  >
                    {t('deck.reason.save')}
                  </Button>
                </form>
              )}
            </>
          )}
        </div>
      ) : null}

      {/* 2. 同类卡已跟着处理（不对外）：撤回 / 看是哪几张 */}
      {applied.length > 0 ? (
        <div
          className="flex flex-col gap-1.5 rounded-lg border border-ws-line bg-ws-surface px-3 py-2"
          data-testid="deck-follow-applied"
        >
          {undone === undefined ? (
            <div className="flex flex-wrap items-center gap-2">
              <span>
                {t('deck.follow.applied', {
                  title: follow?.leader_title ?? card.title,
                  n: String(applied.length),
                  verb,
                })}
              </span>
              <Button
                size="sm"
                variant="ghost"
                className="h-6 px-2 text-xs"
                aria-expanded={list}
                data-testid="deck-follow-list-toggle"
                onClick={() => {
                  setList(!list)
                }}
              >
                {t('deck.follow.which')}
              </Button>
              <Button
                size="sm"
                variant="outline"
                className="h-6 px-2 text-xs"
                disabled={busy}
                data-testid="deck-follow-undo"
                onClick={() => {
                  void run(async () => {
                    const out = await undoFollow(
                      card.id,
                      applied.map((a) => a.id),
                      assignment,
                    )
                    setUndone(out.restored.length)
                    setList(false)
                    onChanged()
                  })
                }}
              >
                {t('deck.follow.undo')}
              </Button>
            </div>
          ) : (
            <span data-testid="deck-follow-undone">
              {t('deck.follow.undone', { n: String(undone) })}
            </span>
          )}
          {list && undone === undefined ? (
            <ul className="flex flex-col gap-1" data-testid="deck-follow-list">
              {applied.map((a) => (
                <li key={a.id} className="flex flex-col">
                  <span className="text-ws-ink">{a.title}</span>
                  <span className="text-ws-muted-fg">{followWhy(a, t)}</span>
                </li>
              ))}
            </ul>
          ) : null}
        </div>
      ) : null}

      {/* 3. 对外动作：只问「要一起发吗」，绝不自动发 */}
      {suggested.length > 0 && !closed ? (
        <div
          className="flex flex-wrap items-center gap-2 rounded-lg border border-ws-line bg-ws-surface px-3 py-2"
          data-testid="deck-follow-suggested"
        >
          {sent !== undefined ? (
            <span data-testid="deck-follow-sent">
              {t('deck.follow.sent', { n: String(sent), verb })}
            </span>
          ) : (
            <>
              <span>{t('deck.follow.suggest', { n: String(suggested.length), verb })}</span>
              <Button
                size="sm"
                variant={armed ? 'default' : 'outline'}
                className="h-6 px-2 text-xs"
                disabled={busy}
                data-armed={armed ? 'true' : undefined}
                data-testid="deck-follow-all"
                onClick={() => {
                  if (!armed) {
                    setArmed(true)
                    return
                  }
                  void run(async () => {
                    const out = await approveBatch(
                      suggested.map((s) => s.id),
                      assignment,
                    )
                    setSent(out.results.filter((r) => r.error === undefined).length)
                    onChanged()
                  })
                }}
              >
                {armed
                  ? t('deck.follow.all_again', { n: String(suggested.length) })
                  : t('deck.follow.all', { n: String(suggested.length), verb })}
              </Button>
              <Button
                size="sm"
                variant="outline"
                className="h-6 px-2 text-xs"
                data-testid="deck-follow-one-by-one"
                onClick={() => {
                  const first = suggested[0]
                  if (first !== undefined) onJump(first.id)
                  setClosed(true)
                }}
              >
                {t('deck.follow.one_by_one')}
              </Button>
              <Button
                size="sm"
                variant="ghost"
                className="h-6 px-2 text-xs"
                onClick={() => {
                  setClosed(true)
                }}
              >
                {t('deck.follow.dismiss')}
              </Button>
            </>
          )}
        </div>
      ) : null}
      {error === '' ? null : (
        <p role="alert" className="text-destructive">
          {error}
        </p>
      )}
    </div>
  )
}
