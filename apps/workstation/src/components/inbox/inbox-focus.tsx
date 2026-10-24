/**
 * WP459（决策 1505 丁）：**一张一张**——中间一张大卡，顶上「第 N 张 / M」+ 接下来几张；
 * 回信卡原信与草稿并排、改价这类就是岗位里那张卡；底下通过 / 改 / 不要 / 跳过 + 快捷键（A / E / D / →）。
 * 和列表是同一份数据、同一张卡。跳过的放到这一轮最后；顶上「刚才：…」跳过的能撤回。
 * WP474（决策 1514）：「不要」的也能撤回（放回待定）；「通过」的在批准后取消窗口里、真发出去之前能撤
 * （按钮带剩几秒，过了就收起；撤不回时底下说一句）。
 *
 * 快捷键找的是这张卡上真有的那颗按钮（草稿卡的 `data-focus-act`，岗位卡的 `data-action`，
 * 信的三个建议），没有就不做事；打字时不响应。
 */
import type { InboxItem, InboxView } from '@agentsws/deck'
import { ArrowRight } from 'lucide-react'
import { type KeyboardEvent, type ReactNode, useEffect, useMemo, useRef, useState } from 'react'
import { Link } from 'react-router-dom'
import { isTypingTarget } from '@/components/deck/deck-gestures'
import { CategoryTag, StatusPill } from '@/components/design'
import { type ApprovalUndoData, getApprovalUndo, undoApproval } from '@/lib/api'
import { useApp } from '@/lib/app-context'
import { apiErrorText } from '@/lib/error-text'
import { cn } from '@/lib/utils'
import type { InboxNotice } from './inbox-actions'
import { itemTitle, positionLabel, setInboxLooking, useInboxRefresh } from './inbox-model'
import { DraftPane, InboxPaneItem, isDraftCard } from './inbox-pane'
import { ItemGlyph, rowPill, rowTag } from './inbox-row'
import { handledByOther, handledText, TeamLine } from './inbox-team'

type Done = {
  kind: 'skip' | 'done'
  item: InboxItem
  /** WP474：卡刚才是通过了还是不要了（问过服务端才知道；信、别的去向是 `other`） */
  did?: 'approve' | 'reject' | 'other'
  /** WP474：还撤不撤得回 */
  undo?: ApprovalUndoData
  /** WP474：「通过」的撤回截止到本机哪一刻（收到时 + 服务端说的剩余秒数；不拿本机钟比服务端的钟） */
  deadline?: number
}

/** WP474：一张卡不在了之后问一句它现在什么状态、还撤不撤得回。 */
async function settle(item: InboxItem): Promise<Pick<Done, 'did' | 'undo' | 'deadline'>> {
  const card = item.card
  if (card === undefined) return { did: 'other' }
  try {
    const out = await getApprovalUndo(card.id, card.position_id)
    const did =
      out.state === 'approved' || out.state === 'approved_edited'
        ? 'approve'
        : out.state === 'rejected' || out.state === 'deferred'
          ? 'reject'
          : 'other'
    const left = out.undo?.seconds_left
    return {
      did,
      ...(out.undo === undefined ? {} : { undo: out.undo }),
      ...(left === undefined ? {} : { deadline: Date.now() + left * 1000 }),
    }
  } catch {
    return { did: 'other' }
  }
}

/** 「通过」的撤回还剩几秒（「不要」的没有期限 → `undefined`；过了 → 0）。 */
function secondsLeft(d: Done | undefined, now: number): number | undefined {
  if (d?.undo?.kind !== 'unapprove') return undefined
  // 老服务进程只给 until：按 until 算（同一台机器上钟是一样的）
  const deadline = d.deadline ?? (d.undo.until === undefined ? undefined : Date.parse(d.undo.until))
  if (deadline === undefined) return undefined
  return Math.max(0, Math.ceil((deadline - now) / 1000))
}

/** 按键 → 这张卡上的哪颗按钮（第一个找得到的）。 */
const KEY_TARGETS: Record<string, readonly string[]> = {
  a: [
    '[data-focus-act="approve"]',
    'button[data-action="approve"]',
    '[data-testid="hand-primary"]',
    '[data-testid="hand-actions"] button[data-testid="hand-self"]',
  ],
  e: ['[data-focus-act="edit"]', 'button[data-action="instruct"]'],
  d: ['[data-focus-act="reject"]', 'button[data-action="reject"]', '[data-testid="hand-notice"]'],
}

