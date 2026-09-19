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
  KolContactView,
  KolCreatorDetail,
  KolCreatorRow,
  KolImportView,
  KolMergeSuggestionView,
  KolOutreachView,
  KolPort,
  KolSearchHit,
  KolSearchResult,
  KolStagedView,
} from '@agentsws/api'
import { ApiError } from '@agentsws/api'
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
  Deliverable,
  EffectiveConfig,
  EventEnvelope,
  Iso8601,
  KolChannel,
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
import { suppressionKey } from '@agentsws/core'
import {
  advanceCollaboration,
  advanceDeliverable,
  affiliateCode,
  applyUtm,
  buildUtm,
  type CampaignBrief,
  collaborationStageName,
  deliverableReviewName,
  draftOutreach,
  type ImportedAccount,
  importAccounts,
  importSummary,
  type MergeProfile,
  nextInSequence,
  normalizeHandle,
  type OutreachStep,
  outreachQuota,
  type PublicCreatorRow,
  type PublicLibraryClient,
  parseCreatorUrl,
  planCampaign,
  rankCreators,
  roleIdOfChannel,
  StageTransitionError,
  scoreCreator,
  suggestMerges,
} from '@agentsws/kol-core'
import type { StageInput, StageOutcome } from '@agentsws/txn'
import type { KolStore } from './kol.js'
import type { KolChannelsAssembly } from './kol-channels.js'
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
   */
  capabilitySource?(capability: string): 'mine' | 'agentsws'
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

/** 去掉一句话末尾的标点（接下一句之前）。 */
const trimTail = (text: string): string => text.replace(/[。．.，,；;：:]+$/u, '')

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

