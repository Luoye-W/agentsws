/**
 * 模型面（WP25 交付 C）：22 模型网关的 HTTP 投影。
 *
 * 在这之前，工作台上根本没有"接模型"这一项——不设 `DEEPSEEK_API_KEY` 环境变量就只有
 * stub 运行时，Agent 一句话都说不出来。这一组路由把它补上：原生表单填 key、
 * 按 purpose 选模型、三级预算与数据驻留、一张按 purpose 汇总的花费小表。
 *
 * 三条边界，和连接面（`routes/connections.ts`）一模一样：
 *
 * 1. **key 只走 `PUT /v1/models/providers/:id` 这一条路，而且只走一次。** 请求体里的
 *    `api_key` 由处理器原样交给端口，端口写进本机 AES-256-GCM 加密库，
 *    然后**没有任何一处**再持有它：不进事件日志、不进 trace、不进响应体、不进 OpenAPI 示例，
 *    `GET /v1/models/providers` 里连密文都没有，只有一个 `has_key: true`。
 * 2. **网关里不写业务**（28 §2）：怎么装配 provider、怎么热更新、怎么试跑，
 *    全在 `apps/server/src/models.ts` 里；这一层只做路由声明、权限判定与信封。
 * 3. **权限是 owner 的**（05）：模型 key 是花钱的东西，客服岗位看不到也改不了。
 *    读走 `store_config.read@workspace`，改走 `policy.stage@workspace`——
 *    和连接面同一套元组，理由也一样：这属于策略层，永远 L1。
 */
import type {
  MaybePromise,
  ModelCheckStepResult,
  ModelPurpose,
  ModelRef,
} from '@agentsws/contracts'
import { z } from 'zod'
import { ApiError } from '../errors.js'
import { assignmentOf, body, ok, param, principalOf } from '../helpers.js'
import { type Route, route } from '../route-spec.js'
import type { GatewayDeps } from '../types.js'

const READ = {
  domain: 'store_config',
  op: 'read',
  range: 'workspace',
  sensitivity: 'internal',
} as const

const WRITE = {
  domain: 'policy',
  op: 'stage',
  range: 'workspace',
  sensitivity: 'restricted',
} as const

const TAG = 'models'

/** 22 的五个 purpose + WP23 的转写。设置页按它分组选默认模型。 */
export const MODEL_PURPOSES: readonly ModelPurpose[] = [
  'run',
  'extraction',
  'reflection',
  'embedding',
  'judge',
  'transcription',
]

// ── 端口类型（apps/server 实现）────────────────────────────────────────

/** 一个 provider 卡的种类。 */
export type ModelProviderKind =
  /** DeepSeek 官方（OpenAI 兼容形态，`https://api.deepseek.com`）。 */
  | 'deepseek'
  /** 任何 OpenAI 兼容网关：OpenAI 本身、Moonshot、通义、智谱、本地 Ollama…… */
  | 'openai_compatible'
  /**
   * 49 M2「用 agentsws 的」：走我们云上的服务入口（`/v1/ai`），按积分扣。
   *
   * 与前两种的差别只有一条——**`api_key` 不由用户填**。它是 WP58 那把工作区服务令牌，
   * 运行时从本机加密库取（`cloud.workspace_token`）；还没关联账号就挂不上，
   * 界面上显示"先在设置 → 账号与积分里关联账号"。
   */
  | 'agentsws_cloud'
  /**
   * WP90（55 §9 Q8）：**用 ChatGPT 的订阅登录**（`pi-ai` 的 `openai-codex`）。
   *
   * 与前三种的根本差别：**没有 key 可填**。凭据是一次 OAuth 登录的产物，
   * 存在本机加密秘密库里、由官方 `pi-ai` 自己刷新；这一条只在个人档出现。
   */
  | 'openai-codex'
  /** WP90：**用 Claude 的订阅登录**（`pi-ai` 的 `anthropic`）。同上。 */
  | 'anthropic'
  /**
   * WP134（Luoye 09-24）：**用我的 DeepSeek 账号登录**——第三种模型来源。
   *
   * 也没有 key 可填：凭据是 dsh 官方 `@deepseek-ai/dsh-deepseek-account-platform` 在系统浏览器里
   * 走完 PKCE 授权的产物，**只存在 dsh 自己的本机凭据库里**（不进我们的秘密库、不上云）。
   * 推理走 `api.deepseek.com` 的 Messages 口、令牌放 `x-dsh-auth-token` 头（官方写法）。
   * 登录 / 登出 / 余额走 `/v1/settings/models/deepseek-account*` 那几条路。数据驻留：境内。
   */
  | 'deepseek_account'

/**
 * 一个 provider 的对外形状。**这里没有、也不会有 key 字段。**
 *
 * `has_key` 是唯一与凭据有关的信息——"这台机器上有没有存过一把"，
 * 一个布尔值，看不出长度、看不出前缀。
 */
export interface ModelProviderView {
  id: string
  kind: ModelProviderKind
  label: string
  /** 请求发到哪儿（不是秘密，用户自己填的）。 */
  base_url: string
  /** 主模型名（`deepseek-chat` / `gpt-4o-mini` / `qwen-plus` / `llama3.1`…）。 */
  model: string
  /** 给了才暴露 embed。 */
  embedding_model?: string
  /** 给了才暴露 transcribe（ASR）。 */
  transcription_model?: string
  /** 22 §2 数据驻留：这家在境内还是境外。 */
  region: 'cn' | 'global'
  /** 这台机器上存过 key 没有。**永远只是布尔值。** */
  has_key: boolean
  /** 现在这一份配置有没有真的挂在网关上（缺 key 就挂不上）。 */
  active: boolean
  /** 挂不上的原因（人话）。 */
  inactive_reason?: string
  /** 每百万 token 的价格（用于预算记账）；不填按 0 记。 */
  price_in?: number
  price_out?: number
  price_cached?: number
  /** WP42：这三个价从哪来。`manual` 的不会被每周刷新覆盖。 */
  price_source?: 'catalog' | 'manual'
  /** 内置 / 抓来的价才有：币种、出处、日期（界面上写"来源：官网 2026-09-10"）。 */
  price_currency?: string
  price_source_url?: string
  price_as_of?: string
  /** 上次从 `/models` 拉回来的模型清单（WP42）。表单里的"模型名"下拉照它画。 */
  models?: string[]
  /** 上次拉清单是什么时候 / 通没通。 */
  last_listing?: ModelListing
  /** 上次"测试"的结果。 */
  last_test?: ModelTestResult
  /** WP127：按上一次验证，这条能不能看图。 */
  vision_status?: ModelVisionStatus
  /** 这一条是环境变量给的（`DEEPSEEK_API_KEY`），界面上不给删。 */
  from_env?: boolean
  /**
   * WP151：DeepSeek 说**余额不足**（推理口 402，判定照官方 0.1.7-rc.2）。模型卡与顶栏据此出一行
   * 醒目提示 +「去充值」：账号那一条引到官方账号模块的 `links.topUpUrl`，API key 那一条引到开放平台的
   * 充值页（官方：账号路的充值不出现在 API key 的失败上，免得充错地方）。之后一次调用成功、或账号余额
   * 刷新回来有钱了，这一格就没了。不是登录失效：`active` / 登录状态都不变。
   */
  quota_exceeded?: DeepSeekQuotaView
}

