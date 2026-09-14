/**
 * Extracted from KefuAgent src/lib/support/verticals/digital/intents.ts
 * （DIGITAL_INTENTS / DIGITAL_CHAT_PLAN / DIGITAL_PRESALES，S039 FR-020/021），**逐字节**。
 *
 * 与 goods 同构的三套独立枚举。分开建模的收益在这里兑现——digital 的开场引导只卖
 * 五类 + 兜底，质检类目又是另一套写法，硬要一一对应只会逼出一堆没人点的按钮。
 *
 * **红线（parity guard 对词表源做断言）**：这张表里绝不允许出现
 * `package / delivery / track / shipment / parcel / my order`。它们在软件语境里全是
 * 高频误伤词——"email delivery failed" 是发信故障不是物流，"npm package" 是依赖，
 * "tracking link" 是埋点，"my order" 在 SaaS 里通常指订阅账单。goods 那张表把它们
 * 全列为订单 / 物流信号，原样搬过来会让 digital 的每一次故障报告都被判成查快递。
 */

import type {
  ChatClassifierRule,
  VerticalChatPlanPack,
  VerticalIntentPack,
  VerticalPresalesPack,
} from '../types.js'
import { DIGITAL_TRIAGE_SCOPE } from './rules.js'

/** `DigitalChatIntent` 十值（产品 doc §3.2 表），顺序即标签表顺序。 */
export const DIGITAL_INTENT_VALUES = [
  'presales_plan',
  'how_to',
  'bug_report',
  'billing_credits',
  'account_access',
  'integration_setup',
  'data_privacy',
  'feature_request',
  'human_handoff',
  'general_support',
] as const

export const DIGITAL_INTENT_LABELS_ZH: Record<string, string> = {
  presales_plan: '售前与套餐',
  how_to: '使用方法',
  bug_report: '故障报告',
  billing_credits: '账单与用量',
  account_access: '账号与登录',
  integration_setup: '接入与集成',
  data_privacy: '数据与隐私',
  feature_request: '功能建议',
  human_handoff: '联系人工',
  general_support: '其他客服问题',
}

/**
 * 顺序即优先级：先命中先返回，最后一条无 `terms` 是兜底。
 *
 * 排序逻辑与 goods 同源 —— **钱和账号排在前面**：一句话同时像账单问题和使用方法
 * 时，判成账单的代价是多转一次人工，判成使用方法的代价是 AI 拿着知识库去回答一个
 * 它没有事实依据的扣费问题。
 *
 * 几处刻意的取舍：
 * - `account_access` 不收裸词 `account`，否则 "delete my account" 会被它截走，
 *   而那是数据删除请求（L3）；
 * - `feature_request` 排在 `bug_report` 之前：它的词面（"when will you support X"、
 *   "roadmap"、"什么时候上线"）比故障词更长更具体，而反过来 "when will you support
 *   SSO" 会先被 `integration_setup` 的 `sso` 截走，问路线图的人就被当成来配集成的；
 * - `bug_report` 排在 `integration_setup` 前面：接入过程中报错先当故障收集复现
 *   信息，比先讲一遍集成文档有用；
 * - `how_to` 的 `can i` 极宽，所以它排在倒数第二 —— 前面那些更具体的意图先取走
 *   "can i get a refund" / "can i change my email" 这类。
 */
