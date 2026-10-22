/**
 * WP459：收件箱队列里的一行（v2 示意 `inbox`）。
 *
 * 两行：标题 + 类型标签 + 状态药丸（+「AI 猜的 · 改」）/ AI 一句话；右边「岗位 · 时间」；
 * 左边岗位图标（卡）或发件人头像（信）。行尾一颗**次按钮** + ⋯（1454：一列不放一排绿色主按钮）：
 * 等你批的卡写「通过」（同岗位卡片流的动词）、要去插件发的写「去发」、拿不准的信写 AI 头号猜测「交给 B2B」、
 * 只能你定的写「我自己回」。「不要 / 改 / 交给别的 / 稍后」都在 ⋯ 里。点整行在第三栏打开。
 */
import type { InboxItem, InboxPosition } from '@agentsws/deck'
import { MoreHorizontal } from 'lucide-react'
import { type ReactNode, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { deckActionLabel } from '@/components/deck/deck-action-bar'
import { categoryOf } from '@/components/deck/deck-card'
import { CategoryTag, StatusPill, WsAvatar } from '@/components/design'
import { Popover } from '@/components/messages/popover'
import { PositionIcon } from '@/components/role-icons/role-icon'
import { useApp } from '@/lib/app-context'
import { useMode } from '@/lib/mode'
import { cn } from '@/lib/utils'
import {
  itemLine,
  itemTitle,
  positionLabel,
  postLinkOf,
  setInboxOpen,
  shortTime,
  waitedHours,
} from './inbox-model'

export type RowAct =
  /** WP469：记成待办（「⋯」第一项，快捷键 T） */
  'todo' | 'approve' | 'reject' | 'snooze' | 'hand' | 'self' | 'notice' | 'original' | 'position'

/** 行上那颗药丸（等了多久 / 剩多久 / 等你发 / 急）。 */
export function rowPill(
  item: InboxItem,
  t: (k: string, v?: Record<string, string | number>) => string,
  now = Date.now(),
): { tone: 'warn' | 'bad' | 'info'; text: string } | undefined {
  if (item.tag === 'post') return { tone: 'info', text: t('inbox.pill.to_post') }
  const card = item.card
  if (card !== undefined) {
    const due = card.expires_at === undefined ? Number.NaN : Date.parse(card.expires_at)
    if (Number.isFinite(due)) {
      const h = (due - now) / 3_600_000
      if (h <= 24)
        return {
          tone: h <= 6 ? 'bad' : 'warn',
          text: t('inbox.pill.due_hours', { n: Math.max(1, Math.round(h)) }),
        }
      if (h <= 24 * 3)
        return { tone: 'warn', text: t('inbox.pill.due_days', { n: Math.ceil(h / 24) }) }
    }
    if (card.priority_band === 'P0') {
      const w = waitedHours(card, now)
      return w > 0 ? { tone: 'warn', text: t('inbox.pill.waited', { n: w }) } : undefined
    }
    return undefined
  }
  if (item.mail?.priority === 'high') return { tone: 'warn', text: t('inbox.pill.urgent') }
  return undefined
}

/** 行上那个类型标签。 */
export function rowTag(item: InboxItem, t: (k: string) => string): string {
  if (item.tag === 'post') return t('inbox.tag.post')
  if (item.tag === 'unsure') return t('inbox.tag.unsure')
  if (item.tag === 'only_you') return t('inbox.tag.only_you')
  return item.card === undefined ? '' : categoryOf(item.card, t)
}

/** 行尾那颗次按钮上写什么。 */
export function primaryLabel(
  item: InboxItem,
  positions: readonly InboxPosition[] | undefined,
  t: (k: string, v?: Record<string, string | number>) => string,
  lang: string,
): string {
  switch (item.primary) {
    case 'approve':
      return item.card === undefined
        ? t('inbox.btn.open')
        : deckActionLabel(item.card, 'approve', t)
    case 'go_post':
      return t('inbox.btn.go_post')
    case 'hand': {
      const pos = item.mail?.suggest?.position
      return t('inbox.btn.hand', { name: positionLabel(positions, pos, lang) ?? '' })
    }
    case 'self':
      return item.mail?.kind === 'billing_system' ? t('inbox.btn.self_handle') : t('inbox.btn.self')
    default:
      return item.card?.layout === 'variants' ? t('inbox.btn.pick') : t('inbox.btn.open')
  }
}

export function ItemGlyph({
  item,
  positions,
}: {
  item: InboxItem
  positions: readonly InboxPosition[] | undefined
}): ReactNode {
  if (item.type === 'mail') {
    const from = item.mail?.from
    return (
      <WsAvatar
        name={from?.name ?? from?.email ?? '?'}
        id={from?.email ?? ''}
        className="size-7 shrink-0"
      />
    )
  }
  const pos = positions?.find((p) => p.id === item.position)
  return (
    <span className="grid size-7 shrink-0 place-items-center rounded-[8px] bg-ws-surface text-ws-body">
      <PositionIcon
        position_id={item.position ?? item.card?.role_id ?? ''}
        icon={pos?.icon}
        size={15}
      />
    </span>
  )
}

export function InboxRow({
  item,
  positions,
  selected,
  busy,
  onAct,
}: {
  item: InboxItem
  positions: readonly InboxPosition[] | undefined
  selected?: boolean
  busy?: boolean
  onAct(item: InboxItem, act: RowAct): void
}): ReactNode {
  const { t, lang } = useApp()
  const { t: modeT } = useMode()
  const navigate = useNavigate()
  const [menu, setMenu] = useState(false)
  const pill = rowPill(item, t)
  const where =
    item.type === 'mail' ? t('inbox.mail') : positionLabel(positions, item.position, lang)
  const open = (): void => {
    setInboxOpen({ kind: 'item', id: item.id })
  }
  const card = item.card
  const menuItems: { act: RowAct | 'open' | 'edit'; label: string; key?: string }[] = [
    { act: 'todo', label: t('inbox.menu.todo'), key: 'T' },
    { act: 'open', label: t('inbox.menu.open') },
    ...(card === undefined
      ? [
          ...(item.mail?.suggest?.action === 'hand'
            ? [{ act: 'open' as const, label: t('inbox.menu.hand_other') }]
            : []),
          { act: 'self' as const, label: t('inbox.btn.self') },
          { act: 'notice' as const, label: t('inbox.menu.notice') },
          { act: 'original' as const, label: t('inbox.menu.original') },
        ]
      : [
          ...(card.available_actions.includes('instruct') && item.tag !== 'post'
            ? [{ act: 'edit' as const, label: t('inbox.menu.edit') }]
            : []),
          ...(card.available_actions.includes('reject')
            ? [{ act: 'reject' as const, label: deckActionLabel(card, 'reject', modeT) }]
            : []),
          ...(card.available_actions.includes('snooze')
            ? [{ act: 'snooze' as const, label: t('inbox.menu.snooze') }]
            : []),
          ...(item.position === undefined
            ? []
            : [{ act: 'position' as const, label: t('inbox.menu.position') }]),
        ]),
  ]
  const link = item.tag === 'post' && card !== undefined ? postLinkOf(card) : undefined
  return (
    // biome-ignore lint/a11y/useSemanticElements: 行里还有按钮，不能整行做成 <button>
    <div
      role="button"
      tabIndex={0}
      data-testid="inbox-row"
      data-id={item.id}
      data-type={item.type}
      data-urgency={item.urgency}
      data-selected={selected === true ? 'true' : undefined}
      className={cn(
        'group flex cursor-pointer items-center gap-3 border-t border-ws-line px-4 py-3 first:border-t-0 hover:bg-ws-surface',
        selected === true && 'bg-ws-tint shadow-[inset_3px_0_0_var(--ws-brand)] hover:bg-ws-tint',
      )}
      onClick={open}
      onKeyDown={(e) => {
        if (e.key === 'Enter' && e.target === e.currentTarget) open()
      }}
    >
      <ItemGlyph item={item} positions={positions} />
      <div className="min-w-0 flex-1">
        <div className="flex min-w-0 items-center gap-1.5">
          <span className="truncate text-[14px] font-semibold text-ws-ink" data-slot="title">
            {itemTitle(item)}
          </span>
          <CategoryTag className="shrink-0" data-testid="inbox-row-tag">
            {rowTag(item, t)}
          </CategoryTag>
          {pill === undefined ? null : (
            <StatusPill tone={pill.tone} className="shrink-0" data-testid="inbox-row-pill">
              {pill.text}
            </StatusPill>
          )}
          {item.type === 'mail' &&
          item.mail?.suggest?.position !== undefined &&
          item.mail.kind_confidence !== undefined ? (
            <span className="ws-num shrink-0 text-xs text-ws-faint" data-slot="status">
              {positionLabel(positions, item.mail.suggest.position, lang)}{' '}
              {Math.round(item.mail.kind_confidence * 100)}%
            </span>
          ) : null}
          {item.guessed === undefined ? null : (
            <button
              type="button"
              data-testid="inbox-row-guess"
              className="shrink-0 border-b border-dashed border-ws-faint text-xs text-ws-muted-fg hover:text-ws-ink"
              onClick={(e) => {
                e.stopPropagation()
                setInboxOpen({ kind: 'guessed', message_id: item.guessed?.message_id })
              }}
            >
              {t('inbox.guess')}
            </button>
          )}
          <span className="ml-auto shrink-0 pl-2 text-xs text-ws-faint" data-slot="status">
            {[where, shortTime(item.at, Date.now(), lang)]
              .filter((x) => x !== undefined && x !== '')
              .join(' · ')}
          </span>
        </div>
        <p className="mt-0.5 truncate text-[13px] text-ws-body" data-testid="inbox-row-line">
          {itemLine(item)}
        </p>
      </div>
      {link !== undefined ? (
        <a
          href={link}
          target="_blank"
          rel="noreferrer"
          title={t('inbox.btn.go_post.hint')}
          data-testid="inbox-row-primary"
          data-act="go_post"
          className="ws-btn ws-btn-secondary ws-btn-sm shrink-0"
          onClick={(e) => {
            e.stopPropagation()
          }}
        >
          {primaryLabel(item, positions, modeT, lang)}
        </a>
      ) : (
        <button
          type="button"
          data-testid="inbox-row-primary"
          data-act={item.primary}
          disabled={busy === true}
          className="ws-btn ws-btn-secondary ws-btn-sm shrink-0"
          onClick={(e) => {
            e.stopPropagation()
            if (item.primary === 'approve' && card?.reconfirm !== true) onAct(item, 'approve')
            else if (item.primary === 'hand') onAct(item, 'hand')
            else if (item.primary === 'self') onAct(item, 'self')
            else open()
          }}
        >
          {primaryLabel(item, positions, modeT, lang)}
        </button>
      )}
      {/* biome-ignore lint/a11y/noStaticElementInteractions: 只挡住冒泡，菜单本身是按钮 */}
      {/* biome-ignore lint/a11y/useKeyWithClickEvents: 同上 */}
      <span
        onClick={(e) => {
          e.stopPropagation()
        }}
      >
        <Popover
          open={menu}
          onOpenChange={setMenu}
          align="end"
          testId="inbox-row-menu"
          trigger={
            <button
              type="button"
              aria-label={t('inbox.more')}
              aria-expanded={menu}
              data-testid="inbox-row-more"
              className="grid size-7 place-items-center rounded-[8px] text-ws-muted-fg hover:bg-ws-surface hover:text-ws-ink"
              onClick={() => {
                setMenu((v) => !v)
              }}
            >
              <MoreHorizontal aria-hidden className="size-4" />
            </button>
          }
        >
          <div className="flex w-44 flex-col p-1" role="menu">
            {menuItems.map((m, i) => (
              <button
                // biome-ignore lint/suspicious/noArrayIndexKey: 同一个菜单里「打开」可能出现两次
                key={`${m.act}-${i}`}
                type="button"
                role="menuitem"
                data-testid={`inbox-menu-${m.act}`}
                className="flex items-center rounded-[8px] px-2.5 py-1.5 text-left text-[13px] hover:bg-ws-surface"
                onClick={() => {
                  setMenu(false)
                  if (m.act === 'open') open()
                  else if (m.act === 'edit') setInboxOpen({ kind: 'item', id: item.id, edit: true })
                  else if (m.act === 'position') {
                    const asg = positions?.find((p) => p.id === item.position)?.assignment_id
                    navigate(asg === undefined ? '/' : `/positions/${asg}`)
                  } else onAct(item, m.act)
                }}
              >
                <span className="min-w-0 flex-1">{m.label}</span>
                {m.key === undefined ? null : (
                  <kbd className="ws-num ml-2 text-xs text-ws-faint">{m.key}</kbd>
                )}
              </button>
            ))}
          </div>
        </Popover>
      </span>
    </div>
  )
}