/** WP151：DeepSeek 余额不足那一行提示（人话 + 去哪充值）。 */
export interface DeepSeekQuotaView {
  /** 什么时候撞上的（ISO8601）。 */
  at: string
  /** 人话：账号路"DeepSeek 账号余额不足，充值后再让它接着做"，API key 路"DeepSeek API 余额不足。用建这把 key 的那个 DeepSeek 账号登录开放平台，充值后再试"。 */
  message: string
  /** 「去充值」打开的地址（不带任何令牌）。 */
  top_up_url: string
}

/**
 * 可以新建哪几种 provider——界面照着画卡片，文案在这里，不在前端。
 *
 * **WP90 起一张卡可以有几个"方案"**（Luoye 定）：同一家厂商 / 渠道的几套接法
 * （阿里云百炼的按量 / Token Plan / Coding Plan，OpenAI 的 API key / ChatGPT 订阅登录）
 * 合成**一张卡**，点进去再选方案。以前是一个方案一张卡——三张百炼卡并排摆着，
 * 用户第一眼要先分清"这三张有什么区别"，而那个区别恰恰是他还不知道的东西。
 *
 * 承载方式是**加三个可选字段**，不是改结构：`vendor` 相同的几条归一张卡，
 * `plan_label` 是卡里那一排单选按钮上的字，`plan_order` 定顺序（小的在前，
 * 默认选第一个）。不填 `vendor` 的那些照旧一条一张卡。
 */
export interface ModelProviderTemplate {
  kind: ModelProviderKind
  label: string
  summary: string
  /** WP90：这几条属于同一张卡（缺省 = 自己独占一张卡）。 */
  vendor?: string
  /** 卡名（同一个 `vendor` 的几条要写一样的）。 */
  vendor_label?: string
  /** 卡上那句话（同上）。 */
  vendor_summary?: string
  /** 这一条在卡里叫什么方案（「Token Plan（订阅）」「按量计费」「用 ChatGPT 订阅登录」）。 */
  plan_label?: string
  /** 方案排序；小的在前，卡打开时默认选第一个。 */
  plan_order?: number
  /**
   * 这个方案怎么认证：填 key（默认），还是用订阅登录。
   *
   * `subscription` 的方案**没有表单**——卡里换成一个"登录"按钮 + 风险提示，
   * 走 `/v1/settings/models/subscription/*` 那几条路。
   *
   * WP134：`account` = 用 DeepSeek 账号登录（系统浏览器授权），走
   * `/v1/settings/models/deepseek-account*`；也没有表单。它单独一张卡（向导第 ① 步与设置页各一张），
   * 不进"一家一张卡"那一排。
   */
  auth?: 'api_key' | 'subscription' | 'account'
  /** `auth: 'subscription'` 时走哪一家（与 {@link SubscriptionView.provider} 同一个串）。 */
  subscription_provider?: SubscriptionProviderKind
  default_base_url: string
  default_model: string
  region: 'cn' | 'global'
  /** ≤ 5 步的准备说明 + 外链，和连接面一个规格。 */
  steps: string[]
  links: { label: string; url: string }[]
  /** 常见的几个填法（Moonshot / 通义 / 智谱 / Ollama），点一下就把地址填好。 */
  presets?: {
    id: string
    label: string
    base_url: string
    model: string
    region: 'cn' | 'global'
  }[]
}

// ── WP90：订阅登录（55 §9 Q8）──────────────────────────────────────────

/** 能用订阅登录的两家。名字是 `pi-ai` 的 provider id，三处（路由、凭据记录、这里）同一个串。 */
export type SubscriptionProviderKind = 'openai-codex' | 'anthropic'

/** 登录方式：设备码（在手机上输一串码）或浏览器（本机回调）。 */
export type SubscriptionLoginMethodName = 'device' | 'browser'

/** 登录途中的一条进展。**永远没有 token**——只有"去哪儿、输什么"。 */
export interface SubscriptionNoticeView {
  message: string
  url?: string
  code?: string
}

/** 登录途中要人回答的一个问题（浏览器流里"把授权码贴回来"那一条）。 */
export interface SubscriptionQuestionView {
  kind: 'text' | 'secret'
  message: string
  placeholder?: string
}

/**
 * 一家订阅登录现在的样子。**这里没有、也不会有 token 字段。**
 *
 * 与凭据有关的只有三样：登没登录（布尔）、账号标识**脱敏后**的样子
 * （`acct…cdef`，看不出完整 id）、什么时候过期。
 */
export interface SubscriptionView {
  provider: SubscriptionProviderKind
  /** 卡上的名字（「用 ChatGPT 订阅登录（Plus / Pro）」）。 */
  label: string
  summary: string
  /** 这家能用哪几种登录方式，最推荐的在前（Claude 只有浏览器）。 */
  methods: SubscriptionLoginMethodName[]
  /** 固定的白话风险提示（卡上一定要显示）。 */
  risk_note: string
  /** 这台机器允不允许（只有个人档允许）。 */
  available: boolean
  /** 不允许的原因（人话）。 */
  unavailable_reason?: string
  signed_in: boolean
  /** 账号标识**脱敏**后的样子；完整值永远不出服务进程。 */
  account?: string
  expires_at?: string
  /** 现在有没有一次登录在跑。 */
  in_flight: boolean
  notice?: SubscriptionNoticeView
  question?: SubscriptionQuestionView
  /** 上一次为什么没成（人话；不含任何凭据）。 */
  last_error?: string
  /** 登录之后能用哪些模型（目录来自 `pi-ai`：gpt-5.x / claude-*）。价目一律是"订阅"。 */
  models: { id: string; name: string }[]
  /** 这个人在这一家选了哪个模型。 */
  selected_model?: string
}

export interface SubscriptionLoginInput {
  provider: SubscriptionProviderKind
  method: SubscriptionLoginMethodName
}

// ── WP134：用我的 DeepSeek 账号登录（第三种模型来源）───────────────────

