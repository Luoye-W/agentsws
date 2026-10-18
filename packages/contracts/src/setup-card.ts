/**
 * WP324（决策 690，Luoye 10-14）：**连接卡 / 配置卡**——任务要先连上什么、先设好什么时，
 * 就在对话流（事项时间线、卡片流）或第三栏里弹一张卡，人就地补上，补完原任务**自动接着做**。
 * 「连接」「消息渠道」「设置」那几页仍在，作总览与管理，不再是唯一入口。
 *
 * 只把**通用机制**做成固定功能：卡长什么样、怎么去重、补完怎么接着跑。具体某一家服务
 * （Shopify、GA4、飞书…）怎么连，由连接目录 / 渠道登记表说了算，卡上按 `service` 挑现成的接法，
 * 不为哪一家做专属界面。
 *
 * 三条纪律：
 * 1. **密码类不经 AI**：连接卡只说「要连谁、为什么」；钥匙 / 口令在本机原生表单里填，
 *    直接打连接面的 `/submit`，不进卡的载荷、不进决定、不进事件、不进模型上下文。
 *    配置卡只收**不是秘密**的设置（{@link isSecretLikeSetupKey} 认出来的一律拒收，改走连接卡）。
 * 2. **同一缺项不重复出卡**：去重键只看「缺的是哪几样」，还有一张没处理就把新卡的事项挂到那一张上。
 * 3. **补完自动接着做**：照 WP304 选主题卡——按这件事原来那段话再跑一次（时间线记「接着做」，不伪造人话）。
 */
import type { ServiceOffer } from './service-order.js'

/** 连接卡上的一样「要连的」。 */
export interface ConnectNeed {
  /** 连接目录里的 kind（`shop` / `ga4` / `ads`…）或渠道 id（`im:feishu`）；去重按它。 */
  kind: string
  /**
   * 卡上用哪种接法：连接页 provider 的 service（`shopify_admin`、`ga4`、`gsc`、`meta_ads`…）、
   * 消息渠道（`im:feishu` / `im:dingtalk` / `im:wecom` / `im:wechat`）、浏览器插件配对（`extension`）、
   * 建站平台的 CLI（`site_theme`：装 CLI / 登录 / 选店）。认不出就没有——卡上只给「去连接页」。
   */
  service?: string
  /** 人话名（「Shopify 店铺后台」）。 */
  name: string
  /** 这件事离了它做不成（必需）还是有它更好（推荐）。 */
  required: boolean
  /** `reauth` = 连过、但凭据过期 / 被拒，要重新授权。 */
  state?: 'not_connected' | 'reauth'
}

/** 补完之后接着做哪件事。 */
export interface SetupResumeTarget {
  matter_id: string
  person_id: string
  assignment_id: string
}

/** 连接卡（`connect_request`）的载荷。 */
export interface ConnectRequestPayload {
  form: 'connect_request'
  /** 为什么要连（一句人话，卡面正文）。 */
  why: string
  needs: ConnectNeed[]
  /**
   * 风险告知（广告投放会花真钱、插件能操作这台电脑…）：有就在连接按钮上方出一行。
   * 点「连接」即视为知道了；真正花钱 / 动东西的那一步仍各自出卡。
   */
  risk?: string
  /** 连好之后接着做的第一件事（同一缺项还在等的别的事项由服务端记着）。 */
  resume?: SetupResumeTarget
  /**
   * WP390（docs/105 §4.1 ②）：服务目录里有声明了这个卡点的服务 → 卡上多一个可选项「交给工坊办」
   * （办成后回到这一步接着做，决策 690）。没有就没有这一格。
   */
  workshop_service?: ServiceOffer
}

/** 配置卡上一格的样子（只收不是秘密的设置）。 */
export type SetupFieldKind = 'text' | 'url' | 'number' | 'select' | 'toggle'

export interface SetupField {
  /** 设置项的键（服务端那个设置目标认的名字）。 */
  key: string
  /** 人话名。 */
  label: string
  kind: SetupFieldKind
  /** `select` 的选项。 */
  options?: { value: string; label: string }[]
  /** 建议值（卡上预填；人不改、直接保存就用它）。`toggle` 用 `'true'` / `'false'`。 */
  suggested?: string
  /** 建议值从哪来（一句，进问号；没有就不出问号）。 */
  suggested_why?: string
  required: boolean
  placeholder?: string
  /**
   * WP348（决策 887）：方案值从哪来（卡上那一句理由后面可点开：哪条档案、哪个网页、哪个已连的账号）。
   * 没有 = 老卡 / 人填的。
   */
  sources?: SetupSource[]
  /**
   * WP348：AI 查不到、或这一格不该 AI 猜（要人选的账号这类）——卡上留空并标「需要你填」。
   * 凭据从来不在配置卡上（见 {@link isSecretLikeSetupKey}），不靠这一格。
   */
  needs_you?: boolean
  /** WP348「我打算改成这样」：这一格现在的值（与 `suggested` 不同 = 要改；相同 = 不动）。 */
  current?: string
}

