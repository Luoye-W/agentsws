/**
 * WP413（真机联调 10-18 R1，Luoye 10-19 定 a–d）：**常驻侧边栏**——Chrome 自带的 sidePanel，点工具栏图标就开，
 * 换标签页不消失。三块：要你处理 / 进度 / 记录（界面少字，照工坊的 `--ws-*` 令牌）。
 *
 * 开着时隔几秒问一次（有正在填的那条时更勤一点），所以工坊里先处理了的卡这里会自己收起；
 * 这里处理了，工坊那边同一张卡也收起（同一个审批总线）。
 */
import type { PanelCard, PanelSnapshot } from '@agentsws/browser-action'
import { PANEL_REFRESH_MS } from '@agentsws/browser-action'
import { useCallback, useEffect, useRef, useState } from 'react'
import { chromePermissions } from '@/lib/ads/permissions'
import type { ExtensionMessage, ExtensionResponse } from '@/lib/messages'
import { send as defaultSend } from '@/lib/messages'
import type { PanelState } from '@/lib/panel/broker'
import { requestReddit } from '@/lib/reddit/permissions'
import { BrandMark } from './brand-mark'
import { type CardActions, PanelCards } from './panel-cards'
import { IconGear } from './panel-icons'
import { PanelProgressView } from './panel-progress'
import { PanelRecords } from './panel-records'

export type Send = (message: ExtensionMessage) => Promise<ExtensionResponse | undefined>
type Tab = 'todo' | 'progress' | 'records'

const busyWrites = (s: PanelSnapshot): boolean =>
  s.writes.some((w) => w.state === 'queued' || w.state === 'filling')

/** 有正在填的那条时多久问一次。 */
export const PANEL_FAST_REFRESH_MS = 2_000

export function SidePanel(props: {
  send?: Send
  refreshMs?: number
  /** 测试里不弹权限窗。 */
  connectReddit?: () => Promise<boolean>
}): React.ReactNode {
  const send = props.send ?? defaultSend
  const [state, setState] = useState<PanelState | undefined>(undefined)
  const [tab, setTab] = useState<Tab | undefined>(undefined)
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
      return r.ok ? undefined : (r.message ?? '没做成。')
    },
    [send, refresh],
  )
  const actions: CardActions = {
    fill: (c: PanelCard, d) =>
      act({
        type: 'panel-fill',
        id: c.id,
        version: c.version,
        ...(d.text === c.draft.text ? {} : { text: d.text }),
        ...(d.title === undefined || d.title === c.draft.title ? {} : { title: d.title }),
      }),
    skip: (c) => act({ type: 'panel-skip', id: c.id, version: c.version }),
    refill: (job) => act({ type: 'panel-refill', job }),
  }

  // WP419：等你定口吻那一张（在工坊里）也算一件要你处理的
  const todoCount =
    snap === undefined
      ? 0
      : snap.cards.length + (snap.progress.stage?.card_id === undefined ? 0 : 1)
  const openCard = (id: string) => void send({ type: 'open-workshop-card', id })
  // 第一次拿到快照时定下停在哪一块（有卡 / 有正在处理的写 → 要你处理；否则进度），之后不跟着数据跳
  const opening: Tab =
    snap !== undefined && (todoCount > 0 || snap.writes.length > 0) ? 'todo' : 'progress'
  useEffect(() => {
    if (tab === undefined && snap !== undefined) setTab(opening)
  }, [tab, snap, opening])
  const current: Tab = tab ?? opening

  return (
    <div className="ws-side" data-testid="ws-side">
      <header className="ws-top">
        <BrandMark />
        <div className="ws-top-text">
          <b>Agents 工坊</b>
          {snap === undefined ? null : (
            <span className="ws-muted ws-clamp-1" data-testid="ws-who">
              {[snap.workspace_name, snap.person_name].filter((x) => x !== undefined).join(' · ')}
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
          {state.reddit_here ? null : (
            <ConnectReddit
              send={send}
              connect={props.connectReddit ?? (() => requestReddit(chromePermissions()))}
              onDone={() => void refresh()}
            />
          )}
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
          {current === 'todo' ? (
            <PanelCards
              cards={snap.cards}
              writes={snap.writes}
              actions={actions}
              canAct={snap.can_act}
              {...(snap.progress.stage === undefined ? {} : { stage: snap.progress.stage })}
              openCard={openCard}
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
