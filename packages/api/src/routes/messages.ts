/**
 * WP113（63 §8）：**消息面**（`/v1/messages/*`）。
 *
 * 28 §2「网关里不写业务」：每条路由都只是消息模块某个方法的投影，
 * 装配在 `apps/server/src/messages.ts`。
 *
 * 鉴权元组照 `work.ts` 那一条（`approval.read|stage / own`）。理由一样：
 * 一只邮箱是**本人自己的收件处**，05 的 scopes 是对业务数据域说的
 * （订单、顾客、广告账户），邮箱不是其中之一。真正会对外产生影响的只有
 * `POST /v1/messages/send`，那一条挂 `outbound: true`，走急停的出站档，
 * 而且它发的是**人自己按下发送的那一封**——不是 Agent 提的草稿。
 *
 * 三条边界写在类型上：
 * - **没有硬删**：`DELETE` 一条路由都没有，删除是 `POST …/move { to: 'trash' }`；
 * - **发送不出卡**（36「只有要人拍板的才是卡」的反面）：人自己按的发送不该
 *   再问他一遍；
 * - **`kefuagents` / `kolagents` 里的信在这里只读**（63 §9）：要亲自回先走
 *   现有的 takeover，这一层不给"直接回复"的口子。
 */
import type {
  MaybePromise,
  MessageBackfillInput,
  MessageDraft,
  MessageDraftInput,
  MessageFlagsInput,
  MessageFolder,
  MessageLabel,
  MessageListQuery,
  MessageMoveInput,
  MessageRecord,
  MessageSendInput,
  MessageSendResult,
  MessageSyncReport,
  MessageThreadSummary,
  PersonId,
  ReplySuggestion,
  SenderRule,
  Todo,
  WorkspaceId,
} from '@agentsws/contracts'
import { z } from 'zod'
import { ApiError } from '../errors.js'
import { assignmentOf, body, intParam, ok, param, principalOf } from '../helpers.js'
import { type Route, route } from '../route-spec.js'
import type { GatewayDeps } from '../types.js'

const READ = { domain: 'approval', op: 'read', range: 'own', sensitivity: 'internal' } as const
const WRITE = { ...READ, op: 'stage' } as const

export interface MessageActor {
  workspace_id: WorkspaceId
  person_id: PersonId
  assignment_id: string
}

/** 一只邮箱在消息页上的样子（"全部邮箱"那一排）。 */
export interface MessageAccountView {
  address: string
  unread: number
  folders: MessageFolder[]
  /** 现在回溯到哪一天（"再往前取"旁边那句话）。 */
  backfill_floor: string
}

/** 打开一封信时一次拿全（正文 + 这条会话 + 右栏那一格要的东西）。 */
export interface MessageThreadView {
  thread_id: string
  subject: string
  messages: MessageRecord[]
  /**
   * 63 §9：`kefuagents` / `kolagents` 里的信顶上那条状态带。
   * 不为空 = 这一页**不给"直接回复"**（避免人与 Agent 撞车）。
   */
  agent_status?: {
    route: 'support' | 'kol'
    /** `working` / `waiting_for_you` / `replied`。 */
    state: 'working' | 'waiting_for_you' | 'replied'
    /** 去对应工作线程的深链（`/matters/<id>`）。 */
    href?: string
    /** "我来接手"要打给谁（现有 takeover 那条路）。 */
    takeover_matter_id?: string
  }
}

/** 右栏 `mail-assistant` 那一格要的东西（一次取全，前端不发第二个请求）。 */
export interface MailAssistantView {
  message_id: string
  summary: string
  /**
   * 这封信要不要回。
   *
   * 与 `suggestions` 分开给，是因为"不用回"与"要回但这台机器上生成不出来"
   * 在界面上必须是两句话——只看空数组的话，一台没接模型的机器会对每封信都说
   * "这封信看起来不用回"，而那是假的。
   */
  needs_reply: boolean
  /** `needs_reply` 为假时是空数组（不生成、不花钱）。 */
  suggestions: ReplySuggestion[]
  sender: {
    address: string
    name?: string
    /** 历史往来多少封。 */
    history_count: number
    /** 关联到的对象（订单 / 红人 / 客户）。 */
    linked: { type: string; id: string; label: string }[]
  }
  /** 相关待办。 */
  todos: { id: string; title: string; status: string }[]
  /** 这台机器上有没有可用的模型（没有时界面照实说，而不是显示"生成失败"）。 */
  model_available: boolean
}

