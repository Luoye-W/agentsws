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
  KolContactView,
  KolCreatorDetail,
  KolCreatorRow,
  KolImportView,
  KolMergeSuggestionView,
  KolPort,
  KolStagedView,
} from '@agentsws/api'
import { ApiError } from '@agentsws/api'
import type {
  ApprovalBus,
  AssignmentId,
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
  ObjectRef,
  PersonId,
  PlatformAccount,
  ProvenanceState,
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
  collaborationStageName,
  deliverableReviewName,
  type ImportedAccount,
  importAccounts,
  importSummary,
  type MergeProfile,
  normalizeHandle,
  parseCreatorUrl,
  rankCreators,
  StageTransitionError,
  suggestMerges,
} from '@agentsws/kol-core'
import type { StageInput, StageOutcome } from '@agentsws/txn'
import type { KolStore } from './kol.js'
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
  /** 15 §5 变更账本的 stage 口（审核结论与合作走它）。 */
  ledger: { stage(input: StageInput): Promise<StageOutcome> }
  /** 05 §4 生效配置：额度与等级从本次那条分配来。 */
  effectiveConfig(id: AssignmentId): EffectiveConfig
  appendEvent(e: Omit<EventEnvelope, 'id' | 'at'> & { at?: string }): void
  random(): number
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
}

const COLLAB_ACTION = 'stage_collaboration'
const REVIEW_ACTION = 'stage_deliverable_review'

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

  const port: KolPort = {
    creators(_actor, filter) {
      const now = clock.now()
      const accounts = store
        .accounts(filter.channel === undefined ? {} : { channel: filter.channel })
        .filter((a) => {
          if (filter.q === undefined || filter.q.trim() === '') return true
          const q = filter.q.trim().toLowerCase()
          const name = store.creator(a.creator_id)?.display_name ?? ''
          return a.handle.toLowerCase().includes(q) || name.toLowerCase().includes(q)
        })
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
      if (store.collaboration(input.collaboration_id) === undefined)
        throw new ApiError('not_found', '库里没有这条合作，交付物挂不上去')
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

  return {
    port,
    revealContact(contact_id) {
      try {
        return secrets.get(contactSecretId(contact_id))?.[CONTACT_SECRET_FIELD]
      } catch {
        return undefined
      }
    },
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