export const DIGITAL_CLASSIFIER_RULES: readonly ChatClassifierRule[] = [
  {
    intent: 'billing_credits',
    terms: [
      'invoice',
      'charged',
      'charge me',
      'billing',
      'refund',
      'subscription',
      'renew',
      'cancel my plan',
      'cancel my subscription',
      'upgrade',
      'downgrade',
      'credits',
      'quota',
      'usage limit',
      'chargeback',
      '扣费',
      '发票',
      '账单',
      '退款',
      '订阅',
      '续费',
      '积分',
      '额度',
      '收费',
      '拒付',
    ],
    confidenceScore: 90,
    riskLevel: 'normal',
    riskEscalation: {
      terms: [
        'refund',
        'charged twice',
        'double charged',
        'charged me twice',
        'chargeback',
        'dispute',
        'unauthorized charge',
        '退款',
        '重复扣费',
        '多扣',
        '拒付',
      ],
      riskLevel: 'high',
    },
    reasonZh:
      '客户在问账单、扣费或额度，只能引用已核实的账户事实；涉及退款或重复扣费需保守处理并转人工。',
  },
  {
    intent: 'account_access',
    terms: [
      'log in',
      'login',
      'logged in',
      'sign in',
      'signin',
      'sign up',
      'password',
      'reset link',
      'reset my',
      '2fa',
      'two-factor',
      'two factor',
      'verification code',
      'locked out',
      'magic link',
      // 盗号/未授权访问同时出现在 riskEscalation 里：这里让它命中本条，那里让它
      // 升到 high。少了这一份，"my account was hacked" 会一路落到兜底类——那是
      // digital 最不该被当成「其他问题」的一句话。
      'hacked',
      'compromised',
      'unauthorized access',
      'unauthorised access',
      '登录',
      '登陆',
      '密码',
      '验证码',
      '账号',
      '帐号',
      '注册不了',
      '被盗',
      '盗号',
    ],
    confidenceScore: 88,
    riskLevel: 'normal',
    riskEscalation: {
      terms: [
        'hacked',
        'compromised',
        'unauthorized access',
        'unauthorised access',
        'someone else',
        'stolen',
        'breach',
        '被盗',
        '盗号',
        '未授权',
        '未经授权',
        '入侵',
      ],
      riskLevel: 'high',
    },
    reasonZh:
      '客户登录或账号出了问题，只能指路自助入口、不得代办账号操作；涉及盗号或未授权访问一律转人工。',
  },
  {
    intent: 'data_privacy',
    terms: [
      'gdpr',
      'ccpa',
      'delete my data',
      'delete my account',
      'delete all my',
      'erase my',
      'remove my data',
      'export my data',
      'download my data',
      'data retention',
      'privacy',
      'dpa',
      'where is my data',
      'data stored',
      '删除数据',
      '删除我的',
      '注销账号',
      '导出数据',
      '隐私',
      '数据存在哪',
      '数据保留',
    ],
    confidenceScore: 90,
    riskLevel: 'normal',
    riskEscalation: {
      terms: [
        'delete my data',
        'delete my account',
        'delete all my',
        'erase my',
        'gdpr',
        'ccpa',
        'right to be forgotten',
        '删除数据',
        '删除我的',
        '注销账号',
      ],
      riskLevel: 'high',
    },
    reasonZh: '客户在提数据或隐私请求，删除/导出有法定时限，绝不能自行承诺，必须转人工。',
  },
  {
    intent: 'feature_request',
    terms: [
      'feature request',
      'would be great',
      'would be nice',
      'can you add',
      'please add',
      'roadmap',
      'roadmap for',
      'any plans to',
      'when will you support',
      'when will you add',
      // 「什么时候有」的其余问法。本条排在 `integration_setup` 之前是**故意**的，
      // 而这几个词面让那个顺序真正生效："when will you ship the API?" 里既有
      // 路线图词面又有 `api`，按本条判是问路线图、按 integration 判是来配集成
      // 的 —— 后者会让 AI 认真讲一遍一个还不存在的东西怎么接。
      'when will you ship',
      'when will you release',
      'when do you plan to',
      'release date',
      // 「修复什么时候好」同样落这里：chatRules 2 把「功能上线时间」与「修复
      // 时限」并列为一律 needs_handoff，二者的正确动作完全相同（记录 + 转人工、
      // 绝不给日期），而 bug_report 的动作是收集复现信息。
      'eta for',
      'any eta',
      '路线图',
      '建议',
      '希望增加',
      '什么时候上线',
      '什么时候支持',
      '什么时候发布',
      '会不会做',
      '能加个',
    ],
    confidenceScore: 78,
    riskLevel: 'normal',
    reasonZh: '客户在提功能建议或问路线图，记录诉求但绝不承诺上线时间，需要转人工。',
  },
  {
    intent: 'bug_report',
    terms: [
      'error',
      'errors',
      'not working',
      "doesn't work",
      'does not work',
      'stopped working',
      'broken',
      'crash',
      'crashed',
      'crashing',
      'failed',
      'failing',
      'fails',
      'bug',
      'blank screen',
      'stuck on',
      'timed out',
      'timeout',
      '500',
      '502',
      'outage',
      'downtime',
      'is down',
      'was down',
      'are down',
      'were down',
      'went down',
      'unavailable',
      '报错',
      '打不开',
      '失败',
      '崩溃',
      '挂了',
      '卡住',
      '用不了',
      '没反应',
      '白屏',
      '宕机',
      '停机',
    ],
    confidenceScore: 86,
    riskLevel: 'normal',
    riskEscalation: {
      terms: [
        'outage',
        'is down',
        'was down',
        'are down',
        'were down',
        'went down',
        'downtime',
        'unavailable',
        'sla',
        'data loss',
        'lost all my',
        '宕机',
        '停机',
        '全线',
        '数据丢失',
      ],
      riskLevel: 'high',
    },
    reasonZh:
      '客户在报故障，先收集复现信息（在哪一步、什么提示、大致时间），不要断言原因或声称已修复。',
  },
  {
    intent: 'integration_setup',
    terms: [
      'api',
      'api key',
      'webhook',
      'sdk',
      'integrate',
      'integration',
      'oauth',
      'sso',
      'saml',
      'zapier',
      'endpoint',
      'rate limit',
      'sandbox',
      '接入',
      '集成',
      '对接',
      '回调',
      '密钥',
    ],
    confidenceScore: 82,
    riskLevel: 'normal',
    reasonZh: '客户在做接入或集成，应结合文档与已学知识给出配置口径，不要编造字段或限额。',
  },
  {
    intent: 'presales_plan',
    terms: [
      'pricing',
      'price',
      'how much',
      'plan',
      'plans',
      'trial',
      'free tier',
      'free plan',
      'does it support',
      'do you support',
      'can it',
      'compare',
      'seats',
      'enterprise',
      '价格',
      '多少钱',
      '套餐',
      '试用',
      '免费版',
      '支持吗',
      '能不能做',
      '对比',
    ],
    // 提到 workspace 学到的产品/品牌词本身就是售前信号（同 goods 语义）。
    matchProductTerms: true,
    confidenceScore: 84,
    riskLevel: 'normal',
    reasonZh:
      '客户在付费前确认套餐、价格或能力，只能基于真实在售套餐与知识库作答，不要替产品承诺功能。',
    dropOrderRef: true,
  },
  {
    intent: 'how_to',
    terms: [
      'how do i',
      'how to',
      'how can i',
      'where can i',
      'where do i',
      'can i',
      'is there a way',
      'tutorial',
      'set up',
      'setup',
      '怎么',
      '如何',
      '在哪',
      '怎样',
      '教程',
      '设置',
    ],
    confidenceScore: 80,
    riskLevel: 'normal',
    reasonZh: '客户在问使用方法，应引用文档与知识库里的步骤作答；有官方文档链接就附上。',
  },
  {
    intent: 'human_handoff',
    terms: ['human', 'agent', 'real person', '人工', '真人', '客服'],
    confidenceScore: 90,
    riskLevel: 'normal',
    reasonZh: '客户明确要求人工，需要给出接管预期并通知值班人员。',
    dropOrderRef: true,
  },
  {
    intent: 'general_support',
    terms: [],
    confidenceScore: 58,
    riskLevel: 'normal',
    reasonZh: '客户问题还不够明确，AI 应先追问关键上下文，而不是直接泛泛回答。',
  },
]