/**
 * 一次登录走到哪一步——官方 `SignInAttemptView.phase` 原样透出（八个值，一个不改）。
 * `waiting-browser` 时界面把 {@link DeepSeekAccountView.authorize_url} 交给系统浏览器打开。
 */
export type DeepSeekAccountPhase =
  | 'initializing'
  | 'waiting-browser'
  | 'exchanging'
  | 'committing'
  | 'succeeded'
  | 'cancelled'
  | 'expired'
  | 'failed'

/** 一个钱包的余额（币种 + 平台给的十进制串，**不转数字**——保留平台的精度）。 */
export interface DeepSeekWalletView {
  currency: 'CNY' | 'USD'
  balance: string
}

/**
 * 「用我的 DeepSeek 账号登录」现在的样子。**这里没有、也不会有令牌字段。**
 *
 * 与账号有关的只有三样（派工单原话「我们只读登录了没有 / 账号名 / 余额」）：`signed_in`、
 * `account`（平台给的名字，或平台**自己脱敏过**的手机号 / 邮箱）、`balance`。
 */
export interface DeepSeekAccountView {
  /** 这台机器能不能用这条路（只有本机档能：授权回调必须回到本机回环地址）。 */
  available: boolean
  /** 不能用的原因（人话）。 */
  unavailable_reason?: string
  /** 官方模块现在挂着没有（用户选了这条路才挂；默认关）。 */
  enabled: boolean
  /** dsh 本机凭据库里有没有这个账号的授权。 */
  signed_in: boolean
  /** 最近一次登录尝试（没有就是没登过或已经登出）。 */
  attempt?: {
    id: string
    phase: DeepSeekAccountPhase
    /** 只在 `waiting-browser` 时有：系统浏览器要打开的授权页（平台源上固定的 `/dsh/authorize`）。 */
    authorize_url?: string
    /** 这次登录最晚什么时候作废（ISO8601）。 */
    expires_at?: string
    /** 没成的原因码（官方四个：`network` / `protocol` / `expired` / `storage`）。 */
    error_code?: 'network' | 'protocol' | 'expired' | 'storage'
    /** 没成的原因（人话）。 */
    error?: string
  }
  /** 账号名：平台上的名字，没有就是平台脱敏过的手机号 / 邮箱。 */
  account?: string
  /** 账号资料查不到时的人话（查不到**不等于**没登录）。 */
  account_error?: string
  /** 余额：充值钱包与赠送钱包分开；查不到时 `status: 'failed'` + 一句人话，**不会显示成 0**。 */
  balance?:
    | { status: 'ready'; wallets: DeepSeekWalletView[]; bonus: DeepSeekWalletView[] }
    | { status: 'failed'; message: string }
  /** 平台上看用量 / 充值的地址（官方 `links`，不带令牌）。 */
  usage_url?: string
  top_up_url?: string
  /** 这一路用哪个型号（官方目录里能看图的那一档）与数据驻留（境内）。 */
  default_model: string
  region: 'cn'
  /**
   * WP150：上一次是**登录失效**把人登出的（不是自己点的登出）——DeepSeek 那边不认这份登录了
   * （推理口 401，或资料 / 余额口 401 / 40003，判定口径照官方）。界面在登录按钮上面说这句人话；
   * 重新登上之后就没有这一格了。
   */
  session_expired?: { at: string; message: string }
  /**
   * WP150：现在**正在用这个账号跑**的事（登出前确认框里列的就是它们；确认后先停这些、再登出）。
   * 只在登录着、且确实有在跑的时候给。
   */
  running_tasks?: DeepSeekAccountTaskView[]
  /**
   * WP151：DeepSeek 说这个账号**余额不足**（推理口 402）。卡片上出一行醒目提示 +「去充值」
   * （`top_up_url`，官方 `links.topUpUrl`）；余额刷新回来有钱了、或一次调用成功，就没有这一格。
   * 不是登录失效：`signed_in` 不变。
   */
  quota_exceeded?: { at: string; message: string }
}

/** WP150：一件正在用 DeepSeek 账号跑的事（事项名是人话；没有模型输入、没有令牌）。 */
export interface DeepSeekAccountTaskView {
  run_id: string
  matter_id: string
  /** 事项名。 */
  title: string
  /** 装了好几个品牌时，是哪个品牌的事。 */
  brand?: string
}

export interface ModelTestResult {
  ok: boolean
  reason?: string
  /** 人话。成功时是"回了 xx 字，用时 xx 毫秒"，**永远没有 key**。 */
  detail?: string
  /** 真正跑起来的那个模型（可能被降级过）。 */
  model?: string
  duration_ms?: number
  checked_at: string
  /**
   * WP127：验证三步各自过没过（连通 → 文字 → 带图）。老版本存下来的结果没有这一格——
   * 那就是"升级前测过、还没验证过能不能看图"。
   */
  steps?: ModelCheckStepResult[]
  /** WP127：第 ③ 步的结论。`false` = 看不了图（`reason: 'no_vision'`）；没跑到就没有。 */
  vision?: boolean
}

/**
 * WP127：这条模型能不能看图，按上一次验证的结论。
 *
 * - `ok`：验证过，能看；
 * - `no`：验证过，看不了（设置页顶部那条提示、需要看图的动作明说「当前模型看不了图」）；
 * - `unchecked`：还没按三步验证过（老用户升级上来的都是这一档）。
 */
export type ModelVisionStatus = 'ok' | 'no' | 'unchecked'

/**
 * WP127 交付 3：**生图单独一档**。
 *
 * 文字模型（必须能看图）与生图是两件事：生图可以不配——不配时要出图的岗位说一句人话
 * 让人来这里配，别的照常干活。能配的来源只有两类：Agents 工坊官方接口（按张扣积分，
 * 单价 `credits_per_image` 常显）与已配的 OpenAI 兼容口（自己的 key，走 `/images/generations`）。
 */
export interface ModelImageView {
  /** 配了没有。 */
  configured: boolean
  /** 用的是哪一条已配的 provider（`ModelProviderView.id`）。 */
  provider_id?: string
  /** 生图模型名（`gpt-image-1` 之类）。 */
  model?: string
  /** 走的是 Agents 工坊官方接口（按张扣积分）。 */
  official: boolean
  /** 官方接口一张图多少积分（`pricing.json` 的 `ai.image`）。**不管配没配都给**，界面常显。 */
  credits_per_image?: number
  /** 能选哪几条（已配、有 key 的 provider；订阅登录那两种没有生图口，不列）。 */
  choices: { provider_id: string; label: string; official: boolean; default_model: string }[]
  /** 没配 / 配的那条现在用不了时的人话。 */
  unavailable_reason?: string
}

