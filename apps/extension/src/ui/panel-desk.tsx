/**
 * WP432（Luoye 10-20 反馈 9，最急）：**侧边栏是发帖台**。
 *
 * - 顶上一行实时状况：巡查到第几块了、今天发了几条、等你发几条、卡在哪（照实说）；
 * - 「等你发」：工坊里批过的每一条——帖子标题、版块、被回的那句、为什么回、草稿全文（还能改）；
 *   点「打开这一条」才在这个窗口新开标签页，插件把草稿填进回复框并描一圈，**发送由你自己点**；
 *   认不出框（页面改版）就停在「等你粘贴」——「复制草稿」随时可用；「稍后」「不发了」也在这里；
 * - 底下一行：插件自己的版本与工坊的版本，对不上就说怎么重新加载；在新版还是旧版 Reddit 上填。
 *
 * 插件**从不**自己开页面、从不点发送（`background.ts` / `queue.ts` / `write.ts` 三处钉住）。
 */
import type { PanelProgress, PanelWrite, RedditSite } from '@agentsws/browser-action'
import { PANEL_DRAFT_MAX, PANEL_TITLE_MAX } from '@agentsws/browser-action'
import { useState } from 'react'
import { IconAlert, IconClock, IconExternal } from './panel-icons'

export interface DeskActions {
  open(write: PanelWrite, edit: { text?: string; title?: string }): Promise<string | undefined>
  drop(write: PanelWrite): Promise<string | undefined>
  later(write: PanelWrite): void
  copy(text: string): Promise<boolean>
}

const VERB: Record<NonNullable<PanelWrite['kind']>, string> = {
  reply: '回复',
  comment: '回帖',
  submit: '发帖',
}

export function deskHead(w: PanelWrite): string {
  const verb = w.kind === undefined ? '回复' : VERB[w.kind]
  const who = w.kind === 'submit' || w.parent_author === undefined ? '' : ` u/${w.parent_author}`
  return `${verb}${who} · r/${w.subreddit}`
}

/** 顶上那一行：巡查到第几块了 / 今天发了几条 / 等你发几条 / 卡在哪。 */
export function statusLine(p: PanelProgress): { text: string; warn: boolean }[] {
  const out: { text: string; warn: boolean }[] = []
  const parts = p.last_run?.parts ?? []
  if (p.reading && parts.length > 0) {
    const done = parts.filter((x) => x.status !== 'waiting').length
    out.push({
      text: `正在巡查 ${Math.min(done + 1, parts.length)}/${parts.length} 块`,
      warn: false,
    })
  }
  out.push({ text: `今天发了 ${p.sent_today ?? 0} 条`, warn: false })
  out.push({ text: `等你发 ${p.awaiting ?? 0} 条`, warn: (p.awaiting ?? 0) > 0 })
  const bad = parts.find((x) => x.status === 'failed' || x.status === 'needs_connection')
  if (bad?.message !== undefined) out.push({ text: `卡住：${bad.message}`, warn: true })
  else if (p.note !== undefined) out.push({ text: p.note, warn: true })
  return out
}

export function PanelStatusStrip(props: { progress: PanelProgress }): React.ReactNode {
  return (
    <div className="ws-strip" data-testid="ws-strip">
      {statusLine(props.progress).map((x) => (
        <span key={x.text} className={x.warn ? 'ws-chip ws-chip--warn' : 'ws-chip'}>
          {x.text}
        </span>
      ))}
    </div>
  )
}

