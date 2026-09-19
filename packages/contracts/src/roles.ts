import type { ChangeKind } from './changes.js'
import type {
  AssignmentId,
  DataDomain,
  Iso8601,
  Level,
  Operation,
  PersonId,
  Range,
  RangeRef,
  RiskClass,
  RoleId,
  Sensitivity,
  WorkspaceId,
} from './common.js'
import type { GroundingRule } from './run.js'

/** 动作 id（WriteActionSpec.id），如 'stage_refund' */
export type ActionId = string

/** 范围组 id（`rg_*`）。 */
export type RangeGroupId = string
/** 产品线 id（`pl_*`）。 */
export type ProductLineId = string

/**
 * 45 H2：一个组织对象是**谁带进来的**。
 *
 * 个人工作区里建的品牌 / 产品线经 Join 向导并进公司之后，公司那份记一条 `origin`——
 * 于是"这条是王岚一个人用的时候建的"这件事在合并十次之后仍然看得见（40 §1 数据归属）。
 */
export interface ObjectOrigin {
  /** 它原来在哪个工作区（个人工作区的 id）。 */
  workspace_id: WorkspaceId
  /** 原来的主人。 */
  person_id: PersonId
  /** 原来那条的 id（合并后它会打上 `superseded_by` 指回公司这条）。 */
  object_id?: string
}

/**
 * 44 G1 品牌 = 范围组：**一组范围的名字**，不是一种新的范围种类。
 *
 * 岗位可以挂"品牌乙"这个组；判权限时展开成成员（`Assignment.ranges` 里存的是展开后的，
 * `Assignment.range_groups` 记住来源）。品牌新开一家店 → 把店加进组 → 挂了这个组的
 * 岗位自动多这家店，并记一条 `assignment.range_expanded`（44 G5）。
 */
export interface RangeGroup {
  id: RangeGroupId
  workspace_id: WorkspaceId
  name: string
  members: RangeRef[]
  created_at: Iso8601
  updated_at: Iso8601
  /**
   * 45 H3：这一份已经被公司那份取代，**只读**；读它的人看到的是 `superseded_by` 指的那一条。
   *
   * 退出公司时（45 H3 最后一句）把它清掉，个人那份恢复可编辑——所以是"别名"不是"删除"。
   */
  superseded_by?: RangeGroupId
  /** 45 H2：这一条是谁、从哪个工作区带进来的（合并进公司之后还看得出来源）。 */
  origin?: ObjectOrigin
  /**
   * 45 H4：谁建的。查重命中时界面上那句"已有：品牌乙（王岚 建，3 个岗位挂着）"
   * 里的"王岚"就是它——没有这一格，后来的人看不出该去问谁。
   */
  created_by?: PersonId
}

/** Shopify 的产品线判据：这四个字段 Admin GraphQL 都能 `query:` 直接过滤（44 §3 G2）。 */
export interface ShopifyLineRule {
  platform: 'shopify'
  collection_ids?: string[]
  tags?: string[]
  vendors?: string[]
  product_types?: string[]
}

/** 亚马逊的产品线判据（SP-API 报表能按 ASIN 过滤；订单要在本地按行项目切）。 */
export interface AmazonLineRule {
  platform: 'amazon'
  asins?: string[]
  sku_prefixes?: string[]
  brand?: string
}

/** 手填一份商品清单——平台不给判据、或者就是想按人头切的时候用。 */
export interface ManualLineRule {
  platform: 'manual'
  product_ids: string[]
}

export type ProductLineRule = ShopifyLineRule | AmazonLineRule | ManualLineRule

/**
 * 44 G2 产品线 = 新范围种类 `product_line` 的定义。
 *
 * `parent` 是它切在哪一层（一家店 / 一个平台账号 / 账号下的一个市场）；
 * `rule` 是平台内的判据。判定发生在两处：拉数据时（能下推的下推，不能的本地按行项目切）、
 * 写动作时（目标商品必须落在成员里，否则 `target_in_range` 拒）。
 */
