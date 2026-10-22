/**
 * WP459（决策 1497–1505）：**收件箱**——左栏原来的「消息」（路由 `/messages` 留着，`/inbox` 同一页）。
 *
 * 一条队列「要你处理」，混两种东西：所有岗位 AI 写好等你批的卡（就地通过 / 不要 / 改，和岗位里是同一张卡，
 * 批了两边一起消失）+ 拿不准归谁 / 只能你定的信。按要紧 / 今天 / 不急分三组（1500 甲）；上面筛选：全部 /
 * 等我批 / 只看信 + 岗位下拉（1501 甲）；右栏「等对方回」「收好的」；顶上今天的简报。
 *
 * 1505（甲 + 丁）：默认列表；页头分段切「一张一张」（`?mode=focus`），同一份数据。
 * 点一行在第三栏打开（外壳那一个第三栏；开不出来——单独渲染这一页时——就在页里画一栏）。
 * 「全部信」是原来的原件档案（`?view=all`），网站聊天是 `?source=chat`，都还是 `MessagesPage`
 * （`MessagesRoute` 在 `messages.tsx` 里按地址挑）。
 */
import type { InboxFilter, InboxItem, InboxUrgency } from '@agentsws/deck'
import { filterInbox, INBOX_URGENCY_ORDER } from '@agentsws/deck'
import { Mail } from 'lucide-react'
import { type ReactNode, useCallback, useEffect, useState } from 'react'
import { Link, useSearchParams } from 'react-router-dom'
import { NoticeLine, PageHeader, Segmented, SkeletonList } from '@/components/design'
import { type InboxNotice, InboxToast, useInboxActions } from '@/components/inbox/inbox-actions'
import { InboxFocus } from '@/components/inbox/inbox-focus'
import {
  pushInboxNotice,
  setInboxOpen,
  useInbox,
  useInboxNotice,
  useInboxOpen,
} from '@/components/inbox/inbox-model'
import { InboxPane } from '@/components/inbox/inbox-pane'
import { InboxRow } from '@/components/inbox/inbox-row'
import { InboxBrief, InboxEmpty, InboxFilterBar, InboxSide } from '@/components/inbox/inbox-side'
import { MessageRulesButton } from '@/components/messages/rules-button'
import { closeRightPane, currentPane, openRightPane } from '@/components/rail/right-pane'
import { useApp } from '@/lib/app-context'
import { apiErrorText } from '@/lib/error-text'
import { cn } from '@/lib/utils'

/** 第三栏那一格的面板 id（`builtin-panels.tsx` 注册）。 */
export const INBOX_PANE_ID = 'inbox-item'

function filterOf(params: URLSearchParams): InboxFilter {
  const type = params.get('type')
  const position = params.get('position')
  return {
    ...(type === 'card' || type === 'mail' ? { type } : {}),
    ...(position === null || position === '' ? {} : { position }),
  }
}

