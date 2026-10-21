/**
 * WP413（真机联调 10-18 R1，Luoye 10-19 定 a–d）：**插件常驻侧边栏**的路由（`/v1/extension/panel*`）。
 *
 * 判权与 `/v1/extension/*` 那一套完全一样（插件令牌 + Origin），**复用现有配对令牌与 scope，不加新的**：
 * - 看（进度 / 要你处理 / 记录）：令牌上有 `reddit.read` 或 `reddit.write` 其中一个；
 * - 处理卡（填进页面 / 不发 / 再填一次）：要 `reddit.write`（WP329 起配的对都有）。
 *
 * 身份（决策 c）：插件里批 = 工坊里批——走同一个审批总线（`deps.approvals.decide`），批的人是**令牌绑定的
 * 那个人**，决定记 `via: 'extension'`（账本与 `approval.decided` 事件里都看得到「在插件里批的」）。
 * 只列这个人**收得到、有权批**的「发出去」卡（与工作台「要你处理」同一把尺子：`tokenFor` + `decidableBy`）；
 * 别人的卡一律 404（不泄漏存在性）。谁先处理算谁的：工坊里先批了，这里再点回 409「已经处理过了」。
 *
 * 「填进页面」= 批（改过就按改过的批）+ 马上交给插件动作通道，不等取消窗口——真正发出去的那一下永远是人在
 * Reddit 页面上亲手点。之后「填好了 / 读回确认已发」走原来的 `/v1/extension/actions/*`，这里只看结果。
 */

import type {
  PanelCard,
  PanelFillResult,
  PanelPost,
  PanelProgress,
  PanelRecord,
  PanelSinkView,
  PanelSnapshot,
  PanelWrite,
} from '@agentsws/browser-action'
import { PANEL_DRAFT_MAX, PANEL_TITLE_MAX } from '@agentsws/browser-action'
import type { ApprovalItem, MaybePromise } from '@agentsws/contracts'
import {
  isPlaceholderOwnerName,
  isPlaceholderWorkspaceName,
  REDDIT_WRITE_FORM,
} from '@agentsws/contracts'
import { z } from 'zod'
import { ApiError } from '../errors.js'
import type { ExtensionSession } from '../extension-store.js'
import { body, ok, param, tokenFor } from '../helpers.js'
import { type Route, route } from '../route-spec.js'
import type { GatewayDeps } from '../types.js'
import { decidableBy } from './approvals.js'
import { extensionSessionOf } from './extension.js'

/** 宿主给的事实（按令牌上的品牌）。卡由路由自己从审批总线取，不经这里。 */
export interface ExtensionPanelFacts {
  workspace_name?: string
  progress: PanelProgress
  /** 这个品牌批过的写（路由再按人筛）。 */
  writes: PanelWrite[]
  /** 发出记录（新的在前；路由再按 `approval_item_id` 按人筛，筛完去掉这一格）。 */
  records: (PanelRecord & { approval_item_id?: string })[]
  sinks: PanelSinkView[]
  /** WP419：交给人发的社媒帖子（`owner` = 担那条渠道的人；路由按人筛，筛完去掉这一格）。 */
  posts?: (PanelPost & { owner?: string })[]
}

export interface ExtensionPanelPort {
  facts(session: ExtensionSession): Promise<ExtensionPanelFacts>
  /**
   * 刚在插件里批的那张「发出去」卡：马上交给插件动作通道（不等取消窗口）。回这一条写现在的样子；
   * 没交出去（插件不在线也照样排着）就回一句人话。
   */
  deliverNow(
    session: ExtensionSession,
    item_id: string,
  ): Promise<{ write?: PanelWrite; message?: string }>
  /** 没发出去的那一条「再填一次」（同一份已批的草稿，不用重批）。 */
  refill(
    session: ExtensionSession,
    job_id: string,
  ): MaybePromise<{ ok: true; write: PanelWrite } | { ok: false; message: string }>
  /** WP419：交给人发的那一条，人回话（发好了 / 不发了）。不是这个品牌交给人的那一条回 `ok: false`。 */
  answerPost?(
    session: ExtensionSession,
    post_id: string,
    answer: { done: true; link?: string } | { done: false; reason?: string },
  ): MaybePromise<{ ok: true } | { ok: false; message: string }>
}