export interface ProductLine {
  id: ProductLineId
  workspace_id: WorkspaceId
  name: string
  /** 只允许 `store` / `account` / `market` 三种（产品线切在它们**里面**）。 */
  parent: RangeRef
  rule: ProductLineRule
  created_at: Iso8601
  updated_at: Iso8601
  /** 45 H3：已经被公司那份取代，只读；读它的人看到的是 `superseded_by` 指的那一条。 */
  superseded_by?: ProductLineId
  /** 45 H2：谁、从哪个工作区带进来的。 */
  origin?: ObjectOrigin
  /** 45 H4：谁建的（查重命中时界面上显示"去问他"）。 */
  created_by?: PersonId
}

/** 05 §1.1。09-08 修正：不做跨 Assignment 并集，每次运行绑定一个 Assignment，其 scopes 原样生效。 */
export interface PermissionScope {
  domain: DataDomain
  ops: Operation[]
  range: Range
  max_sensitivity: Sensitivity
}

/** 05 §1.3 额度。Role 默认 → WorkspacePolicy 覆盖 → Assignment 只能更紧。 */
export interface Mandate {
  caps: Record<string, number | string | boolean | string[]>
  per_change_limits?: { max_items?: number; no_repeat_target_field?: boolean }
  window?: { max_count: number; per: 'day' | 'week' }
}

export interface AutomationSpec {
  ceiling: Level
  initial: Level
  hard_ceiling?: boolean
  /** 09-08：采纳率只是体验指标，不解锁自动执行；此处保留统计口径 */
  promotion: { adoption_rate_min: number; window_weeks: number; min_samples: number }
  demotion_triggers: ('customer_complaint' | 'guardrail_hit' | 'manual')[]
}

export interface WriteActionSpec {
  id: ActionId
  target: DataDomain
  kind: 'staged_change' | 'outbound_message' | 'publish' | 'config_change'
  /** 09-09（WP3）：显式映射到 15 §2 的变更种类与风险等级，不靠命名前缀猜 */
  change_kind?: ChangeKind
  risk_class?: RiskClass
  mandate: Mandate
  requires_record_read?: boolean
  protected_fields?: string[]
  review_cannot_be_disabled?: boolean
  route_to: 'role_holder' | 'scope_manager' | 'owner' | { role: RoleId }
}

export interface ConnectorDependency {
  kind: string
  required: boolean
  grants: string[]
  ownership: 'workspace' | 'person'
}

/** 05 §1.6 首页积木引用（组件与查询按名引用注册表） */
export interface HomeBlockSpec {
  id: string
  placement: 'queue' | 'alert' | 'focus' | 'digest' | 'role_view'
  component: string
  query: string
  default_order: number
  pinnable: boolean
  adaptive: boolean
  /** 36 §3：focus 块限 stat_tile，数字块要知道怎么格式化与默认时间窗 */
  format?: 'money' | 'count' | 'percent' | 'ratio'
  range_default?: 'yesterday' | 'last_7d'
}

/** 05 §1.7 通知路由 */
export interface NotificationRule {
  event: string
  mode: 'immediate' | 'queue' | 'digest'
  recipients: ('role_holder' | 'scope_manager' | 'owner')[]
  escalate_after_hours?: number
  digest_schedule?: string
}

/**
 * WP84（53 §3「217 张角色卡」那一行 / 54 §1 第 6 行）：**冷启动用的一句话**。
 *
 * 为什么要有它：空白的工作台不会告诉人"这个岗位能替我干什么"。别人的做法是给每个
 * 角色配一堆 `quick_prompts`，我们借这个形、不借它的聊天框——36 §3 的对话入口只有
 * 指导 / 问 AI / ⌘K / 事项页四处，所以一条快捷提示点下去是**开一件事**（54 §2 的岗位
 * 任务入口），不是往一个聊天框里塞一句话。
 *
 * 三条纪律：
 * 1. **它不是权限**。快捷提示只是一句预写好的话，能不能做仍由 `actions` 与额度说了算；
 *    点它开出来的事项照样绑在本人那条分配上。
 * 2. **具体到这条职责的动作**，不写"帮我分析一下"这种放哪儿都成立的话。
 * 3. `label` 是按钮上那几个字（中英各一份），`prompt` 是真正送进事项的那句话
 *    （与 {@link RoleDefinition.description} 同一条规矩：一份中文，不双份维护）。
 */