/** 改生图那一档。`provider_id` 给空串 = 不配。 */
export interface SetModelImageInput {
  provider_id: string
  model?: string | undefined
}

/**
 * 「拉一次模型列表」的结果（WP42 交付 1）。
 *
 * 拉不到**不是错**：本地 Ollama 没起来、地址写错、key 过期、这家干脆没有 `/models`
 * ——都可能。所以回的是 `ok: false` + 一句人话，界面据此退回手填而不是弹一个红框。
 */
export interface ModelListing {
  ok: boolean
  /** 拿到的模型名（已去重排序）。拉不到时是空数组。 */
  models: string[]
  /** 拉不到的原因（人话）。**永远没有 key。** */
  reason?: string
  checked_at: string
}

/**
 * 拉模型列表的入参。**全都可选**：
 *
 * - 已经保存过的那条，什么都不给就用存着的地址与加密库里的 key；
 * - 还没保存的（用户刚把地址与 key 填进表单、还没点保存），把这两样带上就能先拉一次。
 *   `api_key` 与保存那条路一样：只走这一次，不落盘、不进事件、不进返回值。
 */
export interface DiscoverModelsInput {
  base_url?: string | undefined
  api_key?: string | undefined
  region?: 'cn' | 'global' | undefined
}

/**
 * 内置价目表的对外形状（WP42 交付 2）。
 *
 * 在这之前，「输入价 / 输出价」是两个空的数字框——用户得自己去官网翻出「每百万
 * token 多少钱」再填进来。填错了不会报错，只会让 22 §3 的三级预算按一个假数字拦人。
 *
 * **不换算币种**：各家官网标什么就是什么，`currency` 跟着走，界面上写出来。
 */
export interface ModelPricingModel {
  model: string
  in: number
  out: number
  cached: number
  aliases?: string[]
}

export interface ModelPricingVendorView {
  id: string
  label: string
  currency: string
  /** 按接口地址的主机名认这一家。 */
  hosts: string[]
  source_url: string
  /** 这份价是哪天的（内置价的日期，或者上次抓成功那天）。 */
  as_of: string
  /** 上次去官网抓这一家的结果（没抓过就没有）。 */
  last_refresh?: { at: string; ok: boolean; models: number; reason?: string }
  models: ModelPricingModel[]
}

export interface ModelPricingView {
  vendors: ModelPricingVendorView[]
  /** 上次整轮刷新是什么时候。 */
  refreshed_at?: string
}

/** 刷一轮价的结果。**只有条数与来源**，没有页面正文、没有任何凭据。 */
export interface ModelPricingRefreshResult {
  at: string
  ok: boolean
  /** 抓成功几家 / 一共几家。 */
  vendors: { id: string; label: string; ok: boolean; models: number; reason?: string }[]
  /** 跟着改了几条 provider 的价（标了"手动"的一条都不动）。 */
  updated_providers: number
  /** 整轮被拦下的原因（比如出站急停）。 */
  reason?: string
}

/** 22 §2 的策略：默认模型 + 按 purpose 覆盖 + 驻留 + 三级预算。 */
export interface ModelDefaultsView {
  /** `provider_id/model`，与 `ModelProviderView.id` 对齐。 */
  default: string
  by_purpose: Partial<Record<ModelPurpose, string>>
  data_residency: 'cn' | 'any'
  budget: {
    workspace_daily_base?: number
    workspace_monthly_base?: number
    assignment_daily_base?: number
  }
  /** 可选的模型清单（`provider_id/model`），给下拉框用。 */
  choices: { id: string; label: string }[]
  /**
   * WP66（52 O3）：这个品牌的模型设置**跟不跟随公司默认**。
   *
   * 跟随时上面那几项读的是公司默认品牌那一份，界面把表单画成只读；
   * 关掉开关这个品牌才有自己的一份。装了多品牌之后才有这一位——
   * 单品牌的机器上它永远是 `false`（自己就是公司默认那一个）。
   */
  inherit_org?: boolean
  /** 这个品牌**就是**公司默认那一个（开关画成灰的、不给点）。 */
  org_default?: boolean
  /** 公司默认品牌的名字（界面上那句"跟随「XX」的设置"）。 */
  org_default_brand?: string
}

/** WP66（52 O3）：改"跟随公司默认"。 */
export interface SetModelInheritanceInput {
  inherit_org: boolean
}

export interface ModelUsageRow {
  purpose: ModelPurpose
  calls: number
  input_tokens: number
  output_tokens: number
  cached_tokens: number
  cost_base: number
}

export interface ModelUsageView {
  since: string
  rows: ModelUsageRow[]
  total: ModelUsageRow | undefined
  /** 三级预算现在用了多少（`budget()` 的工作区档）。 */
  budget: { used_base: number; cap_base: number; frozen: boolean }
}

/** 改策略的入参。可选项一律显式带 `| undefined`（exactOptionalPropertyTypes）。 */
export interface SetModelDefaultsInput {
  default?: string | undefined
  by_purpose?: Partial<Record<ModelPurpose, string>> | undefined
  data_residency?: 'cn' | 'any' | undefined
  budget?:
    | {
        workspace_daily_base?: number | undefined
        workspace_monthly_base?: number | undefined
        assignment_daily_base?: number | undefined
      }
    | undefined
}

export interface ModelsActor {
  workspace_id: string
  person_id: string
  assignment_id: string
  role_id: string
}

/** 保存一个 provider 的入参。**`api_key` 是唯一携带凭据原文的字段。** */
export interface SaveModelProviderInput {
  kind: ModelProviderKind
  label?: string | undefined
  base_url?: string | undefined
  model: string
  embedding_model?: string | undefined
  transcription_model?: string | undefined
  region?: 'cn' | 'global' | undefined
  /** 不给就是"别动已经存着的那一把"（改个模型名不用重填 key）。 */
  api_key?: string | undefined
  price_in?: number | undefined
  price_out?: number | undefined
  price_cached?: number | undefined
  /**
   * WP42：这三个价是用户自己改的（`manual`）还是照内置价目表填的（`catalog`）。
   *
   * 标了 `manual` 的，**每周那次官网刷新一条都不动它**——用户改过的数字不该被
   * 一个后台任务悄悄覆盖掉。不给就由服务端判断（能在价目表里查到就是 catalog）。
   */
  price_source?: 'catalog' | 'manual' | undefined
}