/** 等你发的一条（发帖台上的一张）。 */
export function DeskItem(props: {
  write: PanelWrite
  actions: DeskActions
  canAct: boolean
  open: boolean
  onToggle(): void
}): React.ReactNode {
  const w = props.write
  const [text, setText] = useState(w.text ?? '')
  const [title, setTitle] = useState(w.title ?? '')
  const [busy, setBusy] = useState<'open' | 'drop' | undefined>(undefined)
  const [msg, setMsg] = useState<{ bad: boolean; text: string } | undefined>(undefined)
  const edited = text !== (w.text ?? '') || (w.kind === 'submit' && title !== (w.title ?? ''))
  const run = (what: 'open' | 'drop') => {
    setBusy(what)
    setMsg(undefined)
    const p =
      what === 'open'
        ? props.actions.open(w, {
            ...(text !== (w.text ?? '') ? { text } : {}),
            ...(w.kind === 'submit' && title !== (w.title ?? '') ? { title } : {}),
          })
        : props.actions.drop(w)
    void p.then((m) => {
      setBusy(undefined)
      if (m !== undefined) setMsg({ bad: true, text: m })
    })
  }
  return (
    <li className="ws-card-item ws-desk" data-testid="ws-desk" data-open={props.open ? '1' : '0'}>
      <button type="button" className="ws-card-head" onClick={props.onToggle}>
        <b>{deskHead(w)}</b>
        {edited ? <span className="ws-pill">改过</span> : null}
      </button>
      {props.open ? null : (
        <p className="ws-clamp-1 ws-muted">{w.parent_text ?? w.post_title ?? w.label}</p>
      )}
      {props.open ? (
        <div className="ws-card-body">
          {w.post_title === undefined ? null : <p className="ws-post-title">{w.post_title}</p>}
          {w.parent_text === undefined ? null : (
            <blockquote className="ws-quote ws-clamp-4" data-testid="ws-desk-quote">
              {w.parent_text}
            </blockquote>
          )}
          <div className="ws-meta">
            {w.thread_link === undefined ? null : (
              <a href={w.thread_link} target="_blank" rel="noreferrer" className="ws-link">
                原帖 <IconExternal className="ws-ico ws-ico--sm" />
              </a>
            )}
            {w.reason === undefined ? null : (
              <span className="ws-muted ws-clamp-1" title={w.reason} data-testid="ws-desk-reason">
                为什么回：{w.reason}
              </span>
            )}
          </div>
          {w.kind === 'submit' ? (
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
            data-testid="ws-desk-draft"
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
              data-testid="ws-desk-open"
              disabled={!props.canAct || busy !== undefined || text.trim() === ''}
              title="在这个窗口新开一页、把草稿填进回复框；发送由你自己点"
              onClick={() => run('open')}
            >
              {busy === 'open' ? '正在打开…' : '打开这一条'}
            </button>
            <button
              type="button"
              className="ws-btn ws-btn--ghost"
              data-testid="ws-desk-copy"
              onClick={() => {
                void props.actions.copy(text).then((ok) => {
                  setMsg({ bad: !ok, text: ok ? '草稿已复制' : '没复制上，选中文字自己复制' })
                })
              }}
            >
              复制草稿
            </button>
          </div>
          <div className="ws-actions ws-actions--minor">
            <button
              type="button"
              className="ws-btn ws-btn--ghost ws-btn--sm"
              data-testid="ws-desk-later"
              disabled={busy !== undefined}
              onClick={() => props.actions.later(w)}
            >
              稍后
            </button>
            <button
              type="button"
              className="ws-btn ws-btn--ghost ws-btn--sm"
              data-testid="ws-desk-drop"
              disabled={!props.canAct || busy !== undefined}
              onClick={() => run('drop')}
            >
              不发了
            </button>
          </div>
          {msg === undefined ? null : (
            <p className={msg.bad ? 'ws-note ws-note--bad' : 'ws-note'}>{msg.text}</p>
          )}
        </div>
      ) : null}
    </li>
  )
}

/** 「等你发」那一块（新的在前；点了「稍后」的收在最下面一行）。 */
export function PanelDesk(props: {
  writes: PanelWrite[]
  actions: DeskActions
  canAct: boolean
  /** 点了「稍后」的那几条 job id。 */
  later: ReadonlySet<string>
  showLater(): void
}): React.ReactNode {
  const now = props.writes.filter((w) => !props.later.has(w.job_id))
  const parked = props.writes.length - now.length
  const [openId, setOpenId] = useState<string | undefined>(undefined)
  const open = openId ?? now[0]?.job_id
  if (props.writes.length === 0) return null
  return (
    <section className="ws-desk-sec" data-testid="ws-desk-list">
      <div className="ws-sec-head">
        <b>等你发</b>
        <span className="ws-muted" title="插件不会自己打开页面、也不会点发送">
          点开 · 你来发
        </span>
      </div>
      <ul className="ws-cards">
        {now.map((w) => (
          <DeskItem
            key={w.job_id}
            write={w}
            actions={props.actions}
            canAct={props.canAct}
            open={w.job_id === open}
            onToggle={() => setOpenId(w.job_id === open ? '' : w.job_id)}
          />
        ))}
      </ul>
      {parked === 0 ? null : (
        <button
          type="button"
          className="ws-btn ws-btn--ghost ws-btn--sm"
          data-testid="ws-desk-parked"
          onClick={props.showLater}
        >
          <IconClock className="ws-ico ws-ico--sm" /> 稍后再发的 {parked} 条
        </button>
      )}
    </section>
  )
}

/** 插件版本 vs 工坊版本：对不上就说怎么重新加载（能自己重载的先自己试）。 */
export function versionNote(
  running: string,
  versions: { workshop?: string; folder?: string } | undefined,
): string | undefined {
  const want = versions?.folder
  if (want === undefined || want === running) return undefined
  return `插件是 ${running}，工坊带的是 ${want}：打开 chrome://extensions，找到「Agents 工坊助手」点 ↻ 重新加载`
}

export function PanelFoot(props: {
  running: string
  versions?: { workshop?: string; folder?: string }
  site?: RedditSite
  canAct: boolean
  setSite(site: RedditSite): void
  checkUpdate(): void
}): React.ReactNode {
  const note = versionNote(props.running, props.versions)
  return (
    <footer className="ws-foot" data-testid="ws-foot">
      {note === undefined ? null : (
        <p className="ws-note ws-note--warn ws-banner" data-testid="ws-version-warn">
          <IconAlert className="ws-ico ws-ico--sm" />
          <span>{note}</span>
          <button
            type="button"
            className="ws-btn ws-btn--ghost ws-btn--sm"
            onClick={props.checkUpdate}
          >
            现在更新
          </button>
        </p>
      )}
      <div className="ws-foot-row">
        <span className="ws-muted" data-testid="ws-versions">
          插件 {props.running}
          {props.versions?.workshop === undefined ? '' : ` · 工坊 ${props.versions.workshop}`}
        </span>
        {props.site === undefined ? null : (
          <label className="ws-muted ws-site" title="插件在哪一版 Reddit 上帮你填（默认新版）">
            <select
              className="ws-select"
              data-testid="ws-site"
              value={props.site}
              disabled={!props.canAct}
              onChange={(e) => props.setSite(e.target.value === 'old' ? 'old' : 'new')}
            >
              <option value="new">新版 Reddit</option>
              <option value="old">旧版 old.reddit</option>
            </select>
          </label>
        )}
      </div>
    </footer>
  )
}