export interface RoleQuickPrompt {
  /** 这条职责内唯一（`draft_return_reply`…）。 */
  id: string
  /** 按钮上的几个字。 */
  label: { zh: string; en: string }
  /** 点下去送进事项的那句话。 */
  prompt: string
  /**
   * 这一条是哪种活：`start_task` 真去做一件事、`ask` 只问不动、`review` 看一遍再定。
   * 界面按它排序与分组（做事的排在前面），不参与任何权限判定。
   */
  kind: 'start_task' | 'ask' | 'review'
}

/**
 * WP84：**这条职责典型能接什么活**——指导抽屉顶部的"示例任务"选择题（36 §1 选择题优先）。
 *
 * 与 {@link RoleQuickPrompt} 的分工：快捷提示是"点一下就开干"，示例任务是"它长这样"——
 * 后者带 `expected_output`，回答的是新人第一次看见这条职责时真正想问的那句话：
 * 交给它之后我会拿到什么。
 */
export interface RoleTaskExample {
  /** 这条职责内唯一。 */
  id: string
  title: { zh: string; en: string }
  /** 这件事要做什么（一两句人话）。 */
  description: string
  /** 做完你会拿到什么（一句话；不是保证，是形状）。 */
  expected_output: string
}

/** 一条职责最多几条快捷提示（再多首页那张卡就读不完了）。 */
export const MAX_QUICK_PROMPTS = 8
/** 一条职责最多几条示例任务。 */
export const MAX_TASK_EXAMPLES = 6

export interface RoleDefinition {
  id: RoleId
  version: string
  domain: 'dtc' | 'amz' | 'social' | 'kol' | 'ads' | 'design' | 'dev' | 'common' | 'pr'
  name: { zh: string; en: string }
  description: string
  scopes: PermissionScope[]
  connectors: ConnectorDependency[]
  actions: WriteActionSpec[]
  automation: Record<ActionId, AutomationSpec>
  skills: {
    name: string
    min_version?: string
    tier: 'open' | 'premium'
    load: 'always' | 'on_demand'
  }[]
  home_blocks: HomeBlockSpec[]
  notifications: NotificationRule[]
  grounding?: GroundingRule[]
  /**
   * WP63（51 §2.1）：异常卡的阈值（销售骤降 / 库存断货 / 转化异常）。
   *
   * 与 `Mandate.caps` 的分工：caps 越了就**拦**（那是权限），阈值过了只**出一张卡**
   * （那是提醒）。所以它不进 `EffectiveAction`，也不参与 guardrail。
   */
  thresholds?: Record<string, number>
  /**
   * WP84：首页岗位卡下面那几条"点一下就开干"（最多 {@link MAX_QUICK_PROMPTS} 条，id 唯一）。
   * 不填 = 这条职责在卡上不出快捷提示，别的一切照旧。
   */
  quick_prompts?: RoleQuickPrompt[]
  /**
   * WP84：指导抽屉顶部的"示例任务"（最多 {@link MAX_TASK_EXAMPLES} 条，id 唯一）。
   */
  task_examples?: RoleTaskExample[]
  /**
   * WP82（55 §3「域名白名单」那一行）：**这条职责的浏览器只许打开哪些站**。
   *
   * 一条 = 一个域名，`*.youtube.com` 这种通配也认（判定见 `hostAllowed`）。
   * 岗位带多条职责时取并集，进 `RunRequest.allowed_hosts`。
   *
   * 三条纪律：
   * 1. **不填 = 这条职责不能开浏览器**。缺省为空，空表示一律拒——
   *    白名单是"允许"表不是"禁止"表，忘了填的后果是不能用，不是随便逛。
   * 2. 它**不是权限**：能不能改东西仍由 `actions` 与额度说了算。它管的是
   *    "这条职责的浏览器会不会跑到别的站上去"。
   * 3. 只写这条职责真正要看的站。红人五条各写各的平台，Amazon 那条只开
   *    卖家后台——不是"顺手多开几个以后可能用得上"。
   */
  browser_scope?: string[]
  /**
   * WP72（56 §1）：这条职责靠什么干活。不写 = `api`（走连接器）。
   *
   * 写 `browser` = 这条渠道**没有可用的接口**，动作要走第三栏的受控浏览器
   * （36 §9 / 55 §3）。`social.facebook-group` 是第一个——Groups API 已停。
   *
   * 为什么要单立这一格而不是只看 `connectors` 空不空：空的 `connectors` 有两种
   * 含义——"这条职责不需要连接器"（红人那五条：没连也能靠导入干活）与
   * "这条渠道根本没有连接器可连"。界面上这两句话完全不同：前者不该出「去连接」，
   * 后者要出「这条走浏览器」。
   */
  mode?: 'api' | 'browser'
  /**
   * WP120（69）：**这条职责的角色定位**——系统提示里的「你是谁」。
   *
   * 为什么非有不可：69 §0 那条亲测记录——让红人营销岗位找红人，回出来的是客服的话。
   * 不是路由错了，是 Agent 的提示里从头到尾没有一句「你是谁、你不负责什么」，
   * 于是它照着手边唯一一份剧本（客服）答。
   *
   * 骨架固定六段（69 §2，每段 ≤ 200 字）：你是谁 / 你负责什么 / **你不负责什么、
   * 转给哪个岗位** / 做事顺序与判断口径 / 口气 / 哪些事必须出卡。第三段是防串岗的关键，
   * 不许省；`gen-ontology --check` 把「persona 为空」判成失败。
   *
   * 与 {@link Position.persona} 的分工：岗位那一段说「这个岗位在公司里是干什么的」，
   * 这一段说「这个岗位里的这一条活该怎么干」。装配时岗位在前、职责在后（69 §3）。
   *
   * 老的纯字符串写法仍然认（契约只加不删）：给 `{ zh, en }` 就是中英各一份。
   */
  persona?: PersonaText
  handover: {
    transfers: ('open_work_items' | 'context' | 'home_blocks' | 'queue_lane' | 'scheduled_tasks')[]
    fallback: 'owner' | 'scope_manager'
    revoke_context_on_removal: boolean
  }
  requires?: RoleId[]
}