export interface ModelsPort {
  templates(actor: ModelsActor): MaybePromise<ModelProviderTemplate[]>
  providers(actor: ModelsActor): MaybePromise<ModelProviderView[]>
  /** **唯一**接触 key 原文的方法。实现必须写进加密库后立即遗忘。 */
  save(
    actor: ModelsActor,
    id: string,
    input: SaveModelProviderInput,
  ): MaybePromise<ModelProviderView>
  remove(actor: ModelsActor, id: string): MaybePromise<void>
  /**
   * 验证三步（WP127）：连通 → 一次最小文字请求 → 一次带图的最小请求（`purpose: 'judge'`）。
   * 看不了图的**不通过**（`reason: 'no_vision'`）。
   */
  test(actor: ModelsActor, id: string): MaybePromise<ModelTestResult>
  /** WP127：生图那一档现在是什么样。不实现 = 这个进程没装生图设置。 */
  image?(actor: ModelsActor): MaybePromise<ModelImageView>
  /** WP127：改生图那一档（保存即生效）。 */
  setImage?(actor: ModelsActor, input: SetModelImageInput): MaybePromise<ModelImageView>
  /** 去 provider 的 `/models` 拉一次可用模型清单（WP42）。拉不到回 `ok: false` + 人话。 */
  discover(actor: ModelsActor, id: string, input?: DiscoverModelsInput): MaybePromise<ModelListing>
  defaults(actor: ModelsActor): MaybePromise<ModelDefaultsView>
  setDefaults(actor: ModelsActor, input: SetModelDefaultsInput): MaybePromise<ModelDefaultsView>
  usage(actor: ModelsActor, since?: string): MaybePromise<ModelUsageView>
  /** 内置价目表（含上次抓回来的覆盖）。表单照它自动填价。 */
  pricing(actor: ModelsActor): MaybePromise<ModelPricingView>
  /** 去各家官网抓一次价（普通 HTTP GET，不经模型；出站受急停管）。 */
  refreshPricing(actor: ModelsActor): MaybePromise<ModelPricingRefreshResult>
  /** 这台机器上有没有能用的模型（首页那条黄条按它出现 / 消失）。 */
  configured(): boolean
  /**
   * WP66（52 O3）：改这个品牌的"跟随公司默认"。
   *
   * 不实现 = 这个进程只装了一套模型面（单品牌），
   * `PUT /v1/models/inheritance` 回 not_implemented。
   */
  setInheritance?(
    actor: ModelsActor,
    input: SetModelInheritanceInput,
  ): MaybePromise<ModelDefaultsView>

  /*
   * WP90（55 §9 Q8）：订阅登录。**五个方法都是可选的**——不实现 =
   * 这个进程没有装配订阅登录（公司端的镜像就该是这样），路由回 not_implemented。
   *
   * 为什么挂在模型面而不是新开一个端口：它就是"这台机器怎么接模型"的第三种答案
   * （前两种是填 key 与用积分），设置页上也在同一节里。
   */
  subscriptions?(actor: ModelsActor): MaybePromise<SubscriptionView[]>
  subscription?(actor: ModelsActor, provider: string): MaybePromise<SubscriptionView>
  /** 起一次登录；回来时带着"去这个网址、输这串码"，界面据此轮询 `subscription()`。 */
  subscriptionLogin?(
    actor: ModelsActor,
    input: SubscriptionLoginInput,
  ): MaybePromise<SubscriptionView>
  /** 回答登录途中的那个问题（把授权码贴回来）。 */
  subscriptionAnswer?(
    actor: ModelsActor,
    provider: string,
    value: string,
  ): MaybePromise<SubscriptionView>
  /** 选这一家用哪个模型（目录来自 `pi-ai`）。 */
  subscriptionSelectModel?(
    actor: ModelsActor,
    provider: string,
    model: string,
  ): MaybePromise<SubscriptionView>
  /** 登出 = 销毁本机那条记录。 */
  subscriptionSignOut?(actor: ModelsActor, provider: string): MaybePromise<void>

  /*
   * WP134：用我的 DeepSeek 账号登录。**四个方法都是可选的**——不实现 = 这个进程没有装配这条路
   * （公司端 / 托管端镜像），路由回 not_implemented。登录流程本身是 dsh 官方模块的，这里只是投影。
   */
  /** 现在什么样（界面登录途中轮询它）。带账号名与余额（登录了才查）。 */
  deepseekAccount?(actor: ModelsActor): MaybePromise<DeepSeekAccountView>
  /** 选中这条路 = 挂上官方模块 + 起一次登录；回来时（通常）已经带着授权页地址。 */
  deepseekAccountLogin?(actor: ModelsActor): MaybePromise<DeepSeekAccountView>
  /** 取消正在跑的那一次登录（只取消这一次）。 */
  deepseekAccountCancel?(actor: ModelsActor, attempt_id: string): MaybePromise<DeepSeekAccountView>
  /** 登出 = 官方 signOut（先删本机凭据、后台调平台 logout）+ 摘掉这条 provider + 关模块。 */
  deepseekAccountSignOut?(actor: ModelsActor): MaybePromise<void>
}

/** 装配方给网关的 ModelRef 拆解（`provider/model`）。 */
export function parseModelId(id: string): ModelRef | undefined {
  const at = id.indexOf('/')
  if (at <= 0 || at === id.length - 1) return undefined
  return { provider: id.slice(0, at), model: id.slice(at + 1) }
}

// ── 校验 ───────────────────────────────────────────────────────────────

const KIND = z.enum([
  'deepseek',
  'openai_compatible',
  'agentsws_cloud',
  'openai-codex',
  'anthropic',
  'deepseek_account',
])
/** WP90：订阅登录的两家 + 两种方式。值一律白名单，不接受别的串。 */
const SUBSCRIPTION_PROVIDER = z.enum(['openai-codex', 'anthropic'])
const SubscriptionLoginBody = z.object({
  provider: SUBSCRIPTION_PROVIDER,
  method: z.enum(['device', 'browser']),
})
/** 贴回来的授权码：只限长度，**值不进任何错误信封**（与 `api_key` 同一条纪律）。 */
const SubscriptionAnswerBody = z.object({ value: z.string().min(1).max(4096) })
const SubscriptionModelBody = z.object({ model: z.string().min(1).max(128) })
/** WP134：取消哪一次登录（官方的尝试 id，UUID）。 */
const DeepSeekCancelBody = z.object({ attempt_id: z.string().min(1).max(64) })
const REGION = z.enum(['cn', 'global'])
const PURPOSE = z.enum(['run', 'extraction', 'reflection', 'embedding', 'judge', 'transcription'])

/**
 * 保存 provider 的请求体。
 *
 * `api_key` 只限长度，不限内容（各家 key 的字符集不一样），校验失败时 zod 的 issue
 * 只有 path 与 message——**不会把值抄进错误信封**，这是"零泄漏"断言的一条。
 */
