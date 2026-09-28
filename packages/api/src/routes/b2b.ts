/**
 * WP172（docs/84）：**B2B 库的 `/v1` 面**——列表 / 详情 / 新建草稿 / 提交改动卡。
 *
 * 照 `pr.ts` 的写法，四条纪律都在类型上看得见：
 *
 * 1. **一个对象域一把闸**。九类对象各判各的（`b2b_account` / `b2b_contact` / … /
 *    `export_shipment`），权限就是职责 yml 里的 scopes：跟单那一条没有 `b2b_opportunity`
 *    的 stage，于是它提不了商机草稿，路由里一行 if 都不用写。
 * 2. **读不经卡，写都经卡**。`POST …/drafts` 只存一份草稿（不算数）；`POST …/drafts/:id/submit`
 *    出一张改动卡；**批了**执行器才把它落进库里。这个文件里没有一条路直接改库。
 * 3. **联系方式只出脱敏那一格**。响应体里没有明文、也没有加密库的 key 名
 *    （同 `PrContactRow`）；入参里给的邮箱 / 电话，服务端当场写进加密库，草稿里只留 key 名。
 * 4. **导入名单本身出卡**（docs/84 §1.2）：CSV 用 `b2b-core` 的中英文表头别名解析，
 *    解析出来的客户与联系人跟着那一张 `b2b_list_import` 卡，批了才进库。
 */
import type {
  AssignmentId,
  B2bCollection,
  B2bDraft,
  B2bInquiry,
  B2bQuoteVersion,
  B2bSuppressionEntry,
  DataDomain,
  MaybePromise,
  PersonId,
  RoleId,
  Sensitivity,
  WorkspaceId,
} from '@agentsws/contracts'
import { z } from 'zod'
import { ApiError } from '../errors.js'
import { assignmentOf, body, ok, param, principalOf } from '../helpers.js'
import { type AuthzSpec, type Route, route } from '../route-spec.js'
import type { GatewayDeps } from '../types.js'

/* ── actor 与视图 ─────────────────────────────────────────────────────── */

export interface B2bActor {
  workspace_id: WorkspaceId
  person_id: PersonId
  /** 本次绑定的那条分配——额度、等级与"能不能动"全从它来。 */
  assignment_id: AssignmentId
  role_id: RoleId
}

/**
 * 一行记录在响应体里的样子：就是契约那个对象，但**联系方式那几格换成脱敏的**
 * （`email_ref` / `phone_ref` 不出去，换成 `has_email` / `email_masked`）。
 */
export type B2bRow = Record<string, unknown> & { id: string }

export interface B2bListView {
  rows: B2bRow[]
  /** 这一类还没生效的草稿（提交了没批的也在，状态写着）。 */
  drafts: B2bDraftView[]
}

/** 草稿在响应体里的样子（记录同样脱敏）。 */
export type B2bDraftView = Omit<B2bDraft, 'record'> & { record: B2bRow }

export interface B2bDetailView {
  row: B2bRow
  /** 报价：全部版本（只读，从 1 起）。 */
  versions?: B2bQuoteVersion[]
}

/**
 * 提交之后回来的那一份（照 `PrStagedView`）。`staged` 为假 = guardrail 拦了，
 * `message` 是那句人话。**不抛异常**：被拦下来是正常结果之一。
 */
export interface B2bStagedView {
  staged: boolean
  draft_id: string
  change_id?: string
  approval_item_id?: string
  message?: string
  level?: string
  /** 报价：这张卡谁批（授权内业务员自己 / 超了转上级 / 没有上级转老板）。 */
  approver?: 'role_holder' | 'scope_manager' | 'owner'
  /** 报价：超了授权的哪几条。 */
  breaches?: string[]
}

export interface B2bImportView extends B2bStagedView {
  list_id: string
  /** 解析出来几行（去掉没有公司也没有邮箱的空行之后）。 */
  rows: number
  /** 其中几行在抑制名单上（导入了也不会被开发）。 */
  suppressed: number
}

