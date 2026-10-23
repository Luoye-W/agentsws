/**
 * WP413 侧边栏 ② 要你处理：等你发之外的那几样——起草卡在哪一步、交给插件之后做到哪了（填好了等你点 / 已发 ·
 * 已记录 / 没发出去 · 再填一次）、交给你发的社媒帖子。
 * WP445（决策 1322）：「发出去」卡不再在这里单出一块——它们和批过的那几条一起在上面「等你发」里（`panel-desk.tsx`）。
 */
import {
  PANEL_DRAFT_MAX,
  type PanelPost,
  type PanelStage,
  type PanelWrite,
} from '@agentsws/browser-action'
import { useState } from 'react'
import { stageTone, writeLine, writeTone } from '@/lib/panel/format'
import { SentBox } from './panel-desk'
import { IconAlert, IconCheck, IconExternal } from './panel-icons'
import { PanelPosts, type PostActions } from './panel-posts'
import { StageLine } from './panel-progress'

export interface CardActions {
  /** WP478：给了 `text` = 「修改」过，按改过的字再填。 */
  refill(job: string, text?: string): Promise<string | undefined>
  /** WP467：「我发了，帮我记一下」（贴链接 / 认最近一条）。 */
  sent?(job: string, how: 'link' | 'latest', link?: string): Promise<string | undefined>
}

/** WP456-T7：一条写现在怎样 → 状态药丸上那几个字（细的那句另起一行）。 */
export function writePill(w: PanelWrite): string {
  switch (w.state) {
    case 'awaiting':
      return '等你填入'
    case 'queued':
      return '正在打开'
    case 'filling':
      return '等你点发送'
    case 'sent':
      return w.record_id === undefined ? '已发' : '已发 · 已记录'
    case 'failed':
      return '没发出去'
  }
}

/**
 * 交给插件之后做到哪了（列表组里的一行）。WP456-T7：状态是「点 + 字」的药丸，颜色只表示状态（好 / 要留意 / 出错）；
 * 细的那句（为什么没发出去、要你做什么）另起一行灰字；动作是小号次按钮 / 弱按钮。
 */
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
  const pill = writePill(w)
  const line = writeLine(w)
  const canCopy = w.state === 'filling' && w.text !== undefined && props.copy !== undefined
  // WP467：正在等你点发送 / 没发出去的：你自己发了、插件没认出来，就在这里记一下
  const canSent =
    (w.state === 'filling' || w.state === 'queued' || w.state === 'failed') &&
    w.record_id === undefined &&
    props.canAct &&
    props.actions.sent !== undefined
  const canRefill = w.state === 'failed' && w.can_refill === true && props.canAct
  /** WP478：没发出去的那一条就地改字再填（和岗位页同一个规矩）；`undefined` = 没在改。 */
  const [edit, setEdit] = useState<string | undefined>(undefined)
  const refill = (text?: string): void => {
    setBusy(true)
    void props.actions.refill(w.job_id, text).then((m) => {
      setMsg(m)
      setBusy(false)
      if (m === undefined) setEdit(undefined)
    })
  }
  return (
    <li className={`ws-write ws-write--${tone}`} data-testid="ws-write" data-state={w.state}>
      <div className="ws-write-top">
        <span className="ws-write-label">{w.label ?? `r/${w.subreddit}`}</span>
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
      </div>
      <div className="ws-write-state">
        <span className={`ws-pill ws-pill--${tone}`}>{pill}</span>
        {line === pill ? null : <span className="ws-write-msg">{line}</span>}
      </div>
      {msg === undefined ? null : <small className="ws-bad-text">{msg}</small>}
      {canCopy || canSent || canRefill ? (
        <div className="ws-write-acts">
          {canRefill && edit === undefined ? (
            <>
              <button
                type="button"
                className="ws-btn ws-btn--sm"
                disabled={busy}
                data-testid="ws-refill"
                onClick={() => refill()}
              >
                再填一次
              </button>
              {w.text === undefined ? null : (
                <button
                  type="button"
                  className="ws-btn ws-btn--sm"
                  disabled={busy}
                  data-testid="ws-refill-edit"
                  onClick={() => setEdit(w.text ?? '')}
                >
                  修改
                </button>
              )}
            </>
          ) : null}
          {canCopy ? (
            <button
              type="button"
              className="ws-btn ws-btn--sm"
              data-testid="ws-write-copy"
              onClick={() => {
                void props.copy?.(w.text ?? '').then((ok) => setMsg(ok ? '草稿已复制' : '没复制上'))
              }}
            >
              复制
            </button>
          ) : null}
          {canSent ? (
            <SentBox
              canLatest={w.kind !== 'submit'}
              sent={(how, link) =>
                props.actions.sent?.(w.job_id, how, link) ?? Promise.resolve(undefined)
              }
            />
          ) : null}
        </div>
      ) : null}
      {canRefill && edit !== undefined ? (
        <div className="ws-write-edit" data-testid="ws-refill-editor">
          <textarea
            className="ws-input ws-draft"
            data-testid="ws-refill-text"
            value={edit}
            maxLength={PANEL_DRAFT_MAX}
            aria-label="草稿"
            rows={5}
            onChange={(e) => setEdit(e.target.value)}
          />
          <div className="ws-write-acts">
            <button
              type="button"
              className="ws-btn ws-btn--sm ws-btn--primary"
              disabled={busy || edit.trim() === ''}
              data-testid="ws-refill-save"
              onClick={() => refill(edit)}
            >
              改好了，再填一次
            </button>
            <button
              type="button"
              className="ws-btn ws-btn--sm"
              disabled={busy}
              data-testid="ws-refill-cancel"
              onClick={() => setEdit(undefined)}
            >
              取消
            </button>
          </div>
        </div>
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
    <section className="ws-todo" data-testid="ws-todo">
      {props.stage === undefined || stageTone(props.stage.kind) !== 'warn' ? null : (
        <StageLine
          stage={props.stage}
          {...(props.openCard === undefined ? {} : { openCard: props.openCard })}
        />
      )}
      {props.writes.length === 0 ? null : (
        <ul className="ws-writes ws-group" data-testid="ws-writes">
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
          <IconAlert className="ws-ico" />
          <span className="ws-note-text">
            这把配对只能看。去设置页重新配对一次，就能在这里处理。
          </span>
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