const SaveBody = z.object({
  kind: KIND,
  label: z.string().min(1).max(64).optional(),
  base_url: z.string().min(1).max(512).optional(),
  model: z.string().min(1).max(128),
  embedding_model: z.string().min(1).max(128).optional(),
  transcription_model: z.string().min(1).max(128).optional(),
  region: REGION.optional(),
  api_key: z.string().min(1).max(4096).optional(),
  price_in: z.number().min(0).max(100_000).optional(),
  price_out: z.number().min(0).max(100_000).optional(),
  price_cached: z.number().min(0).max(100_000).optional(),
  price_source: z.enum(['catalog', 'manual']).optional(),
})

/** 拉模型列表的请求体。`api_key` 同 `SaveBody`：只限长度，值不进任何错误信封。 */
/** WP66（52 O3）：一个布尔，别的什么都不收。 */
const InheritanceBody = z.object({ inherit_org: z.boolean() })

/** WP127：生图那一档。`provider_id` 空串 = 不配。 */
const ImageBody = z.object({
  provider_id: z.string().max(64),
  model: z.string().min(1).max(128).optional(),
})

const DiscoverBody = z.object({
  base_url: z.string().min(1).max(512).optional(),
  api_key: z.string().min(1).max(4096).optional(),
  region: REGION.optional(),
})

const DefaultsBody = z.object({
  default: z.string().min(1).max(256).optional(),
  /**
   * **必须是 `partialRecord`。** zod 4 的 `z.record(枚举, …)` 是**穷尽**的：
   * 少给一个 purpose 就整体 400。而这一版界面本来就是"只改 judge 那一格"，
   * 用 `record` 等于按 purpose 选模型这条路根本走不通（WP25 端到端测试逮到的）。
   */
  by_purpose: z.partialRecord(PURPOSE, z.string().min(1).max(256)).optional(),
  data_residency: z.enum(['cn', 'any']).optional(),
  budget: z
    .object({
      workspace_daily_base: z.number().min(0).max(1_000_000).optional(),
      workspace_monthly_base: z.number().min(0).max(1_000_000).optional(),
      assignment_daily_base: z.number().min(0).max(1_000_000).optional(),
    })
    .optional(),
})

function portOf(deps: GatewayDeps): ModelsPort {
  const p = deps.models
  if (p === undefined)
    throw new ApiError('not_implemented', '这个服务进程没有装配模型面（GatewayDeps.models）')
  return p
}

function actorOf(c: Parameters<typeof principalOf>[0]): ModelsActor {
  const p = principalOf(c)
  const a = assignmentOf(c)
  return {
    workspace_id: p.workspace_id,
    person_id: p.person_id,
    assignment_id: a.id,
    role_id: a.role_id,
  }
}

/**
 * WP90：装了订阅登录才有这五条路。没装 = 这个进程是公司端 / 托管端的镜像，
 * 那里本来就不该有"用个人账号登录"这件事——回 not_implemented，不是 500。
 */
function subscriptionPortOf(deps: GatewayDeps): ModelsPort {
  const p = portOf(deps)
  if (p.subscriptionLogin === undefined || p.subscription === undefined)
    throw new ApiError('not_implemented', '这个服务进程没有装配订阅登录（55 §9）')
  return p
}

/** WP134：装了「用 DeepSeek 账号登录」才有那四条路。 */
function deepseekAccountPortOf(deps: GatewayDeps): ModelsPort {
  const p = portOf(deps)
  if (p.deepseekAccount === undefined || p.deepseekAccountLogin === undefined)
    throw new ApiError('not_implemented', '这个服务进程没有装配「用 DeepSeek 账号登录」')
  return p
}

const PROVIDER_PARAM = {
  name: 'provider',
  in: 'path',
  required: true,
  description: '订阅登录的那一家：openai-codex（ChatGPT）或 anthropic（Claude）',
} as const

const ID_PARAM = {
  name: 'id',
  in: 'path',
  required: true,
  description: 'provider 的 id（自己起的名字，比如 deepseek / my-ollama）',
} as const

