/**
 * Extracted from KefuAgent src/lib/support/verticals/types.ts（S039 垂直包的类型面），
 * rewritten for agentsws contracts.
 *
 * 48 v2 L2：**实物 / 虚拟是工作区档案的一个字段，不是两套代码。**
 * 一套代码、一个进程、一个库；「垂直」分开的是产品面（人设、词汇、AI 的知识与边界），
 * 不是代码与数据。
 *
 * 三条纪律，写在类型上比写在文档里管用：
 *
 * 1. **包文件只放数据与纯函数**：不读库、不看时钟、不调模型。包要能被最便宜的一档
 *    测试直接跑，parity guard 才可能是"每次都跑"的那种，而不是"要环境所以先跳过"的那种。
 * 2. **业务代码里禁止 `vertical === 'digital'` 字面比较**：一切差异走
 *    `getVerticalPack(...)` 的字段。`test/vertical-no-literal.test.ts` 扫源码钉住这一条。
 * 3. **两个包字段集合必须一致**：少一个键，那一处 prompt 就插值成 `undefined`
 *    （`test/vertical-parity.test.ts` 钉住这一条，并且不许有空字符串）。
 *
 * 与 KefuAgent 的取舍：**内容逐字节抄，框架不抄**。
 * 舍掉 `pageContext`（聊天 widget 的页面上下文，widget 本体在托管档，WP57 再说）、
 * `onboarding`（它的向导步骤是 KefuAgent 的，我们有 46 自己那一套）、
 * `console`（隐藏后台路由 / 文案 overlay，我们没有那个后台）、
 * `context` / `standardLibrary` / `plans`（KefuAgent 自己也还是 `null` 占位）。
 * 加上三样它没有、我们这一侧真在消费的：`boundaries`（我们的 `BoundaryItem` 形状）、
 * `triage`（邮件词表分流）、`draft`（起草提示词与回信模板）。
 */
import type { ChangeKind } from '@agentsws/contracts'
import type { BoundaryItem, SupportIntent } from '../types.js'

/** 48 v2 L2：工作区卖的是什么。默认实物。 */
export type Vertical = 'goods' | 'digital'

/** 值域校验：非法字符串（老数据、手改的库行、URL 参数）一律当没选过。 */
export const VERTICALS: readonly Vertical[] = ['goods', 'digital']

export function isVertical(value: unknown): value is Vertical {
  return typeof value === 'string' && (VERTICALS as readonly string[]).includes(value)
}

/* ------------------------------------------------------------------ */
/* 人设：prompt 站点的整句角色短语                                        */
/* ------------------------------------------------------------------ */

/**
 * KefuAgent 的 19 处 prompt 站点各一个 key，外加我们自己那一处（`supportDraft`）。
 *
 * 为什么是**整句短语**而不是"你是 ${名词}"插值：19 处里有 5 处根本不以"你是"开头
 * （你为 / 你在改写 / 你在为 / 你在替 / 你在给），统一句式 + 换个名词的方案对它们不成立。
 * 按站点存整句，goods 的值就是 KefuAgent 现网原文逐字节，digital 才有余地重写整句。
 *
 * 有几处站点我们这一版还没有（平台标准库蒸馏、影子质检、widget 开场语），
 * **仍然把文字带着**：它们是产品口径，等 L3 第 8 / 11 项落地时直接就位，
 * 而不是到时候再去翻一个已经退役的仓库。
 */
export type VerticalPersonaKey =
  | 'chatAgent'
  | 'launchConfig'
  | 'greetingRewrite'
  | 'greetingVariant'
  | 'chatTeaching'
  | 'contextQa'
  | 'assistTimeout'
  | 'emailAgent'
  | 'emailRewrite'
  | 'supervisorCopilot'
  | 'triage'
  | 'knowledgeExtractor'
  | 'knowledgeSummarizer'
  | 'standardDistiller'
  | 'shadowDistiller'
  | 'qualityReviewer'
  | 'waitingNote'
  | 'draftSafetyReviewer'
  | 'guideNormalizer'
  /**
   * agentsws 自己的起草站点（`prompts/customer-care.ts` 的 persona 段）。
   *
   * 不直接用 `emailAgent`：那一句里有"可供中国运营审核""已沉淀规则"这些 KefuAgent
   * 的名词，而我们这边对应的东西叫**已确认的业务边界**与**订单事实**。goods 的值
   * 是本仓改造前的原文逐字节（静态前缀的字节被测试钉着，不能因为搬家而变）。
   */
  | 'supportDraft'

