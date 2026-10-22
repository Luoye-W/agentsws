/**
 * WP432（Luoye 10-20 反馈 9，最急）：**侧边栏是发帖台**。
 * WP445（决策 1322，Luoye 10-21）：**审与发都在这里一步完成**——AI 起草的 Reddit 回帖 / 发帖不在工坊出卡，
 * 直接进「等你发」。每一条（还没批的卡 + 公司模式里主管在工坊批过的）都是同一个样子：
 *
 * - 帖子标题、版块、被回的那句、为什么回、草稿全文（能改）；
 * - **打开这一条**：在这个窗口新开一页、插件把草稿填进回复框并描一圈，**发送由你自己点**（还没批的卡 = 批 + 打开）；
 * - **不发**：点了下面出一排快捷理由（不相关 / 时机不对 / 不想回 / 其他…）和「不写理由」——点哪个都是一下就不发了；
 *   **写了理由才跟随同类**（AI 按理由判同类的也一并不发，顶上一行能撤回）、才进学习回路；
 * - **稍后**：收到底下一行，两小时后自己回来。
 *
 * WP467（Luoye 10-22）：「打开这一条」改叫**填入**——你已经开着这个帖子就在那一页里填（不跳转、不另开），没开着才新开
 * www 原帖；「复制」之后自己粘贴发出去也照样记；认不出就点「我发了，帮我记一下」（贴链接 / 认最近一条）。
 *
 * 插件**从不**自己开页面、从不点发送（`background.ts` / `queue.ts` / `write.ts` 三处钉住）。
 * WP445（决策 1323）：底部那一栏去掉了；插件与工坊版本对不上时顶上临时出一条（{@link VersionBanner}），平时不显示。
 */
import type { PanelCard, PanelProgress, PanelWrite } from '@agentsws/browser-action'
import { PANEL_DRAFT_MAX, PANEL_SKIP_REASONS, PANEL_TITLE_MAX } from '@agentsws/browser-action'
import { useState } from 'react'
import { CHECK_LABEL } from '@/lib/panel/format'
import { IconAlert, IconClock, IconExternal, IconInfo, IconRight, IconUp } from './panel-icons'

/** 「等你发」里的一条：还没批的卡（插件里审），或批过、等你打开的那一条写。 */
export type DeskEntry =
  | { from: 'card'; key: string; card: PanelCard }
  | { from: 'write'; key: string; write: PanelWrite }

/** 一条摊平成侧边栏上画的那几格（卡与写同一个样子）。 */
export interface DeskView {
  kind: 'reply' | 'comment' | 'submit'
  subreddit: string
  label?: string
  post_title?: string
  parent_author?: string
  parent_text?: string
  thread_link?: string
  reason?: string
  text: string
  title?: string
  facts?: { id: string; text: string }[]
  rules?: string[]
  warning?: string
  checks?: { kind: string; message: string; fixed?: boolean }[]
  prior_replies?: { text: string; created_at?: string }[]
}

export function deskView(e: DeskEntry): DeskView {
  if (e.from === 'card') {
    const c = e.card
    const quote = c.parent_text ?? c.post_text
    return {
      kind: c.kind,
      subreddit: c.subreddit,
      label: c.title,
      text: c.draft.text,
      ...(c.draft.title === undefined ? {} : { title: c.draft.title }),
      ...(c.post_title === undefined ? {} : { post_title: c.post_title }),
      ...(c.parent_author === undefined ? {} : { parent_author: c.parent_author }),
      ...(quote === undefined ? {} : { parent_text: quote }),
      ...(c.link === undefined ? {} : { thread_link: c.link }),
      ...(c.reason === undefined ? {} : { reason: c.reason }),
      ...(c.facts === undefined ? {} : { facts: c.facts }),
      ...(c.rules === undefined ? {} : { rules: c.rules }),
      ...(c.warning === undefined ? {} : { warning: c.warning }),
      ...(c.checks === undefined ? {} : { checks: c.checks }),
      ...(c.prior_replies === undefined ? {} : { prior_replies: c.prior_replies }),
    }
  }
  const w = e.write
  return {
    kind: w.kind ?? 'reply',
    subreddit: w.subreddit,
    text: w.text ?? '',
    ...(w.label === undefined ? {} : { label: w.label }),
    ...(w.title === undefined ? {} : { title: w.title }),
    ...(w.post_title === undefined ? {} : { post_title: w.post_title }),
    ...(w.parent_author === undefined ? {} : { parent_author: w.parent_author }),
    ...(w.parent_text === undefined ? {} : { parent_text: w.parent_text }),
    ...(w.thread_link === undefined ? {} : { thread_link: w.thread_link }),
    ...(w.reason === undefined ? {} : { reason: w.reason }),
  }
}

