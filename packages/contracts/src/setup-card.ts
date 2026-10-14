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