/* ── 入参 ─────────────────────────────────────────────────────────────── */

export interface B2bDraftInput {
  /** 改哪一条（不给 = 新建）。 */
  record_id?: string | undefined
  /** 草稿 id（给了就在那份草稿上接着改）。 */
  draft_id?: string | undefined
  /** 记录的字段（契约那个对象的形状；`id` / `workspace_id` / 时间由服务端填）。 */
  record: Record<string, unknown>
  /** 联系人 / 展会线索：邮箱明文（当场进加密库，草稿里只留 key 名）。 */
  email?: string | undefined
  phone?: string | undefined
  /** 报价：这一版的几个数（服务端算版本号，旧版不动）。 */
  quote_version?:
    | {
        lines: { sku: string; description: string; qty: number; unit_price_usd: number }[]
        margin_pct: number
        discount_pct: number
        payment_terms_days: number
        incoterm: B2bQuoteVersion['incoterm']
        valid_until: string
      }
    | undefined
}

export interface B2bCsvImportInput {
  /** 这张名单叫什么（"香港秋季电子展来访"）。 */
  name: string
  /** CSV 原文（中英文表头都认：公司 / company、邮箱 / email …）。 */
  csv: string
  /** 名单从哪来的（来源网址，GDPR 第 14 条）。 */
  source_url?: string | undefined
  source_kind?: 'import' | 'trade_show' | undefined
}

/* ── 端口 ─────────────────────────────────────────────────────────────── */

export interface B2bPort {
  list(actor: B2bActor, collection: B2bCollection): MaybePromise<B2bListView>
  get(actor: B2bActor, collection: B2bCollection, id: string): MaybePromise<B2bDetailView>
  /** 存一份草稿（不算数，不出卡）。 */
  saveDraft(
    actor: B2bActor,
    collection: B2bCollection,
    input: B2bDraftInput,
  ): MaybePromise<{ draft: B2bDraftView }>
  /** 把草稿提成一张改动卡。批了执行器才落库。 */
  submitDraft(
    actor: B2bActor,
    collection: B2bCollection,
    draft_id: string,
  ): MaybePromise<B2bStagedView>
  /** 导入一张名单（CSV）：解析 → 出一张 `b2b_list_import` 卡。 */
  importCsv(actor: B2bActor, input: B2bCsvImportInput): MaybePromise<B2bImportView>
  /** 邮件分拣落进来的询盘与往来记录（新的在前）。 */
  inquiries(actor: B2bActor): MaybePromise<{ rows: B2bInquiry[] }>
  /** 抑制名单（只有遮过的地址与原因）。 */
  suppressions(actor: B2bActor): MaybePromise<{ rows: B2bSuppressionEntry[] }>
}

/* ── 九类对象的路由表 ─────────────────────────────────────────────────── */

interface CollectionRoute {
  collection: B2bCollection
  /** 路径那一段（`/v1/b2b/<segment>`）。 */
  segment: string
  /** operationId 里的名字（单数 / 复数）。 */
  one: string
  many: string
  zh: string
  /** 读这一类要的敏感级（联系人、报价是 confidential）。 */
  sensitivity: Sensitivity
}

