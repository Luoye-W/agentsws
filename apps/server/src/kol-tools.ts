/**
 * WP117（66 断点 #1 的后一半）：把红人的能力**真接到工具上**。
 *
 * `kol-core` 的 `tools.ts` 只说了有哪些名字、吃什么；这个文件让那些名字真干活——
 * 十一个工具全部落到 `KolPort` 上，也就是 `/v1/kol/*` 那条路由背后的同一份装配。
 *
 * 为什么不新开一条路：`KolPort` 的每个写口都已经走过 guardrail、进过账本、建过卡
 * （`kol-service.ts`），另写一条「给 Agent 用的」写口等于第二本账。所以这里一行业务
 * 逻辑都没有，只做三件事：
 *
 * 1. **入参归一**：模型给的 input 是 `unknown`，在这里挑出认得的那几格；渠道没给就
 *    按这条职责自己的（`kol.youtube` → youtube）。
 * 2. **回执归一**：回给运行时的 data 一律带上 `rows`（有几条）与 `approval_item_id` /
 *    `change_id`（出了卡没出卡）——运行时靠这两样把「接口 200 但界面什么都没发生」
 *    （66 断点 #5、#7）翻成时间线上看得见的一条。
 * 3. **失败说人话**：拦下来、没接上、缺 id，都回一句中文，不回 `undefined`
 *    （66 断点 #6 的「界面把错误吞了」就是从这里开始的）。
 */
import type { KolActor, KolPort } from '@agentsws/api'
import type {
  CollaborationStage,
  DeliverableKind,
  DeliverableReview,
  Iso8601,
  KolChannel,
  ObjectRef,
  RunRequest,
  WorkspaceId,
} from '@agentsws/contracts'
import { KOL_TOOL_NAMES, kolChannelOfRole } from '@agentsws/kol-core'
import type { ToolExecution, ToolExecutor } from '@agentsws/stand-ins'

export interface KolToolsOptions {
  workspace_id: WorkspaceId
  /** 懒取：红人装配比运行时晚建出来（同 server.ts 里 `work: () => workRef` 那一处）。 */
  port(): KolPort | undefined
  /** 现在几点（登记交付物没给 `due_at` 时按「一周后」兜底）。 */
  now(): Iso8601
}

const str = (v: unknown): string | undefined => (typeof v === 'string' && v !== '' ? v : undefined)
const num = (v: unknown): number | undefined =>
  typeof v === 'number' && Number.isFinite(v) ? v : undefined

const CHANNELS: readonly KolChannel[] = ['youtube', 'instagram', 'tiktok', 'facebook', 'x']
const channelOf = (v: unknown, fallback: KolChannel): KolChannel =>
  CHANNELS.find((c) => c === v) ?? fallback

const STAGES: readonly CollaborationStage[] = [
  'sourced',
  'contacted',
  'replied',
  'negotiating',
  'agreed',
  'delivering',
  'delivered',
  'closed',
  'declined',
]

const KINDS: readonly DeliverableKind[] = ['video', 'post', 'story', 'reel', 'thread', 'live']
const REVIEWS: readonly DeliverableReview[] = [
  'pending',
  'approved',
  'changes_requested',
  'rejected',
]

/** 一条读结果 → data + provenance（15 §6 只证明「读过」）。 */
function rowsOf(rows: readonly unknown[], type: string): ToolExecution {
  const refs: ObjectRef[] = []
  for (const row of rows) {
    const r = row !== null && typeof row === 'object' ? (row as Record<string, unknown>) : undefined
    const id = str(r?.id) ?? str(r?.creator_id)
    if (id !== undefined) refs.push({ type, id })
  }
  return { status: 'ok', data: { rows, object: type }, provenance: refs }
}

/** 一条写结果（`KolStagedView` 那一族）→ data。拦下来也算 ok：卡面上要看得见原因。 */
function stagedOf(
  view: { staged: boolean; change_id?: string; approval_item_id?: string; message?: string },
  kind: string,
  extra: Record<string, unknown> = {},
): ToolExecution {
  if (!view.staged && view.approval_item_id === undefined && view.change_id === undefined) {
    return { status: 'blocked', reason: view.message ?? '被拦下了，没说为什么' }
  }
  return {
    status: 'ok',
    data: {
      kind,
      ...(view.change_id === undefined ? {} : { change_id: view.change_id }),
      ...(view.approval_item_id === undefined ? {} : { approval_item_id: view.approval_item_id }),
      ...(view.message === undefined ? {} : { message: view.message }),
      ...extra,
    },
  }
}