/** 「等你发」：插件里等你审的卡在前（新的在前），主管批过、等你打开的接在后面。 */
export function deskEntries(
  cards: readonly PanelCard[],
  writes: readonly PanelWrite[],
): DeskEntry[] {
  const cardIds = new Set(cards.map((c) => c.id))
  return [
    ...[...cards]
      .sort((a, b) => Date.parse(b.created_at) - Date.parse(a.created_at))
      .map((card): DeskEntry => ({ from: 'card', key: `c:${card.id}`, card })),
    ...writes
      .filter((w) => w.state === 'awaiting' && !cardIds.has(w.approval_item_id))
      .map((write): DeskEntry => ({ from: 'write', key: `w:${write.job_id}`, write })),
  ]
}

export interface DeskActions {
  open(entry: DeskEntry, edit: { text?: string; title?: string }): Promise<string | undefined>
  /** WP467：「我发了，帮我记一下」（贴链接 / 认最近一条）。回没记上那一句。 */
  sent?(entry: DeskEntry, how: 'link' | 'latest', link?: string): Promise<string | undefined>
  /** 不发（理由可选）。 */
  skip(entry: DeskEntry, reason?: string): Promise<string | undefined>
  later(entry: DeskEntry): void
  copy(text: string): Promise<boolean>
}

const VERB: Record<DeskView['kind'], string> = {
  reply: '回复',
  comment: '回帖',
  submit: '发帖',
}