/** 九类对象（契约 `B2B_COLLECTIONS` 的顺序）。 */
export const B2B_COLLECTION_ROUTES: readonly CollectionRoute[] = [
  {
    collection: 'b2b_account',
    segment: 'accounts',
    one: 'Account',
    many: 'Accounts',
    zh: '客户',
    sensitivity: 'internal',
  },
  {
    collection: 'b2b_contact',
    segment: 'contacts',
    one: 'Contact',
    many: 'Contacts',
    zh: '联系人（只出脱敏邮箱）',
    sensitivity: 'confidential',
  },
  {
    collection: 'b2b_opportunity',
    segment: 'opportunities',
    one: 'Opportunity',
    many: 'Opportunities',
    zh: '商机',
    sensitivity: 'internal',
  },
  {
    collection: 'b2b_quote',
    segment: 'quotes',
    one: 'Quote',
    many: 'Quotes',
    zh: '报价（版本只读）',
    sensitivity: 'confidential',
  },
  {
    collection: 'b2b_sample',
    segment: 'samples',
    one: 'Sample',
    many: 'Samples',
    zh: '样品',
    sensitivity: 'internal',
  },
  {
    collection: 'b2b_list',
    segment: 'lists',
    one: 'List',
    many: 'Lists',
    zh: '名单',
    sensitivity: 'internal',
  },
  {
    collection: 'trade_show',
    segment: 'trade-shows',
    one: 'TradeShow',
    many: 'TradeShows',
    zh: '展会',
    sensitivity: 'internal',
  },
  {
    collection: 'trade_show_lead',
    segment: 'trade-show-leads',
    one: 'TradeShowLead',
    many: 'TradeShowLeads',
    zh: '展会线索',
    sensitivity: 'internal',
  },
  {
    collection: 'export_shipment',
    segment: 'shipments',
    one: 'Shipment',
    many: 'Shipments',
    zh: '出运单',
    sensitivity: 'internal',
  },
]

const tuple = (domain: DataDomain, op: 'read' | 'stage', sensitivity: Sensitivity): AuthzSpec => ({
  domain,
  op,
  range: 'assigned',
  sensitivity,
})

function portOf(deps: GatewayDeps): B2bPort {
  const p = deps.b2b
  if (p === undefined)
    throw new ApiError(
      'not_implemented',
      '这个服务进程没有装配 B2B 库（GatewayDeps.b2b）。B2B 岗位那几条职责要它才动得了。',
    )
  return p
}

function actorOf(c: Parameters<typeof principalOf>[0]): B2bActor {
  const p = principalOf(c)
  const a = assignmentOf(c)
  return {
    workspace_id: p.workspace_id,
    person_id: p.person_id,
    assignment_id: a.id,
    role_id: a.role_id,
  }
}

const QuoteVersionBody = z.object({
  lines: z
    .array(
      z.object({
        sku: z.string().min(1).max(100),
        description: z.string().min(1).max(500),
        qty: z.number().int().positive().max(10_000_000),
        unit_price_usd: z.number().nonnegative().max(10_000_000),
      }),
    )
    .min(1)
    .max(200),
  margin_pct: z.number().min(-100).max(100),
  discount_pct: z.number().min(0).max(100),
  payment_terms_days: z.number().int().min(0).max(365),
  incoterm: z.enum(['EXW', 'FOB', 'CIF', 'DDP', 'DAP', 'FCA']),
  valid_until: z.string().min(1).max(40),
})

const DraftBody = z.object({
  record_id: z.string().min(1).max(100).optional(),
  draft_id: z.string().min(1).max(100).optional(),
  record: z.record(z.string(), z.unknown()),
  email: z.string().email().max(300).optional(),
  phone: z.string().min(3).max(50).optional(),
  quote_version: QuoteVersionBody.optional(),
})

const CsvBody = z.object({
  name: z.string().min(1).max(200),
  /** 上限与 `b2b-core` 的解析器一致（10000 行）；按字节再给一道闸。 */
  csv: z.string().min(1).max(2_000_000),
  source_url: z.string().url().max(1000).optional(),
  source_kind: z.enum(['import', 'trade_show']).optional(),
})

/* ── 路由 ─────────────────────────────────────────────────────────────── */

