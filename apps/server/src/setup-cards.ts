/**
 * WP324（决策 690，Luoye 10-14）：**连接卡 / 配置卡**的服务端那一半——出卡、去重、补完接着做。
 *
 * 一件任务跑到一半发现要先连上什么（`not_connected` / 缺凭据 / 建站工具没装没登 / 管店没授权）或先设好什么
 * （还不知道是哪家店、公司地址没填…），运行时在这一轮收尾时调 {@link SetupCardsAssembly.onRunBlocked}：
 *
 * - 缺连接 → 一张 `connect_request`：要连哪几样、为什么、（花钱 / 能动电脑的）一句风险；卡上就地连；
 * - 缺设置 → 一张 `setup_request`：缺哪几格（服务端登记的 {@link SetupTarget} 给格子与建议值）；卡上就地填。
 *
 * **同一缺项不重复出卡**：去重键只看缺的是哪几样；还有一张没处理，就把这件事挂到那一张的「等着的」上。
 * **补完自动接着做**：人在卡上连好（卡自己点「接着做」）/ 在别处连好（连接清单一变就复查）/ 填好保存 →
 * 这张卡上等着的每一件事都按原来那段话再跑一次（照 WP304 选主题卡）。
 *
 * 纪律：这里**没有一个凭据的值**。连接卡只带「要连谁」；口令在本机原生表单里填、直接打连接面，
 * 不经这里、不进卡、不进事件、不进模型上下文。配置卡只收登记过的、不是秘密的格子
 * （{@link isSecretLikeSetupKey} 认出来的格子登记时就拒）。
 *
 * 只把**通用机制**做成固定功能：哪一家服务怎么连由连接目录 / 渠道登记表说了算，这里不为谁写专属分支；
 * 设置目标由各模块自己登记（{@link SetupCardsAssembly.registerTarget}）。
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import {
  type ApprovalBus,
  type ApprovalItem,
  type Clock,
  type ConnectNeed,
  type ConnectRequestPayload,
  type ContextItem,
  connectRequestDedupeKey,
  isLegacySetupRequest,
  isSecretLikeSetupKey,
  type MatterRunBlock,
  type RunRequest,
  type ServiceOffer,
  type SetupField,
  type SetupRequestPayload,
  type SetupResumeTarget,
  setupRequestDedupeKey,
} from '@agentsws/contracts'
import { canonicalJson } from '@agentsws/core'
import { finalPayload } from '@agentsws/txn'
import {
  changeFields,
  createResearchKit,
  mergePlan,
  type SetupPlan,
  type SetupResearchCache,
  type SetupResearchHost,
  type SetupResearchKit,
} from './setup-research.js'

/** 一个设置目标（某个模块登记的「这几格设好了，我就能接着做」）。 */
export interface SetupTarget {
  /** 全局唯一（`site.store`、`company.address`）；工具回 `needs_setup: '<id>'` 认的就是它。 */
  id: string
  /** 人话名（时间线「缺一步设置（X）」用）。 */
  name: string
  /** 卡面那一句为什么。 */
  why: string
  /** 现在要填的几格（带建议值）。不能有秘密格（登记 / 出卡时都查）。 */
  fields(): Promise<SetupField[]>
  /** 已经设好了没有（设好了就不出卡；出了的卡保存后也按它复核）。 */
  satisfied(): Promise<boolean>
  /**
   * 存下人填的值（只含登记过的格子）；不合法就抛 {@link SetupCardError}（那一句给人看）。
   * WP388：第二个参数是谁点的确认（`by` = 人的 id；规则自动的没有）——只该改本人那一份的目标用它。
   */
  apply(values: Record<string, string>, context?: { by?: string }): Promise<void>
  /**
   * WP348（决策 887）：「怎么查」——出卡前在这件事的运行里查一遍（档案、已连的数据、限次联网搜索、
   * 问一次模型），交回每一格的方案值 + 理由 + 来源。不给 = 只用 `fields()` 里已知的。
   */
  research?(kit: SetupResearchKit): Promise<SetupPlan>
  /**
   * WP348：不让 AI 猜的格子（要人选的账号这类）——只认已存的 / 已连的事实；模型、`request_setup`
   * 的建议都不填；查不到就标「需要你填」。
   */
  noGuess?: readonly string[]
  /**
   * WP385：AI 给的建议值里**还没生效**的那几格（已经是这样的去掉）。没有「缺」、只收增减的目标用它
   * （如体检设置：「加一条上架页」已经在了就不再出卡）。不给 = 按格子现值比（{@link changeFields}）。
   */
  pending?(suggestions: Record<string, string>): Promise<Record<string, string>>
  /**
   * WP410（真机 #9）：这个目标**此刻**存着的原值 + 它靠的连接（以插件交回 / 连接表为准）。
   * 给了就按 {@link roles} 注进那几条职责每次运行的上下文（「当前设置快照」，三个运行时同一份字节），
   * AI 说连接 / 设置的状态只按它，不凭记忆或旧对话。
   */
  state?(): Promise<SetupTargetState>
  /** WP410：哪几条职责的运行要带上 {@link state}（不给 = 不带）。 */
  roles?: readonly string[]
}

/** WP410：一个设置目标此刻的真实状态（给岗位 AI 看；没有任何秘密）。 */
export interface SetupTargetState {
  /** 设好了没有（同 `satisfied()`）。 */
  configured: boolean
  /** 人话名 → 现在存着的原值（空的就是空串，不补建议值）。 */
  values: Record<string, string>
  /** 靠的连接：人话名 → 现在怎样（以插件交回 / 连接表为准）。 */
  connections?: Record<string, string>
  /** 另外几句（最近一轮跑了没、结果怎样）。 */
  notes?: string[]
}

/** WP410：「当前设置快照」那一条上下文的 id（三个运行时同一份）。 */
export const SETUP_STATE_CONTEXT_ID = 'setup_state'

