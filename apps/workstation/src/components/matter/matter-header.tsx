/**
 * WP264：事项页页头（docs/design/matter/README §1 / §2）——一行短标题 + 一行灰字元信息，吸顶。
 *
 * - 标题是 AI 起的短标题（决策 177），点了就地改；改过的不再被自动覆盖。
 * - 灰字行：职责小标签（点了换）· 状态（小点与左栏同一套颜色）· 参与者头像 · 最近活动 ·（有才出）「N 个待办」。
 * - 「⋯」收 换职责 / 复制链接 /（有才出）固定记录 / 归档 / 关闭事项；在跑或有卡等你批时归档置灰并说为什么。
 * - WP288（决策 326）：**会话**（`ask` 事项）页头只有标题 + 参与者 + 最近活动——不出状态点、不出职责那一格
 *   （任务才有）；「转成任务」收进「⋯」（原来页头下面单独一排「会话 · 转成任务」）。
 */
import type { Todo } from '@agentsws/contracts'
import { cn } from 'cn'
import {
  Archive,
  ArrowLeftRight,
  ChevronDown,
  CircleX,
  ClipboardList,
  Forward,
  Link2,
  Pencil,
  Pin,
} from 'lucide-react'
import { type ReactNode, useEffect, useRef, useState } from 'react'
import { DutyIcon } from '@/components/role-icons/role-icon'
import { TitleMenu, TopBarTitle } from '@/components/shell/top-bar-slots'
import { useApp } from '@/lib/app-context'
import type { MatterState } from './matter-model'

const STATE_DOT: Record<MatterState, string> = {
  running: 'bg-ws-brand animate-pulse motion-reduce:animate-none',
  doing: 'bg-ws-brand',
  awaiting: 'bg-ws-warn',
  connect: 'bg-ws-warn',
  setup: 'bg-ws-warn',
  blocked: 'bg-ws-bad',
  done: 'bg-ws-good',
}
const STATE_FG: Record<MatterState, string> = {
  running: 'text-ws-brand-ink dark:text-ws-brand',
  doing: 'text-ws-brand-ink dark:text-ws-brand',
  awaiting: 'text-ws-warn',
  connect: 'text-ws-warn',
  setup: 'text-ws-warn',
  blocked: 'text-ws-bad',
  done: 'text-ws-good',
}

export interface DutyOption {
  role_id: string
  role_name: string
  /** 本人名下有这条（换得过去）。 */
  mine: boolean
}

/** 点外面 / Esc 就关的小浮层（菜单、职责清单共用）。 */
function usePopover(): {
  open: boolean
  setOpen: (v: boolean | ((x: boolean) => boolean)) => void
  box: React.RefObject<HTMLDivElement | null>
} {
  const [open, setOpen] = useState(false)
  const box = useRef<HTMLDivElement>(null)
  useEffect(() => {
    if (!open) return
    const close = (e: MouseEvent): void => {
      if (box.current !== null && !box.current.contains(e.target as Node)) setOpen(false)
    }
    const esc = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') setOpen(false)
    }
    globalThis.document?.addEventListener('mousedown', close)
    globalThis.document?.addEventListener('keydown', esc)
    return () => {
      globalThis.document?.removeEventListener('mousedown', close)
      globalThis.document?.removeEventListener('keydown', esc)
    }
  }, [open])
  return { open, setOpen, box }
}

/**
 * WP431：改名框（顶栏标题的下拉里点「改名」才出现，就地换掉标题）。回车 / 失焦存，Esc 放弃。
 */
function TitleEditor({
  title,
  onSave,
  onDone,
}: {
  title: string
  editing: true
  onSave: (next: string) => void
  onDone: () => void
}): ReactNode {
  const { t } = useApp()
  const [draft, setDraft] = useState(title)
  const commit = (): void => {
    onDone()
    const next = draft.replace(/\s+/g, ' ').trim()
    if (next !== '' && next !== title) onSave(next)
  }
  return (
    <input
      // biome-ignore lint/a11y/noAutofocus: 点了「改名」就是要改它，焦点直接进去
      autoFocus
      aria-label={t('matter.title.edit')}
      data-testid="matter-title-input"
      value={draft}
      maxLength={120}
      onChange={(e) => {
        setDraft(e.target.value)
      }}
      onFocus={(e) => {
        e.currentTarget.select()
      }}
      onBlur={commit}
      onKeyDown={(e) => {
        if (e.key === 'Enter' && !e.nativeEvent.isComposing) {
          e.preventDefault()
          commit()
        }
        if (e.key === 'Escape') {
          setDraft(title)
          onDone()
        }
      }}
      className="h-7 w-[min(32em,50vw)] rounded-md border border-ws-brand/60 bg-transparent px-1.5 text-[13.5px] font-medium text-foreground outline-none"
    />
  )
}