/**
 * 开场引导类目 —— `values` 的**刻意真子集**（同 goods 的设计，research D-06）。
 *
 * `integration_setup` / `data_privacy` / `feature_request` / `human_handoff` 由
 * `normalizeGuideCategory` 降级到 `general_support`：开场引导是给客户看的几个按钮，
 * 「数据与隐私」「功能建议」这两类一年也点不了几次，占一个按钮位不如让位给
 * 「其他问题」；`human_handoff` 本来就有自己的转人工路径，不该混进意图按钮。
 * 兜底类必须是最后一个（`normalizeGuideCategory` 取末位作 fallback）。
 */
export const DIGITAL_GUIDE_CATEGORIES = [
  'presales_plan',
  'how_to',
  'bug_report',
  'billing_credits',
  'account_access',
  'general_support',
] as const

/**
 * 点了引导按钮之后 AI 该怎么开这个口 —— 六类各一句。
 *
 * 这些句子进的是 **prompt 的 user 侧**，不是对客文案：它们是给模型的策略，模型
 * 仍然用客户的语言、按既有硬性边界作答。一旦有一句被当成 reply 发出去，那是
 * bug 而不是翻译问题。
 */
export const DIGITAL_GUIDE_OPENING_STRATEGIES: Record<string, string> = {
  presales_plan:
    '客户在对比套餐或确认能不能做某件事。只依据 plans 与知识库里真实存在的套餐、额度和能力作答，不要编造价格或限额；文档没写的能力，说会向团队确认，不要替产品承诺。',
  how_to:
    '客户想知道怎么用。先确认他要完成的是哪一步，按知识库里的步骤答；有官方文档链接就附上，不要自己编操作路径。',
  bug_report:
    '先问清在哪一步、看到什么提示、大致发生时间；有 troubleshooting 条目就按条目答；不要断言原因，也不要说"已修复"。',
  billing_credits:
    '先确认身份已核实，再只引用 account_context 里的事实；身份未核实时不要透露任何账单与用量细节。退款、补偿、折扣一律不承诺，设 needs_handoff。',
  account_access:
    '客户登录不上或要改账号。只能指路到自助入口，绝不代替对方执行账号操作；涉及被盗号或未授权访问一律设 needs_handoff。',
  general_support: '客户点的是「其他问题」。用一句话邀请他把具体问题说出来，不要预设是哪类诉求。',
}

