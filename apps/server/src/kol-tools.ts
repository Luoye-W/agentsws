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
import type { ExtensionObservation, KolActor, KolPort } from '@agentsws/api'
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
import { sanitizePublicContacts } from '@agentsws/contracts'
import { KOL_TOOL_NAMES, kolChannelOfRole } from '@agentsws/kol-core'
import type { ToolExecution, ToolExecutor } from '@agentsws/stand-ins'
import type { KolImportAssembly } from './kol-import.js'
import type { KolSync } from './kol-sync/service.js'

export interface KolToolsOptions {
  workspace_id: WorkspaceId
  /** 懒取：红人装配比运行时晚建出来（同 server.ts 里 `work: () => workRef` 那一处）。 */
  port(): KolPort | undefined
  /** WP489：表格导入 / 邮件判阶段（懒取；没装就没有）。 */
  importer?(): KolImportAssembly | undefined
  /** WP509：红人同步到表格（懒取；没装就没有）。 */
  sync?(): Pick<KolSync, 'propose' | 'describe'> | undefined
  /** 现在几点（登记交付物没给 `due_at` 时按「一周后」兜底）。 */
  now(): Iso8601
  /**
   * WP346（决策 872）：模型没给关键词时，按品牌档案里的品类关键词搜（`brandSearchQuery`）。
   * 读不到回 `undefined`（照旧不带关键词）。
   */
  brandQuery?(): string | undefined
  /**
   * WP428（决策 1244 改）：这条岗位开没开「全自动」（够条件后人点了才开）。开着时 AI 可以把合作推进到
   * 「谈成 / 已寄样」；花钱的（报价、寄样成本、付款）照旧出卡、受额度管。不给 = 没开。
   */
  autopilot?(actor: KolActor): boolean
  /**
   * WP483（决策 1661）：浏览器（ego）里读到的红人公开主页数据——和浏览器插件采集的走同一条路
   * （`ExtensionService.ingest`：存进本机红人库 + 登录了云账号就转发到工坊云端的公共红人库）。不给 = 这个工具用不了。
   */
  observe?(
    actor: KolActor,
    observations: ExtensionObservation[],
  ): Promise<{ saved: number; deduped: number; forwarded: number; pending?: number }>
  /**
   * WP496（决策 1738 / 1739 A）：在 ego 里用插件**同一套**采集器读红人页面、走插件同一个入口记下
   * （`ego-read/capture.ts`）。不给 / ego 用不了 = 这个工具回「用不了」，AI 改用 `record_creator_observations`。
   */
  egoCapture?: {
    available(): boolean
    capture(
      actor: KolActor,
      urls: readonly string[],
      options: { record: boolean },
    ): Promise<
      readonly {
        ok: boolean
        /** WP498（1740 B）：主页存入红人池的回执（只有主页有）。 */
        pool?: { saved: true; new: boolean } | { saved: false; why: string }
      }[]
    >
  }
}

/** WP483：一次最多记几个。 */
export const OBSERVE_MAX = 50

/** WP505：一次最多给几个人改标签。 */
export const TAG_MAX_CREATORS = 50

/**
 * WP483（决策 1661）：把 ego 读到的观测交给**插件那一条同样的入口**（`ExtensionPort.ingest`：存本机红人库 +
 * 登录了云账号就转发到工坊云端）。「谁采的」照插件那样记在这个人头上（`person_id`），令牌那一格写 `ego`。
 */
export function observeViaIngest(
  ingest: (
    session: {
      token_id: string
      workspace_id: WorkspaceId
      person_id: string
      extension_id: string
      scopes: string[]
    },
    input: { observations: ExtensionObservation[] },
  ) => Promise<{
    rows: readonly { status: string }[]
    forwarded_to_public_library: number
    public_library_pending?: number
  }>,
): NonNullable<KolToolsOptions['observe']> {
  return async (actor, observations) => {
    const res = await ingest(
      {
        token_id: 'ego',
        workspace_id: actor.workspace_id,
        person_id: actor.person_id,
        extension_id: 'ego',
        scopes: ['kol.observe'],
      },
      { observations },
    )
    return {
      saved: res.rows.filter((r) => r.status === 'ok').length,
      deduped: res.rows.filter((r) => r.status === 'deduped').length,
      forwarded: res.forwarded_to_public_library,
      ...(res.public_library_pending === undefined ? {} : { pending: res.public_library_pending }),
    }
  }
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
  'sample_sent',
  'delivering',
  'delivered',
  'closed',
  'declined',
]