export interface MessagesPort {
  accounts(actor: MessageActor): MaybePromise<{ accounts: MessageAccountView[] }>
  threads(
    actor: MessageActor,
    query: MessageListQuery,
  ): MaybePromise<{ threads: MessageThreadSummary[] }>
  thread(actor: MessageActor, thread_id: string): MaybePromise<MessageThreadView>
  message(actor: MessageActor, id: string): MaybePromise<{ message: MessageRecord }>
  setFlags(
    actor: MessageActor,
    id: string,
    input: MessageFlagsInput,
  ): MaybePromise<{ message: MessageRecord }>
  /** 挪一封信（也是纠错的落点）。删除 = `to: 'trash'`。 */
  move(
    actor: MessageActor,
    id: string,
    input: MessageMoveInput,
  ): MaybePromise<{ message: MessageRecord; rule?: SenderRule }>
  setLabels(
    actor: MessageActor,
    id: string,
    labels: string[],
  ): MaybePromise<{ message: MessageRecord }>
  /** 「显示图片」/「总是信任这个发件人」。 */
  showImages(
    actor: MessageActor,
    id: string,
    always: boolean,
  ): MaybePromise<{ message: MessageRecord }>

  labels(actor: MessageActor): MaybePromise<{ labels: MessageLabel[] }>
  putLabel(actor: MessageActor, label: MessageLabel): MaybePromise<{ label: MessageLabel }>
  deleteLabel(actor: MessageActor, id: string): MaybePromise<{ deleted: boolean }>
  /** 合并两个标签（把 `from` 上的信都改挂 `into`，然后删掉 `from`）。 */
  mergeLabels(
    actor: MessageActor,
    from: string,
    into: string,
  ): MaybePromise<{ moved: number; labels: MessageLabel[] }>

  senderRules(actor: MessageActor): MaybePromise<{ rules: SenderRule[] }>
  deleteSenderRule(actor: MessageActor, id: string): MaybePromise<{ deleted: boolean }>

  drafts(actor: MessageActor): MaybePromise<{ drafts: MessageDraft[] }>
  saveDraft(actor: MessageActor, input: MessageDraftInput): MaybePromise<{ draft: MessageDraft }>
  discardDraft(actor: MessageActor, id: string): MaybePromise<{ deleted: boolean }>
  /** **人自己按的发送**：走现有 outbox 七态 + 对账，不出卡。 */
  send(actor: MessageActor, input: MessageSendInput): MaybePromise<MessageSendResult>

  /** 右栏那一格（摘要 / 回复建议 / 发件人是谁 / 相关待办）。 */
  assistant(actor: MessageActor, id: string): MaybePromise<MailAssistantView>
  /** 「转成待办」。 */
  toTodo(actor: MessageActor, id: string): MaybePromise<{ todo: Todo }>

  /** 立刻收一次。 */
  sync(actor: MessageActor): MaybePromise<MessageSyncReport>
  /** 「再往前取」。 */
  backfill(actor: MessageActor, input: MessageBackfillInput): MaybePromise<{ floor: string }>
}

function portOf(deps: GatewayDeps): MessagesPort {
  const p = deps.messages
  if (p === undefined)
    throw new ApiError(
      'not_implemented',
      '这个服务进程没有装配消息面（GatewayDeps.messages）。左栏的「消息」要它才有东西可看。',
    )
  return p
}

function actorOf(c: Parameters<typeof principalOf>[0]): MessageActor {
  const p = principalOf(c)
  const a = assignmentOf(c)
  return { workspace_id: p.workspace_id, person_id: p.person_id, assignment_id: a.id }
}