/** WP348：一个方案值的来源种类。 */
export type SetupSourceKind =
  /** 已经存着的设置 */
  | 'saved'
  /** 品牌档案 */
  | 'profile'
  /** 已连的数据（插件登录态里的账号、店铺、已连渠道） */
  | 'connected'
  /** 联网搜到的网页 */
  | 'web'
  /** 问了一次 AI 整理 */
  | 'model'
  /** 默认值（不替人定规矩时的起步值，如每天一次） */
  | 'default'

/** WP348：一个来源（卡上点开看；网页才有地址）。 */
export interface SetupSource {
  kind: SetupSourceKind
  /** 一句人话（「品牌档案 · 关键词」「插件里登着的 Reddit 号」「r/SmartGlasses 的搜索结果」）。 */
  label: string
  /** 只有网页来源才有：点开的地址（只认 http / https）。 */
  url?: string
}

/** WP348：出卡前查了什么（时间线上那几行、卡上「查了几处」点开看）。 */
export interface SetupPlanStep {
  text: string
  source?: SetupSource
}

/** 配置卡（`setup_request`）的载荷。 */
export interface SetupRequestPayload {
  form: 'setup_request'
  /** 设置目标（服务端登记的 `SetupTarget.id`，如 `site.store`）。 */
  target: string
  /** 为什么要设（一句人话）。 */
  why: string
  fields: SetupField[]
  /** 人填好的值：保存时随决定（`approve` + `edited_payload`）带回；没带就用建议值。 */
  values?: Record<string, string>
  resume?: SetupResumeTarget
  /**
   * WP348（决策 887）：卡面是「方案」不是「表单」。
   * - `plan`：「我打算这样设」——每格列 AI 定的值 + 一句理由，「就这样」直接存，「改一下」才展开表单；
   * - `change`：「我打算改成这样」——已设好的目标，列现值 → 新值 + 理由，人确认才生效。
   * 没有 = 老卡（WP324 那张表单）。
   */
  mode?: 'plan' | 'change'
  /** WP348：出卡前查了什么（几行；没查就没有）。 */
  steps?: SetupPlanStep[]
  /**
   * WP410（真机 #6）：出卡前**没查成**——一句人话原因（「联网搜索没开；没接 AI 模型」）。
   * 有它 = 卡上照实说「没查成，原因…，要不要你来填」，不装成方案；没有 = 查过了（或这个目标本来不查）。
   */
  research_failed?: string
  /** WP390：同连接卡那一格——「交给工坊办」。 */
  workshop_service?: ServiceOffer
}

/** WP348：一个来源地址能不能点开（只认 http / https，别的一律不给链接）。 */
export function safeSourceUrl(url: string | undefined): string | undefined {
  if (url === undefined) return undefined
  try {
    const u = new URL(url)
    return u.protocol === 'https:' || u.protocol === 'http:' ? u.toString() : undefined
  } catch {
    return undefined
  }
}

export type SetupCardPayload = ConnectRequestPayload | SetupRequestPayload

export const SETUP_CARD_KINDS = ['connect_request', 'setup_request'] as const
export type SetupCardKind = (typeof SETUP_CARD_KINDS)[number]

export const isConnectRequestPayload = (p: unknown): p is ConnectRequestPayload =>
  typeof p === 'object' &&
  p !== null &&
  (p as { form?: unknown }).form === 'connect_request' &&
  Array.isArray((p as { needs?: unknown }).needs)

export const isSetupRequestPayload = (p: unknown): p is SetupRequestPayload =>
  typeof p === 'object' &&
  p !== null &&
  (p as { form?: unknown }).form === 'setup_request' &&
  typeof (p as { target?: unknown }).target === 'string' &&
  Array.isArray((p as { fields?: unknown }).fields)

/**
 * WP410（真机 #5 / #6）：旧版留下的**空表单**配置卡——WP348 之前出的卡没有 `mode`（WP324 那张表单）。
 * 升级后这种卡一律作废、换成方案卡（决策 530：没有真实用户，不做兼容）。
 */
export const isLegacySetupRequest = (p: unknown): boolean =>
  isSetupRequestPayload(p) && p.mode !== 'plan' && p.mode !== 'change'

/**
 * 一个设置键 / 名字看着像不像秘密（口令、令牌、密钥）。配置卡一律不收这种——
 * 它们只能在连接卡的本机原生表单里填（纪律 1）。宁可多拦：拦错了改走连接卡，放错了就是泄漏。
 */
export function isSecretLikeSetupKey(key: string, label = ''): boolean {
  const s = `${key} ${label}`.toLowerCase()
  return (
    /pass(word|wd|code)?\b|secret|token|api[_ -]?key|private[_ -]?key|credential|\bpin\b|\bkey\b/.test(
      s,
    ) || /密码|口令|密钥|令牌|凭据|秘钥/.test(s)
  )
}

/**
 * 连接卡的去重键：只看缺的是哪几样（kind 排序），与哪件事、哪一轮无关——
 * 同一缺项不管几件事撞上，同一时间只有一张卡（纪律 2）。
 */
export function connectRequestDedupeKey(
  workspace_id: string,
  needs: readonly ConnectNeed[],
): string {
  const kinds = [...new Set(needs.map((n) => n.kind))].sort().join('+')
  return `connect_request:${kinds}:${workspace_id}`
}

