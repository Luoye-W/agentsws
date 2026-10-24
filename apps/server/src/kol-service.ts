/**
 * WP68（48 §5.4）：红人库 `/v1/kol/*` 的**实现**（网关那一层只做装配与校验）。
 *
 * WP67 留下的洞是"红人库没有门"：六张表在那里，面板读得到，可是工作台上
 * 加一个红人、写一条联系方式、推进一个阶段、下一个审核结论，一条路都没有。
 * 这个文件把这些路补齐，并且把三件本来只是注释的纪律变成真的代码：
 *
 * 1. **联系方式真进加密库。** `value_ref` 不再是"谁写谁编的一个名字"——
 *    `POST …/contacts` 收到明文的那一瞬间就 `secrets.put('kol.contact.<id>', …)`，
 *    然后明文在这个进程里再也不出现。读回来的是 {@link maskContact} 那个脱敏形态
 *    （`a***@x.com`）：够人认出是哪个邮箱，不足以拿去发信。真要发信，
 *    是执行器在起草那一步自己去加密库取——那一跳有 Run、有 provenance、有审批。
 * 2. **合并建议真的摆到人面前。** `kol-core` 的 `suggestMerges` 一直没有调用方；
 *    这里把它接上：出建议 → 每条建议进一张 14 四段式卡（`staged_change` 不合适——
 *    合并不是"改一个字段"，它是一次结构性的决定，所以用 `policy_change` 那一类
 *    的建议卡形状：选择题 + 证据 + 影响）→ 人点"合"才真合。
 * 3. **审核结论走变更账本。** `POST …/review` 提的是 `kol_deliverable_review`
 *    这条 staged change（L2 起，采纳率够了升级），不是直接改库的一行。
 *
 * 纪律：这个文件里**没有**第二份判据。分是 `kol-core` 的 `scoreCreator` 算的、
 * 阶段迁移表是 `stages.ts` 那一份、合并判据是 `merge.ts` 那一份、导入的列映射
 * 是 `import.ts` 那一份。这里只负责把它们接到库、加密库与审批总线上。
 */

import type {
  KolCampaignAcceptView,
  KolCampaignGroup,
  KolCampaignPick,
  KolCampaignView,
  KolCollaborationRow,
  KolContactView,
  KolCreatorChecksView,
  KolCreatorDetail,
  KolCreatorProfileView,
  KolCreatorReviewView,
  KolCreatorRow,
  KolImportView,
  KolMergeSuggestionView,
  KolOutreachDefaultsView,
  KolOutreachView,
  KolPort,
  KolSearchHit,
  KolSearchResult,
  KolStagedView,
} from '@agentsws/api'
import { ApiError, KOL_TAG_MAX_LENGTH, KOL_TAGS_MAX } from '@agentsws/api'
import type {
  ApprovalBus,
  Assignment,
  AssignmentId,
  ChangeKind,
  Clock,
  Collaboration,
  CollaborationStage,
  Creator,
  CreatorContact,
  DataSourceLevel,
  DataSourceRoute,
  Deliverable,
  EffectiveConfig,
  EventEnvelope,
  Iso8601,
  KolChannel,
  KolPayment,
  KolSample,
  KolUtm,
  Mandate,
  MaybePromise,
  ObjectRef,
  PersonId,
  PlatformAccount,
  ProvenanceState,
  StagedChange,
  TrackedLink,
  WorkspaceId,
} from '@agentsws/contracts'
import { DEFAULT_DATA_SOURCE_ORDER } from '@agentsws/contracts'
import { suppressionKey } from '@agentsws/core'
import {
  advanceCollaboration,
  advanceDeliverable,
  affiliateCode,
  applyUtm,
  brandScoreCriteria,
  buildUtm,
  type CampaignBrief,
  collaborationStageName,
  collabStatus,
  deliverableReviewName,
  draftOutreach,
  dwellDays,
  hasCjk,
  type ImportedAccount,
  importAccounts,
  importSummary,
  isStageStalled,
  judgeEngagement,
  type MergeProfile,
  nextInSequence,
  normalizeHandle,
  type OutreachLanguage,
  type OutreachStep,
  outreachLanguageOf,
  outreachQuota,
  outreachReason,
  type PublicCreatorRow,
  type PublicLibraryClient,
  parseCreatorUrl,
  planCampaign,
  rankCreators,
  roleIdOfChannel,
  type ScoreCriteria,
  StageTransitionError,
  scoreCreator,
  stageSegments,
  suggestMerges,
} from '@agentsws/kol-core'
import type { StageInput, StageOutcome } from '@agentsws/txn'
import type {
  KolAccountObservation,
  KolCreatorReviewRow,
  KolCreatorTagRow,
  KolStore,
} from './kol.js'
import {
  type ByoEndpointConfig,
  type ByoSourceStore,
  byoSearch,
  byoSecretId,
  byoTestConnection,
} from './kol-byo.js'
import type { KolChannelsAssembly } from './kol-channels.js'
import { creatorChecksOf } from './kol-checks.js'
import type { KolMediaCache } from './kol-media.js'
import {
  maskAddress,
  PAYMENT_STAGES,
  SAMPLE_SECRET_FIELD,
  SAMPLE_SECRET_PREFIX,
  SAMPLE_STAGES,
  withSample,
} from './kol-money.js'
import { REVEAL_CAPABILITY } from './kol-public-client.js'
import type { SecretStore } from './secret-store.js'

/** 加密库里联系方式那一段的 key 前缀。**全仓只有这一处拼它**。 */
export const CONTACT_SECRET_PREFIX = 'kol.contact.'

/** 联系方式在加密库那条记录里的字段名。 */
export const CONTACT_SECRET_FIELD = 'value'

/** `creator_contact` 的 `value_ref`：加密库里的 key 名，不是地址本身。 */
export const contactSecretId = (contact_id: string): string =>
  `${CONTACT_SECRET_PREFIX}${contact_id}`

/**
 * 脱敏：`jonas@example.com` → `j***@example.com`；私信 / 表单地址只留尾巴。
 *
 * 为什么留域名而不是整条打码：人要在清单上认出"这是他那个 gmail 还是公司邮箱"。
 * 只留一个首字母 + 完整域名，认得出来，也拼不回去。
 */
export function maskContact(value: string): string {
  const text = value.trim()
  if (text === '') return ''
  const at = text.indexOf('@')
  if (at > 0) {
    const local = text.slice(0, at)
    const domain = text.slice(at + 1)
    return `${local.slice(0, 1)}***@${domain}`
  }
  // 私信链接 / 合作表单：只露最后一段（`instagram.com/xxx` 里的 xxx）
  if (text.length <= 4) return `${text.slice(0, 1)}***`
  return `${text.slice(0, 2)}***${text.slice(-3)}`
}

/** 合并建议的 id 是**算出来的**，不落第二张表（见文件头第 2 条的理由）。 */
export const mergeSuggestionId = (keep_id: string, merge_id: string): string =>
  `kms_${keep_id}__${merge_id}`

export function parseMergeSuggestionId(
  id: string,
): { keep_id: string; merge_id: string } | undefined {
  if (!id.startsWith('kms_')) return undefined
  const rest = id.slice('kms_'.length)
  const sep = rest.indexOf('__')
  if (sep <= 0) return undefined
  const keep_id = rest.slice(0, sep)
  const merge_id = rest.slice(sep + 2)
  if (keep_id === '' || merge_id === '') return undefined
  return { keep_id, merge_id }
}

/**
 * 一个极小的 CSV / TSV 解析器（RFC 4180 的那几条：引号、转义引号、引号里的换行）。
 *
 * 为什么自己写而不是装一个库：这个仓库的 pnpm 里没有 `exceljs` 之类的表格依赖，
 * 而为"把一张列表读成二维数组"引一棵依赖树不划算。**xlsx 这一版没做**——
 * 它是一个 zip 包，认真解要一个真库；这里照实说，不做半个（见 {@link readTable}）。
 */
export function parseDelimited(text: string, delimiter: string): string[][] {
  const rows: string[][] = []
  let row: string[] = []
  let cell = ''
  let quoted = false
  // BOM：Excel 导出的 CSV 十有八九带它，不去掉的话第一列表头永远认不出来
  const src = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text
  for (let i = 0; i < src.length; i += 1) {
    const ch = src[i] as string
    if (quoted) {
      if (ch === '"') {
        if (src[i + 1] === '"') {
          cell += '"'
          i += 1
        } else quoted = false
      } else cell += ch
      continue
    }
    if (ch === '"') {
      quoted = true
      continue
    }
    if (ch === delimiter) {
      row.push(cell)
      cell = ''
      continue
    }
    if (ch === '\r') continue
    if (ch === '\n') {
      row.push(cell)
      rows.push(row)
      row = []
      cell = ''
      continue
    }
    cell += ch
  }
  if (cell !== '' || row.length > 0) {
    row.push(cell)
    rows.push(row)
  }
  return rows
}

/** 分隔符按表头那一行猜：制表符比逗号多就是 TSV。 */
export function readTable(content: string): string[][] {
  const firstLine = content.split(/\r?\n/, 1)[0] ?? ''
  const tabs = (firstLine.match(/\t/g) ?? []).length
  const commas = (firstLine.match(/,/g) ?? []).length
  const semis = (firstLine.match(/;/g) ?? []).length
  const delimiter = tabs > commas && tabs > semis ? '\t' : semis > commas ? ';' : ','
  return parseDelimited(content, delimiter)
}

/** 这一版能认的表格格式。 */
export const SUPPORTED_IMPORT_EXTENSIONS = ['.csv', '.tsv', '.txt'] as const

/** xlsx 那句人话（36 §3：做不到就说做不到，不做半个）。 */
export const XLSX_NOTE =
  '这一版只认 CSV / TSV。收到 .xlsx 的话，在 Excel 或 Numbers 里「另存为 CSV」再传一次——' +
  'xlsx 是一个压缩包，认真解它要一棵新的依赖树，与其做半个不如先说清楚。'

/** 服务端要的那几件东西。 */
export interface KolServiceOptions {
  workspace_id: WorkspaceId
  store: KolStore
  /** 这个品牌自己那一段加密库（key 名已按品牌加过前缀）。 */
  secrets: SecretStore
  clock: Clock
  approvals: ApprovalBus
  /**
   * 15 §5 变更账本的 stage / list 口。
   *
   * `list` 是日配额与序列跟进用的：**"今天发了几封"与"这个人发到第几封了"都只有
   * 账本知道**——另记一张表就是第二本账，两本账必然对不上。
   */
  ledger: {
    stage(input: StageInput): Promise<StageOutcome>
    list(filter: { workspace_id: WorkspaceId; kind?: ChangeKind }): Promise<StagedChange[]>
  }
  /** 05 §4 生效配置：额度与等级从本次那条分配来。 */
  effectiveConfig(id: AssignmentId): EffectiveConfig
  appendEvent(e: Omit<EventEnvelope, 'id' | 'at'> & { at?: string }): void
  random(): number
  /**
   * WP502（决策 1760 B）：存入红人池时缓存到本机的红人图片（`kol-media.ts`）。详情 / 候选池据此给同源地址，
   * `GET /v1/kol/media/:id` 据此回字节。不给 = 没有图（界面照旧一个字的头像、色块封面）。
   */
  media?: Pick<KolMediaCache, 'localUrlOf' | 'read'> | undefined
  /**
   * 五条渠道的适配器（WP68）。不给的话"去渠道上找人"那一条照实说没装配——
   * 其余的路（导入、公共库、建联、合作、审核、归因）一条都不少。
   */
  channels?: KolChannelsAssembly
  /**
   * 云端公共红人库的客户端（49 M2「用 agentsws 的」那一档）。
   *
   * 不给 = 这台机器永远走"用我的"。这不是降级——本地档（免费）用户拿到的
   * 就是它，而那是正确行为（`kol-core` 的 `public-library.ts` 文件头第 2 条）。
   */
  publicLibrary?: PublicLibraryClient
  /**
   * 49 M2 的那个开关：这项能力用我的还是用 agentsws 的。
   *
   * 键是 `kol.<channel>`（连接页那五张卡上各一个开关）。不给就一律"用我的"——
   * 默认是本地优先（40 §1），把"默认"也写进设置文件是另一回事（见 `cloud.ts`）。
   *
   * WP126：这一个开关仍是权威——显式拨到 `agentsws` 时官方数据接口排到最前。
   * 更细的顺序 / 开关在 {@link dataSourceRoute} 那张表上。
   */
  capabilitySource?(capability: string): 'mine' | 'agentsws'
  /**
   * WP126 数据接口路由：这个渠道的层级顺序与被关掉的那几级。
   * 不给就用 `DEFAULT_DATA_SOURCE_ORDER`（自己的 key → 自己的接口 → 工坊的）。
   */
  dataSourceRoute?(channel: KolChannel): DataSourceRoute
  /**
   * WP126：这个渠道挂的自带数据接口（连接卡「自带数据接口（高级）」上填的）。
   * 没配回 `undefined`——那一级当"没配"，照常落下一级。
   */
  byoDataSource?(channel: KolChannel): ByoEndpointConfig | undefined
  /**
   * WP126：自带数据接口的配置仓（连接卡那组路由用：列 / 接 / 拔 / 试连）。
   * 不给 = 这台机器没有这张卡（路由第②级照常当"没配"跳过）。
   */
  byo?: ByoSourceStore
  /** 自带接口的密钥从哪儿读（本机加密库；测试用替身）。 */
  byoSecrets?: (secret_ref: string) => string | undefined
  /** 测试注入：自带接口的 fetch（生产走全局 fetch）。 */
  byoFetch?: (
    url: string,
    init: { method: string; headers: Record<string, string>; body?: string; signal?: AbortSignal },
  ) => Promise<{ ok: boolean; status: number; text(): Promise<string> }>
  /** 一项能力的价目（49 M4；价从云上那一份来，本地一个数字都不自己算）。 */
  priceOf?(capability: string): MaybePromise<{ credits: number; unit: string } | undefined>
  /**
   * 这个人在这个品牌里持有的分配（campaign 那一条按渠道挑本人自己那条职责用）。
   *
   * **不做并集**（05 §4）：同一个人只勾了 YouTube，就只能建 YouTube 那几条合作。
   */
  assignmentsOf(person_id: PersonId): Assignment[]
  /**
   * 现在谁持有某条职责（序列跟进那条定时用它找"用谁的分配去提"）。
   *
   * 定时任务没有"当前用户"——一封跟进信总得挂在某个人的额度与队列上，
   * 而那个人只能是这条渠道职责的持有人。
   */
  holdersOf(role_id: string): Assignment[]
  /** 品牌名（开发信模板里的 `brand`）。 */
  brandName(): string
  /** 一个人的显示名（开发信的署名）。取不到就用 id。 */
  personName(person_id: PersonId): MaybePromise<string>
  /**
   * WP299（决策 388 / 389）：这个品牌的档案里我们用得上的几格——公司实体地址（英文开发信页脚）、
   * 一句话介绍（认你卖的东西是哪一大类，打分用）、目标市场（打分的地区条件）。不给 = 都没有。
   */
  brandProfile?(): { postal_address?: string; one_liner?: string; markets?: readonly string[] }
  /**
   * WP416：有没有能发信的邮箱。没有时真红人的开发信照样起草，但卡上照实说「批了也发不出去」、
   * 一律要人点（不自动批），回执里带 `needs_mailbox` 让对话里就地出连接卡。不给 = 当连着（老装配）。
   */
  mailConnected?(): boolean
}