const Dot = (): ReactNode => (
  <i aria-hidden className="size-[3px] rounded-full bg-current opacity-60" />
)

export function MatterHeader({
  title,
  roleId,
  roleName,
  duties,
  onReroute,
  rerouting,
  state,
  people,
  lastActivity,
  todos,
  onCheckTodo,
  pinned,
  archiveWhy,
  canArchive,
  onArchive,
  canClose,
  onClose,
  onRetitle,
  onHandOff,
  ask = false,
  onPromote,
  promoting = false,
}: {
  title: string
  roleId?: string | undefined
  roleName?: string | undefined
  duties: DutyOption[]
  onReroute: (role_id: string) => void
  rerouting: boolean
  state: MatterState
  people: { person_id: string; label: string }[]
  lastActivity: string
  todos: Todo[]
  onCheckTodo: (id: string) => void
  pinned: { key: string; label: string }[]
  /** 不能归档时那一句为什么（i18n 键）；能归档 = `undefined`。 */
  archiveWhy?: string | undefined
  canArchive: boolean
  onArchive: () => void
  canClose: boolean
  onClose: () => void
  onRetitle: (title: string) => void
  /** WP276：「交给同事」（② 里、事项是我的、没在交的时候才给；不给 = 菜单里没有这一项）。 */
  onHandOff?: (() => void) | undefined
  /** WP288：这是一段会话（岗位里问的一句）——不出状态与职责那一格。 */
  ask?: boolean
  /** WP288：会话的「转成任务」（在「⋯」里；不给 = 菜单里没有这一项）。 */
  onPromote?: (() => void) | undefined
  promoting?: boolean
}): ReactNode {
  const { t } = useApp()
  const [renaming, setRenaming] = useState(false)
  const picker = usePopover()
  const [todosOpen, setTodosOpen] = useState(false)
  const [copied, setCopied] = useState(false)
  const openTodos = todos.filter((x) => x.status !== 'done' && x.status !== 'dropped')
  const switchable = duties.filter((d) => d.mine)

  /** WP431：「⋯」那几项搬进顶栏标题的下拉（照 Claude：标题 ˅ 就是这件事的操作），最上面加一项「改名」。 */
  const menuItems = (close: () => void): ReactNode => (
    <>
      <button
        type="button"
        role="menuitem"
        data-testid="matter-rename"
        onClick={() => {
          close()
          setRenaming(true)
        }}
        className="flex h-8 items-center gap-2 rounded-lg px-2 text-left text-[13px] hover:bg-muted"
      >
        <Pencil aria-hidden className="size-3.5" />
        {t('topbar.matter.rename')}
      </button>
      {onPromote === undefined ? null : (
        <button
          type="button"
          role="menuitem"
          data-testid="matter-ask-promote"
          disabled={promoting}
          onClick={() => {
            close()
            onPromote()
          }}
          className="flex h-8 items-center gap-2 rounded-lg px-2 text-left text-[13px] hover:bg-muted disabled:text-ws-muted-fg"
        >
          <ClipboardList aria-hidden className="size-3.5" />
          {t('matter.ask.promote')}
        </button>
      )}
      {ask ? null : (
        <button
          type="button"
          role="menuitem"
          disabled={switchable.length === 0}
          onClick={() => {
            close()
            picker.setOpen(true)
          }}
          className="flex h-8 items-center gap-2 rounded-lg px-2 text-left text-[13px] hover:bg-muted disabled:text-ws-muted-fg"
        >
          <ArrowLeftRight aria-hidden className="size-3.5" />
          {t('matter.menu.duty')}
        </button>
      )}
      {onHandOff === undefined ? null : (
        <button
          type="button"
          role="menuitem"
          data-testid="matter-handoff"
          onClick={() => {
            close()
            onHandOff()
          }}
          className="flex h-8 items-center gap-2 rounded-lg px-2 text-left text-[13px] hover:bg-muted"
        >
          <Forward aria-hidden className="size-3.5" />
          {t('handoff.give')}
        </button>
      )}
      <button
        type="button"
        role="menuitem"
        data-testid="matter-copy-link"
        onClick={() => {
          const href = globalThis.location?.href ?? ''
          void globalThis.navigator?.clipboard?.writeText(href).then(
            () => {
              setCopied(true)
            },
            () => undefined,
          )
        }}
        className="flex h-8 items-center gap-2 rounded-lg px-2 text-left text-[13px] hover:bg-muted"
      >
        <Link2 aria-hidden className="size-3.5" />
        {copied ? t('matter.menu.copied') : t('matter.menu.copy')}
      </button>
      {pinned.length === 0 ? null : (
        <div className="mt-1 border-t border-ws-line px-2 pt-2 pb-1" data-testid="matter-pinned">
          <p className="mb-1 text-xs text-ws-muted-fg">{t('matter.pinned')}</p>
          <ul className="flex flex-col gap-1">
            {pinned.map((p) => (
              <li key={p.key} className="flex items-center gap-1.5 text-[12.5px] text-ws-body">
                <Pin aria-hidden className="size-3 text-ws-muted-fg" />
                {p.label}
              </li>
            ))}
          </ul>
        </div>
      )}
      <hr className="mx-0.5 my-1 border-ws-line" />
      {canArchive ? (
        <button
          type="button"
          role="menuitem"
          data-testid="matter-archive"
          disabled={archiveWhy !== undefined}
          onClick={() => {
            close()
            onArchive()
          }}
          className="flex h-8 items-center gap-2 rounded-lg px-2 text-left text-[13px] hover:bg-muted disabled:cursor-not-allowed disabled:text-ws-muted-fg disabled:hover:bg-transparent"
        >
          <Archive aria-hidden className="size-3.5" />
          {t('archive.action')}
          {archiveWhy === undefined ? null : (
            <span
              className="ml-auto truncate text-xs text-ws-muted-fg"
              data-testid="matter-archive-why"
            >
              {t(archiveWhy)}
            </span>
          )}
        </button>
      ) : null}
      {canClose ? (
        <button
          type="button"
          role="menuitem"
          data-testid="matter-close"
          onClick={() => {
            close()
            onClose()
          }}
          className="flex h-8 items-center gap-2 rounded-lg px-2 text-left text-[13px] text-ws-bad hover:bg-muted"
        >
          <CircleX aria-hidden className="size-3.5" />
          {t('matter.close')}
        </button>
      ) : null}
    </>
  )

  return (
    <>
      <TopBarTitle>
        {renaming ? (
          <TitleEditor
            title={title}
            editing
            onDone={() => {
              setRenaming(false)
            }}
            onSave={onRetitle}
          />
        ) : (
          <TitleMenu
            title={title}
            testId="matter-title"
            menuTestId="matter-menu"
            menuLabel={t('matter.menu')}
            menu={menuItems}
          />
        )}
      </TopBarTitle>
      <header
        data-testid="matter-header"
        data-state={state}
        className="sticky top-0 z-20 -mx-1 border-b border-ws-line bg-ws-paper px-1 pt-1 pb-3"
      >
        <div className="flex items-start gap-2.5">
          <div className="min-w-0 flex-1">
            <div
              className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-1 text-[12.5px] text-ws-muted-fg"
              data-testid="matter-meta"
            >
              {ask ? null : (
                <div ref={picker.box} className="relative">
                  <button
                    type="button"
                    data-testid="matter-reroute"
                    data-role={roleId ?? ''}
                    title={t('matter.duty.tip')}
                    aria-haspopup="menu"
                    aria-expanded={picker.open}
                    disabled={switchable.length === 0}
                    onClick={() => {
                      picker.setOpen((v) => !v)
                    }}
                    className="-ml-1 inline-flex h-[22px] items-center gap-1.5 rounded-md px-1.5 hover:text-ws-ink hover:shadow-[inset_0_0_0_1px_var(--ws-line)] disabled:hover:shadow-none"
                  >
                    {roleId === undefined ? null : <DutyIcon role_id={roleId} size={14} />}
                    <span>{roleName ?? t('matter.duty.none')}</span>
                    {switchable.length === 0 ? null : (
                      <ArrowLeftRight aria-hidden className="size-3 text-ws-muted-fg" />
                    )}
                  </button>
                  {picker.open ? (
                    <div
                      role="menu"
                      data-testid="reroute-options"
                      className="absolute top-7 left-0 z-30 flex w-56 flex-col gap-0.5 rounded-xl border border-ws-line bg-ws-card p-1 shadow-ws"
                    >
                      {duties.map((d) => (
                        <button
                          key={d.role_id}
                          type="button"
                          role="menuitemradio"
                          aria-checked={d.role_id === roleId}
                          disabled={!d.mine || rerouting || d.role_id === roleId}
                          onClick={() => {
                            picker.setOpen(false)
                            onReroute(d.role_id)
                          }}
                          className={cn(
                            'flex h-8 items-center gap-2 rounded-lg px-2 text-left text-[13px] text-ws-body hover:bg-muted disabled:text-ws-muted-fg disabled:hover:bg-transparent',
                            d.role_id === roleId && 'font-medium text-ws-ink',
                          )}
                        >
                          <DutyIcon role_id={d.role_id} size={14} />
                          {d.role_name}
                        </button>
                      ))}
                    </div>
                  ) : null}
                </div>
              )}
              {ask ? null : (
                <>
                  <Dot />
                  <span
                    className={cn('inline-flex items-center gap-1.5 font-medium', STATE_FG[state])}
                    data-testid="matter-state"
                  >
                    <i aria-hidden className={cn('size-[7px] rounded-full', STATE_DOT[state])} />
                    {t(`matter.state.${state}`)}
                  </span>
                  <Dot />
                </>
              )}
              <span className="inline-flex items-center" title={t('matter.people')}>
                {people.slice(0, 3).map((p, i) => (
                  <span
                    key={p.person_id}
                    data-testid="matter-participant"
                    data-person={p.person_id}
                    title={p.label}
                    className={cn(
                      'inline-flex size-[18px] items-center justify-center rounded-full bg-ws-warn-bg text-xs font-semibold text-ws-warn shadow-[0_0_0_2px_var(--ws-paper)]',
                      i > 0 && '-ml-1',
                    )}
                  >
                    {Array.from(p.label)[0] ?? '?'}
                  </span>
                ))}
                <span
                  aria-hidden
                  className={cn(
                    'inline-flex size-[18px] items-center justify-center rounded-full bg-ws-tint text-ws-tiny font-semibold text-ws-brand-ink shadow-[0_0_0_2px_var(--ws-paper)] dark:text-ws-brand',
                    people.length > 0 && '-ml-1',
                  )}
                >
                  AI
                </span>
              </span>
              <Dot />
              <span>{t('matter.recent', { at: lastActivity })}</span>
              {openTodos.length === 0 ? null : (
                <>
                  <Dot />
                  <button
                    type="button"
                    data-testid="matter-todos-chip"
                    aria-expanded={todosOpen}
                    onClick={() => {
                      setTodosOpen((v) => !v)
                    }}
                    className="inline-flex h-[22px] items-center gap-1 rounded-full bg-ws-info-bg px-2 font-medium text-ws-info"
                  >
                    {t('matter.todos.count', { count: openTodos.length })}
                    <ChevronDown
                      aria-hidden
                      className={cn('size-3 transition-transform', todosOpen && 'rotate-180')}
                    />
                  </button>
                </>
              )}
            </div>
          </div>
        </div>
        {todosOpen && openTodos.length > 0 ? (
          <ul
            className="mt-2.5 flex flex-col rounded-xl bg-ws-card p-1.5 shadow-ws"
            data-testid="matter-todos"
          >
            {openTodos.map((todo) => (
              <li
                key={todo.id}
                data-todo={todo.id}
                className="flex items-center gap-2.5 rounded-lg px-2 py-1.5 text-[13px] hover:bg-muted"
              >
                <input
                  type="checkbox"
                  aria-label={`${t('todos.done')}：${todo.title}`}
                  className="size-[15px] accent-[var(--ws-good)]"
                  checked={false}
                  onChange={() => {
                    onCheckTodo(todo.id)
                  }}
                />
                <span className="min-w-0 truncate">{todo.title}</span>
                {todo.cards.length === 0 ? null : (
                  <span className="ml-auto shrink-0 text-xs text-ws-muted-fg">
                    {t('todos.cards', { count: todo.cards.length })}
                  </span>
                )}
              </li>
            ))}
          </ul>
        ) : null}
      </header>
    </>
  )
}
