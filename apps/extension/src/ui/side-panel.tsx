/**
 * WP413（真机联调 10-18 R1，Luoye 10-19 定 a–d）：**常驻侧边栏**——Chrome 自带的 sidePanel，点工具栏图标就开，
 * 换标签页不消失。三块：要你处理 / 进度 / 记录（界面少字，照工坊的 `--ws-*` 令牌）。
 *
 * 开着时隔几秒问一次（有正在填的那条时更勤一点），所以工坊里先处理了的卡这里会自己收起；
 * 这里处理了，工坊那边同一张卡也收起（同一个审批总线）。
 *
 * WP445（决策 1322 / 1323）：AI 起草的 Reddit 回帖 / 发帖直接在「等你发」里审、改、打开、不发（工坊不出卡）；
 * 底部那一栏去掉了，插件与工坊版本对不上时顶上临时出一条。
 */
import type { PanelSnapshot } from '@agentsws/browser-action'
import { PANEL_REFRESH_MS } from '@agentsws/browser-action'
import { useCallback, useEffect, useRef, useState } from 'react'
import { chromePermissions } from '@/lib/ads/permissions'
import type { ExtensionMessage, ExtensionResponse } from '@/lib/messages'
import { send as defaultSend } from '@/lib/messages'
import type { PanelState } from '@/lib/panel/broker'
import { requestReddit } from '@/lib/reddit/permissions'
import { BrandMark } from './brand-mark'
import { type CardActions, PanelCards } from './panel-cards'
import {
  type DeskActions,
  deskEntries,
  FollowStrip,
  PanelDesk,
  PanelStatusStrip,
  VersionBanner,
} from './panel-desk'
import { IconGear } from './panel-icons'
import type { PostActions } from './panel-posts'
import { PanelProgressView } from './panel-progress'
import { PanelRecords } from './panel-records'

export type Send = (message: ExtensionMessage) => Promise<ExtensionResponse | undefined>
type Tab = 'todo' | 'progress' | 'records'

const busyWrites = (s: PanelSnapshot): boolean =>
  s.writes.some((w) => w.state === 'queued' || w.state === 'filling')

/** WP432：「稍后」收起多久（本插件页面自己记；过了又回到「等你发」里）。 */
export const LATER_MS = 2 * 60 * 60 * 1000
const LATER_KEY = 'agentsws.panel.later'

function readLater(now: number): Record<string, number> {
  try {
    const raw = JSON.parse(globalThis.localStorage?.getItem(LATER_KEY) ?? '{}') as Record<
      string,
      number
    >
    return Object.fromEntries(Object.entries(raw).filter(([, until]) => until > now))
  } catch {
    return {}
  }
}
function writeLater(v: Record<string, number>): void {
  try {
    globalThis.localStorage?.setItem(LATER_KEY, JSON.stringify(v))
  } catch {
    // 存不下：这一次打开里照样收起
  }
}

/** 侧边栏所在的窗口（「填入」先找这个窗口里开着的原帖页，没有就在这里开新标签页）。 */
async function currentWindowId(): Promise<number | undefined> {
  try {
    return (await chrome.windows.getCurrent()).id
  } catch {
    return undefined
  }
}

/** 正在跑的插件版本（`version_name` 优先）。 */
function runningVersion(): string {
  try {
    const m = chrome.runtime.getManifest()
    return m.version_name !== undefined && m.version_name !== '' ? m.version_name : m.version
  } catch {
    return '?'
  }
}

/** 有正在填的那条时多久问一次。 */
export const PANEL_FAST_REFRESH_MS = 2_000