export type VerticalPersona = Record<VerticalPersonaKey, string>

/* ------------------------------------------------------------------ */
/* 规则集                                                               */
/* ------------------------------------------------------------------ */

/**
 * 在线聊天的硬性边界（KefuAgent `chat-service.ts` 的编号规则）。
 *
 * `numbered` 里**不含规则 11**：它在 KefuAgent 里是条件插值——商家没配额外边界时
 * 整行求值成空串，在规则 10 和 12 之间留下一个空行。把它拍平成一条普通规则会改掉
 * 每一次聊天的 prompt 字节，所以模板与插入位单独建模，条件语义由 `renderChatRules` 保住。
 */
export interface VerticalChatRules {
  /** goods 27 行（1,1a,2…10,12…26）/ digital 26 行（没有 6a）。 */
  numbered: readonly string[]
  /** 规则 11 在 `numbered` 里的插入下标（goods 12、digital 11）。 */
  boundaryRuleIndex: number
  /** 规则 11 模板；`{boundaries}` 由装配层填。 */
  boundaryRuleTemplate: string
}

export interface VerticalEmailRules {
  /** 回复草稿的要求 1–28（含 2a / 3b）。 */
  emailAgent: readonly string[]
  /** 中文指挥重写的要求 1–7。 */
  emailRewrite: readonly string[]
}

/* ------------------------------------------------------------------ */
/* 意图                                                                 */
/* ------------------------------------------------------------------ */

export type ChatRiskLevel = 'normal' | 'high'

/**
 * 聊天关键词分类器的一条规则。顺序即优先级：**先命中先返回**。
 *
 * 顺序被打乱不会抛错，只表现为"某些话被判成了另一类"——所以回归钉的是整表对语料的
 * 分类结果，不是表本身。
 */
export interface ChatClassifierRule {
  intent: string
  /** 命中任一词即进入本条（词面语义，不做正则）。 */
  terms: readonly string[]
  confidenceScore: number
  riskLevel: ChatRiskLevel
  reasonZh: string
  /** 命中后再看这组词，命中则改判子意图（goods：物流延误 vs 订单查询）。 */
  subIntent?: { terms: readonly string[]; intent: string }
  /** 命中后再看这组词，命中则升级风险。 */
  riskEscalation?: { terms: readonly string[]; riskLevel: ChatRiskLevel }
  /** true = 客户消息里出现已知商品 / 产品词本身就算命中（售前）。 */
  matchProductTerms?: boolean
  /** true = 命中本条时不回传订单号（售前 / 转人工两条的语义）。 */
  dropOrderRef?: boolean
}

export interface VerticalIntentPack {
  /** 聊天意图枚举，顺序即标签表顺序。 */
  values: readonly string[]
  labelsZh: Readonly<Record<string, string>>
  /** 顺序词表；最后一条必须是无 `terms` 的兜底。 */
  classifierRules: readonly ChatClassifierRule[]
  /** 开场引导的意图类目，是 `values` 的**刻意真子集**；兜底类必须排最后。 */
  guideCategories: readonly string[]
  /** 点了引导按钮之后 AI 该怎么开这个口，各一句（进 prompt 的 user 侧，不是对客文案）。 */
  guideOpeningStrategies: Readonly<Record<string, string>>
  /** 归一化 prompt 铁律第 5 条：意图枚举 + 中文释义（横跨三行）。 */
  normalizeEnumLine: string
  /** 影子质检的**第三套**词汇，与前两套刻意不同名。 */
  shadowEvalCategories: readonly string[]
  /** 邮箱分流的正 / 负范围各一整行（进模型侧 prompt）。 */
  triageScope: { include: string; exclude: string }
}

/* ------------------------------------------------------------------ */
/* 聊天回复计划（分类之后、生成之前的那一步）                               */
/* ------------------------------------------------------------------ */

/** "客户这一轮已经给了什么"的闭集判据。 */
export type ChatPlanEvidenceSignal = 'order_ref' | 'email' | 'product_context'

export interface ChatPlanMissingInfoRule {
  /** 适用意图（分类器输出的 intent 值域内）。 */
  intents: readonly string[]
  /**
   * 缺的是什么。**措辞即产品口径**：goods 问"订单号或下单邮箱"，digital 问的只能是
   * 注册邮箱与复现细节——一个没有订单概念的垂直嘴里出现"订单号"就是编的。
   */
  label: string
  /** 同一句的英文，对客模板用（缺省回落中文 label）。 */
  labelEn: string
  /** 任一信号命中即视为不缺。 */
  satisfiedBy: readonly ChatPlanEvidenceSignal[]
  /** 额外词面信号：客户文本里出现任一词即视为已给（goods 的照片 / 视频那条）。 */
  satisfiedByTerms?: readonly string[]
}

