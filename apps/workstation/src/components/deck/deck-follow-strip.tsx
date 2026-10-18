/**
 * WP414（Luoye 10-19 真机，Reddit 回信卡；10-19 更正：以理由为准）：决定之后卡流顶上那一两行。
 *
 * 1. **「不要 / 稍后」之后的可选理由**：点一下就生效，这里出一行快捷理由 chip（不相关 / 时机不对 /
 *    不想回 / 其他…；「稍后」只有一个小输入框）——填不填都行。**不填就只处理这一张**；
 *    填了才按这条理由去找同类（AI 逐张判）。
 * 2. **按理由跟着处理了**：「按你的理由「X」，另外 N 张也一并不发了 · 收起 · 全部撤回」，下面直接摊开清单给人
 *    过一眼：每张标题、AI 说为什么属于这个理由、单张「恢复」。
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
  followOf,
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

/** 每张为什么算同类：按理由判的直接用 AI 那一句；「要一起发吗」那一路按钥匙出中英文。 */
export function followWhy(
  f: FollowedCardData,
  t: (k: string, v?: Record<string, string>) => string,
): string {
  if (f.basis.includes('same_reason')) return f.why
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
  /** 撤回 / 恢复 / 一起发 / 跟着处理之后刷新牌堆 */
  onChanged: () => void
}): React.ReactNode {
  const { t } = useMode()
  const { card, action } = after
  const [follow, setFollow] = useState<DecideFollowData | undefined>(after.follow)
  const applied = follow?.applied ?? []
  const suggested = after.follow?.suggested ?? []
  const [reason, setReason] = useState<string | undefined>(follow?.reason)
  const [other, setOther] = useState<string | undefined>(action === 'snooze' ? '' : undefined)
  const [list, setList] = useState(true)
  /** 已经放回待处理的（单张恢复 / 全部撤回） */
  const [restored, setRestored] = useState<ReadonlySet<string>>(new Set())
  const [armed, setArmed] = useState(false)
  const [sent, setSent] = useState<number | undefined>(undefined)
  const [closed, setClosed] = useState(false)
  const [busy, setBusy] = useState<'reason' | 'undo' | 'send' | undefined>(undefined)
  const [error, setError] = useState('')

  const verb = deckActionLabel(card, action === 'instruct' ? 'reject' : action, t)
  const assignment = card.position_id
  const still = applied.filter((a) => !restored.has(a.id))

  const run = async (what: 'reason' | 'undo' | 'send', job: () => Promise<void>): Promise<void> => {
    setBusy(what)
    setError('')
    try {
      await job()
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setBusy(undefined)
    }
  }

  /** 补理由：第一次补时服务端按这条理由去找同类（AI 逐张判），回包里带跟着处理了的那几张。 */
  const saveReason = (text: string): void => {
    void run('reason', async () => {
      const out = await addDecisionReason(
        card.id,
        { reason: text, follower_ids: still.map((a) => a.id) },
        assignment,
      )
      setReason(text)
      setOther(undefined)
      const next = followOf(out)
      if (next !== undefined && next.applied.length > 0) {
        setFollow(next)
        setList(true)
        onChanged()
      }
    })
  }

  const restore = (ids: readonly string[]): void => {
    void run('undo', async () => {
      const out = await undoFollow(card.id, ids, assignment)
      setRestored((prev) => new Set([...prev, ...out.restored.map((r) => r.id)]))
      onChanged()
    })
  }

  const asksReason = action === 'reject' || action === 'snooze'

  return (
    <div className="flex flex-col gap-2 text-xs" data-testid="deck-follow-strip">
      {/* 1. 「不要 / 稍后」之后：可选理由（不填就只处理这一张） */}
      {asksReason ? (
        <div className="flex flex-wrap items-center gap-1.5" data-testid="deck-drop-reasons">
          <span className="text-ws-good">{t('deck.drop.done', { verb })}</span>
          {busy === 'reason' ? (
            <span className="text-ws-muted-fg" data-testid="deck-follow-judging">
              {t('deck.follow.judging')}
            </span>
          ) : reason !== undefined ? (
            <span className="text-ws-muted-fg" data-testid="deck-drop-reason-saved">
              {t('deck.drop.reason_saved', { reason })}
            </span>
          ) : (
            <>
              <span className="text-ws-muted-fg">{t('deck.drop.why')}</span>
              {action === 'reject'
                ? quickReasons(card).map((k) => (
                    <button
                      key={k}
                      type="button"
                      className={chip}
                      data-reason={k}
                      disabled={busy !== undefined}
                      onClick={() => {
                        saveReason(t(k))
                      }}
                    >
                      {t(k)}
                    </button>
                  ))
                : null}
              {other === undefined ? (
                <button
                  type="button"
                  className={chip}
                  data-reason="other"
                  disabled={busy !== undefined}
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
                    autoFocus={action === 'reject'}
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
                    disabled={busy !== undefined || other.trim() === ''}
                  >
                    {t('deck.reason.save')}
                  </Button>
                </form>
              )}
            </>
          )}
        </div>
      ) : null}

      {/* 2. 按理由跟着处理了（不对外）：摊开清单过一眼，单张恢复 / 全部撤回 */}
      {applied.length > 0 ? (
        <div
          className="flex flex-col gap-1.5 rounded-lg border border-ws-line bg-ws-surface px-3 py-2"
          data-testid="deck-follow-applied"
        >
          {still.length === 0 ? (
            <span data-testid="deck-follow-undone">
              {t('deck.follow.undone', { n: String(applied.length) })}
            </span>
          ) : (
            <div className="flex flex-wrap items-center gap-2">
              <span>
                {t('deck.follow.applied', {
                  reason: follow?.reason ?? reason ?? '',
                  n: String(still.length),
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
                {list ? t('deck.follow.collapse') : t('deck.follow.which')}
              </Button>
              <Button
                size="sm"
                variant="outline"
                className="h-6 px-2 text-xs"
                disabled={busy !== undefined}
                data-testid="deck-follow-undo"
                onClick={() => {
                  restore(still.map((a) => a.id))
                }}
              >
                {t('deck.follow.undo')}
              </Button>
            </div>
          )}
          {list && still.length > 0 ? (
            <ul className="flex flex-col gap-1.5" data-testid="deck-follow-list">
              {applied.map((a) => (
                <li
                  key={a.id}
                  className="flex items-start gap-2"
                  data-testid="deck-follow-item"
                  data-id={a.id}
                >
                  <div className="flex min-w-0 flex-1 flex-col">
                    <span className="text-ws-ink">{a.title}</span>
                    <span className="text-ws-muted-fg">{followWhy(a, t)}</span>
                  </div>
                  {restored.has(a.id) ? (
                    <span className="shrink-0 text-ws-muted-fg" data-testid="deck-follow-restored">
                      {t('deck.follow.restored')}
                    </span>
                  ) : (
                    <Button
                      size="sm"
                      variant="outline"
                      className="h-6 shrink-0 px-2 text-xs"
                      disabled={busy !== undefined}
                      data-testid="deck-follow-restore"
                      onClick={() => {
                        restore([a.id])
                      }}
                    >
                      {t('deck.follow.restore')}
                    </Button>
                  )}
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
                disabled={busy !== undefined}
                data-armed={armed ? 'true' : undefined}
                data-testid="deck-follow-all"
                onClick={() => {
                  if (!armed) {
                    setArmed(true)
                    return
                  }
                  void run('send', async () => {
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