function portOf(deps: GatewayDeps): ExtensionPanelPort {
  const p = deps.extensionPanel
  if (p === undefined)
    throw new ApiError('not_implemented', '这个本机服务版本还没有插件侧边栏，先升级 Agents 工坊。')
  return p
}

/** 看：`reddit.read` 或 `reddit.write` 其中一个。 */
function viewerOf(c: Parameters<Route['handler']>[0], deps: GatewayDeps): ExtensionSession {
  const session = extensionSessionOf(c, deps)
  if (!session.scopes.includes('reddit.read') && !session.scopes.includes('reddit.write'))
    throw new ApiError(
      'forbidden',
      '这把配对还没有 Reddit 的权限。在工作台重新生成配对码、插件里再配一次。',
    )
  return session
}

/** 处理卡：要 `reddit.write`。 */
function actorOf(c: Parameters<Route['handler']>[0], deps: GatewayDeps): ExtensionSession {
  const session = viewerOf(c, deps)
  if (!session.scopes.includes('reddit.write'))
    throw new ApiError(
      'forbidden',
      '这把配对只能看、不能处理卡。在工作台重新生成配对码、插件里再配一次。',
    )
  return session
}

const NOT_FOUND = '没有这张卡，或者它不是发给你的。'
const DONE_ELSEWHERE = '这张卡已经处理过了（在工坊里或另一处）。'

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v)
const str = (v: unknown): string | undefined =>
  typeof v === 'string' && v.trim() !== '' ? v : undefined

/** 这张审批项是不是 Reddit「发出去」卡（`outbound_draft` + `form: 'reddit_write'`）。 */
export function isPanelCard(item: Pick<ApprovalItem, 'kind' | 'payload'>): boolean {
  return (
    item.kind === 'outbound_draft' &&
    isRecord(item.payload) &&
    item.payload.form === REDDIT_WRITE_FORM
  )
}

const OPEN = new Set(['pending', 'in_review'])

/** 站内路径 → 给人点的链接（与服务端 `redditLink` 同义）。 */
const linkOf = (path: string | undefined): string | undefined =>
  path === undefined
    ? undefined
    : /^https?:/iu.test(path)
      ? path
      : `https://www.reddit.com${path.startsWith('/') ? '' : '/'}${path}`