export class SetupCardError extends Error {
  constructor(
    readonly code: 'invalid_input' | 'secret_field' | 'unknown_target',
    message: string,
  ) {
    super(message)
    this.name = 'SetupCardError'
  }
}

/** 连上之后会怎样的那一句风险（只有花钱 / 能动东西的才有）。按 service 认，不按哪一家写分支。 */
const RISK_BY_SERVICE: Readonly<Record<string, string>> = {
  meta_ads: '连上后我只看数和起草；花钱、改预算的每一步都先出卡等你点头。',
  meta_marketing: '连上后我只看数和起草；花钱、改预算的每一步都先出卡等你点头。',
  google_ads: '连上后我只看数和起草；花钱、改预算的每一步都先出卡等你点头。',
  extension: '配上后插件只和这台电脑上的工坊说话；它看到的网页只用来做这件事。',
  shop_admin: '授权后改商品、页面的每一步都先出卡等你点头。',
}

export interface SetupCardsOptions {
  workspace_id: string
  clock: Clock
  /**
   * WP390（docs/105 §4.1 ②）：服务目录里声明了这个卡点的工坊服务（`connect:<服务>` / `setup:<设置目标>`）
   * → 卡上多一个可选项「交给工坊办」。不给 / 查不到就没有这一格。
   */
  workshopOffer?(blocker: { key: string; name?: string }): Promise<ServiceOffer | undefined>
  /** 这个品牌的落盘目录（记「哪张卡上等着哪几件事」）；不给就全内存。 */
  dir?: string
  approvals(): ApprovalBus | undefined
  /** 出了新卡：挂进事项时间线 + 回填待办（`work.onCard`）。 */
  onCard?(item: ApprovalItem): void
  /**
   * 这一样现在连上了没有：`true` / `false`；认不出（没有办法查）回 `undefined`——
   * 人点「接着做」时就信人，不再拦。
   */
  isConnected(need: ConnectNeed): Promise<boolean | undefined>
  /** 补完：按这件事原来那段话再跑一次（`text` 是时间线上开跑那一行）。 */
  resume(target: SetupResumeTarget & { text: string }): Promise<void>
  /** 事项时间线上记一句（系统口吻）。 */
  note?(matter_id: string, text: string): void
  /** 审计事件（只有 id / 种类 / 数字，没有任何值）。 */
  emit?(type: string, payload: Record<string, unknown>): void
  /**
   * WP348：出卡前查一遍用的宿主那几样（品牌档案、联网搜索、问一次模型；算在 `actor` 头上）。
   * 不给 = 不查，卡面照样是方案（只用目标自己知道的）。
   */
  research?(input: {
    actor: RunRequest['actor']
    target: string
    run_id?: string
  }): SetupResearchHost | undefined
}

export interface SetupCardsAssembly {
  /** 登记一个设置目标；回注销函数。 */
  registerTarget(target: SetupTarget): () => void
  /** 运行时：一轮卡在缺连接 / 缺设置上 → 出卡（或挂到已有那张上）。 */
  onRunBlocked(input: {
    run_id: string
    matter_id: string
    actor: RunRequest['actor']
    block: MatterRunBlock
    needs: ConnectNeed[]
    targets: string[]
    /** WP334（决策 724）：AI 要卡时给的那一句为什么（压过默认那句）。 */
    why?: string
    /** WP334：AI 给的配置卡建议值（按设置目标；只认登记过的格子）。 */
    suggestions?: Record<string, Record<string, string>>
    /** WP348：AI 给每个建议值的一句理由（按设置目标、按格子）。 */
    reasons?: Record<string, Record<string, string>>
    /** WP348：这几个目标已经设好了，AI 要的是「改成这样」（出改设置方案卡）。 */
    changes?: string[]
  }): Promise<{ item: ApprovalItem; attach: boolean } | undefined>
  /**
   * 别的模块直接要一张连接卡（WP322 / WP323 这类「要先接上 X 才能做」的确认流程用）。
   * 都连上了就不出、回 `undefined`。
   */
  askConnect(input: AskConnectInput): Promise<{ item: ApprovalItem; attach: boolean } | undefined>
  /** 别的模块直接要一张配置卡；设好了就不出、回 `undefined`。 */
  askSetup(input: AskSetupInput): Promise<{ item: ApprovalItem; attach: boolean } | undefined>
  /**
   * WP416：只缺这几样（按 kind）的那张连接卡还开着吗——开着回卡 id（岗位页顶上的引导卡据此不再重复出）。
   */
  openConnectCard?(kinds: readonly string[]): Promise<string | undefined>
  /** 这两种卡被决定了（接着做 / 保存 / 先不连 / 先不设）。别的卡什么都不做。 */
  onDecided(item: ApprovalItem): Promise<void>
  /** 连接清单变了：还在等的连接卡里，缺的都连上了的那几张自动收起、接着做。回接着做了几张。 */
  recheck(): Promise<number>
  /** WP334：一个登记过的设置目标（AI 要卡时认目标用；没登记回 `undefined`）。 */
  target(
    id: string,
  ):
    | (Pick<SetupTarget, 'id' | 'name' | 'satisfied'> &
        Partial<Pick<SetupTarget, 'fields' | 'pending'>>)
    | undefined
  /** WP334：登记过的设置目标 id（认不出时列给模型看）。 */
  targetIds(): string[]
  /**
   * WP410（真机 #5）：升级迁移——旧版留下、还没处理的**空表单**配置卡（没有 `mode`）一律作废；
   * 目标还没设好的，当场换成新版方案卡（先查一遍，等着的事项带过去）。每个品牌只跑一次（记在
   * `setup-cards.json` 的 `migrations` 里）。
   */
  migrateLegacy?(): Promise<{ withdrawn: number; reasked: number }>
  /**
   * WP410（真机 #9）：这条职责的「当前设置快照」（登记了 `state` / `roles` 的目标 + 还开着的设置 / 连接卡）。
   * 没有相关目标回 `undefined`（别的职责的上下文一个字节不变）。
   */
  stateFor?(role_id: string): Promise<ContextItem | undefined>
  /**
   * WP349：这个品牌查过的搜索 / 模型结果缓存（同一句话 7 天内不再花钱）。品牌分析联网查与配置卡
   * 出卡前查**共用这一份**（键同 `createResearchKit`）。可选：老装配 / 替身没有就不缓存。
   */
  researchCache?: SetupResearchCache
}