export function createKolService(options: KolServiceOptions): KolServiceAssembly {
  const { store, secrets, clock, approvals, ledger, appendEvent } = options
  const workspace_id = options.workspace_id
  /** 人点过"不是同一个人"的那几对，进程内记着（重启后会再问一次——建议本来就是算出来的）。 */
  const rejectedMerges = new Set<string>()

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

  const detailOf = (creator: Creator): KolCreatorDetail => {
    const collaborations = store.collaborations().filter((c) => c.creator_id === creator.id)
    const ids = new Set(collaborations.map((c) => c.id))
    return {
      creator,
      accounts: store.accounts({ creator_id: creator.id }),
      contacts: store.contacts(creator.id).map(contactView),
      collaborations,
      deliverables: store.deliverables().filter((d) => ids.has(d.collaboration_id)),
      tracked_links: store.links().filter((l) => ids.has(l.collaboration_id)),
    }
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

  /** 起草并提一封开发信。`step` 不给就按序列算下一封。 */
  const stageOutreach = async (input: {
    actor: { person_id: PersonId; assignment_id: AssignmentId; role_id: string }
    creator: Creator
    channel: KolChannel
    step: OutreachStep
    vars: { product: string; reason: string; brand_pitch?: string; sender_name: string }
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

    const draft = draftOutreach(input.step, {
      creator_name: input.creator.display_name,
      brand: options.brandName(),
      channel: input.channel,
      ...input.vars,
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
            : `还差几格没填：${draft.missing_vars.join('、')}。缺了就不起草——拿一封写着 {{product}} 的信去问人要不要发，比不起草更糟。`,
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
      },
      notes: [`给 ${input.creator.display_name} 的第 ${SEQUENCE_LABEL[draft.step]}`],
      created_by: { kind: 'agent', id: `agent_${input.actor.role_id}` },
      mandate,
      level: sandboxDrill ? 'L1' : level,
      provenance: provenanceOf(run_id, [target, { type: 'creator', id: input.creator.id }]),
      approval: {
        title: `开发信：${input.creator.display_name}（${SEQUENCE_LABEL[draft.step]}）`,
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
    // 首封提上去 = 这条合作进了"已建联"（序列跟进靠这一格找人）
    const collab = store
      .collaborations({ channel: input.channel })
      .find((c) => c.creator_id === input.creator.id && c.stage === 'sourced')
    // WP117b（66 复测 #18）：合作清单上要显示"最近一次往来"，起草也算一次动静
    if (draft.step === 'first' && collab !== undefined)
      store.saveCollaboration({ ...collab, stage: 'contacted', last_activity_at: clock.now() })
    return {
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
          '这条渠道的开关拨到了"用 agentsws 的"，但这台机器还没关联 agentsws 账号。去"设置 → 账号与积分"关联一次，或者把开关拨回"用我的"。',
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
   */
  const revealPrice = async (): Promise<KolSearchResult['reveal_price']> => {
    const found = await options.priceOf?.(REVEAL_CAPABILITY)
    if (found === undefined) return undefined
    return {
      capability: REVEAL_CAPABILITY,
      credits: found.credits,
      unit: found.unit,
      note: `浏览是免费的；取回一个邮箱这一步扣 ${found.credits} 积分。库里没有联系方式不收钱。`,
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
    return words.some((w) => hay.includes(w))
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
    if (followers === undefined) return true
    if (filter.min_followers !== undefined && followers < filter.min_followers) return false
    if (filter.max_followers !== undefined && followers > filter.max_followers) return false
    return true
  }

  const port: KolPort = {
    creators(_actor, filter) {
      const now = clock.now()
      const accounts = store
        .accounts(filter.channel === undefined ? {} : { channel: filter.channel })
        .filter((a) => matchesQ(a, filter.q))
        .filter((a) => inBand(a.followers, filter))
      const hasContact = new Set(store.contacts().map((ct) => ct.creator_id))
      // 排序（含"刷粉的排在后面而不是剔掉"）在 `rankCreators` 里，不在这儿重写
      const rows: KolCreatorRow[] = rankCreators(accounts, { now }).map(({ account, score }) => ({
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
      }))
      return { rows: rows.slice(0, filter.limit ?? 100) }
    },

    async search(actor, input) {
      /*
       * 49 M2 的开关决定走哪条路：**用我的** = 打这条渠道自己的接口（本地直连、
       * 不扣一分）；**用 agentsws 的** = 查云端公共库（浏览免费，reveal 才花钱）。
       * 两条路回的是同一个形状，所以界面上只有"这一份是从哪儿来的"那一个差别。
       */
      if (options.capabilitySource?.(`kol.${input.channel}`) === 'agentsws')
        return publicSearch(input)
      const adapter = options.channels?.adapters[input.channel]
      if (adapter === undefined)
        return {
          ok: false,
          source: 'channel',
          rows: [],
          reason: 'not_connected',
          message:
            '这个服务进程没有装配渠道适配器，所以去平台上找人这一条现在走不通。导入你手上那张表照常能用。',
        }
      const out = await adapter.search({
        q: input.q,
        ...(input.limit === undefined ? {} : { limit: input.limit }),
      })
      if (!out.ok) {
        emit('kol.search_failed', actor.person_id, { channel: input.channel, reason: out.reason })
        return { ok: false, source: 'channel', rows: [], reason: out.reason, message: out.message }
      }
      const known = knownHandles(input.channel)
      const rows: KolSearchHit[] = out.data
        // WP117b（66 复测 #15）：粉丝区间对渠道这条路同样作数（渠道接口自己
        // 大多不收这个条件，所以在这儿收）
        .filter((hit) => inBand(hit.followers, input))
        .map((hit) => ({
          channel: hit.channel,
          handle: hit.handle,
          url: hit.url,
          display_name: hit.display_name,
          ...(hit.followers === undefined ? {} : { followers: hit.followers }),
          ...(hit.engagement_rate === undefined ? {} : { engagement_rate: hit.engagement_rate }),
          ...(hit.category === undefined ? {} : { category: hit.category }),
          ...(hit.language === undefined ? {} : { language: hit.language }),
          ...(hit.region === undefined ? {} : { region: hit.region }),
          in_library: known.has(normalizeHandle(hit.handle)),
        }))
      return {
        ok: true,
        source: 'channel',
        rows,
        observed_at: out.observed_at,
      } satisfies KolSearchResult
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

    collaborations(_actor, filter) {
      return {
        rows: store.collaborations({
          ...(filter.channel === undefined ? {} : { channel: filter.channel }),
          ...(filter.stage === undefined ? {} : { stage: filter.stage }),
        }),
      }
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
       * **卡批了才落库**是这条路的正确行为，可是这一版没有"批了自动落库"的施行器
       * （执行器只认连接器上的写动作）。折中并且照实说：记录当场建出来，
       * 阶段钉在 `sourced`（还没找上人，没有任何对外动作），预算跟着卡走——
       * 也就是说库里这一行代表"我们打算谈"，而"谈成多少钱"仍然由卡决定。
       */
      const row: Collaboration = {
        id: target.id,
        creator_id: creator.id,
        channel: input.channel,
        stage: 'sourced',
        currency,
        ...(input.budget === undefined ? {} : { budget: input.budget }),
        ...(input.campaign_id === undefined ? {} : { campaign_id: input.campaign_id }),
      }
      store.saveCollaboration(row)
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
      if (owner === undefined)
        throw new ApiError('not_found', '库里没有这条合作，交付物挂不上去')
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
      const account = store.accounts({ creator_id: collab.creator_id, channel: collab.channel })[0]
      const utm = buildUtm({
        channel: collab.channel,
        campaign: input.campaign,
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

    async outreach(actor, input) {
      const creator = creatorOr404(input.creator_id)
      // `reason` 不给就用打分里最高那一项的那句带数的话——那正是"为什么找他"
      const account = store.accounts({ creator_id: creator.id, channel: input.channel })[0]
      const top =
        account === undefined
          ? undefined
          : [...scoreCreator(account, { now: clock.now() }).factors].sort(
              (a, b) => b.score - a.score,
            )[0]
      return stageOutreach({
        actor,
        creator,
        channel: input.channel,
        step: input.step ?? 'first',
        vars: {
          product: input.product,
          /*
           * `reason` 不给就用打分里最高那一项的那句带数的话——那正是"为什么找他"。
           * 末尾的标点要去掉再接一个逗号：模板后面紧跟着"所以想问问你对 X 有没有兴趣"，
           * 不去掉就会写出"正好在想要的区间里。，所以想问问……"这种句子。
           */
          reason: input.reason ?? (top === undefined ? '' : `${trimTail(top.why)}，`),
          /*
           * **`brand_pitch` 没有默认值**。"我们是做什么的"这句话只有用户自己知道，
           * 编一个出来最好的情况也是废话（"我是 NordVolt 的王岚。我们是 NordVolt。"），
           * 最坏的情况是替他向红人说了一句不实的话。缺了就照 `draftOutreach`
           * 的规矩走：不起草，把缺的那一格说出来。
           */
          ...(input.brand_pitch === undefined ? {} : { brand_pitch: input.brand_pitch }),
          sender_name: input.sender_name ?? (await options.personName(actor.person_id)),
        },
      })
    },

    async planCampaign(actor, input) {
      const brief: CampaignBrief = {
        goal: input.goal,
        budget: input.budget,
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
      const plan = planCampaign(brief, store.accounts(), clock.now())
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
                reason: `你名下没有「${group.role_id}」这条职责，所以这一组只能看不能建。要做这条渠道，让 owner 把这条职责分给你——一次 campaign 不会把别人的权限并给你（05 §4）。`,
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
        title: `campaign 挑人清单：${input.goal}（${total} 人）`,
        summary:
          `按 ${input.channels.join(' / ')} 分组，人均预算 ${plan.budget_per_creator} ${brief.currency}。` +
          `接受就为每个人建一条合作（阶段从"已找到"开始），每条动作走各自渠道职责的额度。` +
          (blocked.length === 0
            ? ''
            : `其中 ${blocked.map((g) => g.channel).join(' / ')} 这 ${blocked.length} 组你名下没有对应职责，灰着不建。`),
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

    async revealFromPublicLibrary(actor, input) {
      const library = options.publicLibrary
      if (library === undefined || !library.linked())
        return {
          ok: false,
          reason: 'not_linked',
          message: '还没关联 agentsws 账号，用不了公共红人库。去"设置 → 账号与积分"关联一次。',
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
      rejectedMerges.add(id)
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
      const sent = changes
        .filter((c) => c.target.type === 'creator_contact' && c.target.id === contact.id)
        .map((c) => ({
          step: ((c.after as { step?: OutreachStep }).step ?? 'first') as OutreachStep,
          at: c.created_at,
          vars: (c.after as { vars?: Record<string, string> }).vars,
        }))
        .sort((a, b) => a.at.localeCompare(b.at))
      const next = nextInSequence({
        sent: sent.map(({ step, at }) => ({ step, at })),
        replied: false,
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