export interface VerticalChatPlanPack {
  /** 按顺序求值，命中即把 `label` 追加进缺料清单。 */
  missingInfo: readonly ChatPlanMissingInfoRule[]
  /** 缺料也**不阻塞**的意图：先按现有信息答，把缺的那一项放到结尾追问。 */
  nonBlockingIntents: readonly string[]
  /** 无条件进人工审核门的意图（与"风险 high"是或的关系，不是替代）。 */
  mustReviewIntents: readonly string[]
  /** 客户明确要求人工的意图——走求助分支，不是审核门。 */
  handoffIntent: string
  /** 什么都不缺时的收尾话术（商家侧计划字段）。 */
  defaultNextQuestionZh: string
  /** 求助时**发给客户**的那句话（英文，客户可见）。所有兜底路径都发这一句。 */
  handoffReplyEn: string
}

/** 售前那一轮要不要额外物料。 */
export interface VerticalPresalesPack {
  /** 售前意图名（必须是 `intents.values` 之一）。 */
  intent: string
  /** 是否注入标准层售前 playbook（按实物卖家类型写的，digital 吃它比没有更糟）。 */
  standardPlaybook: boolean
  /** 是否推荐在售商品卡（没有商品目录的垂直恒 false）。 */
  productCards: boolean
}

/* ------------------------------------------------------------------ */
/* L3 永不自动发送                                                       */
/* ------------------------------------------------------------------ */

export type L3PatternTable = Record<string, Partial<Record<string, RegExp[]>>>

/**
 * 15 的 guardrail 前置门 `l3_denylist` 的原料（48 §4 第 3 项，WP55 接线）。
 *
 * 规则集只可加行、绝不删 / 弱化行；序列化出来的哈希是自主发送审计链的锚，
 * 所以 `firstPersonCommitment` 这一项也必须收编——少了它复现不出同一个序列化。
 */
export interface L3DenylistPack {
  categories: readonly string[]
  langs: readonly string[]
  /** Tier-2：入站请求形态（"我要退款"）。 */
  t2: L3PatternTable
  /** Tier-3：出站承诺形态（"我们会为您退款"）。 */
  t3: L3PatternTable
  emailIntentMap: Readonly<Record<string, string>>
  chatIntentMap: Readonly<Record<string, string>>
  firstPersonCommitment: RegExp
  /** "意图本身不够、还要看风险等级"的映射。 */
  riskGatedChatIntents: Readonly<Record<string, { riskLevel: ChatRiskLevel; category: string }>>
}

/* ------------------------------------------------------------------ */
/* 知识探测                                                             */
/* ------------------------------------------------------------------ */

export interface VerticalKnowledgePack {
  /** onboarding 期间值得各探一次的路径。 */
  wellKnownPaths: readonly string[]
  /** 值得各发一次 HEAD 的子域。 */
  supportSubdomains: readonly string[]
  /** 是否跑商品枚举。虚拟产品恒 false。 */
  enumerateCatalog: boolean
}

/* ------------------------------------------------------------------ */
/* 邮件分流（我们这一侧的消费面）                                          */
/* ------------------------------------------------------------------ */

/**
 * 词表分流的一条规则。顺序即优先级，先命中先返回。
 *
 * `requires` 是 KefuAgent `classifyEmailHeuristically` 里那个两层结构的数据化：
 * goods 先看是不是客服诉求（`SUPPORT_TERMS` 这道门），命中之后才细分。
 * digital 没有这道门——它按**方向**判定（谁写给谁），门在这一层表达不出来，
 * 所以那两行 `triageScope` 才是 digital 分流的真判据，词表只做兜底。
 */
export interface TriageRule {
  intent: SupportIntent
  is_customer_service: boolean
  terms: readonly string[]
  confidence: number
  reason: string
  /** 命中本条之前必须先命中的门。 */
  requires?: readonly string[]
}