export function SidePanel(props: {
  send?: Send
  refreshMs?: number
  /** 测试里不弹权限窗。 */
  connectReddit?: () => Promise<boolean>
  /** WP432：测试里换掉（窗口 id、复制、版本）。 */
  windowId?: () => Promise<number | undefined>
  copy?: (text: string) => Promise<boolean>
  version?: string
}): React.ReactNode {
  const send = props.send ?? defaultSend
  const [state, setState] = useState<PanelState | undefined>(undefined)
  const [tab, setTab] = useState<Tab | undefined>(undefined)
  const [later, setLater] = useState<Record<string, number>>(() => readLater(Date.now()))
  /** WP445：「不发 + 理由」时同类的也一并不发了（顶上一行，能撤回）。 */
  const [followed, setFollowed] = useState<
    { leader_id: string; ids: string[]; titles: string[] } | undefined
  >(undefined)
  const alive = useRef(true)

  const refresh = useCallback(async () => {
    const r = await send({ type: 'panel-state' })
    if (!alive.current) return
    if (r?.type === 'panel-state') setState(r.state)
    else setState({ kind: 'error', message: '插件后台没回话，稍等一下再看。' })
  }, [send])

  useEffect(() => {
    alive.current = true
    void refresh()
    return () => {
      alive.current = false
    }
  }, [refresh])
  // WP432：一打开侧边栏就问一次「工坊换了新版插件没有」（不等每分钟那一拍；换了就等空闲重载）
  useEffect(() => {
    void send({ type: 'update-check' })
  }, [send])

  const snap = state?.kind === 'ok' ? state.snapshot : undefined
  const fast = snap !== undefined && busyWrites(snap)
  useEffect(() => {
    const ms = fast ? PANEL_FAST_REFRESH_MS : (props.refreshMs ?? PANEL_REFRESH_MS)
    const t = setInterval(() => void refresh(), ms)
    const onFocus = () => void refresh()
    window.addEventListener('focus', onFocus)
    return () => {
      clearInterval(t)
      window.removeEventListener('focus', onFocus)
    }
  }, [fast, props.refreshMs, refresh])

  const act = useCallback(
    async (m: ExtensionMessage): Promise<string | undefined> => {
      const r = await send(m)
      await refresh()
      if (r?.type !== 'panel-act') return '插件后台没回话，稍等一下再试。'
      if (r.ok && r.followed !== undefined) setFollowed(r.followed)
      return r.ok ? undefined : (r.message ?? '没做成。')
    },
    [send, refresh],
  )
  const winOf = props.windowId ?? currentWindowId
  const actions: CardActions = {
    refill: (job) => act({ type: 'panel-refill', job }),
    sent: (job, how, link) =>
      act({ type: 'panel-sent', job, how, ...(link === undefined ? {} : { link }) }),
  }

  // WP432 / WP445：发帖台——等你发的那几条（插件里审的卡 + 主管批过的）
  const desk: DeskActions = {
    open: async (e, edit) => {
      const windowId = await winOf()
      const win = windowId === undefined ? {} : { windowId }
      // 还没批的卡：批（改过就按改过的）+ 打开，是你这一下点的
      if (e.from === 'card')
        return act({ type: 'panel-fill', id: e.card.id, version: e.card.version, ...edit, ...win })
      return act({ type: 'panel-open', job: e.write.job_id, ...edit, ...win })
    },
    // WP467：「我发了，帮我记一下」（还没批的卡记下 = 在插件里批 + 记已发）
    sent: (e, how, link) =>
      act({
        type: 'panel-sent',
        ...(e.from === 'card'
          ? { card: { id: e.card.id, version: e.card.version } }
          : { job: e.write.job_id }),
        how,
        ...(link === undefined ? {} : { link }),
      }),
    skip: (e, reason) => {
      const why = reason === undefined ? {} : { reason }
      if (e.from === 'card')
        return act({ type: 'panel-skip', id: e.card.id, version: e.card.version, ...why })
      return act({ type: 'panel-drop', job: e.write.job_id, ...why })
    },
    later: (e) => {
      const next = { ...readLater(Date.now()), [e.key]: Date.now() + LATER_MS }
      writeLater(next)
      setLater(next)
    },
    copy:
      props.copy ??
      (async (text) => {
        try {
          await navigator.clipboard.writeText(text)
          return true
        } catch {
          return false
        }
      }),
  }
  const entries = snap === undefined ? [] : deskEntries(snap.cards, snap.writes)
  const others = snap?.writes.filter((w) => w.state !== 'awaiting') ?? []
  // WP419：等你定口吻那一张（在工坊里）也算一件要你处理的
  const todoCount =
    snap === undefined
      ? 0
      : entries.length +
        (snap.posts?.length ?? 0) +
        (snap.progress.stage?.card_id === undefined ? 0 : 1)
  // WP419（决策 1231）：交给你发的社媒帖子
  const postActions: PostActions = {
    open: (p) => void send({ type: 'open-social-compose', url: p.compose_url }),
    done: (p, link) =>
      act({ type: 'panel-post-done', id: p.id, ...(link === undefined ? {} : { link }) }),
    skip: (p) => act({ type: 'panel-post-skip', id: p.id }),
  }
  const openCard = (id: string) => void send({ type: 'open-workshop-card', id })
  // 第一次拿到快照时定下停在哪一块（有卡 / 有正在处理的写 → 要你处理；否则进度），之后不跟着数据跳
  const opening: Tab =
    snap !== undefined && (todoCount > 0 || snap.writes.length > 0) ? 'todo' : 'progress'
  useEffect(() => {
    if (tab === undefined && snap !== undefined) setTab(opening)
  }, [tab, snap, opening])
  const current: Tab = tab ?? opening

  const who =
    snap === undefined
      ? ''
      : [snap.workspace_name, snap.person_name]
          .filter((x): x is string => x !== undefined && x.trim() !== '')
          .join(' · ')

  return (
    <div className="ws-side" data-testid="ws-side">
      <header className="ws-top">
        <BrandMark />
        <div className="ws-top-text">
          <b>Agents 工坊</b>
          {/* WP457：「品牌名 · 人名」，两样都没有就整行不画（服务端已经不发占位的 default / owner） */}
          {who === '' ? null : (
            <span className="ws-muted ws-clamp-1" data-testid="ws-who">
              {who}
            </span>
          )}
        </div>
        <button
          type="button"
          className="ws-iconbtn"
          title="设置（配对、连接）"
          aria-label="设置"
          onClick={() => void send({ type: 'open-options' })}
        >
          <IconGear />
        </button>
      </header>
      {state === undefined ? <p className="ws-empty">…</p> : null}
      {state?.kind === 'unpaired' ? <PairBox send={send} onDone={() => void refresh()} /> : null}
      {state !== undefined && state.kind !== 'ok' && state.kind !== 'unpaired' ? (
        <p
          className={state.kind === 'offline' ? 'ws-note' : 'ws-note ws-note--warn'}
          data-testid="ws-state"
        >
          {state.message}
        </p>
      ) : null}
      {state?.kind === 'ok' && snap !== undefined ? (
        <>
          <VersionBanner
            running={props.version ?? runningVersion()}
            {...(snap.versions === undefined ? {} : { versions: snap.versions })}
            checkUpdate={() => void send({ type: 'update-check' })}
          />
          {state.reddit_here ? null : (
            <ConnectReddit
              send={send}
              connect={props.connectReddit ?? (() => requestReddit(chromePermissions()))}
              onDone={() => void refresh()}
            />
          )}
          <PanelStatusStrip progress={snap.progress} />
          <div className="ws-tabs" role="tablist">
            {(
              [
                ['todo', '要你处理', todoCount],
                ['progress', '进度', undefined],
                ['records', '记录', undefined],
              ] as const
            ).map(([id, label, count]) => (
              <button
                key={id}
                type="button"
                role="tab"
                aria-selected={current === id}
                className={current === id ? 'ws-tab ws-tab--on' : 'ws-tab'}
                data-testid={`ws-tab-${id}`}
                onClick={() => setTab(id)}
              >
                {label}
                {count === undefined || count === 0 ? null : (
                  <span className="ws-badge">{count}</span>
                )}
              </button>
            ))}
          </div>
          {current === 'todo' && followed !== undefined ? (
            <FollowStrip
              followed={followed}
              close={() => setFollowed(undefined)}
              undo={() => {
                const f = followed
                setFollowed(undefined)
                void act({ type: 'panel-follow-undo', leader: f.leader_id, ids: f.ids })
              }}
            />
          ) : null}
          {current === 'todo' ? (
            <PanelDesk
              entries={entries}
              actions={desk}
              canAct={snap.can_act}
              later={new Set(Object.keys(later))}
              showLater={() => {
                writeLater({})
                setLater({})
              }}
            />
          ) : null}
          {current === 'todo' ? (
            <PanelCards
              writes={others}
              hideEmpty={entries.length > 0}
              copy={desk.copy}
              actions={actions}
              canAct={snap.can_act}
              {...(snap.progress.stage === undefined ? {} : { stage: snap.progress.stage })}
              openCard={openCard}
              posts={snap.posts ?? []}
              postActions={postActions}
              canPost={snap.can_post === true}
            />
          ) : null}
          {current === 'progress' ? (
            <PanelProgressView progress={snap.progress} openCard={openCard} />
          ) : null}
          {current === 'records' ? (
            <PanelRecords records={snap.records} sinks={snap.sinks} />
          ) : null}
        </>
      ) : null}
    </div>
  )
}

