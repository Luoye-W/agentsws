/**
 * WP398（docs/106 §13 A8）：Amazon 词库的 HTTP 投影（岗位页「词库」块、第三栏词表、体检卡那一行）。
 *
 * | 路由 | 是什么 |
 * |---|---|
 * | `GET /v1/amazon-keywords` | 词库摘要：多少个词、几个差距词、最近一次更新、每个自家 ASIN 的差距词 |
 * | `GET /v1/amazon-keywords/list` | 词表（可按来源 / 标记 / 差距 / 他牌名筛） |
 * | `POST /v1/amazon-keywords/refresh` | 现在刷新一次（读前台联想词，只读；拆 Listing；算差距） |
 * | `POST /v1/amazon-keywords/mark` | 标一个词（核心 / 不要 / 已埋进 Listing），或自己加一个词（只动本机） |
 *
 * 只出建议，不写 Amazon；一期没有搜索量。
 */
import {
  AMAZON_KEYWORD_MARKS,
  AMAZON_KEYWORD_SOURCES,
  type AmazonKeyword,
  type AmazonKeywordBankView,
  type AmazonKeywordMark,
  type AmazonKeywordMarkPatch,
  type AmazonKeywordPage,
  type AmazonKeywordQuery,
  type AmazonKeywordRefresh,
  type AmazonKeywordSource,
  type MaybePromise,
} from '@agentsws/contracts'
import { z } from 'zod'
import { ApiError } from '../errors.js'
import { body, ok, principalOf } from '../helpers.js'
import { type Route, route } from '../route-spec.js'
import type { GatewayDeps } from '../types.js'

const READ = { domain: 'product', op: 'read', range: 'assigned', sensitivity: 'internal' } as const
const TAG = 'amazon-keywords'

export interface AmazonKeywordsActor {
  workspace_id: string
  person_id: string
}

export interface AmazonKeywordsPort {
  view(actor: AmazonKeywordsActor): MaybePromise<AmazonKeywordBankView>
  list(actor: AmazonKeywordsActor, query: AmazonKeywordQuery): MaybePromise<AmazonKeywordPage>
  refresh(
    actor: AmazonKeywordsActor,
    input: { seeds?: string[]; marketplace?: string; autocomplete?: boolean },
  ): MaybePromise<{ refresh: AmazonKeywordRefresh; view: AmazonKeywordBankView }>
  mark(actor: AmazonKeywordsActor, patch: AmazonKeywordMarkPatch): MaybePromise<AmazonKeyword>
}

const Mark = z.enum(AMAZON_KEYWORD_MARKS as unknown as [AmazonKeywordMark, ...AmazonKeywordMark[]])
const RefreshBody = z.object({
  seeds: z.array(z.string().trim().min(2).max(80)).max(10).optional(),
  marketplace: z.string().trim().min(2).max(4).optional(),
  autocomplete: z.boolean().optional(),
})
const MarkBody = z
  .object({
    id: z.string().trim().min(3).max(240).optional(),
    term: z.string().trim().min(2).max(120).optional(),
    marketplace: z.string().trim().min(2).max(4).optional(),
    add: z.array(Mark).max(3).optional(),
    remove: z.array(Mark).max(3).optional(),
  })
  .refine((b) => b.id !== undefined || b.term !== undefined, '要给 id 或 term')

function portOf(deps: GatewayDeps): AmazonKeywordsPort {
  const p = deps.amazonKeywords
  if (p === undefined)
    throw new ApiError(
      'not_implemented',
      '这个服务进程没有装配 Amazon 词库（GatewayDeps.amazonKeywords）',
    )
  return p
}

const actorOf = (c: Parameters<typeof principalOf>[0]): AmazonKeywordsActor => {
  const p = principalOf(c)
  return { workspace_id: p.workspace_id, person_id: p.person_id }
}

const compact = <T extends Record<string, unknown>>(x: T): T =>
  Object.fromEntries(Object.entries(x).filter(([, v]) => v !== undefined)) as T