/**
 * 归一化 prompt 的铁律第 5 条 —— 枚举 + 中文释义。
 *
 * 值域必须与 `DIGITAL_GUIDE_CATEGORIES` 一致：模型吐出枚举外的值会被
 * `normalizeGuideCategory` 静默降级成兜底类，商家在候选表里就会看到一堆
 * 「其他」。跨三行是为了和 goods 的换行形态一致（同一个 join('\n')）。
 */
export const DIGITAL_NORMALIZE_ENUM_LINE = [
  '5. intent 只能取：presales_plan（售前与套餐）/ how_to（使用方法）/',
  '   bug_report（故障报告）/ billing_credits（账单与用量）/ account_access（账号与登录）/',
  '   general_support（其他）。',
].join('\n')

/**
 * shadow 质检的第三套词汇。
 *
 * 与聊天意图刻意不同名：质检看的是「这类工单 AI 写得怎么样」，颗粒度比客户按钮
 * 粗一档（接入与集成、数据与隐私在质检里合成 `integration` / `privacy` 就够用）。
 */
export const DIGITAL_SHADOW_EVAL_CATEGORIES = [
  'pre_sales',
  'how_to',
  'bug_report',
  'billing',
  'account',
  'integration',
  'privacy',
  'other',
] as const

/**
 * 计划构建的 digital 数据（S039 WU-6）。
 *
 * 三条纪律，都是从这个包已有的规则里读出来的，不是新发明的产品行为：
 *
 * 1. **「订单号」一个字都不许出现。** digital 的 AI 手上没有订单，也没有
 *    `account_context`（`context: null`）；账单与账号类该收的是**注册邮箱**
 *    ——chatRules 1a 的原话就是「请对方在已登录的应用内打开聊天，或留下注册
 *    邮箱由我们邮件跟进」，not_found 时「请对方核对注册邮箱」。
 * 2. **故障类收复现信息**，口径抄 chatRules 7：在哪一步、看到什么提示、大致
 *    发生时间。文本里没法可靠判定「他是不是已经说清了这三样」，所以这一条恒缺
 *    —— 而它同时是 non-blocking 的，后果只是 AI 答完在结尾追问，不是拿模板堵人。
 * 3. **V0 的 digital 不产生 `collect_info`**：有缺料规则的三个意图全在
 *    `nonBlockingIntents` 里。理由是这个垂直的答案来自文档与知识库，先答一句
 *    再追问，永远优于「先答录一张表」。真要堵，堵的也该是身份核实（V1 的
 *    `account_context`），不是 V0 的一个模板。
 *
 * `mustReviewIntents` 的两条来自本文件分类器规则自己的 `reasonZh`：数据/隐私
 * 「删除/导出有法定时限，绝不能自行承诺，必须转人工」、功能建议「绝不承诺上线
 * 时间，需要转人工」。账单与账号类不列在这里 —— 它们由**风险映射**升到 high
 * （退款/重复扣费/拒付、盗号/未授权访问），走的是同一道审核门，一步没放宽。
 */