export function deskHead(v: Pick<DeskView, 'kind' | 'parent_author' | 'subreddit'>): string {
  const who = v.kind === 'submit' || v.parent_author === undefined ? '' : ` u/${v.parent_author}`
  return `${VERB[v.kind]}${who} · r/${v.subreddit}`
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

/** WP456-T7：一句里的数字加粗（「今天发了 **0** 条」「正在巡查 **2/3** 块」）。 */
export function boldNumbers(text: string): React.ReactNode[] {
  const out: React.ReactNode[] = []
  let at = 0
  let num = false
  // split 带捕获组：切出来的段轮流是普通字、数字
  for (const part of text.split(/(\d+(?:\/\d+)?)/u)) {
    if (num) out.push(<b key={at}>{part}</b>)
    else if (part !== '') out.push(part)
    at += part.length
    num = !num
  }
  return out
}

/**
 * 顶上一行灰字、数字加粗（WP456 §3.12：原来是两颗灰底药丸，看着像按钮其实点不了）。
 * 卡住的那一句用「要留意」的字色，不加底。
 */
export function PanelStatusStrip(props: { progress: PanelProgress }): React.ReactNode {
  return (
    <div className="ws-strip" data-testid="ws-strip">
      {statusLine(props.progress).map((x) =>
        x.warn && !x.text.startsWith('等你发 ') ? (
          <span key={x.text} className="ws-strip-warn">
            {x.text}
          </span>
        ) : (
          <span key={x.text}>{boldNumbers(x.text)}</span>
        ),
      )}
    </div>
  )
}

/** 「不发」下面那一排：快捷理由 + 其他…（写一句）+ 不写理由。点哪个都是一下就不发了。 */
function SkipReasons(props: {
  onPick(reason: string | undefined): void
  onCancel(): void
  busy: boolean
}): React.ReactNode {
  const [other, setOther] = useState<string | undefined>(undefined)
  return (
    <div className="ws-reasons" data-testid="ws-desk-reasons">
      <span
        className="ws-muted"
        title="写了理由，AI 会按理由把同类的也一并不发，并记下来以后少起草这类；不写只不发这一条"
      >
        不发，因为…（可不选）
      </span>
      <div className="ws-row ws-wrap">
        {PANEL_SKIP_REASONS.map((r) => (
          <button
            key={r}
            type="button"
            className="ws-btn ws-btn--sm"
            data-testid="ws-skip-reason"
            disabled={props.busy}
            onClick={() => props.onPick(r)}
          >
            {r}
          </button>
        ))}
        <button
          type="button"
          className="ws-btn ws-btn--sm"
          data-testid="ws-desk-reason-other"
          disabled={props.busy}
          onClick={() => setOther(other === undefined ? '' : undefined)}
        >
          其他…
        </button>
      </div>
      {other === undefined ? null : (
        <div className="ws-row">
          <input
            className="ws-input"
            data-testid="ws-desk-reason-text"
            value={other}
            maxLength={300}
            aria-label="理由"
            onChange={(e) => setOther(e.target.value)}
          />
          <button
            type="button"
            className="ws-btn ws-btn--sm"
            data-testid="ws-desk-reason-save"
            disabled={props.busy || other.trim() === ''}
            onClick={() => props.onPick(other.trim())}
          >
            不发
          </button>
        </div>
      )}
      <div className="ws-row ws-wrap">
        <button
          type="button"
          className="ws-btn ws-btn--ghost ws-btn--sm"
          data-testid="ws-desk-skip-now"
          disabled={props.busy}
          onClick={() => props.onPick(undefined)}
        >
          不写理由，就不发这一条
        </button>
        <button
          type="button"
          className="ws-btn ws-btn--ghost ws-btn--sm"
          data-testid="ws-desk-skip-cancel"
          disabled={props.busy}
          onClick={props.onCancel}
        >
          算了，还要发
        </button>
      </div>
    </div>
  )
}

/**
 * WP467：「我发了，帮我记一下」——插件没认出你自己发出去的那一条时：贴那一条的链接，或「认最近一条」
 * （插件读这个帖子里你这个号最新发的那一条）。发新帖只能贴链接。
 */
export function SentBox(props: {
  canLatest: boolean
  sent(how: 'link' | 'latest', link?: string): Promise<string | undefined>
}): React.ReactNode {
  const [open, setOpen] = useState(false)
  const [link, setLink] = useState('')
  const [busy, setBusy] = useState(false)
  const [msg, setMsg] = useState<{ bad: boolean; text: string } | undefined>(undefined)
  const go = (how: 'link' | 'latest') => {
    setBusy(true)
    setMsg(undefined)
    void props.sent(how, how === 'link' ? link.trim() : undefined).then((m) => {
      setBusy(false)
      setMsg(m === undefined ? { bad: false, text: '记下了' } : { bad: true, text: m })
    })
  }
  if (!open)
    return (
      <button
        type="button"
        className="ws-btn ws-btn--ghost ws-btn--sm"
        data-testid="ws-sent-open"
        title="你已经在 Reddit 上自己发了、插件没认出来：贴那一条的链接，或认最近一条"
        onClick={() => setOpen(true)}
      >
        我发了，帮我记一下
      </button>
    )
  return (
    <div className="ws-reasons" data-testid="ws-sent">
      <div className="ws-row">
        <input
          className="ws-input"
          data-testid="ws-sent-link"
          value={link}
          maxLength={500}
          placeholder="贴那一条的链接"
          aria-label="那一条的链接"
          onChange={(e) => setLink(e.target.value)}
        />
        <button
          type="button"
          className="ws-btn ws-btn--sm"
          data-testid="ws-sent-save"
          disabled={busy || link.trim() === ''}
          onClick={() => go('link')}
        >
          记下
        </button>
      </div>
      <div className="ws-row ws-wrap">
        {props.canLatest ? (
          <button
            type="button"
            className="ws-btn ws-btn--sm"
            data-testid="ws-sent-latest"
            disabled={busy}
            title="读这个帖子里你这个号最新发的那一条"
            onClick={() => go('latest')}
          >
            认最近一条
          </button>
        ) : null}
        <button
          type="button"
          className="ws-btn ws-btn--ghost ws-btn--sm"
          disabled={busy}
          onClick={() => setOpen(false)}
        >
          算了
        </button>
      </div>
      {msg === undefined ? null : (
        <p className={msg.bad ? 'ws-bad-text' : 'ws-muted'}>{msg.text}</p>
      )}
    </div>
  )
}

/** WP456-T7：一条草稿改到哪了（收起再展开、换一条看都不丢；按条目 + 版本记，卡换了版本就重来）。 */
export interface DeskDraft {
  text?: string
  title?: string
}

/** 「等你发」里每一条的 React key / 草稿 key（卡带版本）。 */
export const deskKey = (e: DeskEntry): string =>
  e.from === 'card' ? `${e.key}:${e.card.version}` : e.key

/**
 * 等你发的一条（发帖台上的一张）。WP456-T7（§3.12 / §2.6 第 13 条）：展开的那一条是一张决定卡（头一行灰字、标题、
 * 被回的那句、原帖链接 + 分类标签、草稿、主 / 次 / 弱三级按钮）；收起的是列表组里的一行（整行可点，右边「›」）。
 */
export function DeskItem(props: {
  entry: DeskEntry
  actions: DeskActions
  canAct: boolean
  open: boolean
  onToggle(): void
  /** 草稿改到哪了（放在上一层，收起 / 换位置也不丢）。 */
  draft?: DeskDraft
  onDraft?(d: DeskDraft): void
}): React.ReactNode {
  const v = deskView(props.entry)
  const [ownDraft, setOwnDraft] = useState<DeskDraft>({})
  const draft = props.draft ?? ownDraft
  const setDraft = (d: DeskDraft) => (props.onDraft ?? setOwnDraft)({ ...draft, ...d })
  const text = draft.text ?? v.text
  const title = draft.title ?? v.title ?? ''
  const [busy, setBusy] = useState<'open' | 'skip' | undefined>(undefined)
  const [msg, setMsg] = useState<{ bad: boolean; text: string } | undefined>(undefined)
  /** 点了「不发」：下面出一排理由（选哪个都是一下就不发了）。 */
  const [skipping, setSkipping] = useState(false)
  const edited = text !== v.text || (v.kind === 'submit' && title !== (v.title ?? ''))
  const open = () => {
    setBusy('open')
    setMsg(undefined)
    void props.actions
      .open(props.entry, {
        ...(text !== v.text ? { text } : {}),
        ...(v.kind === 'submit' && title !== (v.title ?? '') ? { title } : {}),
      })
      .then((m) => {
        setBusy(undefined)
        if (m !== undefined) setMsg({ bad: true, text: m })
      })
  }
  const skip = (reason: string | undefined) => {
    setBusy('skip')
    setMsg(undefined)
    void props.actions.skip(props.entry, reason).then((m) => {
      setBusy(undefined)
      if (m !== undefined) setMsg({ bad: true, text: m })
    })
  }
  const facts = v.facts ?? []
  const rules = v.rules ?? []
  const checks = v.checks ?? []
  const prior = v.prior_replies ?? []
  const snippet = v.parent_text ?? v.post_title ?? v.label
  if (!props.open)
    return (
      <li
        className="ws-card-item ws-desk"
        data-testid="ws-desk"
        data-from={props.entry.from}
        data-open="0"
      >
        <button type="button" className="ws-card-head" onClick={props.onToggle}>
          <span className="ws-card-head-text">
            <span>{deskHead(v)}</span>
            {snippet === undefined ? null : <span className="ws-card-head-snip">{snippet}</span>}
          </span>
          {edited ? <span className="ws-tag">改过</span> : null}
          <IconRight className="ws-ico ws-ico--sm ws-chev" />
        </button>
      </li>
    )
  return (
    <li
      className="ws-card-item ws-desk ws-desk-card"
      data-testid="ws-desk"
      data-from={props.entry.from}
      data-open="1"
    >
      <button type="button" className="ws-card-head" title="收起" onClick={props.onToggle}>
        <span className="ws-card-head-text">{deskHead(v)}</span>
        {edited ? <span className="ws-tag">改过</span> : null}
        <IconUp className="ws-ico ws-ico--sm ws-chev" />
      </button>
      <div className="ws-card-body">
        {v.post_title === undefined ? null : <p className="ws-post-title">{v.post_title}</p>}
        {v.parent_text === undefined ? null : (
          <blockquote className="ws-quote ws-clamp-4" data-testid="ws-desk-quote">
            {v.parent_text}
          </blockquote>
        )}
        <div className="ws-meta">
          {v.thread_link === undefined ? null : (
            <a href={v.thread_link} target="_blank" rel="noreferrer" className="ws-link">
              原帖 <IconExternal className="ws-ico ws-ico--sm" />
            </a>
          )}
          {v.reason === undefined ? null : (
            <span className="ws-clamp-1" title={v.reason} data-testid="ws-desk-reason">
              为什么回：{v.reason}
            </span>
          )}
          {facts.length === 0 ? null : (
            <span className="ws-tag" title={facts.map((f) => f.text).join('\n')}>
              依据 {facts.length}
            </span>
          )}
          {rules.length === 0 ? null : (
            <span className="ws-tag" title={rules.join('\n')}>
              版规 {rules.length}
            </span>
          )}
        </div>
        {v.warning === undefined ? null : (
          <p className="ws-note ws-note--warn">
            <IconAlert className="ws-ico" />
            <span className="ws-note-text">{v.warning}</span>
          </p>
        )}
        {checks.length === 0 && prior.length === 0 ? null : (
          <div className="ws-meta" data-testid="ws-checks">
            {prior.length === 0 ? null : (
              <span
                className="ws-tag"
                title={prior
                  .map(
                    (r) =>
                      `${r.created_at === undefined ? '' : `${r.created_at.slice(5, 10)} `}${r.text}`,
                  )
                  .join('\n')}
                data-testid="ws-prior"
              >
                品牌号在这串里说过 {prior.length} 次
              </span>
            )}
            {checks.map((k) => (
              <span
                key={`${k.kind}:${k.message}`}
                className={k.fixed === true ? 'ws-tag' : 'ws-pill ws-pill--warn'}
                title={k.message}
                data-testid="ws-check"
              >
                {CHECK_LABEL[k.kind] ?? k.kind}
              </span>
            ))}
          </div>
        )}
        {v.kind === 'submit' ? (
          <input
            className="ws-input"
            value={title}
            maxLength={PANEL_TITLE_MAX}
            aria-label="标题"
            onChange={(e) => setDraft({ title: e.target.value })}
          />
        ) : null}
        <textarea
          className="ws-input ws-draft"
          data-testid="ws-desk-draft"
          value={text}
          maxLength={PANEL_DRAFT_MAX}
          aria-label="草稿"
          rows={5}
          onChange={(e) => setDraft({ text: e.target.value })}
        />
        {skipping ? (
          <SkipReasons
            busy={busy !== undefined}
            onPick={skip}
            onCancel={() => setSkipping(false)}
          />
        ) : (
          <>
            <div className="ws-actions">
              <button
                type="button"
                className="ws-btn ws-btn--primary"
                data-testid="ws-desk-open"
                disabled={!props.canAct || busy !== undefined || text.trim() === ''}
                title="在原帖页里填好（你开着就填在那一页，没开着新开一页）；发送你自己点"
                onClick={open}
              >
                {busy === 'open' ? '正在填…' : '填入'}
              </button>
              <button
                type="button"
                className="ws-btn"
                data-testid="ws-desk-copy"
                onClick={() => {
                  void props.actions.copy(text).then((ok) => {
                    setMsg({
                      bad: !ok,
                      text: ok
                        ? '已复制——自己粘贴发出去，插件照样记'
                        : '没复制上，选中文字自己复制',
                    })
                  })
                }}
              >
                复制
              </button>
            </div>
            <div className="ws-actions ws-actions--minor">
              <button
                type="button"
                className="ws-btn ws-btn--ghost ws-btn--sm"
                data-testid="ws-desk-later"
                disabled={busy !== undefined}
                onClick={() => props.actions.later(props.entry)}
              >
                稍后
              </button>
              <button
                type="button"
                className="ws-btn ws-btn--ghost ws-btn--sm"
                data-testid="ws-desk-skip"
                disabled={!props.canAct || busy !== undefined}
                onClick={() => setSkipping(true)}
              >
                不发
              </button>
              {props.actions.sent === undefined || !props.canAct ? null : (
                <SentBox
                  canLatest={v.kind !== 'submit'}
                  sent={(how, link) =>
                    props.actions.sent?.(props.entry, how, link) ?? Promise.resolve(undefined)
                  }
                />
              )}
            </div>
          </>
        )}
        {msg === undefined ? null : (
          <p className={msg.bad ? 'ws-note ws-note--bad' : 'ws-note'}>
            {msg.bad ? <IconAlert className="ws-ico" /> : <IconInfo className="ws-ico" />}
            <span className="ws-note-text">{msg.text}</span>
          </p>
        )}
      </div>
    </li>
  )
}

/** 「按你的理由，另外 N 条同类的也不发了 · 撤回」那一行（一行提醒，右边两个链接）。 */
export function FollowStrip(props: {
  followed: { leader_id: string; ids: string[]; titles: string[] }
  undo(): void
  close(): void
}): React.ReactNode {
  const n = props.followed.ids.length
  return (
    <div className="ws-note ws-banner" data-testid="ws-follow">
      <IconInfo className="ws-ico" />
      <span className="ws-note-text" title={props.followed.titles.join('\n')}>
        按你的理由，另外 {n} 条同类的也不发了
      </span>
      <span className="ws-note-end">
        <button type="button" className="ws-link" data-testid="ws-follow-undo" onClick={props.undo}>
          撤回
        </button>
        <button type="button" className="ws-link-muted" onClick={props.close}>
          知道了
        </button>
      </span>
    </div>
  )
}

/** 把「等你发」排成几段：连着收起的几条并成一张列表组，展开的那一条单独一张卡。 */
export function deskRuns(
  entries: readonly DeskEntry[],
  open: string | undefined,
): { open: boolean; items: DeskEntry[] }[] {
  const runs: { open: boolean; items: DeskEntry[] }[] = []
  for (const e of entries) {
    const isOpen = e.key === open
    const last = runs.at(-1)
    if (!isOpen && last !== undefined && !last.open) last.items.push(e)
    else runs.push({ open: isOpen, items: [e] })
  }
  return runs
}

/** 「等你发」那一块（插件里审的卡在前；点了「稍后」的收在最下面一行）。 */
export function PanelDesk(props: {
  entries: DeskEntry[]
  actions: DeskActions
  canAct: boolean
  /** 点了「稍后」的那几条 key。 */
  later: ReadonlySet<string>
  showLater(): void
}): React.ReactNode {
  const now = props.entries.filter((e) => !props.later.has(e.key))
  const parked = props.entries.length - now.length
  const [openId, setOpenId] = useState<string | undefined>(undefined)
  const [drafts, setDrafts] = useState<Record<string, DeskDraft>>({})
  const open = openId ?? now[0]?.key
  if (props.entries.length === 0) return null
  const item = (e: DeskEntry) => {
    const k = deskKey(e)
    return (
      <DeskItem
        key={k}
        entry={e}
        actions={props.actions}
        canAct={props.canAct}
        open={e.key === open}
        onToggle={() => setOpenId(e.key === open ? '' : e.key)}
        {...(drafts[k] === undefined ? {} : { draft: drafts[k] })}
        onDraft={(d) => setDrafts((all) => ({ ...all, [k]: d }))}
      />
    )
  }
  return (
    <section className="ws-desk-sec" data-testid="ws-desk-list">
      <div className="ws-sec-head">
        <b>
          等你发 <span className="ws-sec-count">{now.length}</span>
        </b>
        <span className="ws-muted" title="插件不会自己打开页面、也不会点发送">
          看一眼 · 填入 · 你来发
        </span>
      </div>
      {deskRuns(now, open).map((run) =>
        run.open ? (
          <ul key={deskKey(run.items[0] as DeskEntry)} className="ws-desk-one ws-cards">
            {run.items.map(item)}
          </ul>
        ) : (
          <ul key={`g:${deskKey(run.items[0] as DeskEntry)}`} className="ws-group ws-cards">
            {run.items.map(item)}
          </ul>
        ),
      )}
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

/**
 * WP445（决策 1323）：插件与工坊版本对不上、要重新加载时，顶上临时出一条；对得上一个字都不画（底部那一栏去掉了）。
 */
export function VersionBanner(props: {
  running: string
  versions?: { workshop?: string; folder?: string }
  checkUpdate(): void
}): React.ReactNode {
  const note = versionNote(props.running, props.versions)
  if (note === undefined) return null
  return (
    <p className="ws-note ws-note--warn ws-banner" data-testid="ws-version-warn">
      <IconAlert className="ws-ico" />
      <span className="ws-note-text">{note}</span>
      <button type="button" className="ws-link ws-note-end" onClick={props.checkUpdate}>
        现在更新
      </button>
    </p>
  )
}