const DAY_MS = 86_400_000

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
 * 十二个红人工具的执行器（WP295 加了 `list_tracked_links`）。
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
      // WP489：在线表格链接 → 预览卡；用过往邮件更新阶段 → 预估卡（两样都是人点了才动库）
      case 'import_creator_sheet': {
        const url = str(input.url)
        if (url === undefined) return missing('表格链接')
        const importer = options.importer?.()
        if (importer === undefined) return { status: 'error', reason: '这个进程没装表格导入。' }
        const message = await importer.previewCard(actor, { filename: url, url })
        return { status: 'ok', data: { kind: 'kol_import_preview', message } }
      }
      // WP509：「把红人同步到我这张飞书表 <链接>」→ 在 ego 里读表头 → 「同步设置」卡（人点了才开始同步）
      case 'sync_creators_to_sheet': {
        const sync = options.sync?.()
        if (sync === undefined) return { status: 'error', reason: '这个进程没装红人同步。' }
        if (input.action === 'status')
          return { status: 'ok', data: { kind: 'kol_sync_status', message: sync.describe() } }
        const url = str(input.url)
        if (url === undefined) return missing('表格链接')
        const what = {
          ...(typeof input.new_creators === 'boolean' ? { new_creators: input.new_creators } : {}),
          ...(typeof input.stages === 'boolean' ? { stages: input.stages } : {}),
          ...(typeof input.collab_records === 'boolean'
            ? { collab_records: input.collab_records }
            : {}),
        }
        const cadence = (['realtime', 'hourly', 'daily'] as const).find((c) => c === input.cadence)
        const hints = Array.isArray(input.columns)
          ? input.columns.flatMap((raw) => {
              const o =
                raw !== null && typeof raw === 'object' ? (raw as Record<string, unknown>) : {}
              return typeof o.column === 'string' ? [{ column: o.column, field: o.field }] : []
            })
          : []
        const got = await sync.propose(actor, {
          url,
          ...(str(input.instruction) === undefined
            ? {}
            : { instruction: str(input.instruction) as string }),
          what,
          ...(cadence === undefined ? {} : { cadence }),
          hints,
        })
        return {
          status: 'ok',
          data: {
            kind: 'kol_sync_setup',
            ok: got.ok,
            message: got.message,
            ...(got.card_id === undefined ? {} : { approval_item_id: got.card_id }),
          },
        }
      }
      case 'update_stages_from_mail': {
        const importer = options.importer?.()
        if (importer === undefined) return { status: 'error', reason: '这个进程没装邮件判阶段。' }
        const months = num(input.months)
        const message = await importer.mailStageCard(actor, {
          ...(months === undefined
            ? {}
            : { months: Math.max(1, Math.min(60, Math.round(months))) }),
        })
        return { status: 'ok', data: { kind: 'kol_mail_stage_estimate', message } }
      }
      case 'search_creators': {
        /*
         * WP117b（66 复测 #15）：**关键词可以是空的，粉丝区间不能丢。**
         *
         * 以前这里是 `str(input.q) ?? channel`——模型没给关键词时拿渠道名当关键词，
         * 于是"找粉丝 1 万到 10 万的 YouTube 频道"变成"找名字里带 youtube 的人"，
         * 库里那两个 48,000 / 31,000 粉的频道一个都搜不出来。现在没关键词就是
         * 没关键词（这条渠道上的人都算候选），筛人交给粉丝区间。
         */
        // WP346：模型没给关键词 → 先读品牌档案（品类关键词）；读不到照旧不带关键词
        const asked = str(input.q)
        const fromProfile = asked === undefined ? options.brandQuery?.() : undefined
        const q = asked ?? fromProfile
        const limit = num(input.limit)
        const min_followers = num(input.min_followers)
        const max_followers = num(input.max_followers)
        const band = {
          ...(min_followers === undefined ? {} : { min_followers }),
          ...(max_followers === undefined ? {} : { max_followers }),
        }
        /*
         * WP502（决策 1763 B）：按人工标签 / 审核决定筛——这两样只有自己的红人池里有，直接查本机库
         * （不去渠道上搜、不花积分）。
         */
        const tag = str(input.tag)
        const review = (['approved', 'rejected', 'pending'] as const).find(
          (r) => r === input.review,
        )
        if (tag !== undefined || review !== undefined) {
          const local = await port.creators(actor, {
            channel,
            ...(asked === undefined ? {} : { q: asked }),
            ...(limit === undefined ? {} : { limit }),
            ...band,
            ...(tag === undefined ? {} : { tag }),
            ...(review === undefined ? {} : { review }),
          })
          const cond = [
            tag === undefined ? undefined : `标签「${tag}」`,
            review === undefined
              ? undefined
              : { approved: '已通过', rejected: '已淘汰', pending: '还没审' }[review],
          ].filter((x): x is string => x !== undefined)
          return {
            ...rowsOf(local.rows, 'creator'),
            data: {
              rows: local.rows,
              object: 'creator',
              source: 'local_library',
              criteria: cond.join(' · '),
              ...(local.tags === undefined ? {} : { tags_in_pool: local.tags }),
            },
          }
        }
        const searchWith = (query: string) =>
          port.search(actor, {
            channel,
            q: query,
            ...(limit === undefined ? {} : { limit }),
            ...band,
            // WP126：上一级报错后，用户点了"改用官方接口"重发的那一次
            ...(input.fallback === 'workshop' ? { fallback: 'workshop' as const } : {}),
          })
        let res = await searchWith(q ?? '')
        // 档案关键词一个都没搜到：退回不带关键词（与 WP117b 以前的行为一样，不让档案把人筛没了）
        let profileUsed = fromProfile !== undefined
        if (profileUsed && res.ok && res.rows.length === 0) {
          res = await searchWith('')
          profileUsed = false
        }
        if (res.ok) {
          return {
            ...rowsOf(res.rows, 'creator'),
            data: {
              rows: res.rows,
              object: 'creator',
              source: res.source,
              ...(res.source_label === undefined ? {} : { source_label: res.source_label }),
              ...(profileUsed ? { criteria: `关键词「${fromProfile}」（品牌档案）` } : {}),
            },
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
        /*
         * WP416（自查 kol A3）：只能按账号查（关键词找人走插件 / 公共库）、上游这次没答上来、配额用完——
         * 一样退回本地库，并照实说为什么（以前 AI 直接拿到一句报错）。
         */
        const fellBack =
          res.reason === 'handle_only' ||
          res.reason === 'upstream_error' ||
          res.reason === 'quota_exhausted'
        if (res.reason === 'not_connected' || res.reason === 'no_data_source' || fellBack) {
          const local = await port.creators(actor, {
            channel,
            ...(q === undefined ? {} : { q }),
            ...(limit === undefined ? {} : { limit }),
            ...band,
          })
          const cond = [
            q === undefined ? undefined : `关键词「${q}」`,
            min_followers === undefined && max_followers === undefined
              ? undefined
              : `粉丝 ${(min_followers ?? 0).toLocaleString('en-US')}–${max_followers === undefined ? '不限' : max_followers.toLocaleString('en-US')}`,
          ].filter((s): s is string => s !== undefined)
          return {
            ...rowsOf(local.rows, 'creator'),
            data: {
              rows: local.rows,
              object: 'creator',
              source: 'local_library',
              ...(cond.length === 0 ? {} : { criteria: cond.join(' · ') }),
              note: fellBack
                ? `${res.message ?? `${channel} 这次没搜成。`} 下面是你自己库里的人（导入、插件收录或以前存下来的${cond.length === 0 ? '' : `，按 ${cond.join(' · ')} 筛过`}）。`
                : `${channel} 还没连上，这一份是你自己库里的人（导入或以前存下来的${cond.length === 0 ? '' : `，按 ${cond.join(' · ')} 筛过`}）。连上之后能搜到更多。`,
            },
          }
        }
        // WP251（决策 91）：「没连上」带上机器码开头——运行时据此在这一轮上记结构化的「卡住了」
        if (res.reason === 'not_connected')
          return {
            status: 'error',
            reason: `not_connected：${res.message ?? `${channel} 还没连上。`}`,
          }
        // WP334（决策 726）：工坊账号没关联——带上机器码，运行时出连接卡（卡里就地关联）
        if (res.reason === 'not_linked')
          return {
            status: 'error',
            reason: `not_linked：${res.message ?? '还没关联 Agents 工坊账号。'}`,
          }
        return { status: 'error', reason: res.message ?? res.reason ?? '这条渠道这次没答上来。' }
      }

      /*
       * WP416（自查 kol A「搜到的新人接后续动作」）：搜出来的人收进库——以前搜到的人没有 creator_id，
       * 接不上 get_creator / draft_outreach，AI 只能对库里原有的人做事。不花钱、不出卡（同 POST /v1/kol/creators）。
       */
      case 'save_creator': {
        const handle = str(input.handle)
        if (handle === undefined) return missing('handle')
        try {
          const detail = await port.createCreator(actor, {
            channel,
            handle,
            display_name: str(input.display_name) ?? handle.replace(/^@/, ''),
            ...(str(input.url) === undefined ? {} : { url: str(input.url) }),
            ...(num(input.followers) === undefined ? {} : { followers: num(input.followers) }),
            ...(str(input.category) === undefined ? {} : { category: str(input.category) }),
            ...(str(input.language) === undefined ? {} : { language: str(input.language) }),
            ...(str(input.region) === undefined ? {} : { region: str(input.region) }),
          })
          return {
            status: 'ok',
            data: {
              creator_id: detail.creator.id,
              display_name: detail.creator.display_name,
              has_contact: detail.contacts.length > 0,
            },
            provenance: [{ type: 'creator', id: detail.creator.id }],
          }
        } catch (e) {
          return { status: 'error', reason: e instanceof Error ? e.message : String(e) }
        }
      }

      /*
       * WP483（决策 1661）：浏览器（ego）里读到的公开主页数据 → 和插件同一条路（本机 + 云端备份）。
       * 只收白名单那几格；私信、账号凭据一格都没有。WP487：加上主页上公开的联系方式（过 `sanitizePublicContacts`）。
       */
      /*
       * WP496（决策 1738 / 1739 A）：ego 打开页面、插件同一套采集器读数、插件同一个入口记下。
       * AI 只给地址；数字一个都不经 AI 的手。
       */
      case 'capture_creator_pages': {
        const cap = options.egoCapture
        if (cap === undefined || !cap.available())
          return {
            status: 'error',
            reason:
              'ego 浏览器这会儿用不了（没装好、没打开或没选用）：读不了页面。要记就用 record_creator_observations 手记，或请人在装了插件的浏览器里打开主页。',
          }
        const raw = Array.isArray(input.urls) ? input.urls : []
        const urls = raw
          .map((u) => (typeof u === 'string' ? u.trim() : ''))
          .filter((u) => /^https:\/\//iu.test(u))
        if (urls.length === 0) return missing('urls（https:// 开头的页面地址）')
        try {
          const record = input.record !== false
          const pages = await cap.capture(actor, urls.slice(0, 10), { record })
          // WP498（1740 B）：读到的红人主页一律存入红人池——存了几个、新增几个，回一句
          const saved = pages.filter((p) => p.pool?.saved === true)
          const fresh = saved.filter((p) => p.pool?.saved === true && p.pool.new).length
          const failed = pages.filter((p) => p.pool?.saved === false).length
          const pool = record
            ? `红人主页存入红人池 ${String(saved.length)} 个（新增 ${String(fresh)} 个，已在池里的 ${String(saved.length - fresh)} 个刷新了资料）${failed > 0 ? `；${String(failed)} 个没存进去（见各页 pool.why）` : ''}。`
            : '只读没记（record: false）：没有存入红人池。'
          return {
            status: 'ok',
            data: {
              rows: pages.length,
              read: pages.filter((p) => p.ok).length,
              pool_saved: saved.length,
              pool_new: fresh,
              summary: pool,
              pages,
              ...(urls.length > 10 ? { note: '一次最多 10 页，后面的没读' } : {}),
            },
          }
        } catch (e) {
          return { status: 'error', reason: e instanceof Error ? e.message : String(e) }
        }
      }

      case 'record_creator_observations': {
        if (options.observe === undefined)
          return { status: 'error', reason: '这个进程没接红人采集那一条路，记不了。' }
        const raw = Array.isArray(input.observations) ? input.observations : []
        const at = options.now()
        const observations: ExtensionObservation[] = []
        for (const one of raw.slice(0, OBSERVE_MAX)) {
          const r = one !== null && typeof one === 'object' ? (one as Record<string, unknown>) : {}
          const handle = str(r.handle)?.trim()
          if (handle === undefined || handle === '') continue
          const count = (v: unknown): number | undefined => {
            const n = num(v)
            return n === undefined || n < 0 ? undefined : Math.round(n)
          }
          const followers = count(r.followers)
          const videos = count(r.video_count)
          const views = count(r.avg_views)
          const url = str(r.url)
          const contacts = sanitizePublicContacts(r.public_contacts)
          observations.push({
            channel,
            handle: channel === 'youtube' ? handle : handle.replace(/^@/u, ''),
            ...(str(r.display_name) === undefined
              ? {}
              : { display_name: str(r.display_name)?.slice(0, 200) }),
            ...(url === undefined || !/^https:\/\//iu.test(url) ? {} : { url, page_url: url }),
            ...(followers === undefined ? {} : { followers }),
            ...(videos === undefined ? {} : { video_count: videos }),
            ...(views === undefined ? {} : { avg_views: views }),
            ...(str(r.country) === undefined ? {} : { country: str(r.country)?.slice(0, 60) }),
            ...(str(r.bio) === undefined ? {} : { bio: str(r.bio)?.slice(0, 1000) }),
            // WP487（1661 补）：主页上公开的联系方式——和插件那条路同一个口子（`ingest` 里再筛一遍）
            ...(contacts.length === 0 ? {} : { public_contacts: contacts }),
            observed_at: at,
            source: 'channel_page',
          })
        }
        if (observations.length === 0) return missing('observations（至少一个 handle）')
        try {
          const res = await options.observe(actor, observations)
          return {
            status: 'ok',
            data: {
              rows: observations.length,
              saved: res.saved,
              deduped: res.deduped,
              backed_up_to_cloud: res.forwarded,
              ...(res.pending === undefined ? {} : { cloud_pending: res.pending }),
              ...(raw.length > OBSERVE_MAX
                ? { note: `一次最多 ${OBSERVE_MAX} 个，后面的没记` }
                : {}),
            },
          }
        } catch (e) {
          return { status: 'error', reason: e instanceof Error ? e.message : String(e) }
        }
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

      /*
       * WP505（决策 1772 B）：AI 打 / 去人工标签。走人点标签的同一个口子（`setCreatorTags`：去空白、不分大小写去重、
       * 每人最多 20 个），所以规整一个字不差；只在原有标签上加减，别的不动。不出卡（标签是归类词，错了人随手改回去）。
       * **审核决定这里一格都不碰**——入参里给了 review / decision 也不认（AI 没有改审核的口子）。
       */
      case 'tag_creators': {
        if (port.setCreatorTags === undefined)
          return { status: 'error', reason: '这一版的红人库还不能改标签。' }
        const ids = [
          ...new Set(
            (Array.isArray(input.creator_ids) ? input.creator_ids : [])
              .map((v) => (typeof v === 'string' ? v.trim() : ''))
              .filter((v) => v !== ''),
          ),
        ]
        if (ids.length === 0) return missing('creator_ids')
        const words = (v: unknown): string[] =>
          (Array.isArray(v) ? v : [])
            .map((w) => (typeof w === 'string' ? w.replace(/\s+/g, ' ').trim() : ''))
            .filter((w) => w !== '')
        const add = words(input.add)
        const remove = new Set(words(input.remove).map((w) => w.toLowerCase()))
        if (add.length === 0 && remove.size === 0) return missing('add 或 remove（至少一个标签）')
        const rows: {
          creator_id: string
          display_name?: string
          tags?: string[]
          error?: string
          dropped?: string[]
        }[] = []
        for (const id of ids.slice(0, TAG_MAX_CREATORS)) {
          const before = await port.creator(actor, id)
          if (before === undefined) {
            rows.push({ creator_id: id, error: `红人库里没有 ${id} 这一条。` })
            continue
          }
          const wanted = [
            ...(before.tags ?? []).filter((t) => !remove.has(t.toLowerCase())),
            ...add.filter((t) => !remove.has(t.toLowerCase())),
          ]
          try {
            const after = await port.setCreatorTags(actor, id, { tags: wanted })
            const kept = new Set((after.tags ?? []).map((t) => t.toLowerCase()))
            const dropped = add.filter(
              (t) => !remove.has(t.toLowerCase()) && !kept.has(t.toLowerCase()),
            )
            rows.push({
              creator_id: id,
              display_name: after.creator.display_name,
              tags: after.tags ?? [],
              ...(dropped.length === 0 ? {} : { dropped }),
            })
          } catch (e) {
            rows.push({ creator_id: id, error: e instanceof Error ? e.message : String(e) })
          }
        }
        const done = rows.filter((r) => r.error === undefined)
        const anyDropped = done.some((r) => r.dropped !== undefined)
        if (done.length === 0)
          return { status: 'error', reason: rows[0]?.error ?? '一个都没改成。' }
        return {
          status: 'ok',
          data: {
            rows: done.length,
            creators: rows,
            summary: `改了 ${String(done.length)} 个人的标签${rows.length > done.length ? `，${String(rows.length - done.length)} 个没改成（见 error）` : ''}${anyDropped ? '；有的人标签满了（每人最多 20 个），没加上的见 dropped' : ''}。审核决定没动。`,
            ...(ids.length > TAG_MAX_CREATORS
              ? { note: `一次最多 ${String(TAG_MAX_CREATORS)} 个，后面的没改` }
              : {}),
          },
          provenance: done.map((r) => ({ type: 'creator', id: r.creator_id })),
        }
      }

      case 'score_creator': {
        const id = str(input.creator_id)
        if (id === undefined) return missing('creator_id')
        const detail = await port.creator(actor, id)
        if (detail === undefined) {
          return { status: 'error', reason: `红人库里没有 ${id} 这一条。` }
        }
        // 打分是详情里现成的一格（`kol-core` 的 `scoreCreator` 在服务端那一跳已经算过）。
        // WP299：以前只回账号、不回分——模型说不出「为什么是这个分」；现在五项各拿多少、为什么都在
        return {
          status: 'ok',
          data: {
            creator_id: id,
            accounts: detail.accounts,
            ...(detail.scores === undefined ? {} : { scores: detail.scores }),
          },
          provenance: [{ type: 'creator', id }],
        }
      }

      case 'list_collaborations': {
        const stage = STAGES.find((s) => s === input.stage)
        const quietDays = num(input.quiet_days)
        const res = await port.collaborations(actor, {
          channel,
          ...(quietDays !== undefined ? { stage: 'contacted' as const } : {}),
          ...(stage === undefined || quietDays !== undefined ? {} : { stage }),
        })
        /*
         * WP295：每行带上**红人名字**与「发出去几天没动静」。以前只有 `creator_id`——模型要答
         * 「谁还没回」得再一个一个 get_creator，岗位页那句快捷提示答出来的是「看合作清单：26 条」。
         * `quiet_days` 给了就只要「已建联、这么多天没动静」的（没记下时间的也算上，不知道 ≠ 回过）。
         */
        const names = new Map(
          (await port.creators(actor, { channel })).rows.map((r) => [r.creator_id, r.display_name]),
        )
        const now = Date.parse(options.now())
        const rows = res.rows
          .map((c) => {
            const at =
              c.last_activity_at === undefined ? Number.NaN : Date.parse(c.last_activity_at)
            const days = Number.isFinite(at) ? Math.floor((now - at) / DAY_MS) : undefined
            return {
              ...c,
              display_name: names.get(c.creator_id) ?? c.creator_id,
              ...(days === undefined ? {} : { days_since_activity: days }),
            }
          })
          .filter(
            (c) =>
              quietDays === undefined ||
              c.days_since_activity === undefined ||
              c.days_since_activity >= quietDays,
          )
        return rowsOf(rows, 'collaboration')
      }

      case 'list_tracked_links': {
        /*
         * WP295：归因那张表给模型读。只要这条渠道的合作上的链接（名字从红人库拼），按收入倒序；
         * 这条渠道上还没建链接的合作单列一格——「没带来订单」与「算不出来」是两回事。
         */
        const only = str(input.collaboration_id)
        const collabs = (await port.collaborations(actor, { channel })).rows
        const byId = new Map(collabs.map((c) => [c.id, c]))
        const names = new Map(
          (await port.creators(actor, { channel })).rows.map((r) => [r.creator_id, r.display_name]),
        )
        const nameOf = (collaboration_id: string): string => {
          const c = byId.get(collaboration_id)
          return c === undefined ? collaboration_id : (names.get(c.creator_id) ?? c.creator_id)
        }
        const links = (
          await port.trackedLinks(actor, only === undefined ? {} : { collaboration_id: only })
        ).rows.filter((l) => byId.has(l.collaboration_id))
        const rows = links
          .map((l) => ({
            id: l.id,
            collaboration_id: l.collaboration_id,
            display_name: nameOf(l.collaboration_id),
            url: l.url,
            ...(l.affiliate_code === undefined ? {} : { affiliate_code: l.affiliate_code }),
            clicks: l.clicks,
            orders: l.orders,
            revenue: l.revenue,
          }))
          .sort((a, b) => b.revenue - a.revenue)
        const linked = new Set(links.map((l) => l.collaboration_id))
        const without_link = collabs
          .filter(
            (c) =>
              (only === undefined || c.id === only) &&
              !linked.has(c.id) &&
              ['agreed', 'sample_sent', 'delivering', 'delivered', 'closed'].includes(c.stage),
          )
          .map((c) => nameOf(c.id))
        const out = rowsOf(rows, 'tracked_link')
        return {
          ...out,
          data: { rows, object: 'tracked_link', without_link },
        }
      }

      case 'list_deliverables': {
        const res = await port.deliverables(actor, {
          ...(str(input.collaboration_id) === undefined
            ? {}
            : { collaboration_id: str(input.collaboration_id) }),
          ...(input.pending === true ? { pending: true } : {}),
        })
        /*
         * WP295：每行带上是谁交的（以前只有 `collaboration_id`，「审一条稿」答出来是「看交付物：2 条」）。
         * 认得出合作的才带名字；别的渠道的交付物不在这条职责的清单里。
         */
        const collabs = new Map(
          (await port.collaborations(actor, { channel })).rows.map((c) => [c.id, c]),
        )
        const names = new Map(
          (await port.creators(actor, { channel })).rows.map((r) => [r.creator_id, r.display_name]),
        )
        const rows = res.rows
          .filter((d) => collabs.has(d.collaboration_id))
          .map((d) => {
            const c = collabs.get(d.collaboration_id)
            const name = c === undefined ? undefined : names.get(c.creator_id)
            return name === undefined ? d : { ...d, display_name: name }
          })
        return rowsOf(rows, 'deliverable')
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
          // WP416：没给预算由服务端按职责的合作预算上限起一个数；名单就是 AI 给的这几个
          budget: num(input.budget) ?? 0,
          channels: [channel],
          headcount: ids.length,
          creator_ids: ids,
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
        /*
         * WP416（决策 531）：产品不给就用存过的默认；「一句话介绍我们」不给由服务端从品牌档案补，
         * AI 给了就用 AI 写的（卡上标出来让人看）。
         */
        const defaults = await port.outreachDefaults?.(actor)
        const product =
          str(input.product) ??
          (defaults?.product === undefined || defaults.product === ''
            ? undefined
            : defaults.product)
        // 品牌这边已经有那一句（存过的 / 品牌档案）就用它，AI 写的只在都没有时补上
        const pitch =
          defaults !== undefined && defaults.brand_pitch !== '' ? undefined : str(input.brand_pitch)
        const view = await port.outreach(actor, {
          creator_id,
          channel,
          ...(step === undefined ? {} : { step }),
          product: product ?? '我们的产品',
          ...(str(input.reason) === undefined ? {} : { reason: str(input.reason) }),
          ...(pitch === undefined ? {} : { brand_pitch: pitch, pitch_by_ai: true }),
        })
        return stagedOf(view, 'kol_outreach', {
          subject: view.subject,
          forbidden_hits: view.forbidden_hits,
          missing_vars: view.missing_vars,
          quota: view.quota,
          // WP416：没连发信邮箱——运行时据此在对话里就地出一张连接卡（决策 690）
          ...(view.needs_mailbox === true
            ? {
                needs_mailbox: true,
                note: '卡出了，但还没连发信邮箱：批了也发不出去。先连上邮箱。',
              }
            : {}),
        })
      }

      case 'advance_collaboration': {
        const id = str(input.collaboration_id)
        const stage = STAGES.find((s) => s === input.stage)
        if (id === undefined) return missing('collaboration_id')
        if (stage === undefined) {
          return { status: 'error', reason: `不认识「${String(input.stage)}」这个阶段。` }
        }
        /*
         * WP416（自查 kol A「advance_collaboration」）：「谈成」「已寄样」不许 AI 直接写库——
         * 谈成要人点头（议价 / 建合作那张卡），已寄样要有寄样记录（寄样那一步，有成本还要出花钱卡）。
         * WP428（决策 1244 改）：这条岗位开了全自动（最近 N 张同类卡都原样批了、出过建议卡、人点了开）
         * 才放行这两步；花钱的仍走卡、受额度管。
         */
        const auto = options.autopilot?.(actor) === true
        if ((stage === 'agreed' || stage === 'sample_sent') && !auto) {
          return {
            status: 'blocked',
            reason:
              stage === 'agreed'
                ? '「谈成」要人点头：报价走议价那张卡，批了才算谈成。不能直接推。'
                : '「已寄样」要有寄样记录：在合作线程上记一笔寄样（有成本会出花钱卡），记了才算。不能直接推。',
          }
        }
        try {
          const collab = await port.advanceCollaboration(actor, id, { stage })
          const byAutopilot = auto && (stage === 'agreed' || stage === 'sample_sent')
          return {
            status: 'ok',
            data: {
              collaboration_id: id,
              stage: collab.stage,
              // WP428：全自动推的这一步，回执里照实说（花钱的另走卡）
              ...(byAutopilot
                ? {
                    autopilot: true,
                    note: '全自动：已推进。花钱的（报价、寄样成本、付款）照旧出卡、受额度管。',
                  }
                : {}),
            },
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
        const target = str(input.target_url) ?? str(input.url)
        if (target === undefined)
          return {
            status: 'error',
            reason: '缺落地页地址：这条链接要指到哪一页（商品页 / 活动页）？先问人，不要编一个。',
          }
        const row = await port.createTrackedLink(actor, {
          collaboration_id,
          // WP416（自查 kol A「create_tracked_link」）：没给落地页就问，不默认 example.com
          url: target,
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