export interface KolServiceAssembly {
  port: KolPort
  /**
   * 起草开发信那一跳取明文用的口子（**只有执行器该调它**）。
   *
   * 放在这里而不是让调用方自己拼 key：拼字符串的地方多一处，
   * "联系方式的 key 名长什么样"就多一份真源。
   */
  revealContact(contact_id: string): string | undefined
  /**
   * 序列跟进的定时方（48 §5.2「首封 / 3 天 / 7 天」）。
   *
   * 调度器**按品牌各跑一轮**（照 WP66 的写法）。每一封仍是一张 `kol_outreach`
   * staged change 走 guardrail——定时的只是"什么时候该提"，提出来之后那条路
   * 与人手点的那一封一个字不差。
   */
  sweepSequences(): Promise<KolSequenceSweep>
}

/** 一轮序列跟进的结果（调度器把它写进任务的 `last_result`）。 */
export interface KolSequenceSweep {
  /** 看了几条"已建联但还没回音"的合作。 */
  scanned: number
  /** 提了几封跟进信。 */
  staged: number
  /** 没提的那几条与为什么（卡面上说不出来的事，日志里要说得出来）。 */
  skipped: { collaboration_id: string; reason: string }[]
}

const COLLAB_ACTION = 'stage_collaboration'
const REVIEW_ACTION = 'stage_deliverable_review'
const OUTREACH_ACTION = 'stage_outreach'

/** 开发信的日配额默认值（职责 yml 的 `max_outreach_per_day`）。 */
export const DEFAULT_OUTREACH_CAP = 30

/** WP416：存在品牌设置里的起草默认值。 */
interface SavedOutreachDefaults {
  brand_pitch?: string
  product?: string
}

/** 公共库那一行的主页地址（库里只有 渠道 + handle，链接是拼出来的）。 */
function urlOfPublicRow(channel: KolChannel, handle: string): string {
  switch (channel) {
    case 'youtube':
      return `https://www.youtube.com/@${handle}`
    case 'instagram':
      return `https://www.instagram.com/${handle}`
    case 'facebook':
      return `https://www.facebook.com/${handle}`
    case 'tiktok':
      return `https://www.tiktok.com/@${handle}`
    default:
      return `https://x.com/${handle}`
  }
}

/** 三封信在卡面上的说法。 */
const SEQUENCE_LABEL: Readonly<Record<OutreachStep, string>> = {
  first: '一封',
  follow_up: '二封（跟进）',
  final: '三封（收尾）',
}

/** WP295：缺了哪一格说人话（以前原样露出 `brand_pitch` 这种字段名）。 */
const OUTREACH_VAR_ZH: Readonly<Record<string, string>> = {
  creator_name: '红人名字',
  brand: '品牌名',
  brand_pitch: '一句话介绍我们是做什么的',
  product: '想聊的产品',
  reason: '为什么找他',
  sender_name: '署名',
}

/** WP295：卡片标题上的那几个字（以前直接用上面那份，标题读出来是「开发信：X（一封）」）。 */
const SEQUENCE_TITLE: Readonly<Record<OutreachStep, string>> = {
  first: '首封',
  follow_up: '跟进',
  final: '收尾',
}