/** 没配对：就地输 6 位码（不用跑去设置页）。 */
function PairBox(props: { send: Send; onDone(): void }): React.ReactNode {
  const [code, setCode] = useState('')
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | undefined>(undefined)
  const [busy, setBusy] = useState(false)
  return (
    <section className="ws-sec" data-testid="ws-pair">
      <b>先和这台电脑上的 Agents 工坊配对</b>
      <p
        className="ws-muted"
        title="在工坊的 Reddit 运营岗位页「先装好浏览器插件」那张卡上拿配对码"
      >
        输入工坊里显示的 6 位配对码
      </p>
      <div className="ws-row">
        <input
          className="ws-input ws-code"
          inputMode="numeric"
          maxLength={6}
          value={code}
          aria-label="配对码"
          onChange={(e) => setCode(e.target.value.replace(/\D/gu, ''))}
        />
        <button
          type="button"
          className="ws-btn ws-btn--primary"
          disabled={busy || code.length !== 6}
          onClick={() => {
            setBusy(true)
            void props.send({ type: 'pair', code }).then((r) => {
              setBusy(false)
              if (r?.type !== 'pair') return
              setMsg({ ok: r.ok, text: r.message })
              if (r.ok) props.onDone()
            })
          }}
        >
          配对
        </button>
      </div>
      {msg === undefined ? null : (
        <p className={msg.ok ? 'ws-note' : 'ws-note ws-note--bad'}>{msg.text}</p>
      )}
    </section>
  )
}

/** 这个 Chrome 还没给 Reddit 的站点权限：填不进页面，就地连（浏览器弹窗由你点）。 */
function ConnectReddit(props: {
  send: Send
  connect(): Promise<boolean>
  onDone(): void
}): React.ReactNode {
  const [msg, setMsg] = useState<string | undefined>(undefined)
  return (
    <div className="ws-note ws-note--warn ws-banner" data-testid="ws-connect-reddit">
      <span>这个 Chrome 还没连 Reddit，填不进页面</span>
      <button
        type="button"
        className="ws-btn ws-btn--primary ws-btn--sm"
        onClick={() => {
          // 申请权限必须在点击这一拍里调（浏览器只认用户手势）
          void props.connect().then(async (granted) => {
            setMsg(granted ? undefined : '浏览器里没有给权限，没连上。')
            await props.send({ type: 'reddit-poll' })
            if (granted) await props.send({ type: 'ads-poll' })
            props.onDone()
          })
        }}
      >
        连接
      </button>
      {msg === undefined ? null : <small>{msg}</small>}
    </div>
  )
}
