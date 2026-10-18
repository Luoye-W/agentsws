/**
 * WP413 侧边栏 ② 要你处理：「发出去」类卡在这里看、改、不发、填进页面。
 * 点「填进页面」= 批这张卡（插件里批 = 工坊里批），插件新开一个标签页跳到那个帖子、把草稿填好；
 * **你自己在 Reddit 上点 Reply**，插件读回确认后这一条变成「已发 · 已记录」。工坊那边是同一张卡、同一份记录。
 */
import type { PanelCard, PanelPost, PanelStage, PanelWrite } from '@agentsws/browser-action'
import { PANEL_DRAFT_MAX, PANEL_TITLE_MAX } from '@agentsws/browser-action'
import { useState } from 'react'
import { CHECK_LABEL, stageTone, writeLine, writeTone } from '@/lib/panel/format'
import { IconCheck, IconClock, IconExternal, IconX } from './panel-icons'
import { PanelPosts, type PostActions } from './panel-posts'
import { StageLine } from './panel-progress'

export interface CardActions {
  fill(card: PanelCard, draft: { text: string; title?: string }): Promise<string | undefined>
  skip(card: PanelCard): Promise<string | undefined>
  refill(job: string): Promise<string | undefined>
}

const KIND_VERB: Record<PanelCard['kind'], string> = {
  reply: '回复',
  comment: '回帖',
  submit: '发帖',
}

function cardHead(c: PanelCard): string {
  const who = c.parent_author === undefined ? '' : ` u/${c.parent_author}`
  return `${KIND_VERB[c.kind]}${c.kind === 'submit' ? '' : who} · r/${c.subreddit}`
}

export function WriteRow(props: { write: PanelWrite; actions: CardActions; canAct: boolean }) {
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

export function CardItem(props: {
  card: PanelCard
  actions: CardActions
  canAct: boolean
  open: boolean
  onToggle(): void
}): React.ReactNode {
  const c = props.card
  const [text, setText] = useState(c.draft.text)
  const [title, setTitle] = useState(c.draft.title ?? '')
  const [busy, setBusy] = useState<'fill' | 'skip' | undefined>(undefined)
  const [msg, setMsg] = useState<string | undefined>(undefined)
  const edited = text !== c.draft.text || (c.kind === 'submit' && title !== (c.draft.title ?? ''))
  const run = (what: 'fill' | 'skip') => {
    setBusy(what)
    setMsg(undefined)
    const p =
      what === 'fill'
        ? props.actions.fill(c, { text, ...(c.kind === 'submit' ? { title } : {}) })
        : props.actions.skip(c)
    void p.then((m) => {
      setMsg(m)
      setBusy(undefined)
    })
  }
  return (
    <li className="ws-card-item" data-testid="ws-card" data-open={props.open ? '1' : '0'}>
      <button type="button" className="ws-card-head" onClick={props.onToggle}>
        <b>{cardHead(c)}</b>
        {edited ? <span className="ws-pill">改过</span> : null}
      </button>
      {props.open ? null : (
        <p className="ws-clamp-1 ws-muted">{c.parent_text ?? c.post_title ?? c.title}</p>
      )}
      {props.open ? (
        <div className="ws-card-body">
          {c.post_title === undefined ? null : <p className="ws-post-title">{c.post_title}</p>}
          {c.parent_text === undefined && c.post_text === undefined ? null : (
            <blockquote className="ws-quote ws-clamp-4" data-testid="ws-quote">
              {c.parent_text ?? c.post_text}
            </blockquote>
          )}
          <div className="ws-meta">
            {c.link === undefined ? null : (
              <a href={c.link} target="_blank" rel="noreferrer" className="ws-link">
                原帖 <IconExternal className="ws-ico ws-ico--sm" />
              </a>
            )}
            {c.reason === undefined ? null : (
              <span className="ws-muted ws-clamp-1" title={c.reason} data-testid="ws-reason">
                为什么回：{c.reason}
              </span>
            )}
            {c.facts === undefined ? null : (
              <span className="ws-pill" title={c.facts.map((f) => f.text).join('\n')}>
                依据 {c.facts.length}
              </span>
            )}
            {c.rules === undefined ? null : (
              <span className="ws-pill" title={c.rules.join('\n')}>
                版规 {c.rules.length}
              </span>
            )}
          </div>
          {c.warning === undefined ? null : <p className="ws-note ws-note--warn">{c.warning}</p>}
          {c.checks === undefined && c.prior_replies === undefined ? null : (
            <div className="ws-meta" data-testid="ws-checks">
              {c.prior_replies === undefined ? null : (
                <span
                  className="ws-pill"
                  title={c.prior_replies
                    .map(
                      (r) =>
                        `${r.created_at === undefined ? '' : `${r.created_at.slice(5, 10)} `}${r.text}`,
                    )
                    .join('\n')}
                  data-testid="ws-prior"
                >
                  品牌号在这串里说过 {c.prior_replies.length} 次
                </span>
              )}
              {(c.checks ?? []).map((k) => (
                <span
                  key={`${k.kind}:${k.message}`}
                  className={k.fixed === true ? 'ws-pill' : 'ws-pill ws-pill--warn'}
                  title={k.message}
                  data-testid="ws-check"
                >
                  {CHECK_LABEL[k.kind] ?? k.kind}
                </span>
              ))}
            </div>
          )}
          {c.kind === 'submit' ? (
            <input
              className="ws-input"
              value={title}
              maxLength={PANEL_TITLE_MAX}
              aria-label="标题"
              onChange={(e) => setTitle(e.target.value)}
            />
          ) : null}
          <textarea
            className="ws-input ws-draft"
            data-testid="ws-draft"
            value={text}
            maxLength={PANEL_DRAFT_MAX}
            aria-label="草稿"
            rows={6}
            onChange={(e) => setText(e.target.value)}
          />
          <div className="ws-actions">
            <button
              type="button"
              className="ws-btn ws-btn--primary"
              data-testid="ws-fill"
              disabled={!props.canAct || busy !== undefined || text.trim() === ''}
              title="批这张卡，插件新开一页填好草稿；Reply 由你自己点"
              onClick={() => run('fill')}
            >
              {busy === 'fill' ? '正在填…' : '填进页面'}
            </button>
            <button
              type="button"
              className="ws-btn ws-btn--ghost"
              data-testid="ws-skip"
              disabled={!props.canAct || busy !== undefined}
              onClick={() => run('skip')}
            >
              不发
            </button>
          </div>
          {msg === undefined ? null : <p className="ws-note ws-note--bad">{msg}</p>}
        </div>
      ) : null}
    </li>
  )
}

export function PanelCards(props: {
  cards: PanelCard[]
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
}): React.ReactNode {
  const posts = props.posts ?? []
  const [openId, setOpenId] = useState<string | undefined>(props.cards[0]?.id)
  const open = openId ?? props.cards[0]?.id
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
            <WriteRow key={w.job_id} write={w} actions={props.actions} canAct={props.canAct} />
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
      {props.cards.length === 0 && posts.length > 0 ? null : props.cards.length === 0 ? (
        <p className="ws-empty" data-testid="ws-todo-empty">
          <IconCheck className="ws-ico" /> 没有要你处理的
        </p>
      ) : (
        <ul className="ws-cards">
          {props.cards.map((c) => (
            <CardItem
              key={`${c.id}:${c.version}`}
              card={c}
              actions={props.actions}
              canAct={props.canAct}
              open={c.id === open}
              onToggle={() => setOpenId(c.id === open ? '' : c.id)}
            />
          ))}
        </ul>
      )}
    </section>
  )
}