export interface Assignment {
  id: AssignmentId
  person_id: PersonId
  workspace_id: WorkspaceId
  role_id: RoleId
  role_version: string
  /** **展开后**的范围（挂的范围组已经摊平进来了）；判权限只看这一份。 */
  ranges: RangeRef[]
  /**
   * 44 G1：这条分配挂了哪几个范围组（品牌）。`ranges` 里由它们展开出来的成员随组变；
   * 组成员一变就重算，并记一条 `assignment.range_expanded`（44 G5）。
   */
  range_groups?: RangeGroupId[]
  /** 按动作收紧（09-09 改：额度按动作索引，不能一份 override 套全部动作） */
  mandate_overrides?: Record<ActionId, Partial<Mandate>>
  automation_state: Record<
    ActionId,
    {
      level: Level
      adoption: { accepted: number; edited: number; rejected: number; since: Iso8601 }
      last_change: { at: Iso8601; reason: string }
    }
  >
  granted_by: PersonId
  granted_at: Iso8601
  revoked_at?: Iso8601
  handover_to?: PersonId | 'owner' | 'scope_manager'
}

export interface WorkspacePolicy {
  workspace_id: WorkspaceId
  mandates: Record<ActionId, Partial<Mandate>>
  global_caps: Record<string, number>
  sensitivity_overrides?: Record<string, Sensitivity>
  separation_of_duties?: ActionId[]
  /**
   * 18 §2.1 受控原始材料区保留多少天（缺省 90）。
   *
   * WP34 先把它塞在 `global_caps.raw_retention_days` 里——但 `global_caps` 是**额度**
   * （15 §3.1「可松可紧」的那一组数），保留期不是额度。WP35 给它一个显式字段；
   * 读的一侧先看这里，没有再回落 `global_caps.raw_retention_days`，最后才是默认值。
   */
  raw_retention_days?: number
}

/**
 * WP120（69 §1）：persona 的正文。
 *
 * 一份中文 + 一份英文（`{ zh, en }`），或者**只有一份**的老写法（纯字符串）。
 * 契约只加不删，所以纯字符串永远认——老的职责 yml 不用改就还能读。
 *
 * 为什么不像 `RoleDefinition.description` 那样「只写中文、界面不双份维护」：
 * description 是给**人**看的一行字，persona 是**进系统提示的正文**。英文界面下
 * 送一段中文 persona 进去，模型十有八九拿中文回英文客户——这正是 persona 要防的
 * 那种串味。所以这一格双份，而且两份要说同一件事。
 */