export function InboxPage(): ReactNode {
  const { t } = useApp()
  const inbox = useInbox()
  const open = useInboxOpen()
  const [params, setParams] = useSearchParams()
  const mode: 'list' | 'focus' = params.get('mode') === 'focus' ? 'focus' : 'list'
  const filter = filterOf(params)
  const pushed = useInboxNotice()
  const [local, setLocal] = useState<InboxNotice | undefined>()
  const notice = local ?? pushed
  const say = useCallback((n: InboxNotice) => {
    pushInboxNotice(undefined)
    setLocal(n)
  }, [])
  const closeNotice = useCallback(() => {
    setLocal(undefined)
    pushInboxNotice(undefined)
  }, [])
  const { act, busy } = useInboxActions(say)
  /** 外壳第三栏开不出来（单独渲染这一页）：在页里画一栏。 */
  const [inline, setInline] = useState(false)

  useEffect(() => {
    if (open === null) {
      setInline(false)
      return
    }
    setInline(!openRightPane({ kind: 'panel', id: INBOX_PANE_ID }))
  }, [open])
  // 离开这一页：第三栏里那一件收掉
  useEffect(
    () => () => {
      const pane = currentPane().pane
      if (pane?.kind === 'panel' && pane.id === INBOX_PANE_ID) closeRightPane()
      setInboxOpen(null)
    },
    [],
  )

  const setParam = (key: string, value: string | undefined): void => {
    setParams(
      (prev) => {
        const next = new URLSearchParams(prev)
        if (value === undefined) next.delete(key)
        else next.set(key, value)
        return next
      },
      { replace: true },
    )
  }
  const changeFilter = (next: InboxFilter): void => {
    setParams(
      (prev) => {
        const p = new URLSearchParams(prev)
        p.delete('type')
        p.delete('position')
        if (next.type !== undefined) p.set('type', next.type)
        if (next.position !== undefined) p.set('position', next.position)
        return p
      },
      { replace: true },
    )
  }

  const view = inbox.data
  const items = view === undefined ? [] : filterInbox(view.items, filter)
  const filtered = filter.type !== undefined || filter.position !== undefined
  const total = view?.counts.all ?? 0
  const selected = open?.kind === 'item' ? open.id : undefined

  const header = (
    <PageHeader
      title={t('nav.messages')}
      titleTestId="inbox-title"
      sub={
        view === undefined
          ? undefined
          : total === 0
            ? t('inbox.sub.empty')
            : t('inbox.sub', { done: view.brief.done, n: total })
      }
      actions={
        <>
          <MessageRulesButton />
          <Segmented
            kind="tabs"
            label={t('inbox.mode')}
            testId="inbox-mode"
            value={mode}
            options={[
              { value: 'list', label: t('inbox.mode.list'), testId: 'inbox-mode-list' },
              { value: 'focus', label: t('inbox.mode.focus'), testId: 'inbox-mode-focus' },
            ]}
            onChange={(v) => {
              setInboxOpen(null)
              setParam('mode', v === 'focus' ? 'focus' : undefined)
            }}
          />
          <Link
            to="/messages?view=all"
            className="ws-link-muted inline-flex items-center gap-1 text-[13px]"
            data-testid="inbox-all-mail"
          >
            <Mail aria-hidden className="size-3.5" />
            {t('inbox.all_mail')}
          </Link>
        </>
      }
    />
  )

  const body = ((): ReactNode => {
    if (inbox.isPending) return <SkeletonList rows={6} />
    if (inbox.error !== null || view === undefined)
      return (
        <NoticeLine tone="bad" role="alert">
          {apiErrorText(inbox.error, t)}
        </NoticeLine>
      )
    if (mode === 'focus')
      return (
        <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_300px]">
          {items.length === 0 ? (
            <InboxEmpty filtered={filtered} />
          ) : (
            <InboxFocus
              view={view}
              items={items}
              onNotice={say}
              onList={() => {
                setParam('mode', undefined)
              }}
            />
          )}
          <div className="flex flex-col gap-3">
            <InboxBrief view={view} folded />
            <InboxSide compact onNotice={say} />
          </div>
        </div>
      )
    const paneOpen = open !== null
    const list =
      items.length === 0 ? (
        <InboxEmpty filtered={filtered} />
      ) : (
        <InboxList items={items} view={view} selected={selected} busy={busy} onAct={act} />
      )
    return (
      <>
        <InboxBrief view={view} folded={paneOpen || total === 0} />
        <InboxFilterBar view={view} filter={filter} onChange={changeFilter} />
        <div
          className={cn(
            'grid items-start gap-5',
            inline && paneOpen
              ? 'lg:grid-cols-[minmax(0,1fr)_minmax(360px,440px)]'
              : !paneOpen && 'lg:grid-cols-[minmax(0,1fr)_320px]',
          )}
        >
          <div className="flex min-w-0 flex-col gap-5">
            {list}
            {/* 打开第三栏时这两堆挪到队列下面 */}
            {paneOpen && !inline ? <InboxSide onNotice={say} /> : null}
          </div>
          {inline && paneOpen ? (
            <aside className="ws-card sticky top-14 p-4" data-testid="inbox-pane-inline">
              <InboxPane inline onNotice={say} />
            </aside>
          ) : paneOpen ? null : (
            <InboxSide onNotice={say} />
          )}
        </div>
      </>
    )
  })()

  return (
    <div
      className="relative mx-auto flex w-full max-w-[1280px] flex-col gap-4 pb-16"
      data-testid="inbox-page"
      data-mode={mode}
    >
      {header}
      {body}
      <InboxToast notice={notice} onClose={closeNotice} />
    </div>
  )
}

const GROUP_KEY: Record<InboxUrgency, string> = {
  urgent: 'inbox.group.urgent',
  today: 'inbox.group.today',
  later: 'inbox.group.later',
}

/** 队列：要紧 / 今天 / 不急三组，组名写在卡里（1500 甲）。 */
function InboxList({
  items,
  view,
  selected,
  busy,
  onAct,
}: {
  items: readonly InboxItem[]
  view: NonNullable<ReturnType<typeof useInbox>['data']>
  selected: string | undefined
  busy: string | undefined
  onAct: Parameters<typeof InboxRow>[0]['onAct']
}): ReactNode {
  const { t } = useApp()
  return (
    <div className="ws-card overflow-visible" data-testid="inbox-list">
      {INBOX_URGENCY_ORDER.map((u) => {
        const rows = items.filter((i) => i.urgency === u)
        if (rows.length === 0) return null
        return (
          <section key={u} data-testid="inbox-group" data-urgency={u}>
            <div className="flex items-center gap-2 bg-ws-surface px-4 py-1.5 text-xs font-semibold text-ws-muted-fg first:rounded-t-[16px]">
              {t(GROUP_KEY[u])}
              <span className="ws-num font-normal text-ws-faint">{rows.length}</span>
            </div>
            {rows.map((item) => (
              <InboxRow
                key={item.id}
                item={item}
                positions={view.positions}
                selected={item.id === selected}
                busy={busy === item.id}
                onAct={onAct}
              />
            ))}
          </section>
        )
      })}
    </div>
  )
}