function collectionRoutes(spec: CollectionRoute): Route[] {
  const base = `/v1/b2b/${spec.segment}`
  const read = tuple(spec.collection, 'read', spec.sensitivity)
  const stage = tuple(spec.collection, 'stage', spec.sensitivity)
  return [
    route(
      {
        method: 'get',
        path: base,
        operationId: `listB2b${spec.many}`,
        summary: `B2B 库：${spec.zh}（连同还没生效的草稿）。读不经卡`,
        tag: 'b2b',
        auth: 'bearer',
        assignment: true,
        authz: read,
        returns: 'B2bListView',
      },
      async (c, deps) => ok(c, await portOf(deps).list(actorOf(c), spec.collection)),
    ),
    route(
      {
        method: 'get',
        path: `${base}/:id`,
        operationId: `getB2b${spec.one}`,
        summary: `B2B 库：一条${spec.zh}的详情${spec.collection === 'b2b_quote' ? '（带全部版本）' : ''}`,
        tag: 'b2b',
        auth: 'bearer',
        assignment: true,
        authz: read,
        params: [{ name: 'id', in: 'path', description: '记录 id' }],
        returns: 'B2bDetailView',
      },
      async (c, deps) => ok(c, await portOf(deps).get(actorOf(c), spec.collection, param(c, 'id'))),
    ),
    route(
      {
        method: 'post',
        path: `${base}/drafts`,
        operationId: `saveB2b${spec.one}Draft`,
        summary: `新建 / 修改一条${spec.zh}的草稿（不算数、不出卡）。邮箱 / 电话当场进加密库，草稿里只留 key 名`,
        tag: 'b2b',
        auth: 'bearer',
        assignment: true,
        authz: stage,
        body: DraftBody,
        returns: '{ draft: B2bDraftView }',
      },
      async (c, deps) => {
        const input = await body(c, DraftBody)
        return ok(
          c,
          await portOf(deps).saveDraft(actorOf(c), spec.collection, input as B2bDraftInput),
        )
      },
    ),
    route(
      {
        method: 'post',
        path: `${base}/drafts/:id/submit`,
        operationId: `submitB2b${spec.one}Draft`,
        summary: `把一份${spec.zh}草稿提成改动卡（批了才落库；被 guardrail 拦下时 staged 为假、message 是那句人话）`,
        tag: 'b2b',
        auth: 'bearer',
        assignment: true,
        authz: stage,
        params: [{ name: 'id', in: 'path', description: '草稿 id' }],
        returns: 'B2bStagedView',
      },
      async (c, deps) =>
        ok(c, await portOf(deps).submitDraft(actorOf(c), spec.collection, param(c, 'id'))),
    ),
  ]
}

export function b2bRoutes(): Route[] {
  return [
    ...B2B_COLLECTION_ROUTES.flatMap(collectionRoutes),
    route(
      {
        method: 'get',
        path: '/v1/b2b/inquiries',
        operationId: 'listB2bInquiries',
        summary: '邮件分拣落进 B2B 库的询盘与往来记录（新的在前；正文在消息库里）',
        tag: 'b2b',
        auth: 'bearer',
        assignment: true,
        authz: tuple('b2b_account', 'read', 'internal'),
        returns: '{ rows: B2bInquiry[] }',
      },
      async (c, deps) => ok(c, await portOf(deps).inquiries(actorOf(c))),
    ),
    route(
      {
        method: 'get',
        path: '/v1/b2b/suppressions',
        operationId: 'listB2bSuppressions',
        summary: '抑制名单（退订 / 硬退信；只有遮过的地址与原因）',
        tag: 'b2b',
        auth: 'bearer',
        assignment: true,
        authz: tuple('b2b_contact', 'read', 'confidential'),
        returns: '{ rows: B2bSuppressionEntry[] }',
      },
      async (c, deps) => ok(c, await portOf(deps).suppressions(actorOf(c))),
    ),
    route(
      {
        method: 'post',
        path: '/v1/b2b/imports/csv',
        operationId: 'importB2bCsv',
        summary:
          '导入一张客户 / 联系人名单（CSV，中英文表头都认）。**导入本身出卡**：批了客户与联系人才进库',
        tag: 'b2b',
        auth: 'bearer',
        assignment: true,
        authz: tuple('b2b_list', 'stage', 'internal'),
        body: CsvBody,
        returns: 'B2bImportView',
      },
      async (c, deps) =>
        ok(
          c,
          await portOf(deps).importCsv(actorOf(c), (await body(c, CsvBody)) as B2bCsvImportInput),
        ),
    ),
  ]
}