const AddressSchema = z.object({
  email: z.string().min(3).max(320),
  name: z.string().max(200).optional(),
})

const FlagsBody = z.object({
  read: z.boolean().optional(),
  starred: z.boolean().optional(),
  answered: z.boolean().optional(),
})

const MoveBody = z.object({
  // 没有 `purge`：删除永远是移到垃圾箱（63 §7）
  to: z.enum(['inbox', 'sent', 'drafts', 'trash', 'spam', 'archive', 'support', 'kol', 'custom']),
  remember_sender: z.boolean().optional(),
})

const LabelsBody = z.object({ labels: z.array(z.string().min(1).max(64)).max(20) })

const LabelBody = z.object({
  id: z.string().min(1).max(64),
  name_zh: z.string().min(1).max(60),
  name_en: z.string().min(1).max(60),
  color: z.string().min(1).max(32),
})

const MergeLabelsBody = z.object({
  from: z.string().min(1).max(64),
  into: z.string().min(1).max(64),
})

const DraftBody = z.object({
  id: z.string().max(120).optional(),
  account: z.string().max(320).optional(),
  thread_id: z.string().max(400).optional(),
  in_reply_to: z.string().max(400).optional(),
  to: z.array(AddressSchema).max(100).optional(),
  cc: z.array(AddressSchema).max(100).optional(),
  bcc: z.array(AddressSchema).max(100).optional(),
  subject: z.string().max(500).optional(),
  text: z.string().max(200_000).optional(),
})

const SendBody = z.object({
  draft_id: z.string().max(120).optional(),
  account: z.string().max(320).optional(),
  thread_id: z.string().max(400).optional(),
  in_reply_to: z.string().max(400).optional(),
  to: z.array(AddressSchema).max(100).optional(),
  cc: z.array(AddressSchema).max(100).optional(),
  bcc: z.array(AddressSchema).max(100).optional(),
  subject: z.string().max(500).optional(),
  text: z.string().max(200_000).optional(),
})

const ImagesBody = z.object({ always: z.boolean().optional() })

const BackfillBody = z.object({
  account: z.string().max(320).optional(),
  folder: z.string().max(200).optional(),
  days: z.number().int().min(1).max(3650).optional(),
})

function queryOf(c: Parameters<typeof principalOf>[0]): MessageListQuery {
  const q = (name: string): string | undefined => {
    const raw = c.req.query(name)
    return raw === undefined || raw.trim() === '' ? undefined : raw.trim()
  }
  const folder_kind = q('folder_kind')
  const routeName = q('route')
  return {
    ...(q('folder') === undefined ? {} : { folder: q('folder') as string }),
    ...(folder_kind === undefined
      ? {}
      : { folder_kind: folder_kind as MessageListQuery['folder_kind'] }),
    ...(q('account') === undefined ? {} : { account: q('account') as string }),
    ...(q('label') === undefined ? {} : { label: q('label') as string }),
    ...(routeName === undefined ? {} : { route: routeName as MessageListQuery['route'] }),
    ...(q('unread') === 'true' ? { unread: true } : {}),
    ...(q('starred') === 'true' ? { starred: true } : {}),
    ...(q('q') === undefined ? {} : { q: q('q') as string }),
    ...(intParam(c, 'limit') === undefined ? {} : { limit: intParam(c, 'limit') as number }),
  }
}

const LIST_PARAMS = [
  { name: 'folder', in: 'query' as const, description: '文件夹真名（`INBOX` / `kefuagents`）' },
  {
    name: 'folder_kind',
    in: 'query' as const,
    description: '文件夹语义（收件箱 / 已发 / 垃圾箱 …）',
  },
  { name: 'account', in: 'query' as const, description: '只看这一只邮箱；不给 = 全部邮箱' },
  { name: 'label', in: 'query' as const, description: '只看这个标签' },
  { name: 'route', in: 'query' as const, description: 'inbox / support / kol' },
  { name: 'unread', in: 'query' as const, description: '`true` = 只看未读' },
  { name: 'starred', in: 'query' as const, description: '`true` = 只看星标' },
  { name: 'q', in: 'query' as const, description: '搜索：发件人 / 主题 / 正文 / 标签 / 文件夹' },
  {
    name: 'limit',
    in: 'query' as const,
    description: '最多几条',
    schema: { type: 'integer' as const },
  },
]