export function createKolService(options: KolServiceOptions): KolServiceAssembly {
  const { store, secrets, clock, approvals, ledger, appendEvent } = options
  const workspace_id = options.workspace_id
  /** 人点过"不是同一个人"的那几对，进程内记着（重启后会再问一次——建议本来就是算出来的）。 */
  // WP416（自查 kol B「同一人合并卡」）：点过「不是同一个人」的落盘（以前只在内存里，重启又冒出来）
  const rejectedMerges = new Set<string>()
  let mergesLoaded = false
  /** 头一次用到时从库里读（库替身可能没有设置口：读不到就当没有）。 */
  const loadRejectedMerges = (): void => {
    if (mergesLoaded) return
    mergesLoaded = true
    try {
      for (const id of store.setting<string[]>('merge_rejected') ?? []) rejectedMerges.add(id)
    } catch {
      // 读不到就从空的开始
    }
  }

  let seq = 0
  const nextId = (prefix: string): string => {
    seq += 1
    const rand = Math.floor(options.random() * 0xffffffff)
      .toString(36)
      .padStart(7, '0')
    return `${prefix}_${rand}${seq.toString(36)}`
  }

  const emit = (type: string, actor: PersonId, payload: Record<string, unknown>): void => {
    appendEvent({
      schema_version: 1,
      workspace_id,
      type,
      actor: { kind: 'person', id: actor },
      correlation: { trace_id: `tr_kol_${clock.now()}` },
      payload,
    })
  }

  const actionOf = (
    assignment_id: AssignmentId,
    action: string,
  ): { mandate: Mandate; level: 'L1' | 'L2' | 'L3' } => {
    try {
      const config = options.effectiveConfig(assignment_id)
      return {
        mandate: config.actions.find((a) => a.id === action)?.mandate ?? { caps: {} },
        level: config.automation[action]?.level ?? 'L1',
      }
    } catch {
      // 这条分配查不到（测试装配 / 已撤销）：按最严的一档办
      return { mandate: { caps: {} }, level: 'L1' }
    }
  }

  /**
   * 人在工作台上按的那一下就是这次运行的触发源。
   *
   * `seen` 里放的是**这条路由真的读过**的那几个对象（下面每处都先从库里读一次
   * 才 stage）——provenance 不是形式，它是"before 从哪来"的证明。
   */
  const provenanceOf = (run_id: string, seen: ObjectRef[]): ProvenanceState => {
    const grouped: Record<string, string[]> = {}
    for (const ref of seen) {
      const list = grouped[ref.type] ?? []
      if (!list.includes(ref.id)) list.push(ref.id)
      grouped[ref.type] = list
    }
    return { run_id, seen: grouped, read_full: [], recorded_at: clock.now() }
  }

  const contactView = (row: CreatorContact): KolContactView => {
    let masked = '（取不到：这台机器的加密库没开或者换过密钥）'
    try {
      const value = secrets.get(row.value_ref)?.[CONTACT_SECRET_FIELD]
      if (value !== undefined) masked = maskContact(value)
    } catch {
      // 换过秘密库密钥：脱敏形态取不出来，但这条记录本身还在——照实说
    }
    return {
      id: row.id,
      creator_id: row.creator_id,
      kind: row.kind,
      source: row.source,
      ...(row.verified_at === undefined ? {} : { verified_at: row.verified_at }),
      masked,
    }
  }

  /**
   * WP299（决策 389）：打分条件带上品牌档案——一句话介绍认出的大类当品类条件、目标市场当地区条件。
   * 以前不带任何条件：库里每个人的类目都拿中间分、地区都满分，一屏几乎全是 90 分，分不出好坏。
   */
  const scoreCriteria = (): ScoreCriteria =>
    brandScoreCriteria(options.brandProfile?.() ?? {}, clock.now())

  const detailOf = (creator: Creator): KolCreatorDetail => {
    const collaborations = store.collaborations().filter((c) => c.creator_id === creator.id)
    const ids = new Set(collaborations.map((c) => c.id))
    const accounts = store.accounts({ creator_id: creator.id })
    const criteria = scoreCriteria()
    return {
      creator,
      accounts,
      scores: Object.fromEntries(
        accounts.map((a) => {
          const sc = scoreCreator(a, criteria)
          return [
            a.id,
            {
              total: sc.total,
              factors: sc.factors.map((f) => ({
                id: f.id,
                label: f.label,
                score: Math.round(f.score),
                why: f.why,
              })),
              ...(sc.blocked === undefined ? {} : { blocked: sc.blocked }),
            },
          ]
        }),
      ),
      contacts: store.contacts(creator.id).map(contactView),
      collaborations,
      deliverables: store.deliverables().filter((d) => ids.has(d.collaboration_id)),
      tracked_links: store.links().filter((l) => ids.has(l.collaboration_id)),
      ...savedProfilesOf(accounts),
      ...checksOf(accounts),
      ...auditOf(creator.id),
      ...tagsAndReviewOf(creator.id),
    }
  }

  /* ── WP502（决策 1763 B）：人工标签与审核决定（只在本机）──────────────── */

  /** 库替身可能没有这两张表的口：读不到就当没有。 */
  const tagRowOf = (creator_id: string): KolCreatorTagRow | undefined => {
    try {
      return store.creatorTags(creator_id)[0]
    } catch {
      return undefined
    }
  }
  const reviewRowOf = (creator_id: string): KolCreatorReviewRow | undefined => {
    try {
      return store.creatorReviews(creator_id)[0]
    } catch {
      return undefined
    }
  }
  const allTagRows = (): KolCreatorTagRow[] => {
    try {
      return store.creatorTags()
    } catch {
      return []
    }
  }
  const allReviewRows = (): KolCreatorReviewRow[] => {
    try {
      return store.creatorReviews()
    } catch {
      return []
    }
  }
  const reviewViewOf = (row: KolCreatorReviewRow): KolCreatorReviewView => ({
    decision: row.decision,
    ...(row.reason === undefined ? {} : { reason: row.reason }),
    decided_at: row.decided_at,
  })
  const tagsAndReviewOf = (creator_id: string): Pick<KolCreatorDetail, 'tags' | 'review'> => {
    const tags = tagRowOf(creator_id)?.tags ?? []
    const review = reviewRowOf(creator_id)
    return {
      ...(tags.length === 0 ? {} : { tags }),
      ...(review === undefined ? {} : { review: reviewViewOf(review) }),
    }
  }

  /** 标签规整：去两头空白、并掉连续空白、按不分大小写去重、截到上限。空的丢掉。 */
  const cleanTags = (input: readonly string[]): string[] => {
    const out: string[] = []
    for (const raw of input) {
      const t = raw.replace(/\s+/g, ' ').trim().slice(0, KOL_TAG_MAX_LENGTH)
      if (t === '' || out.some((o) => o.toLowerCase() === t.toLowerCase())) continue
      out.push(t)
      if (out.length >= KOL_TAGS_MAX) break
    }
    return out
  }

  /** WP502（决策 1760 B）：一份资料里外站图片 → 本机同源地址（缓存到了才有）。 */
  const withMedia = (profile: KolCreatorProfileView): KolCreatorProfileView => {
    const media = options.media
    if (media === undefined) return profile
    const avatar = media.localUrlOf(profile.avatar_url)
    const banner = media.localUrlOf(profile.banner_url)
    return {
      ...profile,
      ...(avatar === undefined ? {} : { avatar_media_url: avatar }),
      ...(banner === undefined ? {} : { banner_media_url: banner }),
      ...(profile.recent_items === undefined
        ? {}
        : {
            recent_items: profile.recent_items.map((r) => {
              const cover = media.localUrlOf(r.thumbnail_url)
              return cover === undefined ? r : { ...r, thumbnail_media_url: cover }
            }),
          }),
    }
  }

  /** 候选池卡片上的头像：这个账号最近一次存入时的头像缓存到了就给。 */
  const avatarMediaOf = (account_id: string): string | undefined => {
    if (options.media === undefined) return undefined
    const latest = latestSavedProfile(store.accountObservations({ account_id }))
    return options.media.localUrlOf(latest?.profile?.avatar_url)
  }

  /**
   * WP500：每个账号的体检 / 受众真实性 / 频道估值 / 更新规律 / 粉丝 30 天变化（`kol-checks.ts`，插件那几份算法）。
   * 一个账号一项都算不出来就不带它；全都没有就不带这一格。
   */
  const checksOf = (
    accounts: readonly PlatformAccount[],
  ): { checks?: Record<string, KolCreatorChecksView> } => {
    const now = clock.now()
    const out: Record<string, KolCreatorChecksView> = {}
    for (const a of accounts) {
      const observations = store.accountObservations({ account_id: a.id })
      const latest = latestSavedProfile(observations)
      const checks = creatorChecksOf(a, latest?.profile, observations, now)
      if (checks !== undefined) out[a.id] = checks
    }
    return Object.keys(out).length === 0 ? {} : { checks: out }
  }

  /** WP500：「采集后自动评分」做成了的那份云端体检（WP131）。没有就不带。 */
  const auditOf = (creator_id: string): Pick<KolCreatorDetail, 'audit'> => {
    const row = store.autoScores().find((r) => r.creator_id === creator_id)
    const audit = row?.audit
    if (audit === undefined || audit.health === undefined) return {}
    return { audit: { health: audit.health, findings: audit.findings ?? [], at: audit.at } }
  }

  /**
   * WP498（决策 1752 C）：每个账号最近一次「存入红人池」时记下的主页资料（插件按钮或 ego 自动存入的那一行快照）。
   * 一个都没有就不带这一格。
   */
  /** 最近一次「存入红人池」那一行（同一刻存了两次取后记的那一行）。 */
  const latestSavedProfile = (
    observations: readonly KolAccountObservation[],
  ): KolAccountObservation | undefined =>
    observations
      .filter((o) => o.source === 'manual_save' && o.profile !== undefined)
      .reduce<KolAccountObservation | undefined>(
        (best, o) =>
          best === undefined || Date.parse(o.observed_at) >= Date.parse(best.observed_at)
            ? o
            : best,
        undefined,
      )

  const savedProfilesOf = (
    accounts: readonly PlatformAccount[],
  ): { profiles?: Record<string, KolCreatorProfileView> } => {
    const out: Record<string, KolCreatorProfileView> = {}
    for (const a of accounts) {
      const latest = latestSavedProfile(store.accountObservations({ account_id: a.id }))
      if (latest?.profile !== undefined)
        out[a.id] = withMedia({ saved_at: latest.observed_at, ...latest.profile })
    }
    return Object.keys(out).length === 0 ? {} : { profiles: out }
  }

  /*
   * WP302（决策 406）：合作清单每一行的紧急程度（`kol-core` 的 `collabStatus`）。现算不存：
   * 还在等人批的卡从账本里读（只算 staged 的红人那几种）、交付物从库里读、往来从库里读、
   * 下一封跟进按节奏算。卡对到合作上：带 `collaboration_id` 的直接对；开发信按「这个人 + 这条渠道」；
   * 交付物验收按交付物挂的合作。
   */
  const withStatus = async (rows: readonly Collaboration[]): Promise<KolCollaborationRow[]> => {
    if (rows.length === 0) return []
    const now = clock.now()
    const pending = (await ledger.list({ workspace_id })).filter(
      (c) => c.status === 'staged' && c.kind.startsWith('kol_'),
    )
    const deliverables = store.deliverables()
    const cardsOf = (c: Collaboration): number =>
      pending.filter((ch) => {
        const after = (ch.after ?? {}) as Record<string, unknown>
        if (after.collaboration_id === c.id) return true
        if (ch.target.type === 'collaboration' && ch.target.id === c.id) return true
        if (ch.target.type === 'deliverable')
          return deliverables.some((d) => d.id === ch.target.id && d.collaboration_id === c.id)
        return (
          after.collaboration_id === undefined &&
          after.creator_id === c.creator_id &&
          (after.channel === undefined || after.channel === c.channel)
        )
      }).length
    return rows.map((c) => {
      const mine = deliverables.filter((d) => d.collaboration_id === c.id)
      const exchanges = store
        .exchanges({ creator_id: c.creator_id })
        .filter((x) => x.channel === c.channel)
        .sort((a, b) => a.at.localeCompare(b.at))
      const last = exchanges[exchanges.length - 1]
      const outbound = exchanges.filter((x) => x.direction === 'out')
      const next =
        c.stage === 'contacted' && outbound.length > 0
          ? nextInSequence({
              sent: outbound.map((x, i) => ({
                step: (['first', 'follow_up', 'final'] as const)[Math.min(i, 2)] ?? 'final',
                at: x.at,
              })),
              replied: exchanges.some((x) => x.direction === 'in'),
              contact: c.creator_id,
              suppressed: [],
            })
          : undefined
      const cards = cardsOf(c)
      const status = collabStatus({
        stage: c.stage,
        now,
        stage_changed_at: c.stage_changed_at,
        last_activity_at: c.last_activity_at,
        pending_cards: cards,
        pending_reviews: mine.filter((d) => d.review === 'pending' && d.submitted_at !== undefined)
          .length,
        overdue_deliverables: mine.filter(
          (d) => d.submitted_at === undefined && d.review === 'pending' && d.due_at < now,
        ).length,
        ...(last === undefined
          ? {}
          : {
              last_exchange: {
                direction: last.direction,
                at: last.at,
                ...(last.reply_class === undefined ? {} : { reply_class: last.reply_class }),
              },
            }),
        outbound_count: outbound.length,
        ...(next === undefined || next.due_at === '' ? {} : { next_follow_up_at: next.due_at }),
      })
      const dwell = dwellDays(c.stage_changed_at, now, c.last_activity_at)
      return {
        ...c,
        status,
        ...(cards === 0 ? {} : { pending_cards: cards }),
        ...(dwell === null ? {} : { dwell_days: dwell }),
        stalled: isStageStalled(c.stage, c.stage_changed_at, now, c.last_activity_at),
        segments: stageSegments(c.stage, {
          now,
          stageChangedAt: c.stage_changed_at,
          lastActivityAt: c.last_activity_at,
          withSample: c.sample !== undefined,
        }),
      }
    })
  }

  const creatorOr404 = (id: string): Creator => {
    const found = store.creator(id)
    if (found === undefined) throw new ApiError('not_found', '库里没有这个红人')
    return found
  }

  /** 合并判断要的画像：联系方式只传**归一键**，明文一次都不进 `kol-core`。 */
  const profilesOf = (): MergeProfile[] =>
    store.creators().map((c) => ({
      creator_id: c.id,
      display_name: c.display_name,
      accounts: store
        .accounts({ creator_id: c.id })
        .map((a) => ({ channel: a.channel, handle: a.handle })),
      contact_keys: store.contacts(c.id).flatMap((ct) => {
        try {
          const value = secrets.get(ct.value_ref)?.[CONTACT_SECRET_FIELD]
          return value === undefined ? [] : [suppressionKey(value)]
        } catch {
          return []
        }
      }),
    }))

  /* ── WP68：开发信、序列跟进、campaign 向导 ─────────────────────────── */

  /**
   * 这个人首选的联系方式（邮箱优先）。
   *
   * 返回的是**那条记录**，不是地址——地址只有发信那一跳从加密库取。
   */
  const contactOf = (creator_id: string): CreatorContact | undefined => {
    const all = store.contacts(creator_id)
    return all.find((c) => c.kind === 'email') ?? all[0]
  }

  /**
   * 抑制名单：在这条渠道上明确谢绝过的那些人的联系方式 **key 名**。
   *
   * 放 key 名而不是地址是要紧的一条：guardrail 比的是
   * `suppressionKey(收件人) ∈ suppressionKey(名单)`，而 `suppressionKey` 对一个
   * 没有 `@` 的字符串就是原样小写——于是比对照样成立，而**账本里一个真地址都没有**。
   */
  const suppressedRefs = (): string[] =>
    store
      .collaborations({ stage: 'declined' })
      .flatMap((c) => store.contacts(c.creator_id).map((ct) => ct.value_ref))

  /** 这条分配今天发了几封（**只问账本**，不另记一张表）。 */
  const outreachQuotaOf = async (
    assignment_id: AssignmentId,
  ): Promise<ReturnType<typeof outreachQuota>> => {
    const { mandate } = actionOf(assignment_id, OUTREACH_ACTION)
    const cap =
      typeof mandate.caps.max_outreach_per_day === 'number'
        ? mandate.caps.max_outreach_per_day
        : DEFAULT_OUTREACH_CAP
    const changes = await ledger.list({ workspace_id, kind: 'kol_outreach' })
    return outreachQuota({
      cap,
      sent_at: changes.filter((c) => c.assignment_id === assignment_id).map((c) => c.created_at),
      now: clock.now(),
    })
  }

  /** 这个人在这条渠道职责上的那一条分配（没有 = 他不做这条活儿）。 */
  const assignmentForChannel = (person_id: PersonId, channel: KolChannel): Assignment | undefined =>
    options
      .assignmentsOf(person_id)
      .find(
        (a) =>
          a.role_id === roleIdOfChannel(channel) &&
          a.workspace_id === workspace_id &&
          a.revoked_at === undefined,
      )

  /**
   * 现在谁持有这条渠道职责（定时跟进用他那条分配去提）。
   *
   * 没人持有就不提——一封没有主人的信，没人负责、也没人点。
   */
  const ownerOfChannel = (channel: KolChannel): Assignment | undefined =>
    options.holdersOf(roleIdOfChannel(channel))[0]

  const savedDefaults = (): SavedOutreachDefaults => {
    try {
      return store.setting<SavedOutreachDefaults>('outreach_defaults') ?? {}
    } catch {
      return {}
    }
  }

  /** WP416（决策 531）：起草那两格的默认值——存过的 → 品牌档案 → 空。 */
  const outreachDefaultsOf = (): KolOutreachDefaultsView => {
    const saved = savedDefaults()
    const profile = options.brandProfile?.()
    const profilePitch = profile?.one_liner?.trim() ?? ''
    const savedPitch = saved.brand_pitch?.trim() ?? ''
    const brand_pitch = savedPitch !== '' ? savedPitch : profilePitch
    return {
      brand_pitch,
      product: saved.product?.trim() ?? '',
      source:
        savedPitch !== '' || (saved.product ?? '') !== ''
          ? 'saved'
          : profilePitch !== ''
            ? 'brand_profile'
            : 'none',
      mailbox_connected: options.mailConnected?.() ?? true,
    }
  }

  /** 起草并提一封开发信。`step` 不给就按序列算下一封。 */
  const stageOutreach = async (input: {
    actor: { person_id: PersonId; assignment_id: AssignmentId; role_id: string }
    creator: Creator
    channel: KolChannel
    step: OutreachStep
    /** WP416：「一句话介绍我们」是哪来的（品牌档案 / AI 写的），卡上说一句。 */
    pitch_note?: string
    vars: {
      product: string
      reason: string
      brand_pitch?: string
      sender_name: string
      /** WP295：信用哪种语言写（跟进那两封沿用首封的）。不给 = 中文。 */
      language?: OutreachLanguage
    }
  }): Promise<KolOutreachView> => {
    const quota = await outreachQuotaOf(input.actor.assignment_id)
    const contact = contactOf(input.creator.id)
    const empty = { step: input.step, subject: '', body: '', forbidden_hits: [], missing_vars: [] }
    if (contact === undefined)
      return {
        ...empty,
        quota,
        staged: false,
        message:
          '这个红人名下还没有联系方式。先在详情页加一条（邮箱直接写进本机加密库），或者从渠道的"在哪儿能找到"那一步拿一个。',
      }
    if (!quota.allowed)
      return {
        ...empty,
        quota,
        staged: false,
        message: `今天这条职责的开发信配额用完了（上限 ${quota.cap} 封）。明天再发——一天多过这个数，收信的人会觉得是群发轰炸。`,
      }
    const suppressed = suppressedRefs()
    if (suppressed.some((ref) => ref === contact.value_ref))
      return {
        ...empty,
        quota,
        staged: false,
        message: '这个人在这条渠道上已经明确谢绝过了。名单上的人一封都不再发。',
      }

    // WP299（决策 388）：公司实体地址每次起草时现取（跟进那两封也用公司档案里最新的那一份）
    const postal_address = options.brandProfile?.().postal_address?.trim()
    const draft = draftOutreach(input.step, {
      creator_name: input.creator.display_name,
      brand: options.brandName(),
      channel: input.channel,
      ...input.vars,
      ...(postal_address === undefined || postal_address === '' ? {} : { postal_address }),
    })
    if (!draft.ok)
      return {
        step: draft.step,
        subject: draft.subject,
        body: draft.body,
        forbidden_hits: draft.forbidden_hits,
        missing_vars: draft.missing_vars,
        quota,
        staged: false,
        message:
          draft.forbidden_hits.length > 0
            ? `这封信里写了「${draft.forbidden_hits.join('」「')}」这类承诺。给钱、白送样品、保证效果都要走"建一条合作"那条路（那一步永远要人点头），不能在信里写死。`
            : `还差几格没填：${draft.missing_vars.map((k) => OUTREACH_VAR_ZH[k] ?? k).join('、')}。缺了就不起草——拿一封空着一格的信去问人要不要发，比不起草更糟。`,
      }

    const run_id = `run_kol_${nextId('o')}`
    const target: ObjectRef = { type: 'creator_contact', id: contact.id }
    const { mandate, level } = actionOf(input.actor.assignment_id, OUTREACH_ACTION)
    /*
     * WP117b（66 复测 #19）：**演练里的开发信一律出卡等人批。**
     *
     * 真实那一侧照职责模板走（`stage_outreach` initial L2 → 低风险 → 自动批），
     * 那是 48 §5.1 定的，不动它。可演练的整个目的就是**让人看清这条链**：
     * 起草 → 一张 outbound 排版的卡 → 人点「批」→ 信真的投出去（进演练收件箱）
     * → 对面按性格回信。自动批掉的话，人在界面上什么都没看见，
     * 「已发 1」就只是一个凭空跳出来的数。
     *
     * 判据是**这个人是不是演练红人**（`Creator.sandbox`），不是"现在是不是演练模式"
     * ——用户可以一边演练一边干真活，那边的开发信不该因此多一道手续。
     */
    const sandboxDrill = input.creator.sandbox === true
    // WP416：真红人、可这台机器上没有能发信的邮箱——卡照样出（信先写好），但照实说、不许自动批
    const noMailbox = !sandboxDrill && options.mailConnected?.() === false
    /*
     * 卡面上要人先看一眼的几句（WP416 自查 kol U5：以前写在 notes 里、卡面看不见）——同时进 notes
     * 与 `after.heads_up`（卡面一行一句）。
     */
    const headsUp: string[] = [
      ...(noMailbox
        ? ['还没连发信邮箱：现在批了也发不出去。先在下面那张连接卡上连好邮箱，再点「发送」。']
        : []),
      ...(input.pitch_note === undefined ? [] : [input.pitch_note]),
      /*
       * WP295：英文信里混进了中文（你填的介绍、产品名，或署名用的是中文名）——对方读不懂，卡上先说一句，
       * 人点「修改」换成英文再发。不拦：有的品牌名本来就是中文。
       */
      ...(input.vars.language === 'en' &&
      hasCjk(`${input.vars.brand_pitch ?? ''} ${input.vars.product} ${input.vars.sender_name}`)
        ? ['这封是英文信，但介绍、产品名或署名里有中文——对方看英文，发之前点「修改」换成英文。']
        : []),
      // WP299（决策 388）：英文信页脚要公司实体地址（法规要求）；没填不拦，提醒去填
      ...(input.vars.language === 'en' && (postal_address === undefined || postal_address === '')
        ? [
            '公司档案里还没填公司地址：英文开发信页脚要用它（法规要求）。去「设置 → 通用 → 公司档案」填一下。',
          ]
        : []),
    ]
    const outcome = await ledger.stage({
      workspace_id,
      role_id: input.actor.role_id,
      assignment_id: input.actor.assignment_id,
      run_id,
      change_set_id: `cs_${run_id}`,
      kind: 'kol_outreach',
      target,
      before: null,
      after: {
        step: draft.step,
        channel: input.channel,
        creator_id: input.creator.id,
        subject: draft.subject,
        body: draft.body,
        // 收件人与名单里放的都是加密库 key 名（见 `suppressedRefs` 的注释）
        recipients: [contact.value_ref],
        suppressed,
        suppression_checked: true,
        // 跟进那一封要用首封同一组变量——跟进信提到的产品必须和首封是同一个
        vars: input.vars,
        ...(headsUp.length === 0 ? {} : { heads_up: headsUp }),
        creator_name: input.creator.display_name,
      },
      notes: [`给 ${input.creator.display_name} 的第 ${SEQUENCE_LABEL[draft.step]}`, ...headsUp],
      created_by: { kind: 'agent', id: `agent_${input.actor.role_id}` },
      mandate,
      level: sandboxDrill || noMailbox ? 'L1' : level,
      provenance: provenanceOf(run_id, [target, { type: 'creator', id: input.creator.id }]),
      approval: {
        title: `开发信：${input.creator.display_name}（${SEQUENCE_TITLE[draft.step]}）`,
        summary: draft.subject,
        recipients: [{ person: input.actor.person_id, via: 'role_holder' }],
        proposer: {
          kind: 'agent',
          id: `agent_${input.actor.role_id}`,
          assignment_id: input.actor.assignment_id,
        },
        rule: 'role_holder',
        separation_of_duties: false,
        source_events: [],
      },
    })
    if (!outcome.ok)
      return {
        step: draft.step,
        subject: draft.subject,
        body: draft.body,
        forbidden_hits: draft.forbidden_hits,
        missing_vars: [],
        quota,
        staged: false,
        message: outcome.message,
      }
    emit('kol.outreach_staged', input.actor.person_id, {
      creator_id: input.creator.id,
      channel: input.channel,
      step: draft.step,
      change_id: outcome.change.id,
      approval_item_id: outcome.approval.id,
      auto_approved: outcome.approval.automation.auto_approved,
    })
    /*
     * WP416（自查 kol C2）：提卡**不再**把合作推到「已建联」——信真发出去（执行器读回之后）才推。
     * 以前一提卡就改阶段，于是没发出去的信也排上了第 3、7 天的跟进。起草仍算一次动静。
     */
    const collab = store
      .collaborations({ channel: input.channel })
      .find((c) => c.creator_id === input.creator.id && c.stage === 'sourced')
    if (draft.step === 'first' && collab !== undefined)
      store.saveCollaboration({ ...collab, last_activity_at: clock.now() })
    return {
      ...(noMailbox ? { needs_mailbox: true } : {}),
      step: draft.step,
      subject: draft.subject,
      body: draft.body,
      forbidden_hits: [],
      missing_vars: [],
      quota: { ...quota, sent_today: quota.sent_today + 1, remaining: quota.remaining - 1 },
      staged: true,
      change_id: outcome.change.id,
      approval_item_id: outcome.approval.id,
      auto_approved: outcome.approval.automation.auto_approved,
    }
  }

  /** 已经在库里的那几个标出来（清单上要看得见"这个人你已经有了"）。 */
  const knownHandles = (channel: KolChannel): Set<string> =>
    new Set(store.accounts({ channel }).map((a) => normalizeHandle(a.handle)))

  /** 「用 agentsws 的」那一档：查云端公共库（浏览免费）。 */
  const publicSearch = async (input: {
    channel: KolChannel
    q: string
    limit?: number | undefined
    min_followers?: number | undefined
    max_followers?: number | undefined
  }): Promise<KolSearchResult> => {
    const library = options.publicLibrary
    if (library === undefined || !library.linked())
      return {
        ok: false,
        source: 'public_library',
        rows: [],
        reason: 'not_linked',
        message:
          '这条渠道的开关拨到了"用 Agents 工坊的"，但这台机器还没关联 Agents 工坊账号。关联一次就能用，或者把开关拨回"用我的"。',
      }
    const out = await library.browse({
      channel: input.channel,
      q: input.q,
      ...(input.limit === undefined ? {} : { limit: input.limit }),
    })
    if (!out.ok)
      return {
        ok: false,
        source: 'public_library',
        rows: [],
        reason: out.reason,
        message: out.message,
      }
    const known = knownHandles(input.channel)
    const price = await revealPrice()
    return {
      ok: true,
      source: 'public_library',
      rows: out.data.rows
        // WP117b（66 复测 #15）：公共库这一档也按粉丝区间筛
        .filter((row: PublicCreatorRow) => inBand(row.followers, input))
        .map((row: PublicCreatorRow) => ({
          channel: row.channel,
          handle: row.handle,
          url: urlOfPublicRow(row.channel, row.handle),
          display_name: row.display_name,
          ...(row.followers === undefined ? {} : { followers: row.followers }),
          ...(row.engagement_rate === undefined ? {} : { engagement_rate: row.engagement_rate }),
          ...(row.category === undefined ? {} : { category: row.category }),
          ...(row.language === undefined ? {} : { language: row.language }),
          ...(row.region === undefined ? {} : { region: row.region }),
          has_contact: row.has_contact,
          in_library: known.has(normalizeHandle(row.handle)),
        })),
      ...(price === undefined ? {} : { reveal_price: price }),
    }
  }

  /**
   * reveal 一次要花多少积分（49 M4）。
   *
   * **起草开发信之前就说**：人在决定"要不要花这笔钱"之前该看得见数，
   * 而不是点下去之后才知道。取不到价目就不编一个——那一格干脆不出现。
   *
   * WP126：官方接口没有免费动作了，所以这里一并把搜索 / 取邮箱的计费口径说出来。
   */
  const revealPrice = async (): Promise<KolSearchResult['reveal_price']> => {
    const found = await options.priceOf?.(REVEAL_CAPABILITY)
    if (found === undefined) return undefined
    return {
      capability: REVEAL_CAPABILITY,
      credits: found.credits,
      unit: found.unit,
      note: `搜索按次收（界面上常显单价）；取回一个邮箱这一步扣 ${found.credits} 积分。库里没有联系方式不收钱。`,
    }
  }

  /*
   * WP117b（66 复测 #15）：**搜不到东西的那两个原因，都在这两个小函数里。**
   *
   * ① 关键词以前是**整串**去 `includes`：Agent 递进来的是「youtube 频道」这样一串，
   *    没有任何一个 handle 或名字整串带着它，于是回 0 个。现在**按词拆开、任意一个
   *    命中就算**，而且名字 / handle / 类目三处都看——「桌面 好物」里的「桌面」
   *    命中类目也该算数。
   * ② 粉丝区间以前**根本没有这一层过滤**。
   */
  const matchesQ = (account: PlatformAccount, q: string | undefined): boolean => {
    const words = (q ?? '')
      .toLowerCase()
      .split(/[\s,，、]+/)
      .filter((w) => w !== '')
    if (words.length === 0) return true
    const hay = [
      account.handle,
      store.creator(account.creator_id)?.display_name ?? '',
      account.category ?? '',
      account.region ?? '',
    ]
      .join(' ')
      .toLowerCase()
    /*
     * WP295：品类反过来也算——人说「数码产品」「户外露营」，库里那一格写的是「数码」「户外」。
     * 只对品类这一格这么认（两个字起），名字与账号仍要关键词整个出现。
     */
    const category = (account.category ?? '').toLowerCase()
    return words.some((w) => hay.includes(w) || (category.length >= 2 && w.includes(category)))
  }

  /**
   * 粉丝数落不落在区间里（两头都含）。
   *
   * **粉丝数没有的那些人算落在区间里**：不知道 ≠ 不合格（36 §3 的同一条）。
   * 把他们剔掉，等于因为"我们没抓到这个数"就当这个人不存在。
   */
  const inBand = (
    followers: number | undefined,
    filter: { min_followers?: number | undefined; max_followers?: number | undefined },
  ): boolean => {
    // WP416（自查 kol A2）：给了粉丝区间、这个人粉丝数却不知道——不算在区间里（以前恒为真，区间形同虚设）
    if (followers === undefined)
      return filter.min_followers === undefined && filter.max_followers === undefined
    if (filter.min_followers !== undefined && followers < filter.min_followers) return false
    if (filter.max_followers !== undefined && followers > filter.max_followers) return false
    return true
  }

  /**
   * 渠道的中文名（来源标签与错误提示用）。不认识就原样回。
   */
  const channelLabel = (channel: KolChannel): string =>
    (
      ({
        youtube: 'YouTube',
        instagram: 'Instagram',
        tiktok: 'TikTok',
        facebook: 'Facebook',
        x: 'X',
      }) as Record<string, string>
    )[channel] ?? channel

  /**
   * 第四层（都没有）的那一句人话 + 两个入口（WP126 定论 1）。
   */
  /*
   * WP142（docs/78 第 15 步）：**两句话 + 两个按钮**。以前这里是两百字，真正要做的两件事
   * 埋在中间；现在第一句说为什么搜不了，第二句说怎么办，两件事各是一个按钮（`entry_points`）。
   */
  const nothingConfigured = (channel: KolChannel): KolSearchResult => ({
    ok: false,
    source: 'channel',
    rows: [],
    reason: 'no_data_source',
    message:
      channel === 'youtube'
        ? '现在搜不了 YouTube 上的红人：还没接任何数据来源。在连接页填你自己的 YouTube 数据 key（免费，不扣积分），或者关联 Agents 工坊账号（按次扣积分），任选其一就能搜。'
        : `现在搜不了 ${channelLabel(channel)} 上的红人：还没接任何数据来源。关联 Agents 工坊账号（按次扣积分）或者接你自己的数据接口（不扣积分），任选其一就能搜；也可以在浏览器里打开 ${channelLabel(channel)}，用插件把人收进来。`,
    entry_points: [
      {
        id: 'link_account',
        label: '关联官方账号',
        note: '送 5 积分，之后走工坊官方数据接口（按次计价，价常显在界面上）。',
      },
      {
        id: 'byo',
        label: '接自己的数据接口',
        note: '高级用法：填一个能按工坊公开格式回数据的服务地址，不扣积分。',
      },
    ],
  })

  const port: KolPort = {
    creators(_actor, filter) {
      const now = clock.now()
      // WP131：插件「回作战室看这批」——只留这一次列表采集收进来的那几位
      const inBatch =
        filter.batch === undefined
          ? undefined
          : new Set(store.accountObservations({ batch_id: filter.batch }).map((o) => o.account_id))
      // WP502（决策 1763 B）：人工标签与审核决定（筛、上卡）
      const tagRows = new Map(allTagRows().map((r) => [r.creator_id, r.tags]))
      const reviewRows = new Map(allReviewRows().map((r) => [r.creator_id, r]))
      const wantTag = filter.tag?.trim().toLowerCase()
      const accounts = store
        .accounts(filter.channel === undefined ? {} : { channel: filter.channel })
        .filter((a) => inBatch === undefined || inBatch.has(a.id))
        .filter((a) => matchesQ(a, filter.q))
        .filter((a) => inBand(a.followers, filter))
        .filter(
          (a) =>
            wantTag === undefined ||
            wantTag === '' ||
            (tagRows.get(a.creator_id) ?? []).some((t) => t.toLowerCase() === wantTag),
        )
        .filter((a) => {
          if (filter.review === undefined) return true
          const decided = reviewRows.get(a.creator_id)?.decision
          return filter.review === 'pending' ? decided === undefined : decided === filter.review
        })
      const hasContact = new Set(store.contacts().map((ct) => ct.creator_id))
      // WP131：自动评分跑出来的体检概括数（做成了的才有）
      const audits = new Map(
        store
          .autoScores()
          .filter((r) => r.audit?.health !== undefined)
          .map((r) => [r.creator_id, r.audit as { health: number; at: string }]),
      )
      // WP302：卡上的迷你进度条与「下一步」按钮——这个人在这条渠道上最近那条合作
      const collabOf = (creator_id: string, channel: KolChannel): Collaboration | undefined =>
        store
          .collaborations({ channel })
          .filter((c) => c.creator_id === creator_id)
          .sort((a, b) => (b.last_activity_at ?? '').localeCompare(a.last_activity_at ?? ''))[0]
      // 排序（含"刷粉的排在后面而不是剔掉"）在 `rankCreators` 里，不在这儿重写
      const rows: KolCreatorRow[] = rankCreators(accounts, { ...scoreCriteria(), now }).map(
        ({ account, score }) => ({
          creator_id: account.creator_id,
          display_name: store.creator(account.creator_id)?.display_name ?? account.creator_id,
          channel: account.channel,
          handle: account.handle,
          url: account.url,
          ...(account.followers === undefined ? {} : { followers: account.followers }),
          ...(account.engagement_rate === undefined
            ? {}
            : { engagement_rate: account.engagement_rate }),
          ...(account.category === undefined ? {} : { category: account.category }),
          observed_at: account.observed_at,
          score: score.total,
          ...(score.blocked === undefined ? {} : { blocked: score.blocked }),
          has_contact: hasContact.has(account.creator_id),
          ...(() => {
            const avatar = avatarMediaOf(account.id)
            const tags = tagRows.get(account.creator_id) ?? []
            const review = reviewRows.get(account.creator_id)
            return {
              ...(avatar === undefined ? {} : { avatar_media_url: avatar }),
              ...(tags.length === 0 ? {} : { tags }),
              ...(review === undefined ? {} : { review: reviewViewOf(review) }),
            }
          })(),
          ...(audits.has(account.creator_id)
            ? {
                audit_health: audits.get(account.creator_id)?.health as number,
                audited_at: audits.get(account.creator_id)?.at as string,
              }
            : {}),
          factors: score.factors.map((f) => ({
            id: f.id,
            score: Math.round(f.score),
            why: f.why,
            ...(f.unknown === undefined ? {} : { unknown: true as const }),
          })),
          ...(() => {
            const v = judgeEngagement(account.engagement_rate, account.followers)
            return v === null ? {} : { engagement_judgement: v }
          })(),
          ...(() => {
            const c = collabOf(account.creator_id, account.channel)
            return c === undefined
              ? {}
              : {
                  collab: {
                    id: c.id,
                    stage: c.stage,
                    ...(c.stage_changed_at === undefined
                      ? {}
                      : { stage_changed_at: c.stage_changed_at }),
                    ...(c.last_activity_at === undefined
                      ? {}
                      : { last_activity_at: c.last_activity_at }),
                    with_sample: c.sample !== undefined,
                    stalled: isStageStalled(c.stage, c.stage_changed_at, now, c.last_activity_at),
                    segments: stageSegments(c.stage, {
                      now,
                      stageChangedAt: c.stage_changed_at,
                      lastActivityAt: c.last_activity_at,
                      withSample: c.sample !== undefined,
                    }),
                    ...(() => {
                      const d = dwellDays(c.stage_changed_at, now, c.last_activity_at)
                      return d === null ? {} : { dwell_days: d }
                    })(),
                  },
                }
          })(),
        }),
      )
      // 筛选下拉要的：这个品牌红人池里用过的全部标签（按字母 / 拼音排，不分大小写去重）
      const vocabulary: string[] = []
      for (const tags of tagRows.values())
        for (const t of tags)
          if (!vocabulary.some((v) => v.toLowerCase() === t.toLowerCase())) vocabulary.push(t)
      vocabulary.sort((a, b) => a.localeCompare(b))
      return {
        rows: rows.slice(0, filter.limit ?? 100),
        ...(vocabulary.length === 0 ? {} : { tags: vocabulary }),
      }
    },

    async search(actor, input) {
      /*
       * WP126：**四级路由**（docs/75 有整张表）。每个渠道 × 每种动作都过这张表：
       *
       * ① 用户自己的官方平台 key → ② 用户自带的数据接口 →
       * ③ Agents 工坊官方数据接口（积分）→ ④ 都没有：人话 + 两个入口。
       *
       * 逐级回退只在「没配」或「这一级不支持这个动作」时发生；**配了但报错
       * 不静默回退到花钱的那一级**——说清哪一级失败，给一句
       * "改用官方接口（约 N 积分）"，用户点头后带 `fallback: 'workshop'` 重发。
       */
      const channel = input.channel
      const route = options.dataSourceRoute?.(channel) ?? {
        order: [...DEFAULT_DATA_SOURCE_ORDER],
        disabled: [],
      }
      // 49 M2 的老开关仍是权威：显式拨到 agentsws 时官方接口排最前
      const order =
        options.capabilitySource?.(`kol.${channel}`) === 'agentsws'
          ? (['workshop', ...route.order.filter((l) => l !== 'workshop')] as DataSourceLevel[])
          : route.order
      const levels = order.filter((l) => !route.disabled.includes(l))
      // 用户点了"改用官方接口"：跳过路由表，直接走官方（③）
      const effective = input.fallback === 'workshop' ? (['workshop'] as DataSourceLevel[]) : levels
      const known = knownHandles(channel)
      // 官方接口的单价（界面上常显；失败提示里的"约 N 积分"也用它）。取不到就不编。
      const searchPrice = await options.priceOf?.(REVEAL_CAPABILITY)
      const fallbackOffer =
        searchPrice === undefined
          ? undefined
          : {
              credits: searchPrice.credits,
              note: `改用工坊官方数据接口（约 ${searchPrice.credits} 积分一次）。`,
            }
      let lastWorkshopFailure: KolSearchResult | undefined
      let handleOnly: string | undefined

      for (const level of effective) {
        // ① 用户自己的官方平台 key（本地直连、不扣积分）
        if (level === 'official_key') {
          const adapter = options.channels?.adapters[channel]
          if (adapter === undefined) continue // 没配 → 落下一级
          const out = await adapter.search({
            q: input.q,
            ...(input.limit === undefined ? {} : { limit: input.limit }),
          })
          if (!out.ok) {
            // 适配器在但没填 key（`not_connected`）＝这一级"没配"，落下一级；
            // 真报错（配额、上游故障…）才停：不静默回退到花钱的那一级
            if (out.reason === 'not_connected') continue
            // WP416：这家只能按账号名查、给的是关键词——这一级做不了这件事，落下一级（公共库那一级能按关键词找）
            if (out.reason === 'handle_only') {
              handleOnly = out.message
              continue
            }
            emit('kol.search_failed', actor.person_id, { channel, reason: out.reason })
            return {
              ok: false,
              source: 'channel',
              rows: [],
              reason: out.reason,
              message: `你自己的 ${channelLabel(channel)} 接口这次没答上来：${out.message}`,
              failed_level: 'official_key',
              ...(fallbackOffer === undefined ? {} : { fallback_offer: fallbackOffer }),
            }
          }
          const rows: KolSearchHit[] = out.data
            .filter((hit) => inBand(hit.followers, input))
            .map((hit) => ({
              channel: hit.channel,
              handle: hit.handle,
              url: hit.url,
              display_name: hit.display_name,
              ...(hit.followers === undefined ? {} : { followers: hit.followers }),
              ...(hit.engagement_rate === undefined
                ? {}
                : { engagement_rate: hit.engagement_rate }),
              ...(hit.category === undefined ? {} : { category: hit.category }),
              ...(hit.language === undefined ? {} : { language: hit.language }),
              ...(hit.region === undefined ? {} : { region: hit.region }),
              in_library: known.has(normalizeHandle(hit.handle)),
            }))
          return {
            ok: true,
            source: 'channel',
            rows,
            source_label: `我的 ${channelLabel(channel)} key`,
            observed_at: out.observed_at,
          } satisfies KolSearchResult
        }

        // ② 用户自带的数据接口（跑本机、走用户自己的额度、不扣积分）
        if (level === 'byo_source') {
          const byo = options.byoDataSource?.(channel)
          if (byo === undefined) continue // 没配 → 落下一级
          const out = await byoSearch(
            byo,
            options.byoSecrets ?? (() => undefined),
            {
              channel,
              q: input.q,
              ...(input.limit === undefined ? {} : { limit: input.limit }),
              ...(input.min_followers === undefined ? {} : { min_followers: input.min_followers }),
              ...(input.max_followers === undefined ? {} : { max_followers: input.max_followers }),
            },
            known,
            options.byoFetch,
          )
          if (!out.ok) {
            // 同一条纪律：配了但报错不静默回退
            return {
              ok: false,
              source: 'byo_source',
              rows: [],
              ...(out.reason === undefined ? {} : { reason: out.reason }),
              message: `你自己的数据接口这次没答上来：${out.message}`,
              failed_level: 'byo_source',
              ...(fallbackOffer === undefined ? {} : { fallback_offer: fallbackOffer }),
            }
          }
          return {
            ok: true,
            source: 'byo_source',
            rows: out.data?.rows ?? [],
            source_label: '我的数据接口',
            ...(out.data?.observed_at === undefined
              ? {}
              : { observed_at: out.data?.observed_at ?? '' }),
          } satisfies KolSearchResult
        }

        // ③ Agents 工坊官方数据接口（积分；对外只有这一个名字）
        if (level === 'workshop') {
          const out = await publicSearch(input)
          if (out.ok) return { ...out, source_label: '公共红人库' }
          // not_linked = 这一级"没配"：落下一级（④）。别的失败也照实往下落，
          // 原因记在 lastFailure 里给 ④ 的 message 用
          lastWorkshopFailure = out
        }
      }

      // WP416：自己的 key 只能按账号名查、别的级又没答上来——照实说（调用方退回本地库 / 指去插件）
      if (handleOnly !== undefined)
        return {
          ok: false,
          source: 'channel',
          rows: [],
          reason: 'handle_only',
          message: handleOnly,
        }
      // ④ 都没有（或都没配）：人话 + 两个入口
      const base = nothingConfigured(channel)
      // 压根没关联：那一级等于没配，两句话就是 base（「去关联」是第一个按钮）
      if (lastWorkshopFailure === undefined || options.publicLibrary?.linked() !== true) return base
      /*
       * 工坊那一级试过但没成（关联了但权限不够、云连不上……）：第一句换成它的原因，
       * 第二句仍是那两条路。原因是云那边给的一句人话，去掉结尾句号再接。
       */
      return {
        ...base,
        message: `现在搜不了 ${channelLabel(channel)} 上的红人：工坊官方数据接口这次没用上——${(lastWorkshopFailure.message ?? '').replace(/[。.]+$/, '')}。可以去账号与积分看看，或者接你自己的数据接口（不扣积分）。`,
      }
    },

    creator(_actor, id) {
      const found = store.creator(id)
      return found === undefined ? undefined : detailOf(found)
    },

    createCreator(actor, input) {
      const now = clock.now()
      const parsed = input.url === undefined ? undefined : parseCreatorUrl(input.url)
      const handle = normalizeHandle(input.handle ?? parsed?.handle ?? input.display_name)
      if (handle === '')
        throw new ApiError(
          'invalid_input',
          '得有一个账号名或者主页链接——渠道之间零共享数据，一条账号靠 渠道 + handle 才认得出来。',
        )
      const channel: KolChannel = parsed?.channel ?? input.channel
      // 同一渠道同一 handle 已经在库里 = 这就是同一条账号，不建第二条
      const existing = store.accounts({ channel }).find((a) => normalizeHandle(a.handle) === handle)
      if (existing !== undefined) return detailOf(creatorOr404(existing.creator_id))

      const creator: Creator = {
        id: nextId('cre'),
        display_name: input.display_name,
        merged_from: [],
      }
      store.saveCreator(creator)
      store.saveAccount({
        id: nextId('pa'),
        creator_id: creator.id,
        channel,
        handle,
        url: input.url ?? parsed?.url ?? '',
        ...(input.followers === undefined ? {} : { followers: input.followers }),
        ...(input.engagement_rate === undefined ? {} : { engagement_rate: input.engagement_rate }),
        ...(input.category === undefined ? {} : { category: input.category }),
        ...(input.language === undefined ? {} : { language: input.language }),
        ...(input.region === undefined ? {} : { region: input.region.toUpperCase() }),
        observed_at: now,
      })
      emit('kol.creator_created', actor.person_id, { creator_id: creator.id, channel, handle })
      return detailOf(creator)
    },

    patchCreator(actor, id, input) {
      const creator = creatorOr404(id)
      if (input.display_name !== undefined && input.display_name !== creator.display_name)
        store.saveCreator({ ...creator, display_name: input.display_name })
      if (input.account !== undefined) {
        const account = store
          .accounts({ creator_id: id })
          .find((a) => a.id === (input.account as { id: string }).id)
        if (account === undefined) throw new ApiError('not_found', '这个红人名下没有这条渠道账号')
        const patch = input.account as Partial<PlatformAccount>
        const next: PlatformAccount = {
          ...account,
          ...(patch.followers === undefined ? {} : { followers: patch.followers }),
          ...(patch.engagement_rate === undefined
            ? {}
            : { engagement_rate: patch.engagement_rate }),
          ...(patch.category === undefined ? {} : { category: patch.category }),
          ...(patch.language === undefined ? {} : { language: patch.language }),
          ...(patch.region === undefined ? {} : { region: patch.region.toUpperCase() }),
          // 资料改了，"这份数字是什么时候看到的"就得跟着走——不然半年前的粉丝数
          // 会顶着今天的时间戳去打分
          observed_at: patch.observed_at ?? clock.now(),
        }
        store.saveAccount(next)
      }
      emit('kol.creator_updated', actor.person_id, { creator_id: id })
      return detailOf(creatorOr404(id))
    },

    /*
     * WP502（决策 1763 B）：人工标签 / 审核决定。是人自己的判断，按下就算（不出卡）；只记本机，
     * 事件里只有 id 与动作，不带标签原文与理由（理由可能写着对这个人的评价）。
     */
    setCreatorTags(actor, id, input) {
      creatorOr404(id)
      const tags = cleanTags(input.tags)
      store.saveCreatorTags({ id, creator_id: id, tags, updated_at: clock.now() })
      emit('kol.creator_tagged', actor.person_id, { creator_id: id, count: tags.length })
      return detailOf(creatorOr404(id))
    },

    reviewCreator(actor, id, input) {
      creatorOr404(id)
      if (input.decision === 'pending') store.removeRow('creator_review', id)
      else {
        const reason = input.reason?.replace(/\s+/g, ' ').trim().slice(0, 300)
        store.saveCreatorReview({
          id,
          creator_id: id,
          decision: input.decision,
          ...(reason === undefined || reason === '' ? {} : { reason }),
          decided_at: clock.now(),
          decided_by: actor.person_id,
        })
      }
      emit('kol.creator_reviewed', actor.person_id, { creator_id: id, decision: input.decision })
      return detailOf(creatorOr404(id))
    },

    creatorMedia(_actor, id) {
      return options.media?.read(id)
    },

    addContact(actor, creator_id, input) {
      creatorOr404(creator_id)
      if (!secrets.available)
        throw new ApiError(
          'invalid_input',
          '这台机器的加密库还没开（缺 AGENTSWS_SECRETS_KEY），联系方式没地方安全地放。' +
            '桌面壳会自动生成这把钥匙；命令行起服务的话得自己给一把。',
        )
      const id = nextId('ctc')
      const value_ref = contactSecretId(id)
      // 明文只在这一行进加密库，函数返回之后这个进程里没人再引用它
      secrets.put(value_ref, { [CONTACT_SECRET_FIELD]: input.value.trim() })
      const row: CreatorContact = {
        id,
        creator_id,
        kind: input.kind,
        value_ref,
        source: input.source ?? 'manual',
      }
      store.saveContact(row)
      // 事件里只有 id 与种类——地址与它的脱敏形态都不进日志（21 §5）
      emit('kol.contact_saved', actor.person_id, {
        contact_id: id,
        creator_id,
        kind: input.kind,
        source: row.source,
      })
      return contactView(row)
    },

    async collaborations(_actor, filter) {
      const rows = store.collaborations({
        ...(filter.channel === undefined ? {} : { channel: filter.channel }),
        ...(filter.stage === undefined ? {} : { stage: filter.stage }),
      })
      return { rows: await withStatus(rows) }
    },

    async createCollaboration(actor, input) {
      const creator = creatorOr404(input.creator_id)
      const currency = input.currency ?? 'USD'
      const run_id = `run_kol_${nextId('c')}`
      const target: ObjectRef = { type: 'collaboration', id: nextId('col') }
      const { mandate, level } = actionOf(actor.assignment_id, COLLAB_ACTION)
      const outcome = await ledger.stage({
        workspace_id,
        role_id: actor.role_id,
        assignment_id: actor.assignment_id,
        run_id,
        change_set_id: `cs_${run_id}`,
        kind: 'kol_collaboration',
        target,
        before: null,
        after: {
          stage: 'sourced',
          creator_id: creator.id,
          creator_name: creator.display_name,
          channel: input.channel,
          ...(input.budget === undefined ? {} : { budget: input.budget }),
          currency,
          ...(input.campaign_id === undefined ? {} : { campaign_id: input.campaign_id }),
        },
        ...(input.budget === undefined
          ? {}
          : {
              money: {
                amount: input.budget,
                currency,
                // 本地档没有汇率源：同币种时基准额就是原额，`fx_rate` 写 1 并说明白
                amount_base: input.budget,
                base_currency: currency,
                fx_rate: 1,
                fx_at: clock.now(),
              },
            }),
        notes: [
          `与 ${creator.display_name} 在 ${input.channel} 上的一条合作${
            input.budget === undefined ? '' : `，预算 ${input.budget} ${currency}`
          }。`,
        ],
        created_by: { kind: 'person', id: actor.person_id },
        mandate,
        // 15 §2 hard_ceiling：`kol_collaboration` 在 HARD_L1 里，报什么都按回人审
        level,
        provenance: provenanceOf(run_id, [target, { type: 'creator', id: creator.id }]),
        approval: {
          title: `合作：${creator.display_name}（${input.channel}）`,
          summary:
            input.budget === undefined
              ? '这条合作还没定价钱。同意就把它建进库里，阶段从"已找到"开始。'
              : `这条合作要付 ${input.budget} ${currency}。同意就把它建进库里。`,
          recipients: [{ person: actor.person_id, via: 'owner' }],
          proposer: { kind: 'person', id: actor.person_id, assignment_id: actor.assignment_id },
          rule: 'owner',
          separation_of_duties: false,
          source_events: [],
        },
      })
      if (!outcome.ok) return { staged: false, message: outcome.message } satisfies KolStagedView
      /*
       * WP416（自查 kol B「建合作卡」）：这一行当场建出来、但标「等你点头」——点「同意」由执行器
       * （`kol-mail.ts`）清掉标记并读回，点「不要」这一行删掉。自动批了的（执行器已经落过库）不再标。
       */
      const auto = outcome.approval.automation.auto_approved
      const existing = store.collaboration(target.id)
      const row: Collaboration = existing ?? {
        id: target.id,
        creator_id: creator.id,
        channel: input.channel,
        stage: 'sourced',
        currency,
        ...(input.budget === undefined ? {} : { budget: input.budget }),
        ...(input.campaign_id === undefined ? {} : { campaign_id: input.campaign_id }),
        ...(auto ? {} : { awaiting_approval: true }),
      }
      if (existing === undefined) store.saveCollaboration(row)
      emit('kol.collaboration_staged', actor.person_id, {
        collaboration_id: row.id,
        creator_id: creator.id,
        channel: input.channel,
        change_id: outcome.change.id,
        approval_item_id: outcome.approval.id,
        auto_approved: outcome.approval.automation.auto_approved,
      })
      return {
        staged: true,
        change_id: outcome.change.id,
        approval_item_id: outcome.approval.id,
        auto_approved: outcome.approval.automation.auto_approved,
        collaboration: row,
      }
    },

    /**
     * WP117b（66 复测 #19）：**议价**——给一条已经存在的合作报一个数。
     *
     * 为什么不复用 `createCollaboration`：那一条是"新建一条合作"，给已经在谈的人
     * 再建一条，库里就有两条指着同一个人的合作，阶段各走各的。议价改的是**这一条**。
     *
     * 出的是一张 money 排版的卡（`kol_collaboration` 在 15 §2 的 `HARD_L1` 里，
     * 报什么数都按回人审）。**批了才算数**：这里一个字都不往库里写，
     * 预算与阶段推进由施行那一跳做（`kolQuoteApply`）——与开发信同一条路，
     * 也是 66 断点 #5「接口 200 但界面上什么都没发生」的反面。
     */
    async quoteCollaboration(actor, id, input) {
      const row = store.collaboration(id)
      if (row === undefined) throw new ApiError('not_found', '库里没有这条合作')
      const creator = creatorOr404(row.creator_id)
      const currency = input.currency ?? row.currency
      const run_id = `run_kol_${nextId('q')}`
      const target: ObjectRef = { type: 'collaboration', id: row.id }
      const { mandate, level } = actionOf(actor.assignment_id, COLLAB_ACTION)
      const outcome = await ledger.stage({
        workspace_id,
        role_id: actor.role_id,
        assignment_id: actor.assignment_id,
        run_id,
        change_set_id: `cs_${run_id}`,
        kind: 'kol_collaboration',
        target,
        before: { budget: row.budget ?? null, stage: row.stage, currency: row.currency },
        after: {
          collaboration_id: row.id,
          creator_id: creator.id,
          creator_name: creator.display_name,
          channel: row.channel,
          budget: input.budget,
          currency,
          stage: 'negotiating',
        },
        money: {
          amount: input.budget,
          currency,
          amount_base: input.budget,
          base_currency: currency,
          fx_rate: 1,
          fx_at: clock.now(),
        },
        notes: [
          `给 ${creator.display_name} 报 ${input.budget} ${currency}${
            input.note === undefined ? '' : `：${input.note}`
          }`,
        ],
        created_by: { kind: 'person', id: actor.person_id },
        mandate,
        level,
        provenance: provenanceOf(run_id, [target, { type: 'creator', id: creator.id }]),
        approval: {
          title: `议价：${creator.display_name}（${input.budget} ${currency}）`,
          summary: `这条合作要付 ${input.budget} ${currency}。批了才作数，批完这条合作进「谈条件中」。`,
          recipients: [{ person: actor.person_id, via: 'owner' }],
          proposer: { kind: 'person', id: actor.person_id, assignment_id: actor.assignment_id },
          rule: 'owner',
          separation_of_duties: false,
          source_events: [],
        },
      })
      if (!outcome.ok) return { staged: false, message: outcome.message } satisfies KolStagedView
      emit('kol.collaboration_quoted', actor.person_id, {
        collaboration_id: row.id,
        creator_id: creator.id,
        budget: input.budget,
        currency,
        change_id: outcome.change.id,
        approval_item_id: outcome.approval.id,
        auto_approved: outcome.approval.automation.auto_approved,
      })
      return {
        staged: true,
        change_id: outcome.change.id,
        approval_item_id: outcome.approval.id,
        auto_approved: outcome.approval.automation.auto_approved,
      }
    },

    /*
     * WP299（决策 386）：寄样。谈成之后才给；收件地址明文只进本机加密库，账本 / 事件 / 卡面上
     * 只有 key 名与脱敏样子。有成本 → 一张「花钱」卡（`kol_sample`，永远人审），批了才落库、
     * 合作进「已寄样」（`kolSampleApply`）；没成本 → 当场记下（不花钱就不用批）。
     */
    async shipSample(actor, id, input) {
      const row = store.collaboration(id)
      if (row === undefined) throw new ApiError('not_found', '库里没有这条合作')
      if (!SAMPLE_STAGES.includes(row.stage))
        throw new ApiError(
          'invalid_input',
          `谈成之后才寄样——这条合作现在是「${collaborationStageName(row.stage)}」。`,
        )
      if (!secrets.available)
        throw new ApiError(
          'invalid_input',
          '这台机器的加密库还没开（缺 AGENTSWS_SECRETS_KEY），收件地址没地方安全地放。',
        )
      const creator = creatorOr404(row.creator_id)
      const address_ref = `${SAMPLE_SECRET_PREFIX}${nextId('smp')}`
      // 明文只在这一行进加密库
      secrets.put(address_ref, { [SAMPLE_SECRET_FIELD]: input.address.trim() })
      const currency = input.currency ?? row.currency
      const cost = input.cost !== undefined && input.cost > 0 ? input.cost : undefined
      const sample: KolSample = {
        address_ref,
        address_masked: maskAddress(input.address),
        ...(input.carrier === undefined || input.carrier === '' ? {} : { carrier: input.carrier }),
        ...(input.tracking_no === undefined || input.tracking_no === ''
          ? {}
          : { tracking_no: input.tracking_no }),
        ...(cost === undefined ? {} : { cost }),
        currency,
        shipped_at: clock.now(),
      }
      if (cost === undefined) {
        store.saveCollaboration(withSample(row, sample, clock.now()))
        emit('kol.sample_shipped', actor.person_id, {
          collaboration_id: row.id,
          creator_id: creator.id,
          ...(sample.carrier === undefined ? {} : { carrier: sample.carrier }),
          cost: 0,
        })
        return {
          staged: false,
          applied: true,
          message: '记下了：已寄样（没有成本，不用批）。',
        } satisfies KolStagedView
      }
      const run_id = `run_kol_${nextId('s')}`
      const target: ObjectRef = { type: 'collaboration', id: row.id }
      const { mandate, level } = actionOf(actor.assignment_id, COLLAB_ACTION)
      const outcome = await ledger.stage({
        workspace_id,
        role_id: actor.role_id,
        assignment_id: actor.assignment_id,
        run_id,
        change_set_id: `cs_${run_id}`,
        kind: 'kol_sample',
        target,
        before: { stage: row.stage, sample: row.sample ?? null },
        after: {
          collaboration_id: row.id,
          creator_id: creator.id,
          creator_name: creator.display_name,
          channel: row.channel,
          sample,
          stage: row.stage === 'agreed' ? 'sample_sent' : row.stage,
        },
        money: {
          amount: cost,
          currency,
          amount_base: cost,
          base_currency: currency,
          fx_rate: 1,
          fx_at: clock.now(),
        },
        notes: [
          `给 ${creator.display_name} 寄一份样品（寄到 ${sample.address_masked}${
            sample.carrier === undefined ? '' : `，${sample.carrier}`
          }${sample.tracking_no === undefined ? '' : ` ${sample.tracking_no}`}）`,
        ],
        created_by: { kind: 'person', id: actor.person_id },
        mandate,
        level,
        provenance: provenanceOf(run_id, [target, { type: 'creator', id: creator.id }]),
        approval: {
          title: `寄样：${creator.display_name}（${cost} ${currency}）`,
          // WP416（自查 kol B「寄样」）：照实说这一步只记录，不替你下单发货
          summary: `给 ${creator.display_name} 寄一份样品，成本 ${cost} ${currency}。批了只记一笔账、合作进「已寄样」——不会替你下单发货，货要你自己寄。`,
          recipients: [{ person: actor.person_id, via: 'owner' }],
          proposer: { kind: 'person', id: actor.person_id, assignment_id: actor.assignment_id },
          rule: 'owner',
          separation_of_duties: false,
          source_events: [],
        },
      })
      if (!outcome.ok) return { staged: false, message: outcome.message } satisfies KolStagedView
      emit('kol.sample_staged', actor.person_id, {
        collaboration_id: row.id,
        creator_id: creator.id,
        cost,
        currency,
        change_id: outcome.change.id,
        approval_item_id: outcome.approval.id,
      })
      return {
        staged: true,
        change_id: outcome.change.id,
        approval_item_id: outcome.approval.id,
        auto_approved: outcome.approval.automation.auto_approved,
      }
    },

    /*
     * WP299（决策 387）：付款登记。谈成之后才给；一张「花钱」卡（`kol_payment`，永远人审），
     * 批了才往 `payments` 里记一笔（`kolPaymentApply`）。加上这一笔超过谈定预算的，卡上说一句
     * （guardrail 记一条 review，不拦——尾款加个运费是常事，人看一眼就行）。
     */
    async recordPayment(actor, id, input) {
      const row = store.collaboration(id)
      if (row === undefined) throw new ApiError('not_found', '库里没有这条合作')
      if (!PAYMENT_STAGES.includes(row.stage))
        throw new ApiError(
          'invalid_input',
          `谈成之后才付款——这条合作现在是「${collaborationStageName(row.stage)}」。`,
        )
      const creator = creatorOr404(row.creator_id)
      const currency = input.currency ?? row.currency
      const paidBefore = (row.payments ?? []).reduce((sum, p) => sum + p.amount, 0)
      const total = Math.round((paidBefore + input.amount) * 100) / 100
      const over = row.budget !== undefined && total > row.budget
      const payment: KolPayment = {
        id: nextId('pay'),
        amount: input.amount,
        currency,
        ...(input.note === undefined || input.note === '' ? {} : { note: input.note }),
        paid_at: clock.now(),
      }
      const run_id = `run_kol_${nextId('p')}`
      const target: ObjectRef = { type: 'collaboration', id: row.id }
      const { mandate, level } = actionOf(actor.assignment_id, COLLAB_ACTION)
      const outcome = await ledger.stage({
        workspace_id,
        role_id: actor.role_id,
        assignment_id: actor.assignment_id,
        run_id,
        change_set_id: `cs_${run_id}`,
        kind: 'kol_payment',
        target,
        before: { paid: paidBefore, budget: row.budget ?? null },
        after: {
          collaboration_id: row.id,
          creator_id: creator.id,
          creator_name: creator.display_name,
          channel: row.channel,
          payment,
          paid_total: total,
          ...(row.budget === undefined ? {} : { budget: row.budget }),
          over_budget: over,
        },
        money: {
          amount: input.amount,
          currency,
          amount_base: input.amount,
          base_currency: currency,
          fx_rate: 1,
          fx_at: clock.now(),
        },
        notes: [
          `付给 ${creator.display_name} ${input.amount} ${currency}${
            input.note === undefined || input.note === '' ? '' : `：${input.note}`
          }`,
          ...(over
            ? [`加上这一笔一共付 ${total} ${currency}，超过谈定的 ${row.budget} ${row.currency}。`]
            : []),
        ],
        created_by: { kind: 'person', id: actor.person_id },
        mandate,
        level,
        provenance: provenanceOf(run_id, [target, { type: 'creator', id: creator.id }]),
        approval: {
          title: `付款：${creator.display_name}（${input.amount} ${currency}）`,
          summary: over
            ? `付给 ${creator.display_name} ${input.amount} ${currency}；加上这一笔超过谈定的 ${row.budget} ${row.currency}。批了才记账。`
            : `付给 ${creator.display_name} ${input.amount} ${currency}。批了才记账。`,
          recipients: [{ person: actor.person_id, via: 'owner' }],
          proposer: { kind: 'person', id: actor.person_id, assignment_id: actor.assignment_id },
          rule: 'owner',
          separation_of_duties: false,
          source_events: [],
        },
      })
      if (!outcome.ok) return { staged: false, message: outcome.message } satisfies KolStagedView
      emit('kol.payment_staged', actor.person_id, {
        collaboration_id: row.id,
        creator_id: creator.id,
        amount: input.amount,
        currency,
        over_budget: over,
        change_id: outcome.change.id,
        approval_item_id: outcome.approval.id,
      })
      return {
        staged: true,
        change_id: outcome.change.id,
        approval_item_id: outcome.approval.id,
        auto_approved: outcome.approval.automation.auto_approved,
      }
    },

    advanceCollaboration(actor, id, input) {
      const row = store.collaboration(id)
      if (row === undefined) throw new ApiError('not_found', '库里没有这条合作')
      let stage: CollaborationStage
      try {
        // 合法迁移表只有 `kol-core` 那一份；这里连"哪些能跳"都不判
        stage = advanceCollaboration(row.stage, input.stage)
      } catch (e) {
        if (e instanceof StageTransitionError) throw new ApiError('invalid_input', e.message)
        throw e
      }
      const next: Collaboration = {
        ...row,
        stage,
        // 谈成那一刻记下来：归因与预算都要知道"从哪天起这笔钱算数"
        ...(stage === 'agreed' && row.agreed_at === undefined ? { agreed_at: clock.now() } : {}),
        // WP117b（66 复测 #18）：推一步阶段也是一次动静，清单上那一列要跟着走
        last_activity_at: clock.now(),
      }
      store.saveCollaboration(next)
      emit('kol.collaboration_stage_changed', actor.person_id, {
        collaboration_id: id,
        from: row.stage,
        to: next.stage,
        label: collaborationStageName(next.stage),
      })
      return next
    },

    deliverables(_actor, filter) {
      return {
        rows: store.deliverables({
          ...(filter.collaboration_id === undefined
            ? {}
            : { collaboration_id: filter.collaboration_id }),
          ...(filter.pending === undefined ? {} : { pending: filter.pending }),
        }),
      }
    },

    createDeliverable(actor, input) {
      const owner = store.collaboration(input.collaboration_id)
      if (owner === undefined) throw new ApiError('not_found', '库里没有这条合作，交付物挂不上去')
      // WP117b（66 复测 #18）：登记一条交付物也是一次动静
      store.saveCollaboration({ ...owner, last_activity_at: clock.now() })
      const row: Deliverable = {
        id: nextId('dlv'),
        collaboration_id: input.collaboration_id,
        kind: input.kind,
        due_at: input.due_at,
        review: 'pending',
        ...(input.url === undefined ? {} : { url: input.url }),
      }
      store.saveDeliverable(row)
      emit('kol.deliverable_created', actor.person_id, {
        deliverable_id: row.id,
        collaboration_id: row.collaboration_id,
        kind: row.kind,
      })
      return row
    },

    async reviewDeliverable(actor, id, input) {
      const row = store.deliverables().find((d) => d.id === id)
      if (row === undefined) throw new ApiError('not_found', '库里没有这件交付物')
      let review: Deliverable['review']
      try {
        review = advanceDeliverable(row.review, input.review)
      } catch (e) {
        if (e instanceof StageTransitionError) throw new ApiError('invalid_input', e.message)
        throw e
      }
      const next: Deliverable = {
        ...row,
        review,
        ...(input.notes === undefined ? {} : { notes: input.notes }),
      }
      const collab = store.collaboration(row.collaboration_id)
      const run_id = `run_kol_${nextId('r')}`
      const target: ObjectRef = { type: 'deliverable', id }
      const { mandate, level } = actionOf(actor.assignment_id, REVIEW_ACTION)
      const outcome = await ledger.stage({
        workspace_id,
        role_id: actor.role_id,
        assignment_id: actor.assignment_id,
        run_id,
        change_set_id: `cs_${run_id}`,
        kind: 'kol_deliverable_review',
        target,
        field: 'review',
        before: { review: row.review },
        after: {
          review: input.review,
          review_label: deliverableReviewName(input.review),
          ...(input.notes === undefined ? {} : { notes: input.notes }),
        },
        notes: input.notes === undefined ? [] : [input.notes],
        created_by: { kind: 'person', id: actor.person_id },
        mandate,
        level,
        provenance: provenanceOf(run_id, [target]),
        approval: {
          title: `审核结论：${deliverableReviewName(input.review)}`,
          summary:
            `${collab === undefined ? '' : `${collab.channel} · `}${row.kind} 这一件的结论是「${deliverableReviewName(input.review)}」。` +
            (input.notes === undefined ? '' : `理由：${input.notes}`),
          recipients: [{ person: actor.person_id, via: 'role_holder' }],
          proposer: { kind: 'person', id: actor.person_id, assignment_id: actor.assignment_id },
          rule: 'role_holder',
          separation_of_duties: false,
          source_events: [],
        },
      })
      if (!outcome.ok) return { staged: false, message: outcome.message }
      // L2 自动批时结论当场生效；要人点的那一档，库里这一行等人点完再由界面推一次
      if (outcome.approval.automation.auto_approved) store.saveDeliverable(next)
      emit('kol.deliverable_reviewed', actor.person_id, {
        deliverable_id: id,
        review: input.review,
        change_id: outcome.change.id,
        approval_item_id: outcome.approval.id,
        auto_approved: outcome.approval.automation.auto_approved,
      })
      return {
        staged: true,
        change_id: outcome.change.id,
        approval_item_id: outcome.approval.id,
        auto_approved: outcome.approval.automation.auto_approved,
      }
    },

    trackedLinks(_actor, filter) {
      return { rows: store.links(filter.collaboration_id) }
    },

    /**
     * WP117b（66 复测 #19）：这条合作来往过什么。
     *
     * 时间正序（库里那一层已经排好），**正文原样端出去**——合作线程页上
     * 要看得见我们发的那一封与他回的那一封，不是一句"有 3 封往来"。
     */
    exchanges(_actor, filter) {
      const rows = store.exchanges({
        ...(filter.collaboration_id === undefined
          ? {}
          : { collaboration_id: filter.collaboration_id }),
        ...(filter.creator_id === undefined ? {} : { creator_id: filter.creator_id }),
      })
      return { rows: filter.limit === undefined ? rows : rows.slice(-filter.limit) }
    },

    createTrackedLink(actor, input) {
      const collab = store.collaboration(input.collaboration_id)
      if (collab === undefined) throw new ApiError('not_found', '库里没有这条合作')
      /*
       * WP117b：活动名不给了就默认用这条合作的活动 id（没有活动就用合作 id）。
       * UTM 会出现在公开链接上，所以用 id 而不是人起的名字——稳、不重复、不泄懒。
       */
      const campaign = input.campaign ?? collab.campaign_id ?? collab.id
      const account = store.accounts({ creator_id: collab.creator_id, channel: collab.channel })[0]
      const utm = buildUtm({
        channel: collab.channel,
        campaign,
        // `content` 放的是合作 id 而不是红人的名字：UTM 会出现在公开链接上
        collaboration_id: collab.id,
        ...(input.utm?.term === undefined ? {} : { term: input.utm.term }),
      })
      // 三参数（source / medium / campaign）由 `buildUtm` 说了算——调用方改得了的
      // 只有 term 与 content，改了那三格就等于把归因的口径换掉了
      const merged: KolUtm = {
        ...utm,
        ...(input.utm?.content === undefined ? {} : { content: input.utm.content }),
      }
      const row: TrackedLink = {
        id: nextId('tl'),
        collaboration_id: collab.id,
        url: applyUtm(input.url, merged),
        utm: merged,
        affiliate_code:
          input.affiliate_code ?? affiliateCode({ handle: account?.handle ?? collab.creator_id }),
        clicks: 0,
        orders: 0,
        revenue: 0,
      }
      store.saveLink(row)
      emit('kol.tracked_link_created', actor.person_id, {
        tracked_link_id: row.id,
        collaboration_id: collab.id,
        campaign: merged.campaign,
      })
      return row
    },

    importTable(actor, input) {
      const name = (input.filename ?? '').toLowerCase()
      const note = name.endsWith('.xlsx') || name.endsWith('.xls') ? XLSX_NOTE : undefined
      const rows = readTable(input.content)
      const result = importAccounts(rows)
      const now = clock.now()

      let created_creators = 0
      let created_accounts = 0
      let updated_accounts = 0
      let created_contacts = 0

      for (const account of result.accounts) {
        const existing = store
          .accounts({ channel: account.channel })
          .find((a) => normalizeHandle(a.handle) === account.handle)
        if (existing !== undefined) {
          store.saveAccount(mergeAccount(existing, account, now))
          updated_accounts += 1
          if (account.email !== undefined && secrets.available)
            created_contacts += saveEmail(existing.creator_id, account.email) ? 1 : 0
          continue
        }
        const creator: Creator = {
          id: nextId('cre'),
          display_name: account.display_name ?? account.handle,
          merged_from: [],
        }
        store.saveCreator(creator)
        created_creators += 1
        store.saveAccount({
          id: nextId('pa'),
          creator_id: creator.id,
          channel: account.channel,
          handle: account.handle,
          url: account.url,
          ...(account.followers === undefined ? {} : { followers: account.followers }),
          ...(account.engagement_rate === undefined
            ? {}
            : { engagement_rate: account.engagement_rate }),
          ...(account.category === undefined ? {} : { category: account.category }),
          ...(account.language === undefined ? {} : { language: account.language }),
          ...(account.region === undefined ? {} : { region: account.region }),
          observed_at: now,
        })
        created_accounts += 1
        if (account.email !== undefined && secrets.available)
          created_contacts += saveEmail(creator.id, account.email) ? 1 : 0
      }

      emit('kol.table_imported', actor.person_id, {
        accounts: result.accounts.length,
        created_creators,
        created_accounts,
        updated_accounts,
        created_contacts,
        duplicates: result.duplicates.length,
        rejected: result.rejected.length,
      })

      return {
        summary: importSummary(result),
        created_creators,
        created_accounts,
        updated_accounts,
        created_contacts,
        duplicates: result.duplicates,
        rejected: result.rejected,
        unmapped: result.mapping.unmapped,
        ...(note === undefined ? {} : { note }),
      } satisfies KolImportView
    },

    outreachDefaults() {
      return outreachDefaultsOf()
    },

    saveOutreachDefaults(actor, input) {
      const prev = savedDefaults()
      const next: SavedOutreachDefaults = {
        ...prev,
        ...(input.brand_pitch === undefined ? {} : { brand_pitch: input.brand_pitch.trim() }),
        ...(input.product === undefined ? {} : { product: input.product.trim() }),
      }
      store.saveSetting('outreach_defaults', next, clock.now())
      emit('kol.outreach_defaults_saved', actor.person_id, {
        brand_pitch: input.brand_pitch !== undefined,
        product: input.product !== undefined,
      })
      return outreachDefaultsOf()
    },

    async outreach(actor, input) {
      const creator = creatorOr404(input.creator_id)
      const account = store.accounts({ creator_id: creator.id, channel: input.channel })[0]
      const language = outreachLanguageOf(account?.language)
      /*
       * WP416（决策 531，自查 kol A1）：「一句话介绍我们」不给就**从品牌这边补**——先取你存过的，
       * 再取品牌档案里的一句话介绍。都没有才照旧说缺（AI 起草时会自己写一句传进来，卡上标出来让你看）。
       */
      const defaults = outreachDefaultsOf()
      const given = input.brand_pitch?.trim()
      const brand_pitch =
        given !== undefined && given !== ''
          ? given
          : defaults.brand_pitch === ''
            ? undefined
            : defaults.brand_pitch
      const pitch_note =
        given !== undefined && given !== ''
          ? input.pitch_by_ai === true
            ? '「一句话介绍我们」是 AI 按品牌情况写的（品牌档案里还没有这一句）；不对就点「修改」。'
            : undefined
          : brand_pitch === undefined
            ? undefined
            : defaults.source === 'brand_profile'
              ? '「一句话介绍我们」取自品牌档案；不对就点「修改」。'
              : undefined
      // WP416（自查 kol U-x5）：英文信默认不署中文名——取不到英文名就用「品牌名 + team」
      const person = input.sender_name ?? (await options.personName(actor.person_id))
      const sender_name =
        input.sender_name === undefined && language === 'en' && hasCjk(person)
          ? `The ${options.brandName()} team`
          : person
      return stageOutreach({
        actor,
        creator,
        channel: input.channel,
        step: input.step ?? 'first',
        ...(pitch_note === undefined ? {} : { pitch_note }),
        vars: {
          product: input.product,
          /*
           * WP295：`reason` 不给就写一句**给红人看的**「为什么找你」（按他做的内容）。
           * 以前用打分里最高那一项的说明（「372,274 粉，正好在想要的区间里。」）——那是我们挑人的
           * 内部理由，原样进了发给对方的信。打分理由仍在卡的依据里，不进正文。
           */
          reason:
            input.reason ??
            outreachReason({ channel: input.channel, language, category: account?.category }),
          language,
          /*
           * **`brand_pitch` 没有默认值**。"我们是做什么的"这句话只有用户自己知道，
           * 编一个出来最好的情况也是废话（"我是 NordVolt 的王岚。我们是 NordVolt。"），
           * 最坏的情况是替他向红人说了一句不实的话。缺了就照 `draftOutreach`
           * 的规矩走：不起草，把缺的那一格说出来。
           */
          ...(brand_pitch === undefined ? {} : { brand_pitch }),
          sender_name,
        },
      })
    },

    async planCampaign(actor, input) {
      /*
       * WP416：AI 给了名单就排这几个人；预算没给（0）时按这条职责的合作预算上限 × 人数起一个数
       * （卡上照样能改）——以前预算缺省 0 被判为「缺口」，这张卡永远出不来。
       */
      const named = input.creator_ids === undefined ? undefined : new Set(input.creator_ids)
      const cap = (() => {
        const mine = assignmentForChannel(actor.person_id, input.channels[0] ?? 'youtube')
        if (mine === undefined) return undefined
        const c = actionOf(mine.id, COLLAB_ACTION).mandate.caps.max_collab_budget
        return typeof c === 'number' && c > 0 ? c : undefined
      })()
      const budget =
        input.budget > 0 || named === undefined || cap === undefined
          ? input.budget
          : cap * named.size
      const brief: CampaignBrief = {
        goal: input.goal,
        budget,
        currency: input.currency ?? 'USD',
        channels: input.channels,
        headcount: input.headcount,
        ...(input.criteria === undefined
          ? {}
          : {
              criteria: {
                ...(input.criteria.category === undefined
                  ? {}
                  : { category: input.criteria.category }),
                ...(input.criteria.language === undefined
                  ? {}
                  : { language: input.criteria.language }),
                ...(input.criteria.region === undefined ? {} : { region: input.criteria.region }),
                ...(input.criteria.followers_band === undefined
                  ? {}
                  : { followers_band: input.criteria.followers_band }),
              },
            }),
      }
      const plan = planCampaign(
        brief,
        store.accounts().filter((a) => named === undefined || named.has(a.creator_id)),
        clock.now(),
      )
      const campaign_id = nextId('cmp')
      const existing = store.collaborations()
      const by_channel: KolCampaignGroup[] = plan.by_channel.map((group) => {
        const mine = assignmentForChannel(actor.person_id, group.channel)
        const picks: KolCampaignPick[] = group.picks.map((pick) => ({
          creator_id: pick.account.creator_id,
          display_name:
            store.creator(pick.account.creator_id)?.display_name ?? pick.account.creator_id,
          channel: group.channel,
          handle: pick.account.handle,
          ...(pick.account.followers === undefined ? {} : { followers: pick.account.followers }),
          score: pick.score.total,
          why: [...pick.score.factors]
            .sort((a, b) => b.score - a.score)
            .slice(0, 2)
            .map((f) => f.why),
          already: existing.some(
            (c) => c.creator_id === pick.account.creator_id && c.channel === group.channel,
          ),
        }))
        return {
          channel: group.channel,
          role_id: group.role_id,
          allowed: mine !== undefined,
          ...(mine === undefined ? {} : { assignment_id: mine.id }),
          ...(mine === undefined
            ? {
                // WP141：不把职责 id 印给人看——说「{渠道}红人」这条职责
                reason: `你名下没有「${channelLabel(group.channel)} 红人」这条职责，所以这一组只能看不能建。要做这条渠道，让负责人把这条职责分给你——一次挑人不会把别人的权限并给你。`,
              }
            : {}),
          picks,
        }
      })

      const view: KolCampaignView = {
        campaign_id,
        ready: plan.ready,
        gaps: plan.gaps,
        message: plan.message,
        by_channel,
        budget_per_creator: plan.budget_per_creator,
      }
      if (!plan.ready) return view

      const total = by_channel.reduce((n, g) => n + g.picks.length, 0)
      const blocked = by_channel.filter((g) => !g.allowed)
      const item = await approvals.create({
        workspace_id,
        schema_version: 1,
        kind: 'kol_campaign',
        role_id: actor.role_id,
        subject: { object: { type: 'campaign', id: campaign_id } },
        dedupe_key: `${workspace_id}:kol_campaign:${campaign_id}`,
        // WP141（docs/78 §2 红人）：标题与摘要里不夹英文词、不印小写渠道值
        title: `挑人清单：${input.goal}（${total} 人）`,
        summary:
          `按 ${input.channels.map(channelLabel).join(' / ')} 分组，人均预算 ${plan.budget_per_creator} ${brief.currency}。` +
          `接受就为每个人建一条合作（阶段从"已找到"开始），每条动作走各自渠道职责的额度。` +
          (blocked.length === 0
            ? ''
            : `其中 ${blocked.map((g) => channelLabel(g.channel)).join(' / ')} 这 ${blocked.length} 组你名下没有对应职责，灰着不建。`),
        payload: { campaign_id, brief, by_channel },
        evidence: {
          source_events: [],
          provenance: {
            seen: by_channel.flatMap((g) =>
              g.picks.map((p): ObjectRef => ({ type: 'creator', id: p.creator_id })),
            ),
          },
          diff: {
            before: null,
            after: { collaborations: by_channel.filter((g) => g.allowed).length },
            summary: '接受后按渠道分别建一批合作',
          },
          precheck: {},
        },
        proposer: { kind: 'person', id: actor.person_id, assignment_id: actor.assignment_id },
        // L2：清单本身不改任何东西，它只是"这批人你认不认"
        automation: { level_at_creation: 'L2' },
        routing: {
          recipients: [{ person: actor.person_id, via: 'role_holder' }],
          rule: 'role_holder',
          escalation: {
            after_hours: 48,
            business_hours: true,
            chain: ['scope_manager'],
            escalated_at: [],
          },
          separation_of_duties: false,
        },
        priority: 'queue',
      })
      if (item.state !== 'blocked') view.approval_item_id = item.id
      emit('kol.campaign_planned', actor.person_id, {
        campaign_id,
        channels: input.channels,
        picks: total,
        blocked_channels: blocked.map((g) => g.channel),
        ...(view.approval_item_id === undefined ? {} : { approval_item_id: view.approval_item_id }),
      })
      return view
    },

    async acceptCampaign(actor, approval_item_id) {
      const item = await approvals.get(approval_item_id)
      if (item === undefined || item.kind !== 'kol_campaign' || item.workspace_id !== workspace_id)
        throw new ApiError('not_found', '没有这张 campaign 清单卡')
      const payload = item.payload as {
        campaign_id?: string
        by_channel?: KolCampaignGroup[]
      }
      const campaign_id = payload.campaign_id ?? approval_item_id
      const created: KolCampaignAcceptView['created'] = []
      const skipped: KolCampaignAcceptView['skipped'] = []

      for (const group of payload.by_channel ?? []) {
        /*
         * **每一组重新查一次本人有没有这条职责**，不信卡上那一格。
         * 卡可能是昨天出的，而职责昨天分出去今天收回来是一件正常的事——
         * 按卡面上的旧结论去建，就是拿一张过期的授权在写库。
         */
        const mine = assignmentForChannel(actor.person_id, group.channel)
        if (mine === undefined) {
          skipped.push({
            channel: group.channel,
            reason: `你名下没有「${group.role_id}」这条职责。一次 campaign 不并集权限（05 §4）。`,
          })
          continue
        }
        for (const pick of group.picks) {
          if (store.creator(pick.creator_id) === undefined) {
            skipped.push({
              channel: group.channel,
              creator_id: pick.creator_id,
              reason: '这个人已经不在库里了（可能刚被合并过）。',
            })
            continue
          }
          const already = store
            .collaborations({ channel: group.channel })
            .find((c) => c.creator_id === pick.creator_id)
          if (already !== undefined) {
            skipped.push({
              channel: group.channel,
              creator_id: pick.creator_id,
              reason: '这条渠道上已经有一条合作了，不重复建。',
            })
            continue
          }
          const out = await port.createCollaboration(
            // 用**那条渠道职责自己的分配**去建（额度、等级、权限全从它来）
            { ...actor, assignment_id: mine.id, role_id: mine.role_id },
            { creator_id: pick.creator_id, channel: group.channel, campaign_id },
          )
          if (out.collaboration === undefined) {
            skipped.push({
              channel: group.channel,
              creator_id: pick.creator_id,
              reason: out.message ?? '被 guardrail 拦下了。',
            })
            continue
          }
          created.push({
            channel: group.channel,
            creator_id: pick.creator_id,
            collaboration_id: out.collaboration.id,
          })
        }
      }
      emit('kol.campaign_accepted', actor.person_id, {
        campaign_id,
        approval_item_id,
        created: created.length,
        skipped: skipped.length,
      })
      return { campaign_id, created, skipped }
    },

    /* ── WP126：自带数据接口（高级卡；每渠道最多一个）────────────────── */

    byoSources() {
      const reader = options.byoSecrets ?? options.byo?.reader ?? (() => undefined)
      const rows = (['youtube', 'instagram', 'tiktok', 'facebook', 'x'] as const).flatMap(
        (channel) => {
          const rec = options.byo?.record(channel)
          if (rec === undefined) return []
          return [
            {
              channel: rec.channel,
              service_url: rec.service_url,
              format: rec.format,
              has_key: reader(rec.secret_ref) !== undefined,
              ...(rec.updated_at === undefined ? {} : { updated_at: rec.updated_at }),
            },
          ]
        },
      )
      return { rows }
    },

    setByoSource(_actor, input) {
      if (options.byo === undefined)
        throw new ApiError('not_implemented', '这台机器没有装配自带数据接口的那张卡。')
      const rec = options.byo.set(input.channel, {
        service_url: input.service_url,
        ...(input.api_key === undefined ? {} : { api_key: input.api_key }),
      })
      const reader = options.byoSecrets ?? options.byo.reader
      return {
        channel: rec.channel,
        service_url: rec.service_url,
        format: rec.format,
        has_key: reader(rec.secret_ref) !== undefined,
        ...(rec.updated_at === undefined ? {} : { updated_at: rec.updated_at }),
      }
    },

    clearByoSource(_actor, channel) {
      return { cleared: options.byo?.clear(channel) ?? false }
    },

    testByoSource(_actor, input) {
      const reader = options.byoSecrets ?? options.byo?.reader ?? (() => undefined)
      const config =
        input.service_url !== undefined
          ? {
              service_url: input.service_url,
              secret_ref: byoSecretId(input.channel),
              format: 'byo/v1' as const,
            }
          : options.byoDataSource?.(input.channel)
      if (config === undefined)
        return {
          ok: false,
          message:
            '还没填服务地址。在卡上填一个能按工坊公开格式回数据的服务地址，再点一次「测试连接」。',
        }
      return byoTestConnection(
        config,
        input.api_key === undefined ? reader : () => input.api_key as string,
        input.channel,
        options.byoFetch,
      )
    },

    async revealFromPublicLibrary(actor, input) {
      const library = options.publicLibrary
      if (library === undefined || !library.linked())
        return {
          ok: false,
          reason: 'not_linked',
          message: '还没关联 Agents 工坊账号，用不了公共红人库。关联一次就能用。',
        }
      const handle = normalizeHandle(input.handle)
      const out = await library.reveal({ public_id: `${input.channel}:${handle}` })
      if (!out.ok) return { ok: false, reason: out.reason, message: out.message }
      const contact = out.data.contacts[0]
      if (contact === undefined)
        return {
          ok: false,
          reason: 'not_found',
          message: '库里还没有这个人的联系方式。没有取到就不收钱。',
        }

      /*
       * 挂到哪个人身上：给了 `creator_id` 就挂那个；没给就按 渠道 + handle 找，
       * 找不到才建一条新的。**不按名字找**——公共库里没有显示名（去标识化），
       * 按名字找会把两个真不同的人并成一个。
       */
      let creator_id = input.creator_id
      if (creator_id === undefined) {
        const existing = store
          .accounts({ channel: input.channel })
          .find((a) => normalizeHandle(a.handle) === handle)
        if (existing !== undefined) creator_id = existing.creator_id
        else {
          const created: Creator = { id: nextId('cre'), display_name: handle, merged_from: [] }
          store.saveCreator(created)
          store.saveAccount({
            id: nextId('pa'),
            creator_id: created.id,
            channel: input.channel,
            handle,
            url: urlOfPublicRow(input.channel, handle),
            observed_at: clock.now(),
          })
          creator_id = created.id
        }
      }
      if (store.creator(creator_id) === undefined)
        throw new ApiError('not_found', '库里没有这个红人')

      // 明文已经在加密库里了（`reveal` 那一跳写的）；这里只落 key 名
      const row: CreatorContact = {
        // `value_ref` 长这样：`kol.contact.<id>`，所以 id 从它身上反解出来
        id: contact.value_ref.slice(CONTACT_SECRET_PREFIX.length),
        creator_id,
        kind: contact.kind,
        value_ref: contact.value_ref,
        source: contact.source,
        ...(contact.verified_at === undefined ? {} : { verified_at: contact.verified_at }),
      }
      store.saveContact(row)
      emit('kol.contact_revealed', actor.person_id, {
        creator_id,
        channel: input.channel,
        contact_id: row.id,
        credits_spent: out.credits_spent,
      })
      return {
        ok: true,
        creator_id,
        contact: contactView(row),
        credits_spent: out.credits_spent,
      }
    },

    async mergeSuggestions(actor) {
      const names = new Map(store.creators().map((c) => [c.id, c.display_name]))
      const rows: KolMergeSuggestionView[] = []
      loadRejectedMerges()
      for (const s of suggestMerges(profilesOf())) {
        const id = mergeSuggestionId(s.keep_id, s.merge_id)
        if (rejectedMerges.has(id)) continue
        const view: KolMergeSuggestionView = {
          id,
          keep: { creator_id: s.keep_id, display_name: names.get(s.keep_id) ?? s.keep_id },
          merge: { creator_id: s.merge_id, display_name: names.get(s.merge_id) ?? s.merge_id },
          reasons: s.reasons.map((r) => ({ id: r.id, text: r.text })),
          confidence: s.confidence,
        }
        /*
         * 14 四段式卡：**这是什么 / 凭什么 / 会怎样 / 你要做什么**。
         * 选择题两项（合 / 不是同一个人）——合并不是"改一个字段"，
         * 它是一次结构性的决定，所以走建议卡那条路而不是 staged change。
         */
        const item = await approvals.create({
          workspace_id,
          schema_version: 1,
          kind: 'policy_change',
          role_id: actor.role_id,
          subject: { object: { type: 'creator', id: s.keep_id } },
          dedupe_key: `${workspace_id}:kol_merge:${id}`,
          title: `这两条是同一个人吗：${view.keep.display_name} 与 ${view.merge.display_name}`,
          summary: `${s.reasons.map((r) => r.text).join('')}合了之后，${view.merge.display_name} 名下的渠道账号、联系方式与合作都会挂到 ${view.keep.display_name} 上；合错了拆得回来（被合掉那条的 id 留在 merged_from 里）。`,
          payload: {
            suggestion_id: id,
            keep_id: s.keep_id,
            merge_id: s.merge_id,
            reasons: s.reasons,
            confidence: s.confidence,
            /*
             * WP416（自查 kol B「同一人合并卡」）：选项也放进载荷——卡片投影只认载荷里的 options，
             * 以前只放在卡本身上，卡面成了一个是非题，选了也没效果。
             */
            options: [
              { id: 'merge', label: '是同一个人，合' },
              { id: 'keep_apart', label: '不是同一个人' },
            ],
          },
          evidence: {
            source_events: [],
            provenance: {
              seen: [
                { type: 'creator', id: s.keep_id },
                { type: 'creator', id: s.merge_id },
              ],
            },
            diff: {
              before: { creators: 2 },
              after: { creators: 1, merged_from: [s.merge_id] },
              summary: '两条红人记录合成一条',
            },
            precheck: {},
          },
          proposer: { kind: 'system', id: 'kol-merge' },
          automation: { level_at_creation: 'L1' },
          routing: {
            recipients: [{ person: actor.person_id, via: 'role_holder' }],
            rule: 'role_holder',
            escalation: {
              after_hours: 72,
              business_hours: true,
              chain: ['scope_manager'],
              escalated_at: [],
            },
            separation_of_duties: false,
          },
          priority: 'queue',
          options: [
            { id: 'merge', label: '是同一个人，合' },
            { id: 'keep_apart', label: '不是同一个人' },
          ],
        })
        if (item.state !== 'blocked') view.approval_item_id = item.id
        rows.push(view)
      }
      return { rows }
    },

    acceptMerge(actor, id) {
      const parsed = parseMergeSuggestionId(id)
      if (parsed === undefined) throw new ApiError('invalid_input', '这不是一条合并建议的 id')
      const merged = store.merge({ keep_id: parsed.keep_id, merge_id: parsed.merge_id })
      if (merged === undefined)
        throw new ApiError('not_found', '这两条里至少有一条已经不在库里了（可能刚被合过）')
      emit('kol.creators_merged', actor.person_id, {
        keep_id: parsed.keep_id,
        merge_id: parsed.merge_id,
        merged_from: merged.merged_from,
      })
      return { creator: merged }
    },

    rejectMerge(actor, id) {
      if (parseMergeSuggestionId(id) === undefined)
        throw new ApiError('invalid_input', '这不是一条合并建议的 id')
      loadRejectedMerges()
      rejectedMerges.add(id)
      try {
        store.saveSetting('merge_rejected', [...rejectedMerges], clock.now())
      } catch {
        // 落不了盘：这一次进程里照样不再提
      }
      emit('kol.merge_rejected', actor.person_id, { suggestion_id: id })
      return { id, rejected: true as const }
    },
  }

  /** 导入时带进来的邮箱：写进加密库，库里只留 key 名。回 true = 真的新加了一条。 */
  function saveEmail(creator_id: string, email: string): boolean {
    const key = suppressionKey(email)
    const already = store.contacts(creator_id).some((ct) => {
      try {
        const value = secrets.get(ct.value_ref)?.[CONTACT_SECRET_FIELD]
        return value !== undefined && suppressionKey(value) === key
      } catch {
        return false
      }
    })
    if (already) return false
    const id = nextId('ctc')
    const value_ref = contactSecretId(id)
    secrets.put(value_ref, { [CONTACT_SECRET_FIELD]: email.trim() })
    store.saveContact({ id, creator_id, kind: 'email', value_ref, source: 'import' })
    return true
  }

  /**
   * 序列跟进（48 §5.2「首封 / 3 天 / 7 天」）。
   *
   * 三条判断都不在这里写第二遍：**该不该有下一封**由 `kol-core` 的
   * `nextInSequence` 说（回过信的不跟、收尾发过的不跟、名单上的不跟），
   * **今天还能发几封**由 `outreachQuota` 说，**这一封能不能提**由 guardrail 说。
   * 这个函数只回答"现在轮到谁了"。
   */
  const sweepSequences = async (): Promise<KolSequenceSweep> => {
    const now = clock.now()
    const nowMs = Date.parse(now)
    const suppressed = suppressedRefs()
    const changes = await ledger.list({ workspace_id, kind: 'kol_outreach' })
    const out: KolSequenceSweep = { scanned: 0, staged: 0, skipped: [] }

    // 只看"已建联但还没回音"的——回过信的人接下来是人在谈，不是机器在跟
    for (const collab of store.collaborations({ stage: 'contacted' })) {
      out.scanned += 1
      const creator = store.creator(collab.creator_id)
      const contact = contactOf(collab.creator_id)
      if (creator === undefined || contact === undefined) {
        out.skipped.push({ collaboration_id: collab.id, reason: '这个人名下没有联系方式' })
        continue
      }
      /*
       * WP416（自查 kol C2）：**只算真发出去的那几封**——往来记录里我们发的（执行器读回之后才记）。
       * 以前按账本里提过的卡算：被拒掉的、没连邮箱发不出去的首封都算「已发」，于是第 3、7 天
       * 去跟进一封对方从没收到的信。回过信（往来里有他发来的）就不再跟。
       */
      const thread = store.exchanges({ creator_id: collab.creator_id })
      const byId = new Map(changes.map((c) => [c.id, c]))
      const sent = thread
        .filter((x) => x.direction === 'out' && x.channel === collab.channel)
        .map((x) => {
          const c = x.change_id === undefined ? undefined : byId.get(x.change_id)
          return {
            step: (x.step ??
              (c?.after as { step?: OutreachStep } | undefined)?.step ??
              'first') as OutreachStep,
            at: x.at,
            vars: (c?.after as { vars?: Record<string, string> } | undefined)?.vars,
          }
        })
        .sort((a, b) => a.at.localeCompare(b.at))
      if (sent.length === 0) {
        out.skipped.push({ collaboration_id: collab.id, reason: '首封还没真发出去，不排跟进' })
        continue
      }
      const firstAt = sent[0]?.at ?? ''
      const replied = thread.some((x) => x.direction === 'in' && x.at >= firstAt)
      // 上一封跟进还在等人批（或在发）：不重复提
      const pending = changes.some(
        (c) =>
          c.target.type === 'creator_contact' &&
          c.target.id === contact.id &&
          (c.status === 'staged' || c.status === 'approved' || c.status === 'applying') &&
          !thread.some((x) => x.change_id === c.id),
      )
      if (pending) {
        out.skipped.push({ collaboration_id: collab.id, reason: '上一封还在等你批' })
        continue
      }
      const next = nextInSequence({
        sent: sent.map(({ step, at }) => ({ step, at })),
        replied,
        contact: contact.value_ref,
        suppressed,
      })
      if (next === undefined) {
        out.skipped.push({ collaboration_id: collab.id, reason: '序列走完了，或者这个人在名单上' })
        continue
      }
      if (next.due_at === '' || Date.parse(next.due_at) > nowMs) {
        out.skipped.push({ collaboration_id: collab.id, reason: `还没到时候（${next.why}）` })
        continue
      }
      // 跟进那一封用**首封那一封的变量**：跟进信提到的产品必须和首封是同一个
      const vars = sent.find((x) => x.step === 'first')?.vars
      if (vars === undefined || typeof vars.product !== 'string') {
        out.skipped.push({
          collaboration_id: collab.id,
          reason: '找不到首封那一封的变量，跟进信提到的产品会对不上，所以不提',
        })
        continue
      }
      // 用**这条渠道职责的持有人**那条分配去提（额度与等级从它来）
      const holder = ownerOfChannel(collab.channel)
      if (holder === undefined) {
        out.skipped.push({
          collaboration_id: collab.id,
          reason: `现在没有人持有「${roleIdOfChannel(collab.channel)}」这条职责`,
        })
        continue
      }
      const view = await stageOutreach({
        actor: {
          person_id: holder.person_id,
          assignment_id: holder.id,
          role_id: holder.role_id,
        },
        creator,
        channel: collab.channel,
        step: next.step,
        vars: {
          product: vars.product,
          reason: vars.reason ?? '',
          brand_pitch: vars.brand_pitch ?? '',
          sender_name: vars.sender_name ?? '',
          // WP295：跟进信与首封同一种语言（老数据没有这一格 = 中文，与当时发出去的一致）
          ...(vars.language === 'en' || vars.language === 'zh' ? { language: vars.language } : {}),
        },
      })
      if (view.staged) out.staged += 1
      else
        out.skipped.push({
          collaboration_id: collab.id,
          reason: view.message ?? '这一封没提上去',
        })
    }
    return out
  }

  return {
    port,
    revealContact(contact_id) {
      try {
        return secrets.get(contactSecretId(contact_id))?.[CONTACT_SECRET_FIELD]
      } catch {
        return undefined
      }
    },
    sweepSequences,
  }
}

/**
 * 导入把已有账号的资料**更新**上去。
 *
 * 只覆盖表里真的有值的那几格：用户那张表常常只填了粉丝数，
 * 把空的类目 / 语言也盖上去等于用"没填"抹掉已有的事实。
 */
function mergeAccount(
  existing: PlatformAccount,
  incoming: ImportedAccount,
  now: Iso8601,
): PlatformAccount {
  return {
    ...existing,
    ...(incoming.url === '' ? {} : { url: incoming.url }),
    ...(incoming.followers === undefined ? {} : { followers: incoming.followers }),
    ...(incoming.engagement_rate === undefined
      ? {}
      : { engagement_rate: incoming.engagement_rate }),
    ...(incoming.category === undefined ? {} : { category: incoming.category }),
    ...(incoming.language === undefined ? {} : { language: incoming.language }),
    ...(incoming.region === undefined ? {} : { region: incoming.region }),
    observed_at: now,
  }
}