export interface AskConnectInput {
  needs: ConnectNeed[]
  why?: string
  risk?: string
  actor: RunRequest['actor']
  matter_id?: string
  run_id?: string
  /**
   * WP360：`false` = 卡照样挂进这件事的时间线，但**不**记成「连好就按原话再跑一次」——主动引导装插件那张
   * （这件事并没有卡在插件上，原话已经照常在跑）。不给 = 照旧（给了 `matter_id` 就等着接着做）。
   */
  resume?: false
}

export interface AskSetupInput {
  target: string
  why?: string
  /** 调用方（模型 / 规则）给的建议值，压过目标自己的建议。只认登记过的格子。 */
  suggestions?: Record<string, string>
  /** WP348：调用方给每个建议值的一句理由。 */
  reasons?: Record<string, string>
  /**
   * WP348（决策 841 并进来）：目标已经设好了，调用方要的是「改成这样」——出一张现值 → 新值的方案卡，
   * 人确认才生效。`suggestions` 就是新值；一格都没变就不出。
   */
  change?: boolean
  actor: RunRequest['actor']
  matter_id?: string
  run_id?: string
  /**
   * WP410（真机 #5）：已经有一张开着的卡时，重查一遍、格子变了就换一张（插件刚交回账号这类：
   * 已知的值要预填上）。不给 = 照旧（开着的那张是新版方案卡就直接挂上去）。
   */
  refresh?: boolean
}

/** 内部：重出一张时直接用上一张的格子（不再查一遍、不再花钱）。 */
interface AskSetupPrepared {
  fields: SetupField[]
  mode: 'plan' | 'change'
  steps?: SetupRequestPayload['steps']
}

/** 落盘：哪张卡上等着哪几件事（卡本身在审批总线里）。 */
interface CardRecord {
  kind: 'connect_request' | 'setup_request'
  dedupe_key: string
  waiting: SetupResumeTarget[]
  /** 补完 / 不要了：再收到决定或连接变化都不再动。 */
  done?: true
}
interface StateFile {
  version: 1
  cards: Record<string, CardRecord>
  /** WP348：查过的搜索 / 模型结果（同一句话 7 天内不再花钱）。 */
  research?: Record<string, { at: string; value: unknown }>
  /** WP410：跑过的升级迁移（跑一次就记下）。 */
  migrations?: string[]
}

/** WP410：旧版空表单卡作废那一次迁移的名字。 */
export const LEGACY_SETUP_MIGRATION = 'wp410-legacy-setup-cards'

/** WP348：查过的搜索 / 模型结果留多久。 */
const RESEARCH_TTL_MS = 7 * 86_400_000
/** WP348：最多留几条（多了丢最旧的）。 */
const RESEARCH_MAX = 200

const ACTIVE_STATES = new Set(['pending', 'in_review', 'deferred'])