export type PersonaText = string | { zh: string; en: string }

/** 05 §2 岗位模板：只在分配那一刻展开成一组 Assignment */
export interface Position {
  id: string
  version: string
  name: { zh: string; en: string }
  roles: { role: RoleId; default: boolean }[]
  /**
   * WP120（69 §1）：**这个岗位的角色定位**——装配时排在职责 persona **前面**。
   *
   * 岗位那一段回答的是「这个岗位在公司里是干什么的、什么活不归它」；
   * 职责那一段回答「这个岗位里的这一条活怎么干」。两段都写，因为串岗有两种：
   * 岗位之间串（红人岗位答退款）与岗位内部串（红人岗位里 YouTube 那条去管 TikTok）。
   *
   * 只加字段：不填的岗位一切照旧（但内置的九个岗位一个都不许空，见 69 §2）。
   */
  persona?: PersonaText
}

/**
 * WP69（54 §1）：**岗位实体** = 一个工作区里"网站运营"这个岗位本身。
 *
 * 三条纪律，一条都不能松：
 *
 * 1. **算出来的，不是存出来的**。05 §2「岗位只在分配那一刻展开」一个字没改——
 *    这里的 `holders` / `roles` 全是从分配表现算的视图，没有第二份真源，
 *    也没有任何一条写口会往"岗位"上落东西。
 * 2. **不是权限并集**（05 §4 / 31 §3.1）。`roles[].assignment_ids` 只是"这个岗位下
 *    有哪几条分配"，每一次运行仍然只在**其中一条**下跑。
 * 3. **只含本人看得见的**：`open_matters` / `pending_cards` 是按请求人过滤后的数。
 */
export interface PositionInstance {
  /** 岗位模板 id（`web-ops`…），不是 Assignment id。 */
  position_id: string
  workspace_id: WorkspaceId
  name: { zh: string; en: string }
  /** 模板当时的版本（05 §2：之后改模板不影响已分配的人）。 */
  template_version: string
  /** 谁在做：默认包里的职责都在他名下才算（05 §2）。 */
  holders: PersonId[]
  /** 展开的职责 → 各自的分配（本工作区、未撤销的那些）。 */
  roles: {
    role_id: RoleId
    role_name: string
    /** 模板里这条是不是默认勾上的 */
    default: boolean
    /** 这个工作区里这条职责的全部分配（谁都算——这是岗位的视图，不是某个人的） */
    assignment_ids: AssignmentId[]
    /**
     * **请求人自己**在这条职责上的那一条。没有 = 他不做这条活儿。
     *
     * 界面上的每一个入口都只能用它：跳到岗位页、用这条职责开一件事、换职责——
     * 拿 `assignment_ids` 里别人那条去做，就是借岗位扩权。
     */
    my_assignment_id?: AssignmentId
    /**
     * WP84：这条职责的快捷提示（首页岗位卡按职责折叠着显示）。
     *
     * 从职责定义原样抄来的，不是第二份真源——改 yml 这里就变。没有 `my_assignment_id`
     * 的那几条职责（别人在做、我没有）照样带着它们，但界面上点不动：开事项只能用本人那条。
     */
    quick_prompts?: RoleQuickPrompt[]
    /** WP84：这条职责的示例任务（指导抽屉顶部的选择题）。同样是原样抄来的。 */
    task_examples?: RoleTaskExample[]
  }[]
  /** 这个岗位下还没关的事项数（本人可见的） */
  open_matters: number
  /** 这个岗位下还等着人定的卡数（54 §4：通知按岗位聚合） */
  pending_cards: number
  /** 岗位层记忆的一句话（`position` 技能层 + 提到岗位层的教训条数） */
  memory_summary: string
  /**
   * WP120（69 §4）：这个岗位的角色定位——右栏「角色」面板顶上那一段。
   *
   * 已经叠加过公司层覆盖：包里的原文由 `GET /positions/:id/persona` 另给一份，
   * 界面上的「还原」按钮拿它来比。
   */
  persona?: PersonaText
}