export interface VerticalTriagePack {
  rules: readonly TriageRule[]
  /** 一条都没命中时的结论。 */
  fallback: Omit<TriageRule, 'terms' | 'requires'>
  /** 线程已被接管时直接给的意图（"后续来信默认继续处理"）。 */
  takenOverIntent: SupportIntent
  /** 风险词（词面来自冻结词集里本垂直用得上的那些），按表顺序命中。 */
  riskTerms: readonly string[]
  /** 缺什么资料：首条命中即返回。措辞即产品口径。 */
  needs: readonly { terms: readonly string[]; need: string }[]
  /**
   * 一条记录都没读到、来信里也没有可用的标识时，缺的是哪一样。
   * 实物是订单号；虚拟产品是**注册邮箱**——向一个没有订单的客户要订单号，
   * 比答不上来更伤信任。
   */
  recordRefNeed: string
}

/* ------------------------------------------------------------------ */
/* 业务边界的门                                                          */
/* ------------------------------------------------------------------ */

export interface VerticalChangeGate {
  /** 提出某一类变更之前，哪几条边界必须先有答案。 */
  governing: Readonly<Partial<Record<ChangeKind, readonly string[]>>>
  /** 退款 / 退货窗口从哪条边界的哪个数值槽读，读不到时兜底几天。 */
  window: { boundaryId: string; valuePath: string; defaultDays: number }
  /**
   * 额外的条件门：正文**同时**命中每一组词时，再加一条必须答过的边界。
   * goods 的"物流显示已签收但客户说没收到"就是它（两个线索都要有，只有一个不算）。
   */
  extra: readonly {
    changeKind: ChangeKind
    allOf: readonly (readonly string[])[]
    boundaryId: string
  }[]
}

/* ------------------------------------------------------------------ */
/* 起草（我们这一侧的消费面）                                              */
/* ------------------------------------------------------------------ */

/**
 * 回信正文模板。占位用 `{名字}`，渲染只做整串替换，不求值任何表达式。
 *
 * 为什么是模板串而不是一段函数：这几句话是**产品口径**，运营要能一眼读完、
 * 能指着某一句说"这句改一下"；藏在 if 里的字符串没人读得到。
 */
export interface VerticalReplyTemplate {
  /** `{customer}` */
  greeting: string
  /** 读到记录时的第一句。`{order}` `{financial_status}` `{fulfillment_status}` */
  record: string
  /** 没读到记录时的第一句。 */
  noRecord: string
  /** 条款那一句。`{days}` */
  policy: string
  /**
   * 读不到任何条款数值时还要不要印 `policy` 那一句（用兜底天数）。
   * goods 恒 true（现状）；digital false——虚拟产品的来信大多与退款无关，
   * 开口先背一遍退款窗口只会显得答非所问。
   */
  policyWhenUnknown: boolean
  /** 记录里的时间那一句。`{date}` `{days}` */
  timeline: string
  /** 窗口内且**真提出了**一笔变更。`{days}` `{amount}` `{currency}` */
  withinWithChange: string
  /** 窗口内但没提变更。`{days}` */
  within: string
  /** 窗口外。`{days}` */
  outside: string
  /** 连记录都没有时的下一步——**追问什么**在这里定口径。 */
  noRecordNextStep: string
  /** 落款前那一行。 */
  signoff: string
  /** 没有来信主题但读到了记录时的回信主题。`{order}` */
  orderSubject: string
  /** 没有来信主题也没读到记录时的回信主题。 */
  fallbackSubject: string
}

export interface VerticalDraftPack {
  /** persona 段的正文（= `persona.supportDraft`，这里再放一份是为了取用点只有一个）。 */
  persona: string
  /** 回答纪律（进 prompt 的"要求："那一段）。 */
  rules: readonly string[]
  template: VerticalReplyTemplate
}

/* ------------------------------------------------------------------ */
/* 包                                                                   */
/* ------------------------------------------------------------------ */

export interface VerticalPack {
  key: Vertical
  labelZh: string
  /** 一句人话的解释，进首次设置那个选项的 tooltip（46 §1）。 */
  hintZh: string
  persona: VerticalPersona
  chatRules: VerticalChatRules
  emailRules: VerticalEmailRules
  intents: VerticalIntentPack
  chatPlan: VerticalChatPlanPack
  presales: VerticalPresalesPack
  l3Denylist: L3DenylistPack
  knowledge: VerticalKnowledgePack
  /** 业务边界 registry（顺序即 prompt 注入顺序，不要重排）。 */
  boundaries: readonly BoundaryItem[]
  changeGate: VerticalChangeGate
  triage: VerticalTriagePack
  draft: VerticalDraftPack
}