export const DIGITAL_CHAT_PLAN: VerticalChatPlanPack = {
  missingInfo: [
    {
      intents: ['billing_credits', 'account_access'],
      label: '注册邮箱',
      labelEn: 'the email address your account is registered with',
      satisfiedBy: ['email'],
    },
    {
      intents: ['bug_report'],
      label: '出问题的步骤、看到的提示和大致发生时间',
      labelEn: 'the step where it happens, the exact message you see, and roughly when it started',
      satisfiedBy: [],
    },
  ],
  nonBlockingIntents: ['billing_credits', 'account_access', 'bug_report'],
  mustReviewIntents: ['data_privacy', 'feature_request'],
  handoffIntent: 'human_handoff',
  defaultNextQuestionZh: '我会根据产品文档和已学的客服知识继续帮你处理。',
  // goods 版那句请客户"留邮箱和订单号"。digital 没有订单可留，按 chatRules 10
  // （坦诚在向同事/主管核实、邀请留邮箱、不承诺时限）与 1a（要的是**注册**邮箱）
  // 改写。仍是英文：这是对客文案，不是给模型的策略。
  handoffReplyEn:
    "Thanks for the details — I want to make sure you get an accurate answer, so I'm checking with my team on this. It may take a little while. If you'd like, leave the email address your account is registered with and we'll follow up there, so you don't have to wait here.",
}

/**
 * 售前物料（S039 WU-6 后续）。
 *
 * digital 的售前问题（套餐、价格、能不能做某件事）必须走 **presales 阶段的知识
 * 检索** —— 答案都在 pricing / docs 页里。另外两样都关掉，且都不是"暂缺"：
 * 没有商品目录（`knowledge.enumerateCatalog=false`），推不出在售商品卡；标准层
 * 售前 playbook 是按实物卖家类型写的，digital 的标准库是 V3（§3.9）——让它去吃
 * 一份 generic 的实物售前话术，比没有更糟。
 */
export const DIGITAL_PRESALES: VerticalPresalesPack = {
  intent: 'presales_plan',
  standardPlaybook: false,
  productCards: false,
}

export const DIGITAL_INTENTS: VerticalIntentPack = {
  values: DIGITAL_INTENT_VALUES,
  labelsZh: DIGITAL_INTENT_LABELS_ZH,
  classifierRules: DIGITAL_CLASSIFIER_RULES,
  guideCategories: DIGITAL_GUIDE_CATEGORIES,
  guideOpeningStrategies: DIGITAL_GUIDE_OPENING_STRATEGIES,
  normalizeEnumLine: DIGITAL_NORMALIZE_ENUM_LINE,
  shadowEvalCategories: DIGITAL_SHADOW_EVAL_CATEGORIES,
  triageScope: DIGITAL_TRIAGE_SCOPE,
}