/** 05 §4 有效配置（单个 Assignment，不并集） */
export interface EffectiveAction {
  id: ActionId
  target: DataDomain
  kind: WriteActionSpec['kind']
  /** 15 §2 变更种类（显式映射优先，其次由动作 id 推导） */
  change_kind?: ChangeKind
  mandate: Mandate
  risk_class: RiskClass
  route_to: WriteActionSpec['route_to']
  requires_record_read: boolean
  protected_fields: string[]
  review_cannot_be_disabled: boolean
}
export interface EffectiveAutomation {
  level: Level
  recorded_level: Level
  ceiling: Level
  hard_ceiling: boolean
  risk_class: RiskClass
  clamped_by?: 'ceiling' | 'risk_class'
}
export interface EffectiveConfig {
  assignment_id: AssignmentId
  person_id: PersonId
  workspace_id: WorkspaceId
  role_id: RoleId
  role_version: string
  scopes: PermissionScope[]
  connectors: ConnectorDependency[]
  missing_connectors: string[]
  actions: EffectiveAction[]
  automation: Record<ActionId, EffectiveAutomation>
  skills: RoleDefinition['skills']
  grounding: GroundingRule[]
  /**
   * WP82：这条职责的浏览器域名白名单（`RoleDefinition.browser_scope`，没填就是空数组）。
   * 服务端组 `RunRequest.allowed_hosts` 时读它；空 = 这条职责开不了浏览器。
   */
  browser_scope: string[]
  /**
   * WP120（69 §3）：这条职责的角色定位，**包里的原文**。
   *
   * 公司层覆盖不在这儿叠——`effectiveConfig` 是个纯函数（输入只有职责定义、
   * 分配与工作区策略），把一张要查库的覆盖表塞进来，它就不再是纯的了，
   * 回放也算不出同一份。叠加发生在装 `persona` 段的那一跳（`apps/server/src/personas.ts`），
   * 与技能的六层叠加同一个位置、同一条规矩（24 §1）。
   */
  persona?: PersonaText
  /** 展开后的范围（挂的范围组已摊平）。 */
  ranges: RangeRef[]
  /** 44 G1：这些范围是从哪几个范围组（品牌）来的。 */
  range_groups?: RangeGroupId[]
  home_blocks: HomeBlockSpec[]
  notifications: NotificationRule[]
  ready: boolean
  unassigned_range: boolean
}

/* ── WP120（69 §4）：角色定位的公司层覆盖 ────────────────────────────────── */

/** 一段 persona 挂在谁身上：一个岗位模板，或者一条职责。 */
export type PersonaSubject =
  | { kind: 'position'; id: string }
  | { kind: 'role'; id: RoleId }

/**
 * 69 §4：**公司改写过的那一份**。
 *
 * 三条纪律：
 * 1. **包里的原文一个字不动**。覆盖是另存的一层，所以「还原」永远做得到——
 *    这与技能的六层覆盖是同一条规矩（24 §1），不另起一套。
 * 2. **只有公司层**。个人改 persona = 每个人手里的 Agent 说不同的话，
 *    而 persona 是公司对外的口径。要个性化的东西在个人技能层里，不在这儿。
 * 3. **每一次改记一条审计**（`persona.overridden` / `persona.reverted`），
 *    因为它进系统提示——改了它等于改了 Agent 对外说什么。
 */
export interface PersonaOverride {
  workspace_id: WorkspaceId
  subject: PersonaSubject
  /** 改写后的正文。中英各一份；只填一边的话另一边回落包里的原文。 */
  text: PersonaText
  updated_at: Iso8601
  updated_by: PersonId
}

/** 右栏「角色」面板要的那一份：现在生效的 + 包里的原文（「还原」拿它比）。 */
export interface PersonaView {
  subject: PersonaSubject
  /** 显示名（岗位名 / 职责名）。 */
  name: { zh: string; en: string }
  /** 现在真正进系统提示的那一份。 */
  effective: PersonaText
  /** 包里自带的原文。与 `effective` 不同 = 公司改写过。 */
  packaged: PersonaText
  /** 公司改写过吗（= 有覆盖且与原文不同）。 */
  overridden: boolean
  updated_at?: Iso8601
  updated_by?: PersonId
}
