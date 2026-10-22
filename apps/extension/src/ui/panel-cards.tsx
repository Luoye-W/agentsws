/**
 * WP413 侧边栏 ② 要你处理：等你发之外的那几样——起草卡在哪一步、交给插件之后做到哪了（填好了等你点 / 已发 ·
 * 已记录 / 没发出去 · 再填一次）、交给你发的社媒帖子。
 * WP445（决策 1322）：「发出去」卡不再在这里单出一块——它们和批过的那几条一起在上面「等你发」里（`panel-desk.tsx`）。
 */
import type { PanelPost, PanelStage, PanelWrite } from '@agentsws/browser-action'
import { useState } from 'react'
import { stageTone, writeLine, writeTone } from '@/lib/panel/format'
import { SentBox } from './panel-desk'
import { IconCheck, IconClock, IconExternal, IconX } from './panel-icons'
import { PanelPosts, type PostActions } from './panel-posts'
import { StageLine } from './panel-progress'

export interface CardActions {
  refill(job: string): Promise<string | undefined>
  /** WP467：「我发了，帮我记一下」（贴链接 / 认最近一条）。 */
  sent?(job: string, how: 'link' | 'latest', link?: string): Promise<string | undefined>
}

export function WriteRow(props: {
  write: PanelWrite
  actions: CardActions
  canAct: boolean
  /** WP432：填好了但页面对不上（等你粘贴）时，「复制草稿」。 */
  copy?: (text: string) => Promise<boolean>
}) {
  const w = props.write
  const tone = writeTone(w)
  const [msg, setMsg] = useState<string | undefined>(undefined)
  const [busy, setBusy] = useState(false)
  const Icon = tone === 'good' ? IconCheck : tone === 'bad' ? IconX : IconClock
  return (
    <li className={`ws-write ws-write--${tone}`} data-testid="ws-write" data-state={w.state}>
      <Icon className="ws-ico" />
      <div className="ws-write-body">
        <span className="ws-write-label">{w.label ?? `r/${w.subreddit}`}</span>
        <span className="ws-write-state">{writeLine(w)}</span>
        {msg === undefined ? null : <small className="ws-bad-text">{msg}</small>}
      </div>
      {w.link === undefined ? null : (
        <a
          className="ws-iconbtn"
          href={w.link}
          target="_blank"
          rel="noreferrer"
          title="打开发出去的那一条"
        >
          <IconExternal />
        </a>
      )}
      {w.state === 'filling' && w.text !== undefined && props.copy !== undefined ? (
        <button
          type="button"
          className="ws-btn ws-btn--ghost ws-btn--sm"
          data-testid="ws-write-copy"
          onClick={() => {
            void props.copy?.(w.text ?? '').then((ok) => setMsg(ok ? '草稿已复制' : '没复制上'))
          }}
        >
          复制
        </button>
      ) : null}
      {/* WP467：正在等你点发送 / 没发出去的：你自己发了、插件没认出来，就在这里记一下 */}
      {(w.state === 'filling' || w.state === 'queued' || w.state === 'failed') &&
      w.record_id === undefined &&
      props.canAct &&
      props.actions.sent !== undefined ? (
        <SentBox
          canLatest={w.kind !== 'submit'}
          sent={(how, link) =>
            props.actions.sent?.(w.job_id, how, link) ?? Promise.resolve(undefined)
          }
        />
      ) : null}
      {w.state === 'failed' && w.can_refill === true && props.canAct ? (
        <button
          type="button"
          className="ws-btn ws-btn--ghost ws-btn--sm"
          disabled={busy}
          data-testid="ws-refill"
          onClick={() => {
            setBusy(true)
            void props.actions.refill(w.job_id).then((m) => {
              setMsg(m)
              setBusy(false)
            })
          }}
        >
          再填一次
        </button>
      ) : null}
    </li>
  )
}

export function PanelCards(props: {
  writes: PanelWrite[]
  actions: CardActions
  canAct: boolean
  /** WP419：起草卡在要你动手的那一步（等定口吻 / 矛盾 / 没人担…）——放在最上面一行。 */
  stage?: PanelStage
  openCard?: (id: string) => void
  /** WP419（决策 1231）：交给你发的社媒帖子。 */
  posts?: PanelPost[]
  postActions?: PostActions
  canPost?: boolean
  /** 上面「等你发」里有东西时，不说「没有要你处理的」。 */
  hideEmpty?: boolean
  copy?: (text: string) => Promise<boolean>
}): React.ReactNode {
  const posts = props.posts ?? []
  // 下面那几行是「做到哪了」，不算要你处理的
  const empty = posts.length === 0 && props.hideEmpty !== true
  const stageWarn = props.stage !== undefined && stageTone(props.stage.kind) === 'warn'
  // 什么都没有要画的（上面「等你发」里有东西）：不留一个空框
  if (!empty && !stageWarn && props.writes.length === 0 && posts.length === 0 && props.canAct)
    return null
  return (
    <section className="ws-sec" data-testid="ws-todo">
      {props.stage === undefined || stageTone(props.stage.kind) !== 'warn' ? null : (
        <StageLine
          stage={props.stage}
          {...(props.openCard === undefined ? {} : { openCard: props.openCard })}
        />
      )}
      {props.writes.length === 0 ? null : (
        <ul className="ws-writes" data-testid="ws-writes">
          {props.writes.map((w) => (
            <WriteRow
              key={w.job_id}
              write={w}
              actions={props.actions}
              canAct={props.canAct}
              {...(props.copy === undefined ? {} : { copy: props.copy })}
            />
          ))}
        </ul>
      )}
      {props.canAct ? null : (
        <p className="ws-note ws-note--warn">
          这把配对只能看。去设置页重新配对一次，就能在这里处理。
        </p>
      )}
      {props.postActions === undefined ? null : (
        <PanelPosts posts={posts} actions={props.postActions} canAct={props.canPost === true} />
      )}
      {empty ? (
        <p className="ws-empty" data-testid="ws-todo-empty">
          <IconCheck className="ws-ico" /> 没有要你处理的
        </p>
      ) : null}
    </section>
  )
}