export function amazonKeywordRoutes(): Route[] {
  const spec = (
    method: 'get' | 'post',
    path: string,
    operationId: string,
    summary: string,
    returns: string,
  ) => ({
    method,
    path,
    operationId,
    summary,
    tag: TAG,
    auth: 'bearer' as const,
    assignment: true,
    // 标词只动本机词库（不碰任何业务对象），亚马逊店铺运营一期只有读权限，所以四条都按读判
    authz: READ,
    returns,
  })
  return [
    route(
      spec(
        'get',
        '/v1/amazon-keywords',
        'getAmazonKeywords',
        'Amazon 词库摘要：词数、差距词、最近一次更新、每个自家 ASIN 的差距词（WP398；没有搜索量）',
        'AmazonKeywordBankView',
      ),
      async (c, deps) => ok(c, await portOf(deps).view(actorOf(c))),
    ),
    route(
      {
        ...spec(
          'get',
          '/v1/amazon-keywords/list',
          'listAmazonKeywords',
          'Amazon 词表（按竞品出现次数排；可按来源 / 标记 / 差距 / 他牌名筛）',
          'AmazonKeywordPage',
        ),
        params: [
          { name: 'source', in: 'query', description: AMAZON_KEYWORD_SOURCES.join(' | ') },
          { name: 'mark', in: 'query', description: AMAZON_KEYWORD_MARKS.join(' | ') },
          {
            name: 'gap',
            in: 'query',
            description: 'true = 只看差距词',
            schema: { type: 'boolean' },
          },
          {
            name: 'other_brand',
            in: 'query',
            description: 'true = 只看含他牌名的',
            schema: { type: 'boolean' },
          },
          { name: 'q', in: 'query', description: '词里包含这几个字' },
          { name: 'limit', in: 'query', description: '默认 200', schema: { type: 'integer' } },
          { name: 'offset', in: 'query', description: '默认 0', schema: { type: 'integer' } },
        ],
      },
      async (c, deps) => {
        const source = c.req.query('source')
        const mark = c.req.query('mark')
        if (source !== undefined && !AMAZON_KEYWORD_SOURCES.includes(source as AmazonKeywordSource))
          throw new ApiError('invalid_input', `source 只能是 ${AMAZON_KEYWORD_SOURCES.join(' / ')}`)
        if (mark !== undefined && !AMAZON_KEYWORD_MARKS.includes(mark as AmazonKeywordMark))
          throw new ApiError('invalid_input', `mark 只能是 ${AMAZON_KEYWORD_MARKS.join(' / ')}`)
        const num = (k: string): number | undefined => {
          const v = Number(c.req.query(k))
          return Number.isFinite(v) && c.req.query(k) !== undefined ? v : undefined
        }
        const query = compact({
          source: source as AmazonKeywordSource | undefined,
          mark: mark as AmazonKeywordMark | undefined,
          gap: c.req.query('gap') === 'true' ? true : undefined,
          other_brand: c.req.query('other_brand') === 'true' ? true : undefined,
          q: c.req.query('q'),
          limit: num('limit'),
          offset: num('offset'),
        }) as AmazonKeywordQuery
        return ok(c, await portOf(deps).list(actorOf(c), query))
      },
    ),
    route(
      {
        ...spec(
          'post',
          '/v1/amazon-keywords/refresh',
          'refreshAmazonKeywords',
          '现在刷新词库：读 Amazon 前台联想词（只读，自报 Agent 身份，被拦就停）、拆 Listing、算差距',
          '{ refresh: AmazonKeywordRefresh; view: AmazonKeywordBankView }',
        ),
        body: RefreshBody,
      },
      async (c, deps) => {
        const b = await body(c, RefreshBody)
        return ok(
          c,
          await portOf(deps).refresh(actorOf(c), {
            ...(b.seeds === undefined ? {} : { seeds: b.seeds }),
            ...(b.marketplace === undefined ? {} : { marketplace: b.marketplace }),
            ...(b.autocomplete === undefined ? {} : { autocomplete: b.autocomplete }),
          }),
        )
      },
    ),
    route(
      {
        ...spec(
          'post',
          '/v1/amazon-keywords/mark',
          'markAmazonKeyword',
          '标一个词（核心 / 不要 / 已埋进 Listing），或自己加一个词（只动本机词库）',
          'AmazonKeyword',
        ),
        body: MarkBody,
      },
      async (c, deps) => {
        const input = compact(await body(c, MarkBody)) as AmazonKeywordMarkPatch
        return ok(c, await portOf(deps).mark(actorOf(c), input))
      },
    ),
  ]
}
