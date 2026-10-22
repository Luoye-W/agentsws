/**
 * WP419（决策 1231）：侧边栏「要你处理」里的**等你发的社媒帖子**——到点了、没接官方接口（不用开发者应用），
 * 交给你在自己登录着的后台里发：打开发帖页（X / Threads / LinkedIn 正文已预填，别的点「复制文案」再粘贴）、
 * 素材在工坊素材库里自己带上、**你点发布**；回来点「发好了」（贴回那一条的链接 = 工坊读回确认；不贴只记「你说发了」）。
 * 插件不在页面上点任何东西。
 */
import type { PanelPost } from '@agentsws/browser-action'
import { useState } from 'react'
import { IconAlert, IconExternal } from './panel-icons'

export interface PostActions {
  open(post: PanelPost): void
  done(post: PanelPost, link: string | undefined): Promise<string | undefined>
  skip(post: PanelPost): Promise<string | undefined>
}

function when(iso: string | undefined): string {
  if (iso === undefined) return ''
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return ''
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`
}

export function PostItem(props: {
  post: PanelPost
  actions: PostActions
  canAct: boolean
}): React.ReactNode {
  const p = props.post
  const [link, setLink] = useState('')
  const [busy, setBusy] = useState(false)
  const [msg, setMsg] = useState<string | undefined>(undefined)
  const [copied, setCopied] = useState(false)
  const act = (fn: () => Promise<string | undefined>) => {
    setBusy(true)
    setMsg(undefined)
    void fn().then((m) => {
      setMsg(m)
      setBusy(false)
    })
  }
  return (
    <li className="ws-card-item ws-desk-card" data-testid="ws-post" data-channel={p.channel}>
      <div className="ws-card-head ws-card-head--static">
        <b>
          {p.channel_label}
          {p.account === '' ? '' : ` · ${p.account}`}
        </b>
        {p.scheduled_at === undefined ? null : (
          <span className="ws-muted" title="原定什么时候发">
            {when(p.scheduled_at)}
          </span>
        )}
      </div>
      <div className="ws-card-body">
        <blockquote className="ws-quote ws-clamp-4" data-testid="ws-post-body">
          {p.body}
        </blockquote>
        <div className="ws-meta">
          <span className="ws-tag" title="正文已经填进发帖页；没填的点「复制文案」再粘贴">
            {p.prefilled ? '正文已预填' : '要粘贴正文'}
          </span>
          {p.media === 0 ? null : (
            <span className="ws-pill ws-pill--warn" title="素材在工坊的素材库里，发帖时自己带上">
              素材 {p.media} 个
            </span>
          )}
        </div>
        <div className="ws-actions">
          <button
            type="button"
            className="ws-btn ws-btn--primary"
            data-testid="ws-post-open"
            onClick={() => props.actions.open(p)}
          >
            打开发帖页 <IconExternal className="ws-ico ws-ico--sm" />
          </button>
          <button
            type="button"
            className="ws-btn"
            data-testid="ws-post-copy"
            onClick={() => {
              void navigator.clipboard
                ?.writeText(p.body)
                .then(() => setCopied(true))
                .catch(() => setMsg('复制没成，手动选中上面的正文复制。'))
            }}
          >
            {copied ? '复制好了' : '复制文案'}
          </button>
        </div>
        {props.canAct ? (
          <>
            <input
              className="ws-input"
              value={link}
              placeholder="发好了的那一条的链接（可不填）"
              aria-label="发出去那一条的链接"
              data-testid="ws-post-link"
              onChange={(e) => setLink(e.target.value)}
            />
            <div className="ws-row">
              <button
                type="button"
                className="ws-btn ws-btn--sm"
                disabled={busy}
                data-testid="ws-post-done"
                title="贴了链接 = 工坊记下那一条；不贴只记「你说发了」"
                onClick={() =>
                  act(() => props.actions.done(p, link.trim() === '' ? undefined : link.trim()))
                }
              >
                发好了
              </button>
              <button
                type="button"
                className="ws-btn ws-btn--ghost ws-btn--sm"
                disabled={busy}
                data-testid="ws-post-skip"
                onClick={() => act(() => props.actions.skip(p))}
              >
                不发了
              </button>
            </div>
          </>
        ) : (
          <p className="ws-note ws-note--warn">
            <IconAlert className="ws-ico" />
            <span className="ws-note-text">这把配对还不能回发帖结果，去设置页重新配对一次。</span>
          </p>
        )}
        {msg === undefined ? null : <small className="ws-bad-text">{msg}</small>}
      </div>
    </li>
  )
}

export function PanelPosts(props: {
  posts: PanelPost[]
  actions: PostActions
  canAct: boolean
}): React.ReactNode {
  if (props.posts.length === 0) return null
  return (
    <ul className="ws-cards ws-posts" data-testid="ws-posts">
      {props.posts.map((p) => (
        <PostItem key={p.id} post={p} actions={props.actions} canAct={props.canAct} />
      ))}
    </ul>
  )
}