const missing = (what: string): ToolExecution => ({
  status: 'error',
  reason: `缺 ${what}：这一步得先知道是哪一条，先把清单读出来或在界面上点一条再来。`,
})

/**
 * 十一个红人工具的执行器。
 *
 * 不认的名字回 `undefined`——调用方（`records.ts` 的 `executeTool`）接着往下问别的执行器，
 * 谁都不认才报 `unsupported_tool`。
 */
export function createKolToolExecutor(options: KolToolsOptions): ToolExecutor {
  const actorOf = (request: RunRequest): KolActor => ({
    workspace_id: options.workspace_id,
    person_id: request.actor.person_id,
    assignment_id: request.actor.assignment_id,
    role_id: request.actor.role_id,
  })

  return async ({ name, input, request }): Promise<ToolExecution> => {
    const bare = name.includes('.') ? name.slice(name.indexOf('.') + 1) : name
    if (!KOL_TOOL_NAMES.includes(bare)) {
      return { status: 'error', reason: `not_a_kol_tool:${bare}` }
    }
    const port = options.port()
    if (port === undefined) {
      return { status: 'error', reason: '这个进程没装红人那一摊，工具用不了。' }
    }
    const actor = actorOf(request)
    // 这条职责自己的渠道；`kol.*` 之外的职责调红人工具一律拒（越权的那一半由 scope 管，
    // 这一句管的是「这个工具对这条职责有没有意义」）
    const own = kolChannelOfRole(request.actor.role_id)
    if (own === undefined) {
      return {
        status: 'blocked',
        reason: `${request.actor.role_id} 不是红人职责，用不了这个工具。`,
      }
    }
    const channel = channelOf(input.channel, own)

    switch (bare) {
      case 'search_creators': {
        const q = str(input.q) ?? channel
        const limit = num(input.limit)
        const res = await port.search(actor, {
          channel,
          q,
          ...(limit === undefined ? {} : { limit }),
        })
        if (res.ok) {
          return {
            ...rowsOf(res.rows, 'creator'),
            data: { rows: res.rows, object: 'creator', source: res.source },
          }
        }
        /*
         * 66 断点 #4：**没连这条渠道不等于找不了人。**
         *
         * 职责 yml 自己写着「没连也能用——找人靠导入你手上那张表与公共红人库」，
         * 可这条路以前只回一句「去连接页连上」就停了。现在退到**本地红人库**
         * （导入进来的那张表 + 以前搜过存下来的人）——它是真有数据的一层，
         * 不是安慰剂。公共库那一档要等 WP116 真接上，接上之后 `port.search`
         * 自己就会回 `ok`，这里一行都不用改。
         */
        if (res.reason === 'not_connected') {
          const local = await port.creators(actor, {
            channel,
            q,
            ...(limit === undefined ? {} : { limit }),
          })
          return {
            ...rowsOf(local.rows, 'creator'),
            data: {
              rows: local.rows,
              object: 'creator',
              source: 'local_library',
              note: `${channel} 还没连上，这一份是你自己库里的人（导入或以前存下来的）。连上之后能搜到更多。`,
            },
          }
        }
        return { status: 'error', reason: res.message ?? res.reason ?? '这条渠道这次没答上来。' }
      }

      case 'get_creator': {
        const id = str(input.creator_id)
        if (id === undefined) return missing('creator_id')
        const detail = await port.creator(actor, id)
        if (detail === undefined) {
          return { status: 'error', reason: `红人库里没有 ${id} 这一条。` }
        }
        return { status: 'ok', data: detail, provenance: [{ type: 'creator', id }] }
      }

      case 'score_creator': {
        const id = str(input.creator_id)
        if (id === undefined) return missing('creator_id')
        const detail = await port.creator(actor, id)
        if (detail === undefined) {
          return { status: 'error', reason: `红人库里没有 ${id} 这一条。` }
        }
        // 打分是详情里现成的一格（`kol-core` 的 `scoreCreator` 在服务端那一跳已经算过）
        return {
          status: 'ok',
          data: { creator_id: id, accounts: detail.accounts },
          provenance: [{ type: 'creator', id }],
        }
      }

      case 'list_collaborations': {
        const stage = STAGES.find((s) => s === input.stage)
        const res = await port.collaborations(actor, {
          channel,
          ...(stage === undefined ? {} : { stage }),
        })
        return rowsOf(res.rows, 'collaboration')
      }

      case 'list_deliverables': {
        const res = await port.deliverables(actor, {
          ...(str(input.collaboration_id) === undefined
            ? {}
            : { collaboration_id: str(input.collaboration_id) }),
          ...(input.pending === true ? { pending: true } : {}),
        })
        return rowsOf(res.rows, 'deliverable')
      }

      case 'add_to_campaign': {
        const ids = Array.isArray(input.creator_ids)
          ? input.creator_ids.filter((v): v is string => typeof v === 'string')
          : []
        if (ids.length === 0) return missing('creator_ids')
        /*
         * 「进候选池」走的是 campaign 向导（`planCampaign`）：它出的是一张清单卡，
         * 人点「接受」才真建合作。**不直接建合作**——48 §5.1 的 `stage_collaboration`
         * 永远 L1，一个工具调用不该替人点头。
         */
        const view = await port.planCampaign(actor, {
          goal: str(input.campaign) ?? str(input.product) ?? '新品建联',
          budget: num(input.budget) ?? 0,
          channels: [channel],
          headcount: ids.length,
        })
        const picks = view.by_channel.flatMap((g) => g.picks)
        return {
          status: 'ok',
          data: {
            kind: 'kol_campaign',
            ...(view.approval_item_id === undefined
              ? {}
              : { approval_item_id: view.approval_item_id }),
            rows: picks,
            object: 'creator',
            ready: view.ready,
            ...(view.message === '' ? {} : { message: view.message }),
          },
        }
      }

      case 'draft_outreach': {
        const creator_id = str(input.creator_id)
        if (creator_id === undefined) return missing('creator_id')
        const step = (['first', 'follow_up', 'final'] as const).find((s) => s === input.step)
        const view = await port.outreach(actor, {
          creator_id,
          channel,
          ...(step === undefined ? {} : { step }),
          product: str(input.product) ?? '我们的产品',
          ...(str(input.reason) === undefined ? {} : { reason: str(input.reason) }),
        })
        return stagedOf(view, 'kol_outreach', {
          subject: view.subject,
          forbidden_hits: view.forbidden_hits,
          missing_vars: view.missing_vars,
          quota: view.quota,
        })
      }

      case 'advance_collaboration': {
        const id = str(input.collaboration_id)
        const stage = STAGES.find((s) => s === input.stage)
        if (id === undefined) return missing('collaboration_id')
        if (stage === undefined) {
          return { status: 'error', reason: `不认识「${String(input.stage)}」这个阶段。` }
        }
        try {
          const collab = await port.advanceCollaboration(actor, id, { stage })
          return {
            status: 'ok',
            data: { collaboration_id: id, stage: collab.stage },
            provenance: [{ type: 'collaboration', id }],
          }
        } catch (e) {
          return { status: 'blocked', reason: e instanceof Error ? e.message : String(e) }
        }
      }

      case 'register_deliverable': {
        const collaboration_id = str(input.collaboration_id)
        if (collaboration_id === undefined) return missing('collaboration_id')
        const kind = KINDS.find((k) => k === input.kind) ?? 'video'
        const due_at =
          str(input.due_at) ?? new Date(Date.parse(options.now()) + 7 * 86_400_000).toISOString()
        const row = await port.createDeliverable(actor, {
          collaboration_id,
          kind,
          due_at,
          ...(str(input.url) === undefined ? {} : { url: str(input.url) }),
        })
        return {
          status: 'ok',
          data: { deliverable_id: row.id, kind: row.kind, due_at: row.due_at },
          provenance: [{ type: 'deliverable', id: row.id }],
        }
      }

      case 'review_deliverable': {
        const id = str(input.deliverable_id)
        if (id === undefined) return missing('deliverable_id')
        const review = REVIEWS.find((r) => r === input.review)
        if (review === undefined || review === 'pending') {
          return {
            status: 'error',
            reason: '验收结论只能是 approved / changes_requested / rejected。',
          }
        }
        const view = await port.reviewDeliverable(actor, id, {
          review,
          ...(str(input.notes) === undefined ? {} : { notes: str(input.notes) }),
        })
        return stagedOf(view, 'kol_deliverable_review', { deliverable_id: id, review })
      }

      case 'create_tracked_link': {
        const collaboration_id = str(input.collaboration_id)
        if (collaboration_id === undefined) return missing('collaboration_id')
        const row = await port.createTrackedLink(actor, {
          collaboration_id,
          url: str(input.target_url) ?? str(input.url) ?? 'https://example.com',
          campaign: str(input.campaign) ?? 'kol',
          ...(str(input.discount_code) === undefined
            ? {}
            : { affiliate_code: str(input.discount_code) }),
        })
        return {
          status: 'ok',
          data: { tracked_link_id: row.id, url: row.url, collaboration_id },
          provenance: [{ type: 'tracked_link', id: row.id }],
        }
      }

      default:
        return { status: 'error', reason: `unsupported_tool：${bare}` }
    }
  }
}