export function messageRoutes(): Route[] {
  return [
    route(
      {
        method: 'get',
        path: '/v1/messages/accounts',
        operationId: 'listMessageAccounts',
        summary: '连着哪几只邮箱 + 每只的文件夹与未读数（"全部邮箱"那一排）',
        tag: 'messages',
        auth: 'bearer',
        assignment: true,
        authz: READ,
        returns: '{ accounts: MessageAccountView[] }',
      },
      async (c, deps) => ok(c, await portOf(deps).accounts(actorOf(c))),
    ),
    route(
      {
        method: 'get',
        path: '/v1/messages/labels',
        operationId: 'listMessageLabels',
        summary: '标签清单（内置十一个 + 用户自建的）',
        tag: 'messages',
        auth: 'bearer',
        assignment: true,
        authz: READ,
        returns: '{ labels: MessageLabel[] }',
      },
      async (c, deps) => ok(c, await portOf(deps).labels(actorOf(c))),
    ),
    route(
      {
        method: 'post',
        path: '/v1/messages/labels',
        operationId: 'putMessageLabel',
        summary: '新建或改一个标签（内置的只能改名改色，删不掉）',
        tag: 'messages',
        auth: 'bearer',
        assignment: true,
        authz: WRITE,
        body: LabelBody,
        returns: '{ label: MessageLabel }',
      },
      async (c, deps) => {
        const input = await body(c, LabelBody)
        return ok(c, await portOf(deps).putLabel(actorOf(c), { ...input, builtin: false }), 201)
      },
    ),
    route(
      {
        method: 'post',
        path: '/v1/messages/labels/merge',
        operationId: 'mergeMessageLabels',
        summary: '合并两个标签：`from` 上的信改挂 `into`，然后删掉 `from`',
        tag: 'messages',
        auth: 'bearer',
        assignment: true,
        authz: WRITE,
        body: MergeLabelsBody,
        returns: '{ moved: number; labels: MessageLabel[] }',
      },
      async (c, deps) => {
        const input = await body(c, MergeLabelsBody)
        return ok(c, await portOf(deps).mergeLabels(actorOf(c), input.from, input.into))
      },
    ),
    route(
      {
        method: 'delete',
        path: '/v1/messages/labels/:id',
        operationId: 'deleteMessageLabel',
        summary: '删一个自建标签（会从所有信上摘干净）。内置的删不掉',
        tag: 'messages',
        auth: 'bearer',
        assignment: true,
        authz: WRITE,
        returns: '{ deleted: boolean }',
      },
      async (c, deps) => ok(c, await portOf(deps).deleteLabel(actorOf(c), param(c, 'id'))),
    ),
    route(
      {
        method: 'get',
        path: '/v1/messages/rules',
        operationId: 'listMessageSenderRules',
        summary: '你教过的发件人规则（"以后这个发件人都这样"）',
        tag: 'messages',
        auth: 'bearer',
        assignment: true,
        authz: READ,
        returns: '{ rules: SenderRule[] }',
      },
      async (c, deps) => ok(c, await portOf(deps).senderRules(actorOf(c))),
    ),
    route(
      {
        method: 'delete',
        path: '/v1/messages/rules/:id',
        operationId: 'deleteMessageSenderRule',
        summary: '撤掉一条发件人规则',
        tag: 'messages',
        auth: 'bearer',
        assignment: true,
        authz: WRITE,
        returns: '{ deleted: boolean }',
      },
      async (c, deps) => ok(c, await portOf(deps).deleteSenderRule(actorOf(c), param(c, 'id'))),
    ),
    route(
      {
        method: 'get',
        path: '/v1/messages/drafts',
        operationId: 'listMessageDrafts',
        summary: '草稿箱（自动保存的那几份）',
        tag: 'messages',
        auth: 'bearer',
        assignment: true,
        authz: READ,
        returns: '{ drafts: MessageDraft[] }',
      },
      async (c, deps) => ok(c, await portOf(deps).drafts(actorOf(c))),
    ),
    route(
      {
        method: 'post',
        path: '/v1/messages/drafts',
        operationId: 'saveMessageDraft',
        summary: '存一份草稿（写信框每隔几秒自动打这一条）',
        tag: 'messages',
        auth: 'bearer',
        assignment: true,
        authz: WRITE,
        body: DraftBody,
        returns: '{ draft: MessageDraft }',
      },
      async (c, deps) =>
        ok(c, await portOf(deps).saveDraft(actorOf(c), await body(c, DraftBody)), 201),
    ),
    route(
      {
        method: 'delete',
        path: '/v1/messages/drafts/:id',
        operationId: 'discardMessageDraft',
        summary: '丢掉一份草稿',
        tag: 'messages',
        auth: 'bearer',
        assignment: true,
        authz: WRITE,
        returns: '{ deleted: boolean }',
      },
      async (c, deps) => ok(c, await portOf(deps).discardDraft(actorOf(c), param(c, 'id'))),
    ),
    route(
      {
        method: 'post',
        path: '/v1/messages/send',
        operationId: 'sendMessage',
        summary:
          '发一封信（**人自己按的发送**）。走现有 outbox 七态 + 对账，不出卡——36「只有要人拍板的才是卡」',
        tag: 'messages',
        auth: 'bearer',
        assignment: true,
        authz: WRITE,
        outbound: true,
        body: SendBody,
        returns: 'MessageSendResult',
      },
      async (c, deps) => ok(c, await portOf(deps).send(actorOf(c), await body(c, SendBody)), 201),
    ),
    route(
      {
        method: 'post',
        path: '/v1/messages/sync',
        operationId: 'syncMessages',
        summary: '立刻收一次（调度器每分钟自己也会收）',
        tag: 'messages',
        auth: 'bearer',
        assignment: true,
        authz: WRITE,
        returns: 'MessageSyncReport',
      },
      async (c, deps) => ok(c, await portOf(deps).sync(actorOf(c))),
    ),
    route(
      {
        method: 'post',
        path: '/v1/messages/backfill',
        operationId: 'backfillMessages',
        summary: '再往前取（首次只回溯 30 天 / 2000 封）',
        tag: 'messages',
        auth: 'bearer',
        assignment: true,
        authz: WRITE,
        body: BackfillBody,
        returns: '{ floor: string }',
      },
      async (c, deps) =>
        ok(c, await portOf(deps).backfill(actorOf(c), await body(c, BackfillBody))),
    ),
    route(
      {
        method: 'get',
        path: '/v1/messages/threads/:id',
        operationId: 'getMessageThread',
        summary: '一条会话里的全部信 + 顶上那条"客服 Agent 在处理"的状态带（63 §9）',
        tag: 'messages',
        auth: 'bearer',
        assignment: true,
        authz: READ,
        returns: 'MessageThreadView',
      },
      async (c, deps) => ok(c, await portOf(deps).thread(actorOf(c), param(c, 'id'))),
    ),
    route(
      {
        method: 'get',
        path: '/v1/messages/:id/assistant',
        operationId: 'getMailAssistant',
        summary: '右栏那一格：本封摘要、回复建议（**打开时才生成并缓存**）、发件人是谁、相关待办',
        tag: 'messages',
        auth: 'bearer',
        assignment: true,
        authz: READ,
        returns: 'MailAssistantView',
      },
      async (c, deps) => ok(c, await portOf(deps).assistant(actorOf(c), param(c, 'id'))),
    ),
    route(
      {
        method: 'post',
        path: '/v1/messages/:id/flags',
        operationId: 'setMessageFlags',
        summary: '已读 / 星标 / 已回。**回写 IMAP**——回到自己的邮箱软件看到的是同一个状态',
        tag: 'messages',
        auth: 'bearer',
        assignment: true,
        authz: WRITE,
        body: FlagsBody,
        returns: '{ message: MessageRecord }',
      },
      async (c, deps) =>
        ok(c, await portOf(deps).setFlags(actorOf(c), param(c, 'id'), await body(c, FlagsBody))),
    ),
    route(
      {
        method: 'post',
        path: '/v1/messages/:id/move',
        operationId: 'moveMessage',
        summary:
          '挪一封信（移到客服 / 移到红人 / 移回收件箱 / 归档 / **删除 = 移到垃圾箱**）；可顺手写一条发件人规则',
        tag: 'messages',
        auth: 'bearer',
        assignment: true,
        authz: WRITE,
        body: MoveBody,
        returns: '{ message: MessageRecord; rule?: SenderRule }',
      },
      async (c, deps) =>
        ok(
          c,
          await portOf(deps).move(
            actorOf(c),
            param(c, 'id'),
            (await body(c, MoveBody)) as MessageMoveInput,
          ),
        ),
    ),
    route(
      {
        method: 'post',
        path: '/v1/messages/:id/labels',
        operationId: 'setMessageLabels',
        summary: '给一封信换一组标签（服务器支持 keyword 时顺手同步，不支持就只在本地）',
        tag: 'messages',
        auth: 'bearer',
        assignment: true,
        authz: WRITE,
        body: LabelsBody,
        returns: '{ message: MessageRecord }',
      },
      async (c, deps) =>
        ok(
          c,
          await portOf(deps).setLabels(
            actorOf(c),
            param(c, 'id'),
            (await body(c, LabelsBody)).labels,
          ),
        ),
    ),
    route(
      {
        method: 'post',
        path: '/v1/messages/:id/images',
        operationId: 'showMessageImages',
        summary:
          '显示这封信的远程图片；`always` = 以后总是信任这个发件人（默认不加载，防追踪像素）',
        tag: 'messages',
        auth: 'bearer',
        assignment: true,
        authz: WRITE,
        body: ImagesBody,
        returns: '{ message: MessageRecord }',
      },
      async (c, deps) =>
        ok(
          c,
          await portOf(deps).showImages(
            actorOf(c),
            param(c, 'id'),
            (await body(c, ImagesBody)).always === true,
          ),
        ),
    ),
    route(
      {
        method: 'post',
        path: '/v1/messages/:id/todo',
        operationId: 'messageToTodo',
        summary: '把这封信转成一条待办（右栏那个一键）',
        tag: 'messages',
        auth: 'bearer',
        assignment: true,
        authz: WRITE,
        returns: '{ todo: Todo }',
      },
      async (c, deps) => ok(c, await portOf(deps).toTodo(actorOf(c), param(c, 'id')), 201),
    ),
    route(
      {
        method: 'get',
        path: '/v1/messages/:id',
        operationId: 'getMessage',
        summary: '一封信（含净化过的 HTML 正文与附件元数据）',
        tag: 'messages',
        auth: 'bearer',
        assignment: true,
        authz: READ,
        returns: '{ message: MessageRecord }',
      },
      async (c, deps) => ok(c, await portOf(deps).message(actorOf(c), param(c, 'id'))),
    ),
    route(
      {
        method: 'get',
        path: '/v1/messages',
        operationId: 'listMessageThreads',
        summary: '会话列表（中栏那一列）。搜索、文件夹、标签、未读、星标、多邮箱都走这一条',
        tag: 'messages',
        auth: 'bearer',
        assignment: true,
        authz: READ,
        params: LIST_PARAMS,
        returns: '{ threads: MessageThreadSummary[] }',
      },
      async (c, deps) => ok(c, await portOf(deps).threads(actorOf(c), queryOf(c))),
    ),
  ]
}