/** 配置卡的去重键：同一个设置目标同一时间只有一张。 */
export function setupRequestDedupeKey(workspace_id: string, target: string): string {
  return `setup_request:${target}:${workspace_id}`
}

/* ── WP334（决策 724 / 725 / 726，Luoye 10-15）：AI 自己要卡 + 内置几样「能就地连的」 ── */

/**
 * 不在连接目录里、但卡上也能**就地连**的几样（每样一个现成接法，不为谁写专属界面）：
 *
 * | service | 卡上的接法 |
 * |---|---|
 * | `model` | 接模型（与开工向导第 ① 步同一个件：工坊接口 / DeepSeek 官方 / 自己的 key——key 走本机原生表单） |
 * | `deepseek_account` | DeepSeek 账号登录（与设置页同一个件） |
 * | `chatgpt_subscription` | ChatGPT 订阅登录（与设置页同一个件；WP362） |
 * | `workshop_account` | 关联 Agents 工坊账号（与设置页同一个注册 / 登录表单） |
 * | `im:wecom` | 企业微信机器人表单（BotID + Secret，本机原生表单，只有负责人能填） |
 * | `im:wechat` | 个人微信扫码 |
 * | `im:feishu` / `im:dingtalk` | 团队机器人卡（WP324 已有） |
 * | `extension` | 浏览器插件配对码（WP324 已有） |
 * | `google_account` | 在浏览器里登录 Google 账号（WP386：信息监控的前置；建 Google 提醒要用） |
 *
 * 连接目录里的那些（`imap_smtp` 发信邮箱、`ga4`、`meta_ads`…）照 WP324 按目录走，不在这张表里。
 */
export const BUILTIN_CONNECT_NEEDS: Readonly<Record<string, Omit<ConnectNeed, 'required'>>> = {
  model: { kind: 'model', service: 'model', name: 'AI 模型' },
  deepseek_account: {
    kind: 'deepseek_account',
    service: 'deepseek_account',
    name: 'DeepSeek 账号',
  },
  /** WP362：ChatGPT 订阅登录（与设置页那张订阅卡同一个件）。 */
  chatgpt_subscription: {
    kind: 'chatgpt_subscription',
    service: 'chatgpt_subscription',
    name: 'ChatGPT 订阅',
  },
  workshop_account: {
    kind: 'workshop_account',
    service: 'workshop_account',
    name: 'Agents 工坊账号',
  },
  'im:wecom': { kind: 'im:wecom', service: 'im:wecom', name: '企业微信' },
  'im:wechat': { kind: 'im:wechat', service: 'im:wechat', name: '微信' },
  'im:feishu': { kind: 'im:feishu', service: 'im:feishu', name: '飞书' },
  'im:dingtalk': { kind: 'im:dingtalk', service: 'im:dingtalk', name: '钉钉' },
  extension: { kind: 'extension', service: 'extension', name: '浏览器插件' },
  /**
   * WP386（docs/103 S5）：Google 账号——信息监控的前置（Google 提醒要在用户自己的 Google 账号里建）。
   * 卡上让人在这台电脑的浏览器里登录 Google；已经连过任一 Google 服务（Gmail / GA4 / GSC…）就算有。
   */
  google_account: { kind: 'google_account', service: 'google_account', name: 'Google 账号' },
}

/** 内置那几样之一 → 一样「要连的」（认不出回 `undefined`）。 */
export function builtinConnectNeed(service: string, required = true): ConnectNeed | undefined {
  const hit = BUILTIN_CONNECT_NEEDS[service]
  return hit === undefined ? undefined : { ...hit, required }
}

/**
 * 工具回执里「缺一样能就地连的」的**机器码**写法（与 `needs_setup:<目标>` 对称）：
 * `reason` 以 `needs_connection:<service>` 开头，后面可以跟一句人话。
 * 运行时认码不认人话；人话照旧给模型和人看。
 */
export function needsConnectionReason(service: string, text = ''): string {
  return `needs_connection:${service}${text === '' ? '' : ` ${text}`}`
}

/**
 * 一段给 AI / 卡面的字里像不像夹着秘密（`sk-…`、长串令牌、`password=…`）。
 * AI 要卡时的「为什么」「建议值」一律过这一道：像就整条拒收（不回显那段字）——
 * 口令只能在本机原生表单里填，永不进 AI 上下文、卡的载荷与事件。
 */
export function looksLikeSecretValue(text: string): boolean {
  const longToken = (text.match(/[A-Za-z0-9+_-]{32,}/g) ?? []).some(
    (t) => /[0-9]/.test(t) && /[A-Za-z]/.test(t),
  )
  return (
    longToken ||
    /\b(?:sk|pk|rk|ghp|gho|xox[abp]|AKIA)[-_][A-Za-z0-9_-]{8,}/.test(text) ||
    /(?:password|passwd|secret|token|api[_ -]?key)\s*[:=]\s*\S+/i.test(text) ||
    /(?:密码|口令|密钥|令牌)\s*[:：=是为]\s*\S+/.test(text)
  )
}