/** 审批项 → 侧边栏上的一张卡（只取卡上本来就有的那几格；外部文本原样当文字）。 */
export function panelCardOf(item: ApprovalItem): PanelCard | undefined {
  if (!isPanelCard(item) || !isRecord(item.payload)) return undefined
  const p = item.payload
  const r = isRecord(p.reddit) ? p.reddit : {}
  const b = isRecord(p.body) ? p.body : {}
  const kind =
    r.kind === 'reply' || r.kind === 'comment' || r.kind === 'submit' ? r.kind : undefined
  const sub = str(r.subreddit)
  if (kind === undefined || sub === undefined) return undefined
  const facts = Array.isArray(p.facts)
    ? p.facts
        .filter(isRecord)
        .map((f) => ({ id: String(f.id ?? ''), text: String(f.text ?? '') }))
        .filter((f) => f.text !== '')
    : []
  const rules = Array.isArray(p.rules)
    ? p.rules.filter((x): x is string => typeof x === 'string')
    : []
  // WP419：几道检查（矛盾的不出卡，这里只有没依据 / 口吻 / 整串没现读成）、品牌号在这串里说过的
  const checks = Array.isArray(p.checks)
    ? p.checks
        .filter(isRecord)
        .map((x) => ({
          kind: String(x.kind ?? ''),
          message: String(x.message ?? ''),
          ...(x.fixed === true ? { fixed: true } : {}),
        }))
        .filter((x) => x.message !== '')
        .slice(0, 6)
    : []
  const prior = Array.isArray(p.prior_replies)
    ? p.prior_replies
        .filter(isRecord)
        .map((x) => ({
          text: String(x.text ?? '').slice(0, 400),
          ...(typeof x.created_at === 'string' ? { created_at: x.created_at } : {}),
        }))
        .filter((x) => x.text !== '')
        .slice(-5)
    : []
  const title = str(b.subject)
  const opt = <K extends string>(k: K, v: string | undefined): Partial<Record<K, string>> =>
    v === undefined ? {} : ({ [k]: v } as Record<K, string>)
  const postTitle = str(r.post_title)
  // WP419（自查 U15）：回帖子时「回的那一句」就是原帖标题（`in_reply_to` 兜底取的标题）——不再重复一遍
  const parentRaw = str(r.parent_text) ?? str(p.in_reply_to)
  const parentText =
    parentRaw !== undefined && postTitle !== undefined && parentRaw.trim() === postTitle.trim()
      ? undefined
      : parentRaw
  return {
    id: item.id,
    version: item.revision,
    kind,
    subreddit: sub.replace(/^\/?r\//u, ''),
    title: item.title,
    ...opt('post_title', postTitle),
    ...opt('post_text', str(r.post_text)),
    ...opt('parent_author', str(r.parent_author) ?? str(p.author)),
    ...opt('parent_text', parentText),
    ...opt('link', linkOf(str(r.permalink))),
    draft: { text: str(b.text) ?? '', ...(title === undefined ? {} : { title }) },
    ...opt('reason', str(p.reason)),
    ...(facts.length === 0 ? {} : { facts }),
    ...(rules.length === 0 ? {} : { rules }),
    ...opt('warning', str(p.warning)),
    ...(checks.length === 0 ? {} : { checks }),
    ...(prior.length === 0 ? {} : { prior_replies: prior }),
    created_at: item.created_at,
  }
}

/** 这张卡这个人看得见、批得动吗（与工作台「要你处理」同一把尺子）。 */
function decidable(deps: GatewayDeps, session: ExtensionSession, item: ApprovalItem): boolean {
  return (
    item.workspace_id === session.workspace_id &&
    isPanelCard(item) &&
    OPEN.has(item.state) &&
    tokenFor(item, session.person_id) !== undefined &&
    decidableBy(deps, session.person_id, session.workspace_id)(item)
  )
}

/** 这个人能看这条写 / 记录吗：卡是发给他的，或者是他批的。 */
const mine = (item: ApprovalItem | undefined, person: string): boolean =>
  item !== undefined &&
  (item.routing.recipients.some((r) => r.person === person) || item.decision?.by === person)

const fillSchema = z
  .object({
    text: z.string().max(PANEL_DRAFT_MAX).optional(),
    title: z.string().max(PANEL_TITLE_MAX).optional(),
    version: z.number().int().nonnegative().optional(),
  })
  .strict()

const skipSchema = z
  .object({
    reason: z.string().max(300).optional(),
    version: z.number().int().nonnegative().optional(),
  })
  .strict()

/**
 * 取一张这个人现在能处理的卡。不存在 / 不是他的 → 404（不泄漏存在性）；他的、但已经处理过了 → 409；
 * 卡在别处改过（版本对不上）→ 409。
 */
async function openCard(
  deps: GatewayDeps,
  session: ExtensionSession,
  id: string,
  version: number | undefined,
): Promise<ApprovalItem> {
  const item = await deps.approvals.get(id)
  if (
    item === undefined ||
    item.workspace_id !== session.workspace_id ||
    !isPanelCard(item) ||
    !mine(item, session.person_id)
  )
    throw new ApiError('not_found', NOT_FOUND)
  if (!OPEN.has(item.state)) throw new ApiError('conflict', DONE_ELSEWHERE)
  if (!decidable(deps, session, item)) throw new ApiError('not_found', NOT_FOUND)
  if (version !== undefined && version !== item.revision)
    throw new ApiError('conflict', '这张卡在工坊里改过了，刷新一下再看。')
  return item
}

/** 总线回的错 → 插件那边说得清的话（被别处抢先 = 409；不是他的 = 404）。 */
function decideError(err: unknown): never {
  const code = isRecord(err) ? err.code : undefined
  if (code === 'conflict' || code === 'snapshot_mismatch')
    throw new ApiError('conflict', DONE_ELSEWHERE)
  if (code === 'forbidden' || code === 'not_found') throw new ApiError('not_found', NOT_FOUND)
  throw err
}

/** 改过的草稿 → 卡上的新载荷（只换正文 / 标题，别的原样）；没改回 `undefined`。 */
export function editedPayloadOf(
  item: ApprovalItem,
  input: { text?: string | undefined; title?: string | undefined },
): Record<string, unknown> | undefined {
  const card = panelCardOf(item)
  if (card === undefined || !isRecord(item.payload)) return undefined
  const text = input.text ?? card.draft.text
  const title = input.title ?? card.draft.title
  if (text === card.draft.text && title === card.draft.title) return undefined
  const b = isRecord(item.payload.body) ? item.payload.body : {}
  return {
    ...item.payload,
    body: { ...b, text, ...(title === undefined ? {} : { subject: title }) },
  }
}

/** 快照：卡从总线取；写与记录按「是不是发给他的 / 他批的」筛，并标出在插件里批的。 */
async function snapshotOf(deps: GatewayDeps, session: ExtensionSession): Promise<PanelSnapshot> {
  const facts = await portOf(deps).facts(session)
  const queue = await deps.approvals.queue({
    workspace_id: session.workspace_id,
    person_id: session.person_id,
    lane: 'mine',
    kind: 'outbound_draft',
    state: ['pending', 'in_review'],
  })
  const cards = queue
    .filter((i) => decidable(deps, session, i))
    .map(panelCardOf)
    .filter((x): x is PanelCard => x !== undefined)
  const seen = new Map<string, ApprovalItem | undefined>()
  const itemOf = async (id: string): Promise<ApprovalItem | undefined> => {
    if (!seen.has(id)) seen.set(id, await deps.approvals.get(id))
    return seen.get(id)
  }
  const writes: PanelWrite[] = []
  for (const w of facts.writes) {
    const it = await itemOf(w.approval_item_id)
    if (it === undefined || it.workspace_id !== session.workspace_id) continue
    if (!mine(it, session.person_id)) continue
    writes.push({ ...w, ...(it.decision?.via === 'extension' ? { via_extension: true } : {}) })
  }
  const records: PanelRecord[] = []
  for (const { approval_item_id, ...row } of facts.records) {
    const it = approval_item_id === undefined ? undefined : await itemOf(approval_item_id)
    if (it === undefined || !mine(it, session.person_id)) continue
    records.push(row)
  }
  // WP419：交给人发的帖子只给担那条渠道的人（没记是谁的就给配对的人看）
  const posts = (facts.posts ?? [])
    .filter((p) => p.owner === undefined || p.owner === session.person_id)
    .map(({ owner: _o, ...p }) => p)
  const person = await deps.identity.getPerson(session.person_id).catch(() => undefined)
  // WP457：头部只写品牌名和人名；占位的 `default` / `owner`、工作区 id、人的 id 一律不写（没有就空着）
  const workspace_name = facts.workspace_name?.trim()
  const person_name = person?.name?.trim()
  const showWorkspace =
    workspace_name !== undefined &&
    workspace_name !== '' &&
    !isPlaceholderWorkspaceName(workspace_name, session.workspace_id)
  const showPerson =
    person_name !== undefined &&
    person_name !== '' &&
    person_name !== session.person_id &&
    !isPlaceholderOwnerName(person_name)
  return {
    at: deps.clock.now(),
    ...(showWorkspace ? { workspace_name } : {}),
    ...(showPerson ? { person_name } : {}),
    can_act: session.scopes.includes('reddit.write'),
    progress: facts.progress,
    cards,
    writes,
    records,
    sinks: facts.sinks,
    ...(posts.length === 0 ? {} : { posts }),
    can_post: session.scopes.includes('social.post'),
  }
}

const postDoneSchema = z.object({ link: z.string().max(500).optional() }).strict()
const postSkipSchema = z.object({ reason: z.string().max(300).optional() }).strict()

/** WP419：回「发好了 / 不发了」要 `social.post`（老令牌没有：重新配对一次）。 */
function posterOf(c: Parameters<Route['handler']>[0], deps: GatewayDeps): ExtensionSession {
  const session = viewerOf(c, deps)
  if (!session.scopes.includes('social.post'))
    throw new ApiError(
      'forbidden',
      '这把配对还不能回社媒发帖的结果。在工作台重新生成配对码、插件里再配一次。',
    )
  return session
}

async function answerPostOf(
  c: Parameters<Route['handler']>[0],
  deps: GatewayDeps,
  answer: { done: true; link?: string } | { done: false; reason?: string },
) {
  const session = posterOf(c, deps)
  const port = portOf(deps)
  const id = param(c, 'id')
  // 只认交给这个人的那一条（别人的一律 404，不泄漏存在性）
  const facts = await port.facts(session)
  const post = (facts.posts ?? []).find((p) => p.id === id)
  if (post === undefined || (post.owner !== undefined && post.owner !== session.person_id))
    throw new ApiError('not_found', '没有这一条，或者它不是交给你发的。')
  if (port.answerPost === undefined)
    throw new ApiError('not_implemented', '这个本机服务版本还不能回发帖结果，先升级 Agents 工坊。')
  const out = await port.answerPost(session, id, answer)
  if (!out.ok) throw new ApiError('conflict', out.message)
  return ok(c, { ok: true as const })
}

export function extensionPanelRoutes(): Route[] {
  return [
    route(
      {
        method: 'get',
        path: '/v1/extension/panel',
        operationId: 'extensionPanel',
        summary:
          '插件侧边栏一屏：进度（读了什么、几点、下次几点、在做什么）、要你处理（发给本人的「发出去」卡）、记录（发出记录与记录去处）',
        tag: 'extension',
        auth: 'public',
        returns: 'PanelSnapshot',
      },
      async (c, deps) => ok(c, await snapshotOf(deps, viewerOf(c, deps))),
    ),
    route(
      {
        method: 'post',
        path: '/v1/extension/panel/cards/:id/fill',
        operationId: 'extensionPanelFill',
        summary:
          '在插件里批这张「发出去」卡（改过就按改过的），马上交给插件填进 Reddit 页面——发送那一下由人点',
        tag: 'extension',
        auth: 'public',
        outbound: true,
        params: [{ name: 'id', in: 'path', required: true, description: '审批项 id' }],
        body: fillSchema,
        returns: 'PanelFillResult',
      },
      async (c, deps) => {
        const session = actorOf(c, deps)
        const input = await body(c, fillSchema)
        if (input.text !== undefined && input.text.trim() === '')
          throw new ApiError('invalid_input', '草稿是空的，没法填。')
        const item = await openCard(deps, session, param(c, 'id'), input.version)
        const edited = editedPayloadOf(item, input)
        const token = tokenFor(item, session.person_id)
        if (token === undefined) throw new ApiError('not_found', NOT_FOUND)
        await deps.approvals
          .decide(item.id, session.person_id, {
            decision_token: token,
            action: edited === undefined ? 'approve' : 'approve_edited',
            via: 'extension',
            ...(edited === undefined ? {} : { edited_payload: edited }),
          })
          .catch(decideError)
        const out = await portOf(deps).deliverNow(session, item.id)
        const result: PanelFillResult = { ok: true, ...out }
        return ok(c, result)
      },
    ),
    route(
      {
        method: 'post',
        path: '/v1/extension/panel/cards/:id/skip',
        operationId: 'extensionPanelSkip',
        summary: '在插件里点「不发」（驳回这张卡，与工坊里驳回是同一件事）',
        tag: 'extension',
        auth: 'public',
        params: [{ name: 'id', in: 'path', required: true, description: '审批项 id' }],
        body: skipSchema,
        returns: '{ ok: true }',
      },
      async (c, deps) => {
        const session = actorOf(c, deps)
        const input = await body(c, skipSchema)
        const item = await openCard(deps, session, param(c, 'id'), input.version)
        const token = tokenFor(item, session.person_id)
        if (token === undefined) throw new ApiError('not_found', NOT_FOUND)
        await deps.approvals
          .decide(item.id, session.person_id, {
            decision_token: token,
            action: 'reject',
            via: 'extension',
            reason: input.reason?.trim() || '在插件里点了不发',
          })
          .catch(decideError)
        return ok(c, { ok: true as const })
      },
    ),
    route(
      {
        method: 'post',
        path: '/v1/extension/panel/posts/:id/done',
        operationId: 'extensionPanelPostDone',
        summary:
          '交给你发的社媒帖子：你在自己的后台里发好了（贴回那一条的链接 = 读回确认；不贴 = 只记你说发了）',
        tag: 'extension',
        auth: 'public',
        params: [{ name: 'id', in: 'path', required: true, description: '帖子 id' }],
        body: postDoneSchema,
        returns: '{ ok: true }',
      },
      async (c, deps) => {
        const input = await body(c, postDoneSchema)
        const link = input.link?.trim()
        return answerPostOf(c, deps, {
          done: true,
          ...(link === undefined || link === '' ? {} : { link }),
        })
      },
    ),
    route(
      {
        method: 'post',
        path: '/v1/extension/panel/posts/:id/skip',
        operationId: 'extensionPanelPostSkip',
        summary: '交给你发的社媒帖子：不发了（帖子记「没发」，待办收掉）',
        tag: 'extension',
        auth: 'public',
        params: [{ name: 'id', in: 'path', required: true, description: '帖子 id' }],
        body: postSkipSchema,
        returns: '{ ok: true }',
      },
      async (c, deps) => {
        const input = await body(c, postSkipSchema)
        const reason = input.reason?.trim()
        return answerPostOf(c, deps, {
          done: false,
          ...(reason === undefined || reason === '' ? {} : { reason }),
        })
      },
    ),
    route(
      {
        method: 'post',
        path: '/v1/extension/panel/writes/:job/refill',
        operationId: 'extensionPanelRefill',
        summary: '没发出去的那一条再填一次（同一份已批的草稿，不用重批）',
        tag: 'extension',
        auth: 'public',
        outbound: true,
        params: [{ name: 'job', in: 'path', required: true, description: '插件动作的那一件 id' }],
        returns: 'PanelFillResult',
      },
      async (c, deps) => {
        const session = actorOf(c, deps)
        const job = param(c, 'job')
        const facts = await portOf(deps).facts(session)
        const w = facts.writes.find((x) => x.job_id === job)
        const it = w === undefined ? undefined : await deps.approvals.get(w.approval_item_id)
        if (
          it === undefined ||
          it.workspace_id !== session.workspace_id ||
          !mine(it, session.person_id)
        )
          throw new ApiError('not_found', '没有这一条，或者它不是你批的。')
        const out = await portOf(deps).refill(session, job)
        const result: PanelFillResult = out.ok ? { ok: true, write: out.write } : out
        return ok(c, result)
      },
    ),
  ]
}