export function createSetupCards(options: SetupCardsOptions): SetupCardsAssembly {
  const ws = options.workspace_id
  const file = options.dir === undefined ? undefined : join(options.dir, 'setup-cards.json')
  const targets = new Map<string, SetupTarget>()
  const state: StateFile = load()
  /** 同一张卡同一时间只结一次（人点「接着做」与连接清单变化可能前后脚到）。 */
  const settling = new Set<string>()

  function load(): StateFile {
    if (file === undefined) return { version: 1, cards: {} }
    try {
      const raw = JSON.parse(readFileSync(file, 'utf8')) as Partial<StateFile>
      return {
        version: 1,
        cards: raw.cards ?? {},
        ...(raw.research === undefined ? {} : { research: raw.research }),
        ...(Array.isArray(raw.migrations) ? { migrations: raw.migrations } : {}),
      }
    } catch {
      return { version: 1, cards: {} }
    }
  }
  const save = (): void => {
    if (file === undefined) return
    try {
      mkdirSync(dirname(file), { recursive: true })
      // 结过的卡不落盘（再收到它的决定 / 连接变化，查不到就什么都不做）——文件不会越攒越大
      const cards = Object.fromEntries(
        Object.entries(state.cards).filter(([, rec]) => rec.done !== true),
      )
      writeFileSync(
        file,
        `${JSON.stringify(
          {
            version: 1,
            cards,
            ...(state.research === undefined ? {} : { research: state.research }),
            ...(state.migrations === undefined ? {} : { migrations: state.migrations }),
          },
          null,
          2,
        )}\n`,
      )
    } catch {
      // 写不下只丢「等着的」清单：卡还在，人补完照样能在事项里说「接着做」
    }
  }
  const emit = (type: string, payload: Record<string, unknown>): void => {
    try {
      options.emit?.(type, { workspace_id: ws, ...payload })
    } catch {
      // 审计事件失败不拦正事
    }
  }
  const note = (matter_id: string, text: string): void => {
    try {
      options.note?.(matter_id, text)
    } catch {
      // 事项已经没了
    }
  }

  const resumeOf = (
    actor: RunRequest['actor'],
    matter_id?: string,
  ): SetupResumeTarget | undefined =>
    matter_id === undefined
      ? undefined
      : { matter_id, person_id: actor.person_id, assignment_id: actor.assignment_id }

  /** 还在等人处理的那张（去重键一致、总线上还没定）。 */
  const activeCard = async (
    bus: ApprovalBus,
    dedupe_key: string,
  ): Promise<{ id: string; item: ApprovalItem; rec: CardRecord } | undefined> => {
    for (const [id, rec] of Object.entries(state.cards)) {
      if (rec.dedupe_key !== dedupe_key || rec.done === true) continue
      const item = await bus.get(id).catch(() => undefined)
      if (item !== undefined && ACTIVE_STATES.has(item.state)) return { id, item, rec }
    }
    return undefined
  }

  /** 把这件事挂到这张卡的「等着的」上；挂上了（原来没有）回 `true`。 */
  const attachTo = (rec: CardRecord, resume: SetupResumeTarget | undefined): boolean => {
    if (resume === undefined) return false
    if (rec.waiting.some((w) => w.matter_id === resume.matter_id)) return false
    rec.waiting.push(resume)
    save()
    return true
  }

  const cardBase = (input: {
    actor: RunRequest['actor']
    matter_id?: string | undefined
    run_id?: string | undefined
    object: { type: string; id: string }
  }) => ({
    workspace_id: ws as never,
    schema_version: 1 as const,
    role_id: input.actor.role_id as never,
    subject: {
      object: input.object,
      ...(input.matter_id === undefined ? {} : { matter_id: input.matter_id as never }),
    },
    evidence: {
      ...(input.run_id === undefined ? {} : { run_id: input.run_id as never }),
      source_events: [],
      provenance: { seen: [] },
      precheck: {},
    },
    proposer: {
      kind: 'system' as const,
      id: 'setup_cards',
      assignment_id: input.actor.assignment_id as never,
    },
    automation: {
      level_at_creation: 'L1' as const,
      auto_approved: false,
      mandate_check: { within: true, caps_hit: [] },
      sampling: { selected: false },
    },
    routing: {
      recipients: [{ person: input.actor.person_id as never, via: 'role_holder' as const }],
      rule: 'role_holder' as const,
      escalation: {
        after_hours: 24,
        business_hours: true,
        chain: ['owner' as const],
        escalated_at: [],
      },
      separation_of_duties: false,
    },
    priority: 'immediate' as const,
    risk_class: 'low' as const,
  })

  const namesOf = (needs: readonly ConnectNeed[]): string => needs.map((n) => n.name).join('、')

  const askConnect: SetupCardsAssembly['askConnect'] = async (input) => {
    const bus = options.approvals()
    if (bus === undefined) return undefined
    // 已经连上的不再要（认不出的照样要：卡上给接法，人自己判断）
    const needs: ConnectNeed[] = []
    for (const n of input.needs) {
      if (needs.some((x) => x.kind === n.kind)) continue
      const connected = await options.isConnected(n).catch(() => undefined)
      if (connected === true && n.state !== 'reauth') continue
      needs.push(n)
    }
    if (needs.length === 0) return undefined
    const dedupe_key = connectRequestDedupeKey(ws, needs)
    const resume = input.resume === false ? undefined : resumeOf(input.actor, input.matter_id)
    const prior = await activeCard(bus, dedupe_key)
    if (prior !== undefined) {
      const attach = attachTo(prior.rec, resume)
      emit('setup_card.reused', { card_id: prior.id, kind: 'connect_request', attach })
      return { item: prior.item, attach }
    }
    const risk =
      input.risk ??
      needs
        .map((n) => (n.service === undefined ? undefined : RISK_BY_SERVICE[n.service]))
        .find((r) => r !== undefined)
    const first = needs[0]
    const offer =
      first === undefined
        ? undefined
        : await options
            .workshopOffer?.({ key: `connect:${first.service ?? first.kind}`, name: first.name })
            .catch(() => undefined)
    const payload: ConnectRequestPayload = {
      form: 'connect_request',
      why: input.why ?? `这件事要用到${namesOf(needs)}，连上我就接着做。`,
      needs,
      ...(risk === undefined ? {} : { risk }),
      ...(resume === undefined ? {} : { resume }),
      ...(offer === undefined ? {} : { workshop_service: offer }),
    }
    const item = await bus.create({
      ...cardBase({
        actor: input.actor,
        matter_id: input.matter_id,
        run_id: input.run_id,
        object: { type: 'connection', id: needs.map((n) => n.kind).join('+') },
      }),
      kind: 'connect_request',
      dedupe_key,
      title: `先连上${namesOf(needs)}`,
      summary: payload.why,
      payload,
    } as never)
    state.cards[item.id] = {
      kind: 'connect_request',
      dedupe_key,
      waiting: resume === undefined ? [] : [resume],
    }
    save()
    emit('setup_card.asked', {
      card_id: item.id,
      kind: 'connect_request',
      needs: needs.map((n) => n.kind),
    })
    return { item, attach: resume !== undefined }
  }

  /** 目标的格子（查一遍没有秘密格）。 */
  const fieldsOf = async (target: SetupTarget): Promise<SetupField[]> => {
    const fields = await target.fields()
    for (const f of fields)
      if (isSecretLikeSetupKey(f.key, f.label))
        throw new SetupCardError(
          'secret_field',
          `「${f.label}」像是口令 / 密钥，不能放进配置卡（只能在连接卡的本机表单里填）。`,
        )
    return fields
  }

  /** WP348：查过的搜索 / 模型结果（同一句话 7 天内不再花钱）。 */
  const researchCache = {
    get(key: string): unknown {
      const hit = state.research?.[key]
      if (hit === undefined) return undefined
      if (Date.parse(options.clock.now()) - Date.parse(hit.at) > RESEARCH_TTL_MS) return undefined
      return hit.value
    },
    set(key: string, value: unknown): void {
      const all = { ...(state.research ?? {}), [key]: { at: options.clock.now(), value } }
      const keys = Object.keys(all)
      if (keys.length > RESEARCH_MAX)
        for (const k of keys
          .sort((a, b) => Date.parse(all[a]?.at ?? '') - Date.parse(all[b]?.at ?? ''))
          .slice(0, keys.length - RESEARCH_MAX))
          delete all[k]
      state.research = all
      save()
    },
  }

  /**
   * WP348：出卡前查一遍（目标有「怎么查」、宿主给了工具才查）。查的过程写进这件事的时间线
   * （几行：查了什么、看到什么），也带在卡上。
   */
  const planOf = async (
    target: SetupTarget,
    fields: SetupField[],
    input: AskSetupInput,
  ): Promise<{
    fields: SetupField[]
    steps: NonNullable<SetupRequestPayload['steps']>
    /** WP410：没查成的那一句原因（查成了 / 本来不查就没有）。 */
    failed?: string
  }> => {
    // 宿主没给工具（老装配 / 测试）：照样查——已连的数据由目标自己读，档案 / 搜索 / 模型就是没有
    const host: SetupResearchHost | undefined =
      target.research === undefined
        ? undefined
        : (options.research?.({
            actor: input.actor,
            target: target.id,
            ...(input.run_id === undefined ? {} : { run_id: input.run_id }),
          }) ?? { profile: () => ({}) })
    let plan: SetupPlan = {}
    let steps: NonNullable<SetupRequestPayload['steps']> = []
    let threw: string | undefined
    let problems: string[] = []
    if (target.research !== undefined && host !== undefined) {
      const {
        kit,
        steps: stepsOf,
        used,
        problems: problemsOf,
      } = createResearchKit(host, { cache: researchCache })
      try {
        plan = await target.research(kit)
      } catch (e) {
        plan = {}
        // WP410：查的过程出错——照实说（只留一小段，不带堆栈）
        const msg = e instanceof Error ? e.message.trim() : ''
        threw = msg === '' ? '查的时候出错了' : `查的时候出错了：${msg.slice(0, 60)}`
      }
      steps = stepsOf()
      problems = problemsOf()
      emit('setup_card.researched', { target: target.id, steps: steps.length, ...used() })
    }
    const merged = mergePlan(fields, plan, {
      ...(input.suggestions === undefined ? {} : { suggestions: input.suggestions }),
      ...(input.reasons === undefined ? {} : { reasons: input.reasons }),
      ...(target.noGuess === undefined ? {} : { noGuess: target.noGuess }),
    })
    if (input.matter_id !== undefined) for (const st of steps) note(input.matter_id, st.text)
    const failed =
      target.research === undefined ? undefined : researchFailure(merged, target, threw, problems)
    if (failed !== undefined) emit('setup_card.research_failed', { target: target.id })
    return { fields: merged, steps, ...(failed === undefined ? {} : { failed }) }
  }

  /** WP410：开着的这张为什么要换掉（不用换回 `undefined`）。格子形状变了 / 旧版空表单 → 一定换。 */
  const staleOf = async (
    prior: SetupRequestPayload,
    target: SetupTarget,
    input: AskSetupInput,
  ): Promise<'legacy' | 'shape' | 'research_failed' | 'suggestions' | 'refresh' | undefined> => {
    if (isLegacySetupRequest(prior)) return 'legacy'
    const keys = (await fieldsOf(target).catch(() => undefined))?.map((f) => f.key)
    if (keys !== undefined && keys.join('\n') !== prior.fields.map((f) => f.key).join('\n'))
      return 'shape'
    if (prior.research_failed !== undefined) return 'research_failed'
    const given = Object.entries(input.suggestions ?? {})
    if (
      given.some(([k, v]) => {
        const f = prior.fields.find((x) => x.key === k)
        return f !== undefined && (f.suggested ?? '').trim() !== v.trim()
      })
    )
      return 'suggestions'
    return input.refresh === true ? 'refresh' : undefined
  }

  const askSetupWith = async (
    input: AskSetupInput,
    prepared?: AskSetupPrepared,
  ): Promise<{ item: ApprovalItem; attach: boolean } | undefined> => {
    const bus = options.approvals()
    const target = targets.get(input.target)
    if (bus === undefined || target === undefined) return undefined
    const change = prepared?.mode === 'change' || input.change === true
    // 「改成这样」不看设好了没有；别的设好了就不出
    if (!change && (await target.satisfied().catch(() => false))) return undefined
    const dedupe_key = setupRequestDedupeKey(ws, target.id)
    const resume = resumeOf(input.actor, input.matter_id)
    const prior = await activeCard(bus, dedupe_key)
    /*
     * WP410（真机 #6）：开着的那张不是拿来就用——旧版空表单、格子变了、上次没查成、AI 这次给的值不一样、
     * 或调用方要「刷新」（插件刚交回账号）：重新查、重出一张，开着的那张收起，等着的事项带过去。
     */
    const stale =
      prior === undefined || prepared !== undefined
        ? undefined
        : await staleOf(finalPayload(prior.item) as SetupRequestPayload, target, input)
    if (prior !== undefined && stale === undefined) {
      const attach = attachTo(prior.rec, resume)
      emit('setup_card.reused', { card_id: prior.id, kind: 'setup_request', attach })
      return { item: prior.item, attach }
    }
    let fields: SetupField[]
    let steps: NonNullable<SetupRequestPayload['steps']> = prepared?.steps ?? []
    let failed: string | undefined
    if (prepared !== undefined) fields = prepared.fields
    else if (change) {
      const next = changeFields(await fieldsOf(target), input.suggestions ?? {}, {
        ...(input.reasons === undefined ? {} : { reasons: input.reasons }),
        ...(target.noGuess === undefined ? {} : { noGuess: target.noGuess }),
      })
      if (next === undefined) return undefined
      fields = next
    } else {
      const planned = await planOf(target, await fieldsOf(target), input)
      fields = planned.fields
      steps = planned.steps
      failed = planned.failed
    }
    if (fields.length === 0) return undefined
    // 「刷新」「AI 给了值」重查出来跟开着的那张一样：不换，照旧挂上去
    if (prior !== undefined && (stale === 'refresh' || stale === 'suggestions')) {
      const was = finalPayload(prior.item) as SetupRequestPayload
      if (JSON.stringify(was.fields) === JSON.stringify(fields) && was.research_failed === failed) {
        const attach = attachTo(prior.rec, resume)
        emit('setup_card.reused', { card_id: prior.id, kind: 'setup_request', attach })
        return { item: prior.item, attach }
      }
    }
    const carried: SetupResumeTarget[] = []
    if (prior !== undefined) {
      prior.rec.done = true
      save()
      await bus.withdraw(prior.id, 'system' as never).catch(() => undefined)
      carried.push(...prior.rec.waiting)
      emit('setup_card.replaced', { card_id: prior.id, target: target.id, reason: stale })
    }
    const waiting = [...carried]
    if (resume !== undefined && !waiting.some((w) => w.matter_id === resume.matter_id))
      waiting.push(resume)
    const offer = change
      ? undefined
      : await options
          .workshopOffer?.({ key: `setup:${target.id}`, name: target.name })
          .catch(() => undefined)
    const why =
      failed === undefined
        ? (input.why ?? target.why)
        : `没查成：${failed}。要不要你来填下面几格？也可以补好品牌档案后跟我说「再查一次」。`
    const payload: SetupRequestPayload = {
      form: 'setup_request',
      target: target.id,
      why,
      fields,
      mode: change ? 'change' : 'plan',
      ...(steps.length === 0 ? {} : { steps }),
      ...(failed === undefined ? {} : { research_failed: failed }),
      ...(resume === undefined ? {} : { resume }),
      ...(offer === undefined ? {} : { workshop_service: offer }),
    }
    const item = await bus.create({
      ...cardBase({
        actor: input.actor,
        matter_id: input.matter_id ?? carried[0]?.matter_id,
        run_id: input.run_id,
        object: { type: 'setting', id: target.id },
      }),
      kind: 'setup_request',
      dedupe_key,
      title: change
        ? `${target.name}：我打算改成这样`
        : failed === undefined
          ? `${target.name}：我打算这样设`
          : `${target.name}：没查成，要你来填吗`,
      summary: payload.why,
      payload,
    } as never)
    state.cards[item.id] = { kind: 'setup_request', dedupe_key, waiting }
    save()
    // 没查成照实说：这件事的时间线上记一句（不装成方案）
    if (failed !== undefined)
      for (const w of waiting)
        note(w.matter_id, `没查成${target.name}的方案：${failed}。卡上的格子要不要你来填？`)
    // 换下来的那张上等着的别的事项：说一声卡换了
    for (const w of carried)
      if (w.matter_id !== input.matter_id)
        note(w.matter_id, `${target.name}的设置卡换成新的了，在「要你处理」里。`)
    emit('setup_card.asked', {
      card_id: item.id,
      kind: 'setup_request',
      target: target.id,
      mode: payload.mode,
      needs_you: fields.filter((f) => f.needs_you === true).length,
      ...(failed === undefined ? {} : { research_failed: true }),
      ...(prior === undefined ? {} : { replaced: prior.id }),
    })
    return { item, attach: resume !== undefined }
  }
  const askSetup: SetupCardsAssembly['askSetup'] = (input) => askSetupWith(input)

  const onRunBlocked: SetupCardsAssembly['onRunBlocked'] = async (input) => {
    const common = {
      actor: input.actor,
      matter_id: input.matter_id,
      run_id: input.run_id,
      ...(input.why === undefined ? {} : { why: input.why }),
    }
    // 缺连接比缺设置根本：两样都有先连
    if (input.needs.length > 0) {
      const needs =
        input.block.reason === 'missing_credential'
          ? input.needs.map((n) => ({ ...n, state: 'reauth' as const }))
          : input.needs
      const out = await askConnect({ ...common, needs })
      if (out !== undefined) return out
    }
    for (const target of input.targets) {
      const suggestions = input.suggestions?.[target]
      const reasons = input.reasons?.[target]
      const out = await askSetup({
        ...common,
        target,
        ...(suggestions === undefined ? {} : { suggestions }),
        ...(reasons === undefined ? {} : { reasons }),
        ...(input.changes?.includes(target) === true ? { change: true } : {}),
      })
      if (out !== undefined) return out
    }
    return undefined
  }

  /** 这张卡上等着的每件事都接着做（只做一次）。 */
  const settle = async (id: string, rec: CardRecord, text: string): Promise<number> => {
    if (rec.done === true || settling.has(id)) return 0
    settling.add(id)
    try {
      rec.done = true
      save()
      let n = 0
      for (const w of rec.waiting) {
        try {
          await options.resume({ ...w, text })
          n += 1
        } catch {
          note(w.matter_id, '补好了，但这件事没能接着跑起来；在这里说一句「接着做」就行。')
        }
      }
      emit('setup_card.resumed', { card_id: id, kind: rec.kind, resumed: n })
      return n
    } finally {
      settling.delete(id)
    }
  }

  /** 还缺哪几样（认不出的当连上了：人说连好了就信人）。 */
  const stillMissing = async (needs: readonly ConnectNeed[]): Promise<ConnectNeed[]> => {
    const out: ConnectNeed[] = []
    for (const n of needs)
      if ((await options.isConnected(n).catch(() => undefined)) === false) out.push(n)
    return out
  }

  /** WP348：上一张配置卡（带人填过的值）→ 重出一张时的格子（不再查一遍）。 */
  const preparedFrom = (item: ApprovalItem): AskSetupPrepared | undefined => {
    const p = finalPayload(item) as SetupRequestPayload
    if (!Array.isArray(p.fields)) return undefined
    const given = p.values ?? {}
    const fields = p.fields.map((f): SetupField => {
      const v = given[f.key]
      if (typeof v !== 'string' || v.trim() === '') return f
      const { needs_you: _n, ...rest } = f
      return { ...rest, suggested: v.trim() }
    })
    return {
      fields,
      mode: p.mode === 'change' ? 'change' : 'plan',
      ...(p.steps === undefined ? {} : { steps: p.steps }),
    }
  }

  /** 卡没成（还没连上 / 填得不对）：给等着的事项说一句，再出一张新的（把等着的带过去）。 */
  const reask = async (item: ApprovalItem, rec: CardRecord, text: string): Promise<void> => {
    rec.done = true
    save()
    for (const w of rec.waiting) note(w.matter_id, text)
    const first = rec.waiting[0]
    const actor = {
      person_id: (first?.person_id ?? item.routing.recipients[0]?.person ?? '') as never,
      assignment_id: (first?.assignment_id ?? item.proposer.assignment_id ?? '') as never,
      role_id: item.role_id,
    } as RunRequest['actor']
    const payload = item.payload as ConnectRequestPayload | SetupRequestPayload
    const out =
      payload.form === 'connect_request'
        ? await askConnect({
            actor,
            needs: payload.needs,
            why: payload.why,
            ...(first === undefined ? {} : { matter_id: first.matter_id }),
          })
        : await askSetupWith(
            {
              actor,
              target: payload.target,
              why: payload.why,
              ...(first === undefined ? {} : { matter_id: first.matter_id }),
            },
            preparedFrom(item),
          )
    if (out === undefined) return
    const next = state.cards[out.item.id]
    if (next !== undefined) for (const w of rec.waiting.slice(1)) attachTo(next, w)
    try {
      options.onCard?.(out.item)
    } catch {
      // 挂不上事项不影响卡本身
    }
  }

  const onDecided: SetupCardsAssembly['onDecided'] = async (item) => {
    if (item.kind !== 'connect_request' && item.kind !== 'setup_request') return
    const rec = state.cards[item.id]
    if (rec === undefined || rec.done === true) return
    const action = item.decision?.action
    if (action === 'reject') {
      rec.done = true
      save()
      /*
       * WP410（真机 #9）：只说「这张卡不要了」，不说「这件事停在这儿」——别的路可能早就在跑
       * （Reddit 巡查走插件，不连官方 API 照样跑），那一句会让人以为事情停了。
       */
      const p = item.payload as ConnectRequestPayload | SetupRequestPayload
      const what =
        p.form === 'connect_request'
          ? `先不连${namesOf(p.needs)}了`
          : `先不设${targets.get(p.target)?.name ?? '这一步'}了`
      for (const w of rec.waiting)
        note(w.matter_id, `${what}；用到它的那一步先跳过，要用时跟我说一声。`)
      emit('setup_card.declined', { card_id: item.id, kind: item.kind })
      return
    }
    if (action !== 'approve' && action !== 'approve_edited') return
    if (item.kind === 'connect_request') {
      const payload = item.payload as ConnectRequestPayload
      const missing = await stillMissing(payload.needs)
      if (missing.length > 0) {
        await reask(item, rec, `还没连上${namesOf(missing)}，连好会自动接着做。`)
        return
      }
      await settle(item.id, rec, '连好了，接着做')
      return
    }
    const payload = finalPayload(item) as SetupRequestPayload
    const target = targets.get(payload.target)
    if (target === undefined) {
      rec.done = true
      save()
      return
    }
    try {
      const by = item.decision?.by
      await target.apply(
        valuesOf(payload),
        by === undefined || by === 'mandate' ? {} : { by: String(by) },
      )
    } catch (e) {
      const why = e instanceof Error ? e.message : '没存成'
      await reask(item, rec, `没存成：${why}`)
      return
    }
    emit('setup_card.saved', { card_id: item.id, target: target.id })
    await settle(item.id, rec, '设好了，接着做')
  }

  const recheck: SetupCardsAssembly['recheck'] = async () => {
    const bus = options.approvals()
    if (bus === undefined) return 0
    let n = 0
    for (const [id, rec] of Object.entries(state.cards)) {
      if (rec.done === true || rec.kind !== 'connect_request') continue
      const item = await bus.get(id).catch(() => undefined)
      if (item === undefined || !ACTIVE_STATES.has(item.state)) continue
      const payload = item.payload as ConnectRequestPayload
      // 认不出的不算连上（没人点，不替人判断）
      let all = true
      for (const need of payload.needs)
        if ((await options.isConnected(need).catch(() => undefined)) !== true) all = false
      if (!all) continue
      // 在别处（连接页 / 第三栏）连好了：卡自己收起，等着的接着做
      await bus.withdraw(id, 'system' as never).catch(() => undefined)
      n += (await settle(id, rec, '连好了，接着做')) > 0 ? 1 : 0
    }
    return n
  }

  /** WP410：升级迁移——旧版空表单卡作废，没设好的目标换成方案卡（每个品牌一次）。 */
  const migrateLegacy = async (): Promise<{ withdrawn: number; reasked: number }> => {
    const out = { withdrawn: 0, reasked: 0 }
    if (state.migrations?.includes(LEGACY_SETUP_MIGRATION) === true) return out
    const bus = options.approvals()
    if (bus === undefined) return out
    for (const [id, rec] of Object.entries(state.cards)) {
      if (rec.done === true || rec.kind !== 'setup_request') continue
      const item = await bus.get(id).catch(() => undefined)
      if (item === undefined || !ACTIVE_STATES.has(item.state)) continue
      const payload = item.payload as SetupRequestPayload
      if (!isLegacySetupRequest(payload)) continue
      rec.done = true
      save()
      await bus.withdraw(id, 'system' as never).catch(() => undefined)
      out.withdrawn += 1
      emit('setup_card.migrated', { card_id: id, target: payload.target })
      const target = targets.get(payload.target)
      if (target === undefined || (await target.satisfied().catch(() => false))) continue
      const first = rec.waiting[0]
      const actor = {
        person_id: (first?.person_id ?? item.routing.recipients[0]?.person ?? '') as never,
        assignment_id: (first?.assignment_id ?? item.proposer.assignment_id ?? '') as never,
        role_id: item.role_id,
      } as RunRequest['actor']
      const next = await askSetupWith({
        actor,
        target: target.id,
        ...(first === undefined ? {} : { matter_id: first.matter_id }),
      }).catch(() => undefined)
      if (next === undefined) continue
      out.reasked += 1
      const rec2 = state.cards[next.item.id]
      if (rec2 !== undefined) for (const w of rec.waiting.slice(1)) attachTo(rec2, w)
      for (const w of rec.waiting)
        note(
          w.matter_id,
          `旧版的「${target.name}」设置卡作废了，换成新的方案卡：我先查过一遍，你点头就行。`,
        )
      try {
        options.onCard?.(next.item)
      } catch {
        // 挂不上事项不影响卡本身
      }
    }
    state.migrations = [...(state.migrations ?? []), LEGACY_SETUP_MIGRATION]
    save()
    // 没有要换的就不记审计事件（每个新品牌开机都会走到这里）
    if (out.withdrawn > 0)
      emit('setup_card.migration_done', { name: LEGACY_SETUP_MIGRATION, ...out })
    return out
  }

  /** WP410：这条职责的「当前设置快照」。 */
  const stateFor = async (role_id: string): Promise<ContextItem | undefined> => {
    const mine = [...targets.values()].filter(
      (t) => t.state !== undefined && t.roles?.includes(role_id) === true,
    )
    if (mine.length === 0) return undefined
    const settings: Record<string, unknown>[] = []
    for (const t of mine) {
      const st = await t.state?.().catch(() => undefined)
      if (st === undefined) continue
      settings.push({
        target: t.id,
        name: t.name,
        configured: st.configured,
        values: Object.fromEntries(
          Object.entries(st.values).map(([k, v]) => [k, v.trim() === '' ? '（空）' : v]),
        ),
        ...(st.connections === undefined ? {} : { connections: st.connections }),
        ...(st.notes === undefined || st.notes.length === 0 ? {} : { notes: st.notes }),
      })
    }
    if (settings.length === 0) return undefined
    // 还开着的设置 / 连接卡（这条职责名下的，或就是这几个目标的）
    const open: { kind: string; title: string }[] = []
    const bus = options.approvals()
    const ids = new Set(mine.map((t) => t.id))
    if (bus !== undefined)
      for (const [id, rec] of Object.entries(state.cards)) {
        if (rec.done === true) continue
        const item = await bus.get(id).catch(() => undefined)
        if (item === undefined || !ACTIVE_STATES.has(item.state)) continue
        const p = item.payload as ConnectRequestPayload | SetupRequestPayload
        const ours = item.role_id === role_id || (p.form === 'setup_request' && ids.has(p.target))
        if (!ours) continue
        open.push({ kind: rec.kind === 'connect_request' ? '连接卡' : '设置卡', title: item.title })
      }
    const content = canonicalJson({
      note:
        '这是此刻从库里读出的真实值，不是记忆。说连接、设置、巡查跑没跑，只按这一段；' +
        '这里没写的就说不知道、去查，不要凭之前的对话。',
      settings,
      open_cards: open,
    })
    return {
      id: SETUP_STATE_CONTEXT_ID,
      kind: 'summary',
      source_ref: SETUP_STATE_CONTEXT_ID,
      sensitivity: 'internal',
      content,
      bytes: new TextEncoder().encode(content).byteLength,
    }
  }

  return {
    migrateLegacy,
    stateFor,
    registerTarget(target) {
      if (targets.has(target.id))
        throw new SetupCardError('invalid_input', `设置目标重复登记：${target.id}`)
      targets.set(target.id, target)
      return () => {
        if (targets.get(target.id) === target) targets.delete(target.id)
      }
    },
    onRunBlocked,
    askConnect,
    askSetup,
    onDecided,
    recheck,
    async openConnectCard(kinds) {
      const bus = options.approvals()
      if (bus === undefined) return undefined
      const key = connectRequestDedupeKey(
        ws,
        kinds.map((kind) => ({ kind, name: kind, required: true })),
      )
      return (await activeCard(bus, key))?.id
    },
    target: (id) => targets.get(id),
    targetIds: () => [...targets.keys()].sort(),
    researchCache,
  }
}