export function InboxFocus({
  view,
  items,
  onNotice,
  onList,
  onTodo,
}: {
  view: InboxView
  /** 筛过的这一轮（同列表那一份）。 */
  items: readonly InboxItem[]
  onNotice(n: InboxNotice): void
  onList(): void
  /** WP469：按 T 把这一张记成待办（记完翻到下一张） */
  onTodo?: (item: InboxItem) => void
}): ReactNode {
  const { t, lang } = useApp()
  const refresh = useInboxRefresh()
  const box = useRef<HTMLElement | null>(null)
  const [skipped, setSkipped] = useState<string[]>([])
  const [cursor, setCursor] = useState<string | undefined>(items[0]?.id)
  const [fallback, setFallback] = useState(0)
  const [recent, setRecent] = useState<Done[]>([])
  const [undoing, setUndoing] = useState(false)
  /** WP474：撤回了的那张——等它回到这一轮里再翻过去（重取之前它还不在） */
  const [returning, setReturning] = useState<string | undefined>()
  const [tick, setTick] = useState(() => Date.now())
  // 这一轮的顺序：跳过的挪到最后
  const order = useMemo(() => {
    const skip = new Set(skipped)
    return [
      ...items.filter((i) => !skip.has(i.id)),
      ...skipped.flatMap((id) => items.filter((i) => i.id === id)),
    ]
  }, [items, skipped])
  const found = cursor === undefined ? -1 : order.findIndex((i) => i.id === cursor)
  const index = found >= 0 ? found : Math.max(0, Math.min(fallback, order.length - 1))
  const item = order[index]
  // 这张不在了（批了 / 交出去了）：记一笔「刚才」，停在同一个位置（后面那张补上来）
  const last = useRef<InboxItem | undefined>(undefined)
  useEffect(() => {
    const prev = last.current
    if (prev !== undefined && !items.some((i) => i.id === prev.id)) {
      const entry: Done = { kind: 'done', item: prev }
      setRecent((r) => [entry, ...r].slice(0, 5))
      // WP474：问一句刚才是通过还是不要、还撤不撤得回
      void settle(prev).then((more) => {
        setRecent((r) => r.map((x) => (x === entry ? { ...x, ...more } : x)))
        setTick(Date.now())
      })
    }
    last.current = item
  }, [items, item])
  useEffect(() => {
    if (found < 0 && item !== undefined) setCursor(item.id)
  }, [found, item])
  useEffect(() => {
    if (returning === undefined || !items.some((i) => i.id === returning)) return
    setCursor(returning)
    setReturning(undefined)
  }, [items, returning])
  useEffect(() => {
    box.current?.focus({ preventScroll: true })
  }, [])
  // WP510：「我在看」= 这一轮当前那一张（② / ③ 里别人那边出「X 在看」）
  const lookingId = item?.id
  useEffect(() => {
    setInboxLooking(lookingId ?? null)
  }, [lookingId])

  const skip = (): void => {
    if (item === undefined || order.length < 2) return
    const next = order[index + 1] ?? order[0]
    setSkipped((s) => [...s.filter((x) => x !== item.id), item.id])
    setRecent((r) => [{ kind: 'skip' as const, item }, ...r].slice(0, 5))
    setCursor(next?.id)
    setFallback(index)
  }
  const undoSkip = (d: Done): void => {
    setSkipped((s) => s.filter((x) => x !== d.item.id))
    setRecent((r) => r.filter((x) => x !== d))
    setCursor(d.item.id)
  }
  /** WP474：撤回「不要 / 通过」——放回待定，翻回这一张。撤不回（已经发了 / 过了窗口）就说一句。 */
  const undoDecision = (d: Done): void => {
    const card = d.item.card
    if (card === undefined || undoing) return
    setUndoing(true)
    undoApproval(card.id, card.position_id)
      .then(() => {
        setRecent((r) => r.filter((x) => x !== d))
        setReturning(d.item.id)
        onNotice({ tone: 'ok', text: t('inbox.focus.undone', { title: itemTitle(d.item) }) })
      })
      .catch((e: unknown) => {
        setRecent((r) =>
          r.map((x) => {
            if (x !== d) return x
            const { undo: _closed, ...rest } = x
            return rest
          }),
        )
        onNotice({ tone: 'warn', text: apiErrorText(e, t) })
      })
      .finally(() => {
        setUndoing(false)
        refresh()
      })
  }
  const onKeyDown = (e: KeyboardEvent<HTMLElement>): void => {
    if (isTypingTarget(e.target as HTMLElement | null)) return
    if (e.metaKey || e.ctrlKey || e.altKey) return
    if (e.key === 'ArrowRight') {
      e.preventDefault()
      skip()
      return
    }
    if ((e.key === 't' || e.key === 'T') && onTodo !== undefined && item !== undefined) {
      e.preventDefault()
      onTodo(item)
      skip()
      return
    }
    const targets = KEY_TARGETS[e.key.toLowerCase()]
    if (targets === undefined) return
    const card = box.current?.querySelector('[data-testid="inbox-focus-card"]')
    for (const sel of targets) {
      const btn = card?.querySelector<HTMLButtonElement>(sel)
      if (btn !== null && btn !== undefined && !btn.disabled) {
        e.preventDefault()
        btn.click()
        return
      }
    }
  }

  const upcoming = order.slice(index + 1, index + 4)
  const latest = recent[0]
  // WP474：「通过」的撤回按钮带剩几秒，每秒走一下，到点收起
  const left = secondsLeft(latest, tick)
  useEffect(() => {
    if (left === undefined || left <= 0) return
    const timer = setTimeout(() => {
      setTick(Date.now())
    }, 1000)
    return () => {
      clearTimeout(timer)
    }
  }, [left])
  // WP510：这一张是同事处理掉的——「刚才」写他的名字，不给撤回（撤回只认本人那一下）
  const byOther = latest?.kind === 'done' ? handledByOther(view, latest.item.id) : undefined
  const canUndo =
    latest !== undefined &&
    byOther === undefined &&
    (latest.kind === 'skip' || (latest.undo !== undefined && (left === undefined || left > 0)))
  const pill = item === undefined ? undefined : rowPill(item, t)
  const posName =
    item === undefined ? undefined : positionLabel(view.positions, item.position, lang)
  const asg = view.positions.find((p) => p.id === item?.position)?.assignment_id
  // 岗位里那张卡自己带卡壳与头一行（同一张卡），外面不再套一层
  const ownShell = item?.card !== undefined && !isDraftCard(item)
  return (
    <section
      ref={box}
      // biome-ignore lint/a11y/noNoninteractiveTabindex: 这一叠卡本身就是交互面，键盘要落在它上面
      tabIndex={0}
      data-testid="inbox-focus"
      aria-label={t('inbox.mode.focus')}
      aria-keyshortcuts="A E D T ArrowRight"
      onKeyDown={onKeyDown}
      className="flex min-w-0 flex-col gap-3 rounded-[16px] outline-none"
    >
      <div
        className="ws-card flex items-center gap-3 px-4 py-2.5"
        data-testid="inbox-focus-progress"
      >
        <span className="shrink-0 text-[14px] font-semibold text-ws-ink">
          {t('inbox.focus.progress', { i: Math.min(index + 1, order.length) })}
          <span className="ws-num ml-1 font-normal text-ws-faint">/ {order.length}</span>
        </span>
        <span className="hidden h-1.5 w-28 shrink-0 overflow-hidden rounded-full bg-ws-surface sm:block">
          <span
            className="block h-full rounded-full bg-ws-brand"
            style={{
              width: `${order.length === 0 ? 0 : Math.round(((index + 1) / order.length) * 100)}%`,
            }}
          />
        </span>
        {upcoming.length === 0 ? null : (
          <span className="hidden shrink-0 text-xs text-ws-muted-fg md:inline">
            {t('inbox.focus.next')}
          </span>
        )}
        <span className="hidden min-w-0 flex-1 items-center gap-1.5 overflow-hidden md:flex">
          {upcoming.map((u) => (
            <button
              key={u.id}
              type="button"
              data-testid="inbox-focus-upcoming"
              className="max-w-44 shrink-0 truncate rounded-[8px] bg-ws-surface px-2 py-1 text-xs text-ws-body hover:text-ws-ink"
              onClick={() => {
                setCursor(u.id)
              }}
            >
              {itemTitle(u)}
            </button>
          ))}
        </span>
        <button
          type="button"
          className="ws-link ml-auto inline-flex shrink-0 items-center gap-1 text-xs"
          data-testid="inbox-focus-all"
          onClick={onList}
        >
          {t('inbox.focus.all')}
          <ArrowRight aria-hidden className="size-3" />
        </button>
      </div>
      {item === undefined ? null : <TeamLine item={item} className="px-1" />}
      {item === undefined ? null : (
        <div
          className={cn('flex flex-col gap-3', ownShell ? '' : 'ws-card p-5')}
          data-testid="inbox-focus-card"
          data-id={item.id}
        >
          {ownShell ? null : (
            <div className="flex flex-wrap items-center gap-1.5">
              <ItemGlyph item={item} positions={view.positions} />
              {posName === undefined ? null : <CategoryTag>{posName}</CategoryTag>}
              {/* 信的类型标签在下面那块里（同第三栏），这里不再写一遍 */}
              {item.type === 'mail' ? null : <CategoryTag>{rowTag(item, t)}</CategoryTag>}
              {pill === undefined ? null : <StatusPill tone={pill.tone}>{pill.text}</StatusPill>}
              {asg === undefined || posName === undefined ? null : (
                <Link to={`/positions/${asg}`} className="ws-link ml-auto text-xs">
                  {t('inbox.pane.in_position', { name: posName })}
                </Link>
              )}
            </div>
          )}
          {ownShell ? null : (
            <h2 className="text-[16px] font-semibold text-ws-ink" data-slot="title">
              {itemTitle(item)}
            </h2>
          )}
          {isDraftCard(item) && item.card !== undefined ? (
            <DraftPane
              item={item}
              card={item.card}
              edit={false}
              compact
              onNotice={onNotice}
              onDone={() => undefined}
            />
          ) : (
            <InboxPaneItem item={item} onNotice={onNotice} onDone={() => undefined} />
          )}
          <div
            className={cn(
              'flex items-center gap-2',
              ownShell ? 'px-1' : 'border-t border-ws-line pt-3',
            )}
          >
            <button
              type="button"
              data-testid="inbox-focus-skip"
              className="ws-btn ws-btn-ghost"
              disabled={order.length < 2}
              onClick={skip}
            >
              {t('inbox.focus.skip')}
            </button>
            <span
              className="ml-auto flex items-center gap-3 text-xs text-ws-faint"
              data-testid="inbox-focus-keys"
            >
              <span>
                <kbd className="ws-num rounded-[6px] bg-ws-surface px-1.5 py-0.5">A</kbd>{' '}
                {t('inbox.focus.key.approve')}
              </span>
              <span>
                <kbd className="ws-num rounded-[6px] bg-ws-surface px-1.5 py-0.5">E</kbd>{' '}
                {t('inbox.menu.edit')}
              </span>
              <span>
                <kbd className="ws-num rounded-[6px] bg-ws-surface px-1.5 py-0.5">D</kbd>{' '}
                {t('inbox.menu.reject')}
              </span>
              {onTodo === undefined ? null : (
                <span>
                  <kbd className="ws-num rounded-[6px] bg-ws-surface px-1.5 py-0.5">T</kbd>{' '}
                  {t('inbox.menu.todo')}
                </span>
              )}
              <span>
                <kbd className="ws-num rounded-[6px] bg-ws-surface px-1.5 py-0.5">→</kbd>{' '}
                {t('inbox.focus.skip')}
              </span>
            </span>
          </div>
        </div>
      )}
      {latest === undefined ? null : (
        <p
          className="flex items-center gap-2 px-1 text-xs text-ws-muted-fg"
          data-testid="inbox-focus-recent"
        >
          {t('inbox.focus.recent', {
            what:
              byOther !== undefined
                ? handledText(byOther, t)
                : t(
                    latest.kind === 'skip'
                      ? 'inbox.focus.did.skip'
                      : latest.did === 'approve'
                        ? 'inbox.focus.did.approve'
                        : latest.did === 'reject'
                          ? 'inbox.focus.did.reject'
                          : 'inbox.focus.did.other',
                    { title: itemTitle(latest.item) },
                  ),
          })}
          {canUndo ? (
            <button
              type="button"
              className="ws-link"
              data-testid="inbox-focus-undo"
              data-undo={latest.kind === 'skip' ? 'skip' : latest.undo?.kind}
              disabled={undoing}
              onClick={() => {
                if (latest.kind === 'skip') undoSkip(latest)
                else undoDecision(latest)
              }}
            >
              {left === undefined || latest.kind === 'skip'
                ? t('inbox.focus.undo')
                : t('inbox.focus.undo_left', { s: left })}
            </button>
          ) : null}
        </p>
      )}
    </section>
  )
}