export function modelRoutes(): Route[] {
  return [
    route(
      {
        method: 'get',
        path: '/v1/models/providers',
        operationId: 'listModelProviders',
        summary: '已配的模型 provider（**永不含 key**：只有 has_key 这个布尔值）+ 可新建的种类',
        tag: TAG,
        auth: 'bearer',
        assignment: true,
        authz: READ,
        returns:
          '{ providers: ModelProviderView[]（WP127：vision_status = ok / no / unchecked，按上一次验证）, templates: ModelProviderTemplate[] }',
      },
      async (c, deps) => {
        const port = portOf(deps)
        const actor = actorOf(c)
        return ok(c, {
          providers: await port.providers(actor),
          templates: await port.templates(actor),
        })
      },
    ),
    route(
      {
        method: 'get',
        path: '/v1/models/defaults',
        operationId: 'getModelDefaults',
        summary: '按 purpose 的默认模型、数据驻留、三级预算（22 §2）',
        tag: TAG,
        auth: 'bearer',
        assignment: true,
        authz: READ,
        returns: 'ModelDefaultsView',
      },
      async (c, deps) => ok(c, await portOf(deps).defaults(actorOf(c))),
    ),
    route(
      {
        method: 'put',
        path: '/v1/models/defaults',
        operationId: 'setModelDefaults',
        summary: '改默认模型 / 驻留 / 预算；保存即生效，不重启进程',
        tag: TAG,
        auth: 'bearer',
        assignment: true,
        authz: WRITE,
        body: DefaultsBody,
        returns: 'ModelDefaultsView',
      },
      async (c, deps) => {
        const input = await body(c, DefaultsBody)
        return ok(c, await portOf(deps).setDefaults(actorOf(c), input))
      },
    ),
    route(
      {
        method: 'put',
        path: '/v1/models/inheritance',
        operationId: 'setModelInheritance',
        summary: '这个品牌的模型设置跟不跟随公司默认（52 O3）',
        tag: TAG,
        auth: 'bearer',
        assignment: true,
        authz: WRITE,
        body: InheritanceBody,
        returns: 'ModelDefaultsView',
      },
      async (c, deps) => {
        const port = portOf(deps)
        if (port.setInheritance === undefined)
          throw new ApiError(
            'not_implemented',
            '这个服务进程只装了一套模型面（单品牌），没有"跟随公司默认"这个开关',
          )
        const input = await body(c, InheritanceBody)
        return ok(c, await port.setInheritance(actorOf(c), input))
      },
    ),
    route(
      {
        method: 'get',
        path: '/v1/models/usage',
        operationId: 'getModelUsage',
        summary: '按 purpose 汇总的调用与花费（22 §3），外加工作区预算用了多少',
        tag: TAG,
        auth: 'bearer',
        assignment: true,
        authz: READ,
        params: [
          {
            name: 'since',
            in: 'query',
            required: false,
            description: 'ISO 时间；不给就是今天零点起',
          },
        ],
        returns: 'ModelUsageView',
      },
      async (c, deps) => {
        const since = c.req.query('since')
        return ok(
          c,
          await portOf(deps).usage(actorOf(c), ...(since === undefined ? [] : ([since] as const))),
        )
      },
    ),
    route(
      {
        method: 'get',
        path: '/v1/models/pricing',
        operationId: 'getModelPricing',
        summary:
          '内置价目表（WP42）：各家每百万 token 的输入 / 输出 / 缓存命中价，每条带出处与日期。选定模型后表单照它自动填',
        tag: TAG,
        auth: 'bearer',
        assignment: true,
        authz: READ,
        returns: 'ModelPricingView',
      },
      async (c, deps) => ok(c, await portOf(deps).pricing(actorOf(c))),
    ),
    route(
      {
        method: 'post',
        path: '/v1/models/pricing/refresh',
        operationId: 'refreshModelPricing',
        summary:
          '去各家官网抓一次价（普通 HTTP GET，**不经模型**；出站受急停管）。抓不到就保留内置价并说清楚为什么；标了"手动"的价一条都不动',
        tag: TAG,
        auth: 'bearer',
        assignment: true,
        authz: WRITE,
        returns: 'ModelPricingRefreshResult',
      },
      async (c, deps) => ok(c, await portOf(deps).refreshPricing(actorOf(c))),
    ),
    route(
      {
        method: 'put',
        path: '/v1/models/providers/:id',
        operationId: 'saveModelProvider',
        summary:
          '原生表单直填 API key（13 §4.3）：值只走这一条到本机服务进程，写进加密库后即遗忘；不进事件日志、不进 trace、不进模型',
        tag: TAG,
        auth: 'bearer',
        assignment: true,
        authz: WRITE,
        params: [ID_PARAM],
        body: SaveBody,
        returns: 'ModelProviderView（无 key）',
      },
      async (c, deps) => {
        const input = await body(c, SaveBody)
        // 处理器只把值往下传一次，自己不读、不记、不回显。
        return ok(c, await portOf(deps).save(actorOf(c), param(c, 'id'), input))
      },
    ),
    route(
      {
        method: 'post',
        path: '/v1/models/providers/:id/test',
        operationId: 'testModelProvider',
        summary:
          '验证三步（WP127）：连通 → 一次最小文字请求 → 一次带图的最小请求（purpose=judge）；看不了图的不通过（reason=no_vision）。回延迟、模型名与三步结果，不回 key',
        tag: TAG,
        auth: 'bearer',
        assignment: true,
        authz: WRITE,
        params: [ID_PARAM],
        returns:
          'ModelTestResult（WP127：steps = 连通 / 文字 / 看图三步各自 ok；vision = 能不能看图，它就是这条 provider 的 capabilities.vision 声明的来源）',
      },
      async (c, deps) => ok(c, await portOf(deps).test(actorOf(c), param(c, 'id'))),
    ),
    route(
      {
        method: 'get',
        path: '/v1/models/image',
        operationId: 'getModelImage',
        summary:
          '生图那一档（WP127）：配了没有、用哪条、官方接口一张图多少积分（常显）、能选哪几条',
        tag: TAG,
        auth: 'bearer',
        assignment: true,
        authz: READ,
        returns: 'ModelImageView',
      },
      async (c, deps) => {
        const port = portOf(deps)
        if (port.image === undefined)
          throw new ApiError('not_implemented', '这个服务进程没有装配生图设置')
        return ok(c, await port.image(actorOf(c)))
      },
    ),
    route(
      {
        method: 'put',
        path: '/v1/models/image',
        operationId: 'setModelImage',
        summary:
          '改生图那一档（WP127）：选一条已配的 provider 与生图模型，或给空串不配；保存即生效',
        tag: TAG,
        auth: 'bearer',
        assignment: true,
        authz: WRITE,
        body: ImageBody,
        returns: 'ModelImageView',
      },
      async (c, deps) => {
        const port = portOf(deps)
        if (port.setImage === undefined)
          throw new ApiError('not_implemented', '这个服务进程没有装配生图设置')
        const input = await body(c, ImageBody)
        return ok(c, await port.setImage(actorOf(c), input))
      },
    ),
    route(
      {
        method: 'post',
        path: '/v1/models/providers/:id/discover',
        operationId: 'discoverModelProviderModels',
        summary:
          '去这家的 /models 拉一次可用模型清单（WP42）：设置页的"模型名"因此是一个下拉而不是手填；拉不到回 ok=false + 一句人话',
        tag: TAG,
        auth: 'bearer',
        assignment: true,
        authz: WRITE,
        params: [ID_PARAM],
        body: DiscoverBody,
        returns: 'ModelListing',
      },
      async (c, deps) => {
        const input = await body(c, DiscoverBody)
        // 和保存那条路同一条纪律：`api_key` 往下传一次，自己不读、不记、不回显。
        return ok(c, await portOf(deps).discover(actorOf(c), param(c, 'id'), input))
      },
    ),
    route(
      {
        method: 'delete',
        path: '/v1/models/providers/:id',
        operationId: 'removeModelProvider',
        summary: '删掉一个 provider（key 随之从加密库删除）',
        tag: TAG,
        auth: 'bearer',
        assignment: true,
        authz: WRITE,
        params: [ID_PARAM],
        returns: '{ removed: true }',
      },
      async (c, deps) => {
        await portOf(deps).remove(actorOf(c), param(c, 'id'))
        return ok(c, { removed: true })
      },
    ),
    /*
     * WP90（55 §9 Q8）：订阅登录五条路。
     *
     * 路径挂在 `/v1/settings/models/subscription` 下而不是 `/v1/models/…`：
     * 这是**设置页上的一件事**（这台机器上这个人登了谁的账号），不是"这个工作区
     * 配了哪些模型 provider"——它按人、按机器，不按工作区。与 `/v1/settings/browser`
     * （WP82，同样是一台机器一份）摆在一起。
     *
     * 权限照模型面那一套：读 `store_config.read`，改 `policy.stage`。
     */
    route(
      {
        method: 'get',
        path: '/v1/settings/models/subscription',
        operationId: 'listModelSubscriptions',
        summary:
          '用 ChatGPT / Claude 的订阅登录现在什么样（**永不含 token**：只有登没登录、账号脱敏后的样子、到期时间）。公司档 / 托管档上 available=false 并带一句人话',
        tag: TAG,
        auth: 'bearer',
        assignment: true,
        authz: READ,
        returns: '{ providers: SubscriptionView[] }',
      },
      async (c, deps) => {
        const port = portOf(deps)
        if (port.subscriptions === undefined) return ok(c, { providers: [] })
        return ok(c, { providers: await port.subscriptions(actorOf(c)) })
      },
    ),
    route(
      {
        method: 'post',
        path: '/v1/settings/models/subscription/login',
        operationId: 'startModelSubscriptionLogin',
        summary:
          '起一次订阅登录（设备码或浏览器）：回来时带着"去这个网址、输这串码"，界面据此轮询状态。**只在个人档**，公司档 403',
        tag: TAG,
        auth: 'bearer',
        assignment: true,
        authz: WRITE,
        body: SubscriptionLoginBody,
        returns: 'SubscriptionView',
      },
      async (c, deps) => {
        const port = subscriptionPortOf(deps)
        const input = await body(c, SubscriptionLoginBody)
        return ok(c, await port.subscriptionLogin?.(actorOf(c), input))
      },
    ),
    route(
      {
        method: 'get',
        path: '/v1/settings/models/subscription/:provider',
        operationId: 'getModelSubscription',
        summary: '这一家订阅登录现在什么样（界面登录途中轮询它）',
        tag: TAG,
        auth: 'bearer',
        assignment: true,
        authz: READ,
        params: [PROVIDER_PARAM],
        returns: 'SubscriptionView',
      },
      async (c, deps) => {
        const port = subscriptionPortOf(deps)
        return ok(c, await port.subscription?.(actorOf(c), param(c, 'provider')))
      },
    ),
    route(
      {
        method: 'post',
        path: '/v1/settings/models/subscription/:provider/answer',
        operationId: 'answerModelSubscriptionLogin',
        summary:
          '回答登录途中的那个问题（把浏览器里的授权码贴回来）。值只走这一次，不落盘、不进事件、不回显',
        tag: TAG,
        auth: 'bearer',
        assignment: true,
        authz: WRITE,
        params: [PROVIDER_PARAM],
        body: SubscriptionAnswerBody,
        returns: 'SubscriptionView',
      },
      async (c, deps) => {
        const port = subscriptionPortOf(deps)
        const input = await body(c, SubscriptionAnswerBody)
        return ok(c, await port.subscriptionAnswer?.(actorOf(c), param(c, 'provider'), input.value))
      },
    ),
    route(
      {
        method: 'put',
        path: '/v1/settings/models/subscription/:provider/model',
        operationId: 'selectModelSubscriptionModel',
        summary: '选这一家用哪个模型（清单来自 pi-ai 的目录；价目一律显示"订阅"）',
        tag: TAG,
        auth: 'bearer',
        assignment: true,
        authz: WRITE,
        params: [PROVIDER_PARAM],
        body: SubscriptionModelBody,
        returns: 'SubscriptionView',
      },
      async (c, deps) => {
        const port = subscriptionPortOf(deps)
        const input = await body(c, SubscriptionModelBody)
        return ok(
          c,
          await port.subscriptionSelectModel?.(actorOf(c), param(c, 'provider'), input.model),
        )
      },
    ),
    route(
      {
        method: 'delete',
        path: '/v1/settings/models/subscription/:provider',
        operationId: 'signOutModelSubscription',
        summary: '登出：把本机那条授权记录销毁（下一次运行就连不上了，这正是本意）',
        tag: TAG,
        auth: 'bearer',
        assignment: true,
        authz: WRITE,
        params: [PROVIDER_PARAM],
        returns: '{ signed_out: true }',
      },
      async (c, deps) => {
        const port = subscriptionPortOf(deps)
        await port.subscriptionSignOut?.(actorOf(c), param(c, 'provider'))
        return ok(c, { signed_out: true })
      },
    ),
    /*
     * WP134：用我的 DeepSeek 账号登录。`/v1/settings/models/deepseek-account` 与上面的
     * `subscription` 是同级的另一个定值段，撞不上；`login` / `cancel` 是它下面的定值段。
     * 回调**不在这里**：官方模块在服务进程的现有端口上注册 `/oauth/callback`，由它自己校验
     * state + PKCE（不走 bearer，浏览器那一跳没有我们的会话）。
     */
    route(
      {
        method: 'get',
        path: '/v1/settings/models/deepseek-account',
        operationId: 'getDeepSeekAccount',
        summary:
          '「用我的 DeepSeek 账号登录」现在什么样（**永不含令牌**：只有登录了没有、账号名、余额；登录途中带授权页地址）',
        tag: TAG,
        auth: 'bearer',
        assignment: true,
        authz: READ,
        returns: 'DeepSeekAccountView',
      },
      async (c, deps) => ok(c, await deepseekAccountPortOf(deps).deepseekAccount?.(actorOf(c))),
    ),
    route(
      {
        method: 'post',
        path: '/v1/settings/models/deepseek-account/login',
        operationId: 'startDeepSeekAccountLogin',
        summary:
          '选中这条路并起一次登录（dsh 官方模块，系统浏览器 PKCE）：回来时带授权页地址，界面交给系统浏览器打开、再轮询状态。只在本机档',
        tag: TAG,
        auth: 'bearer',
        assignment: true,
        authz: WRITE,
        returns: 'DeepSeekAccountView',
      },
      async (c, deps) =>
        ok(c, await deepseekAccountPortOf(deps).deepseekAccountLogin?.(actorOf(c))),
    ),
    route(
      {
        method: 'post',
        path: '/v1/settings/models/deepseek-account/cancel',
        operationId: 'cancelDeepSeekAccountLogin',
        summary: '取消正在跑的那一次登录（只取消这一次；迟到的浏览器回调不会再把人登进去）',
        tag: TAG,
        auth: 'bearer',
        assignment: true,
        authz: WRITE,
        body: DeepSeekCancelBody,
        returns: 'DeepSeekAccountView',
      },
      async (c, deps) => {
        const port = deepseekAccountPortOf(deps)
        const input = await body(c, DeepSeekCancelBody)
        return ok(c, await port.deepseekAccountCancel?.(actorOf(c), input.attempt_id))
      },
    ),
    route(
      {
        method: 'delete',
        path: '/v1/settings/models/deepseek-account',
        operationId: 'signOutDeepSeekAccount',
        summary:
          '登出：有运行正在用这个账号跑就先停掉它们（WP150，界面先确认），再由官方先删本机凭据、后台调平台 logout；这条模型来源随之摘掉，官方模块关掉',
        tag: TAG,
        auth: 'bearer',
        assignment: true,
        authz: WRITE,
        returns: '{ signed_out: true }',
      },
      async (c, deps) => {
        await deepseekAccountPortOf(deps).deepseekAccountSignOut?.(actorOf(c))
        return ok(c, { signed_out: true })
      },
    ),
  ]
}