/**
 * 卡上带回的值 → 只留登记过的格子（多的扔掉）；人没改的用建议值；必填空着就拒。
 * 秘密格子在出卡时就拒了，这里再兜一道（带回来的值里有像秘密的键也扔）。
 */
export function valuesOf(payload: SetupRequestPayload): Record<string, string> {
  const given = payload.values ?? {}
  const out: Record<string, string> = {}
  for (const f of payload.fields) {
    if (isSecretLikeSetupKey(f.key, f.label)) continue
    const raw = given[f.key] ?? f.suggested ?? ''
    const v = typeof raw === 'string' ? raw.trim() : String(raw)
    if (v === '') {
      if (f.required) throw new SetupCardError('invalid_input', `「${f.label}」还没填。`)
      continue
    }
    if (f.kind === 'select' && f.options !== undefined && !f.options.some((o) => o.value === v))
      throw new SetupCardError('invalid_input', `「${f.label}」不在可选的里面。`)
    out[f.key] = v
  }
  return out
}

/**
 * WP410（真机 #6）：查完了，卡上能让人「就这样」的格子一格都没有（只剩默认的下拉 / 开关、
 * 不让 AI 猜的账号）——这就是没查成，不能装成方案、静默退回一张空表单。回人话原因；查成了回 `undefined`。
 */
export function researchFailure(
  fields: readonly SetupField[],
  target: Pick<SetupTarget, 'noGuess'>,
  threw: string | undefined,
  problems: readonly string[],
): string | undefined {
  if (threw !== undefined) return [threw, ...problems].join('；')
  const noGuess = new Set(target.noGuess ?? [])
  const free = fields.filter(
    (f) => f.kind !== 'select' && f.kind !== 'toggle' && !noGuess.has(f.key),
  )
  if (free.length === 0) return undefined
  if (free.some((f) => (f.suggested ?? '').trim() !== '')) return undefined
  return problems.length > 0 ? problems.join('；') : '档案和搜索里都没找到能用的'
}
