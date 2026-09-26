/**
 * 模型面的装配（WP25 交付 C）。
 *
 * 一句话职责：把「本机加密秘密库里的 API key + 一份 JSON 配置」装配成 22 的模型网关，
 * 并且**保存即生效**——改完设置下一次 `complete` 就走新 provider，不用重启进程。
 *
 * 为什么非做不可：在这之前，这台机器上有没有模型只看一个环境变量
 * （`DEEPSEEK_API_KEY`）。没设就是 stub 运行时——工作台看着一切正常，Agent 却一句
 * 人话都说不出来，而界面上没有任何地方能让用户把 key 填进去。
 *
 * 四条纪律（22 §5 + 13 §4.3）：
 *
 * 1. **key 只在网关**。业务代码拿到的是装配好的 `ModelProvider`；key 的值只在
 *    `openaiCompatibleProvider` 的 `apiKey()` 回调里出现一次，直接进 `Authorization` 头。
 *    它不进 `process.env`、不进配置对象、不进事件、不进响应体。
 * 2. **配置与凭据分开落盘**：非秘密的（base_url / 模型名 / 价格 / 预算）进
 *    `models.json`，key 进 `secrets.sqlite` 的 `model_provider:` 前缀（AES-256-GCM，
 *    与邮箱口令同一个库、不同前缀）。
 * 3. **热更新不清账**：换 provider 走网关的 `reconfigure`，预算已花额度与 usage
 *    记录原样留着（重建一个网关等于把今天花的钱清零，三级预算当场失效）。
 * 4. 时间经注入的 `Clock`；没有一处 `Date.now()` / `Math.random()` 裸调。
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import type {
  DiscoverModelsInput,
  ModelDefaultsView,
  ModelImageView,
  ModelListing,
  ModelPricingRefreshResult,
  ModelPricingVendorView,
  ModelPricingView,
  ModelProviderKind,
  ModelProviderTemplate,
  ModelProviderView,
  ModelsActor,
  ModelsPort,
  ModelTestResult,
  ModelUsageRow,
  ModelUsageView,
  ModelVisionStatus,
  SaveModelProviderInput,
  SetModelDefaultsInput,
  SetModelImageInput,
} from '@agentsws/api'
import type {
  Clock,
  EventEnvelope,
  Halt,
  ModelProvider,
  ModelPurpose,
  ModelRef,
} from '@agentsws/contracts'
import {
  CLOUD_BASE_URL_ENV,
  cloudBaseUrl,
  DEFAULT_CLOUD_BASE_URL,
  NO_VISION_REASON,
  VISION_MODEL_EXAMPLES,
} from '@agentsws/contracts'
import { buildPricing, creditsFor } from '@agentsws/metering'
import type {
  AccountFetch,
  CatalogPrice,
  FetchLike,
  ModelGatewayApi,
  ModelGatewayPolicy,
  PageFetch,
} from '@agentsws/model-gateway'
import {
  catalogModels,
  checkModel,
  DEEPSEEK_ACCOUNT_BASE_URL,
  DEEPSEEK_ACCOUNT_DEFAULT_MODEL,
  DEEPSEEK_ACCOUNT_MODELS,
  DeepSeekFileStore,
  deepseekAccountProvider,
  deepseekMessagesProvider,
  hostOf,
  jsonFileUploadIndex,
  NO_IMAGE_MODEL_ZH,
  openaiCompatibleProvider,
  openaiImageProvider,
  PRICE_CATALOG,
  refreshPriceCatalog,
  stubProvider,
  vendorForBaseUrl,
} from '@agentsws/model-gateway'
import type { SecretStore } from './secret-store.js'
import { SECRETS_KEY_ENV } from './secret-store.js'

/** 秘密库里模型 key 的前缀（和连接 id、Shopify 应用凭据分开）。 */
export const MODEL_KEY_PREFIX = 'model_provider:'

/** 无界面时的兜底：这个环境变量还认（`scripts/dev-real.sh` / CI 靠它）。 */
export const DEEPSEEK_KEY_ENV = 'DEEPSEEK_API_KEY'

/**
 * WP143：「DeepSeek 官方」API key 那一路改走 **Messages 口**的开关——**默认关**，设成 `1` 才开。
 *
 * 官方适配器 `dsh-llm-deepseek` 0.1.7 起只用 Messages（API key 走 `x-api-key`），改过去就能一起用上
 * Files 复用与思考块原样回传。没默认打开的原因写在 WP143 报告里（没法离线核的几件事：真 key 下
 * 模型名、看图、计费口径），等 Luoye 用真 key 跑一遍三步验证再定。开了也**只动 DeepSeek 官方这一家**，
 * 且只认官方地址（`https://api.deepseek.com`）——改过地址的（代理 / 中转）照旧走 OpenAI 兼容口。
 */
export const DEEPSEEK_MESSAGES_ENV = 'AGENTSWS_DEEPSEEK_MESSAGES'

/** WP143：这一条 DeepSeek 官方配置要不要走 Messages 口（开关开了 + 官方地址）。 */
export function deepseekUsesMessages(
  config: { kind: string; base_url: string },
  env: Record<string, string | undefined>,
): boolean {
  if (config.kind !== 'deepseek' || env[DEEPSEEK_MESSAGES_ENV]?.trim() !== '1') return false
  try {
    const url = new URL(config.base_url)
    return (
      url.origin === 'https://api.deepseek.com' &&
      ['', '/', '/v1', '/v1/'].includes(url.pathname) &&
      url.search === ''
    )
  } catch {
    return false
  }
}

/**
 * 49 M2「用 agentsws 的」那条 provider 的凭据在秘密库里叫什么。
 *
 * **不是 `model_provider:` 前缀**：它不是用户填的模型 key，而是 WP58 那把工作区服务
 * 令牌——关联一次账号就有，撤销账号关联它就没了。一把令牌服务全部云上能力（模型、
 * 红人库、社媒配额、值守），所以它属于账号那一面，不属于模型那一面。
 */
export const CLOUD_TOKEN_SECRET_ID = 'cloud.workspace_token'

/**
 * 云侧地址；自建 / 联调时用环境变量指到别处（`bin/dev.mjs` 就起在 4401）。
 * 常量本身在 `@agentsws/contracts`（WP110 收成一处），这里只转出去。
 */
export { CLOUD_BASE_URL_ENV, DEFAULT_CLOUD_BASE_URL }

/** `…/v1/ai`：服务入口的 OpenAI 兼容口（49 M3）。 */
export function cloudAiBaseUrl(env: Record<string, string | undefined>): string {
  return `${cloudBaseUrl(env)}/v1/ai`
}

/** 环境变量兜底出来的那条 provider 的固定 id。 */
export const ENV_PROVIDER_ID = 'deepseek'

/**
 * WP150：系统自己摘 DeepSeek 账号那一条时用的身份（登录失效那一下没有"人"在点）。
 * `remove` 不看 actor（模型面按机器 / 品牌，不按人），这里只是让签名成立。
 */
const DROP_ACTOR: ModelsActor = {
  workspace_id: 'system',
  person_id: 'system',
  assignment_id: 'system',
  role_id: 'system',
}

/** stub provider 的 ref——一个模型都没配时，运行时落回它（确定性、不花钱）。 */
export const STUB_REF: ModelRef = { provider: 'stub', model: 'stub-v1', region: 'cn' }

const STUB_PRICES = { 'stub/stub-v1': { in: 0, out: 0, cached: 0 } }

/**
 * WP127：生图那一档没指定模型名时用哪个。OpenAI 与 Agents 工坊官方接口（背后是汇聚网关）
 * 都认这个名字；别家的兼容口换成它自己的生图模型名即可（设置页那一格可改）。
 */
export const DEFAULT_IMAGE_MODEL = 'gpt-image-1'

/** 能挂生图的 provider 种类：OpenAI 兼容口与官方接口。DeepSeek 没有生图口，订阅登录也没有。 */
const IMAGE_CAPABLE_KINDS: readonly ModelProviderKind[] = ['openai_compatible', 'agentsws_cloud']

/**
 * WP127：验证没过、卡在"看不了图"时那句人话。**只列公开型号名，不是推荐**——
 * 真能不能看以验证为准。
 */
export function noVisionMessage(): string {
  return `这个模型看不了图，Agents 工坊要求模型能看图。换一个能看图的模型再测，常见的有：${VISION_MODEL_EXAMPLES.join('、')}。`
}

/** 一条 provider 的**非秘密**配置。key 不在这里，在加密库里。 */
export interface ModelProviderConfig {
  id: string
  kind: ModelProviderKind
  label: string
  base_url: string
  model: string
  embedding_model?: string
  transcription_model?: string
  region: 'cn' | 'global'
  price_in?: number
  price_out?: number
  price_cached?: number
  /** WP42：这三个价从哪来。`manual` 的每周刷新一条都不动。 */
  price_source?: 'catalog' | 'manual'
  price_currency?: string
  price_source_url?: string
  price_as_of?: string
  /** WP42：上次从 `/models` 拉回来的清单（下拉框照它画，按 purpose 选也从它里面挑）。 */
  models?: string[]
  /** WP42：上次拉清单通没通（拉不到时界面退回手填，并把原因原样显示出来）。 */
  last_listing?: ModelListing
}

/**
 * WP42：上次从官网抓回来的价，盖在内置价目表上面。
 *
 * 为什么是"盖"而不是"改 catalog.json"：那是包里的文件，改它等于让一台机器上跑出来的
 * 结果依赖它自己的安装目录被写过没有。抓回来的东西落在工作区的 `models.json` 里，
 * 内置价永远是那个能回退的底。
 */
interface PricingOverlayVendor {
  at: string
  ok: boolean
  models: number
  reason?: string
  prices?: Record<string, CatalogPrice>
}

interface PricingOverlay {
  refreshed_at: string
  vendors: Record<string, PricingOverlayVendor>
}

interface ModelsStateFile {
  version: 1
  providers: ModelProviderConfig[]
  /** WP42：上次抓回来的价。 */
  pricing?: PricingOverlay
  defaults: {
    default?: string
    by_purpose?: Partial<Record<ModelPurpose, string>>
    /**
     * WP127：生图那一档（单独设置，可以不配）。放在 `defaults` 里而不是另起一格：
     * 52 O3「跟随公司默认」与 O4「从某个品牌复制」复制的就是这一份决定，生图也该跟着走。
     */
    image?: { provider_id: string; model: string }
    data_residency?: 'cn' | 'any'
    budget?: {
      workspace_daily_base?: number
      workspace_monthly_base?: number
      assignment_daily_base?: number
    }
  }
  /** provider id → 上次测试结果（只有 ok / 延迟 / 模型名，没有 key 线索）。 */
  tests: Record<string, ModelTestResult>
}

/** 拉一次模型清单最多等多久。本机 Ollama 冷启动慢，10 秒够了；卡住不该拖着界面。 */
export const DISCOVER_TIMEOUT_MS = 10_000

export interface ModelsOptions {
  clock: Clock
  /** 网关。装配好之后由本模块 `reconfigure`。 */
  gateway: ModelGatewayApi
  /** 与连接凭据同一个加密库、不同 key 前缀。 */
  secrets: SecretStore
  env: Record<string, string | undefined>
  /** `models.json` 的目录；不给就全内存（测试与一次性任务）。 */
  dbDir?: string
  /** 试跑用的 fetch（测试注入 fixture，不联网）。 */
  fetch?: FetchLike
  /** WP42：抓价目页用的 fetch（测试回放固定页面，不联网）。 */
  pageFetch?: PageFetch
  /** 28 §1 急停：`outbound` 档打开时不去抓官网。 */
  halt?: Halt
  /** 抓完记一条 `pricing.refreshed`（只有条数与来源）。 */
  appendEvent?: (e: Omit<EventEnvelope, 'id' | 'at'> & { at?: string }) => void
  /** 记事件要写在哪个工作区。取值函数——身份装在模型面之后。 */
  workspace_id?: () => string | undefined
  /**
   * WP134：「用我的 DeepSeek 账号登录」那一路。**只有两样**：登录了没有（同步）与官方
   * `resolveToken`（每次请求现取）。不给 = 这个进程没装这条路，那种 provider 永远挂不上。
   */
  deepseekAccount?: {
    signedIn(): boolean
    resolveToken(url: string): Promise<string | undefined>
    /** WP150：推理口 401 时把那一次的令牌报回官方（官方判断要不要清登录）。 */
    rejectToken?(token: string): Promise<void>
    /** 测试 / demo 注入的 Messages 口替身（不联网）。 */
    fetch?: AccountFetch
  }
}

/**
 * WP66（52 O4「从某个品牌复制设置」）：一份**不含任何 key** 的模型设置快照。
 *
 * 复制的是"我用哪家、哪个模型、哪个当默认、预算多少"这些**决定**；
 * key 一个字节都不带——加密库里那一条是按品牌存的，复制一把过去等于把一条凭据
 * 悄悄多放一处（13 §4.3）。复制出来的那几条在新品牌里显示"还没填 key"。
 */
export interface ModelSettingsSnapshot {
  providers: ModelProviderConfig[]
  defaults: ModelsStateFile['defaults']
}

export interface ModelsAssembly {
  port: ModelsPort
  /** 这台机器上有没有能用的模型（运行时与首页黄条问它，不再看环境变量）。 */
  configured(): boolean
  /** 现在生效的默认模型（运行时组 `RunRequest.runtime.model` 用）。 */
  defaultRef(): ModelRef
  /**
   * WP127：现在生效的默认模型能不能看图（按上一次验证）。需要看图的动作据此明说
   * 「当前模型看不了图」——不阻塞岗位，只是那一步如实说。
   */
  visionStatus(): ModelVisionStatus
  /** WP66：端一份可复制的设置快照（**没有 key**）。 */
  exportSettings(): ModelSettingsSnapshot
  /**
   * WP66：把一份快照写进来（52 O4 建品牌时的"从某个品牌复制"）。
   *
   * **只往空的里写**：已经配过 provider 的品牌一条都不动，回 0——
   * 复制是建品牌那一刻的一次性动作，不是同步（52 §3「不做品牌间的自动同步」）。
   * 返回真的写进去几条。
   */
  importSettings(snapshot: ModelSettingsSnapshot): number
  /**
   * WP134：DeepSeek 账号登录 / 登出之后调一次——那条 provider 能不能挂上变了，网关要重装。
   */
  accountChanged(): void
  /**
   * WP150：某个 purpose 的模型请求现在会落到哪条来源（按 purpose 覆盖过就是覆盖那条，否则默认那条）。
   * 运行时开跑时记一次，登出 DeepSeek 账号前据此认出"哪几件事正在用这个账号跑"。
   */
  purposeRef(purpose: ModelPurpose): ModelRef
  /**
   * WP150：把「用我的 DeepSeek 账号登录」那一条模型来源摘掉（手动登出与登录失效**同一条路**：
   * 同 `port.remove`——配置、默认、按 purpose 的选择、三步验证结果一起清，网关重装），
   * 并在这个品牌的事件日志里记一条 `model.account_signed_out`（界面据此刷新「还没接模型」与那张卡）。
   * 这个品牌没有那一条就什么都不做、回 `false`。
   */
  dropAccountProvider(reason: 'signed_out' | 'expired'): boolean
}

// ── 可以新建哪几种 ─────────────────────────────────────────────────────

/**
 * 阿里云百炼的 OpenAI 兼容口（WP88）。
 *
 * 北京地域这条是官方「获取 API Key」页上写的那条
 * （<https://help.aliyun.com/zh/model-studio/get-api-key>，2026-09-17 核实）。
 * 官方现在**另外**推荐一条按业务空间分的地址
 * （`https://{WorkspaceId}.cn-beijing.maas.aliyuncs.com/compatible-mode/v1`，
 * 说是更快更稳），但它要用户先去控制台抄一个 WorkspaceId 出来——一键设置里不该有
 * 这一步。所以默认填这条老地址（官方明说仍然可用），要用新地址的人自己改一个字段，
 * 价目表的 `hosts` 里也把 `maas.aliyuncs.com` 一并认了。
 */
export const BAILIAN_CN_BASE_URL = 'https://dashscope.aliyuncs.com/compatible-mode/v1'

/** 国际站（新加坡）。同样是官方仍在用的老地址，新形态是 `{WorkspaceId}.ap-southeast-1.maas.aliyuncs.com`。 */
export const BAILIAN_INTL_BASE_URL = 'https://dashscope-intl.aliyuncs.com/compatible-mode/v1'

/**
 * 默认挑 `qwen-vl-plus`：WP127 之后文字模型必须能看图（Luoye 09-23 定），所以默认给多模态那一档；
 * 纯文字的 `qwen-plus` / `qwen-turbo` 仍在下拉里但过不了第三步验证。**单价待核对**（原 `qwen-plus` 的价是核实过的，这条不是）。
 */
export const BAILIAN_DEFAULT_MODEL = 'qwen-vl-plus'

/**
 * 百炼的两个**订阅**产品的专属口（WP88）。
 *
 * 百炼一共三套东西，**key 与 base URL 官方明说完全隔离、必须配对使用**，混用要么
 * 认证失败、要么"产生意料之外的扣费"：
 *
 * | 档 | base URL | key | 怎么扣 |
 * |---|---|---|---|
 * | 按量计费 | `dashscope.aliyuncs.com/compatible-mode/v1` | `sk-` | 按 token |
 * | Token Plan（订阅） | `token-plan.cn-beijing.maas.aliyuncs.com/compatible-mode/v1` | `sk-sp-` | 按 Credits |
 * | Coding Plan（订阅） | `coding.dashscope.aliyuncs.com/v1` | `sk-sp-` | 按次数配额 |
 *
 * **Luoye 实测**（2026-09-17）：手上那把 Token Plan 的 key（`sk-sp-` 开头、114 字符）
 * 打标准口，国内国际都回 `401 invalid_api_key`。
 *
 * 所以界面上必须是**三张卡**，不是一张卡上的三个预设——把"选错了要么打不通要么乱
 * 扣钱"这件事留给用户自己避，是把最难的一步推给了最不该承担它的人。
 *
 * 两个订阅档在价目表里三个价都是 0：`cost_base` 记 0、token 照记。剩多少 Credits /
 * 配额只有百炼控制台算得出来，我们这边算不出也不编。
 *
 * 出处：<https://help.aliyun.com/zh/model-studio/token-plan-personal-quick-start>、
 * <https://help.aliyun.com/zh/model-studio/coding-plan>（均 2026-09-17 核实）。
 */
export const BAILIAN_TOKEN_PLAN_BASE_URL =
  'https://token-plan.cn-beijing.maas.aliyuncs.com/compatible-mode/v1'

/**
 * Token Plan 的默认模型。清单以它自己的 `/models` 为准；`qwen3.7-plus` 是
 * Luoye 控制台里那份可用模型中通用向最稳的一档（官方文档没有一页把 ID 列全）。
 */
export const BAILIAN_TOKEN_PLAN_DEFAULT_MODEL = 'qwen3.7-plus'

/** Coding Plan 的口。注意**没有** `/compatible-mode` 这一段。 */
export const BAILIAN_CODING_BASE_URL = 'https://coding.dashscope.aliyuncs.com/v1'

/** Coding Plan 的国际口（FAQ 页列的那条）。Token Plan 没有国际口——官方只支持华北2。 */
export const BAILIAN_CODING_INTL_BASE_URL = 'https://coding-intl.dashscope.aliyuncs.com/v1'

/**
 * Coding Plan 档的默认模型：官网「推荐模型」里排第一的 `qwen3.7-plus`。
 * 这一档里还有 `qwen3-coder-plus` / `qwen3-max-2026-01-23` / `kimi-k2.5` / `glm-5` 等，
 * 从它自己的 `GET /v1/models` 拉出来在下拉里选。
 */
export const BAILIAN_CODING_DEFAULT_MODEL = 'qwen3.7-plus'

/**
 * v1 只做两种：**DeepSeek 官方** + **OpenAI 兼容自定义**（WP88 起，后者出四张卡：
 * 通用的那张 + 百炼按量 + 百炼 Token Plan + 百炼 Coding Plan）。
 *
 * 后者一种形态覆盖一大片：OpenAI 本身、Moonshot（Kimi）、通义千问、智谱 GLM、
 * 硅基流动、以及本地跑的 Ollama / vLLM——它们的 `/chat/completions` 是同一个形状，
 * 差别只在地址和模型名。所以给一组预设点一下就填好，而不是每家写一张卡。
 */

/**
 * WP90（Luoye 定）：**同一家厂商 / 渠道的几个方案合成一张卡**，点进去再选方案。
 *
 * WP88 把百炼做成了三张并排的卡（按量 / Token Plan / Coding Plan）。三张卡各自
 * 讲得都对，但摆在一起的第一眼问题是"这三张有什么区别"——而那恰恰是用户还不
 * 知道的事。合成一张之后，第一眼变成"阿里云百炼"，第二眼才是"你买的是哪个方案"，
 * 那是个他答得上来的问题。
 *
 * **三套逻辑一行没改**：地址、key 形态、说明、计费方式还是各是各的，
 * 只是从三张卡收进一张卡的三个单选。已经填好的配置也一条不动——保存的是
 * provider 配置（`models.json` + 加密库），与卡怎么画无关。
 */
const BAILIAN_VENDOR = {
  vendor: 'bailian',
  vendor_label: '阿里云百炼',
  vendor_summary:
    '一把 key 同时调通义千问与 DeepSeek，账单也在一处。先选你买的是哪个方案——三个方案的地址与 key 互不通用，选错要么打不通要么乱扣钱。',
} as const

/** WP90：订阅登录那两张卡的接口地址（只是给卡一个稳定的身份，不真的往这儿发请求）。 */
export const CHATGPT_SUBSCRIPTION_URL = 'https://chatgpt.com'
export const CLAUDE_SUBSCRIPTION_URL = 'https://claude.ai'

/**
 * Anthropic 自己的 **OpenAI 兼容口**（`https://api.anthropic.com/v1/`）。
 *
 * 官方给的是"把 OpenAI SDK 的 base_url 指到这里、把 key 换成 Anthropic 的"那一层
 * 兼容层，所以形态仍是 `openai_compatible`，复用同一套 provider 实现。
 */
export const ANTHROPIC_OPENAI_COMPAT_URL = 'https://api.anthropic.com/v1'

const OPENAI_VENDOR = {
  vendor: 'openai',
  vendor_label: 'OpenAI / ChatGPT',
  vendor_summary:
    '两条路：用你已经在付的 ChatGPT 订阅登录，或者去 platform.openai.com 建一把 API key 按量付费。',
} as const

const ANTHROPIC_VENDOR = {
  vendor: 'anthropic',
  vendor_label: 'Anthropic / Claude',
  vendor_summary:
    '两条路：用你已经在付的 Claude 订阅登录，或者去 console.anthropic.com 建一把 API key 按量付费。',
} as const

/**
 * WP152（Luoye 09-26）：**DeepSeek 两种连法合成一张卡**「DeepSeek 官方」，卡里二选一：
 * 「官方账户登录」（排第一、默认选中：不用建 key）与「官方 API 接口连接」（去开放平台建 key）。
 *
 * 只动展示名与分组：provider id（`deepseek` / `deepseek-account`）、kind、存储、接口、计费一律不变。
 * 已配的那几条的显示名走 {@link providerDisplayLabel}（老数据里存的旧名字照样认）。
 */
export const DEEPSEEK_CARD_LABEL = 'DeepSeek 官方'
export const DEEPSEEK_API_PLAN_LABEL = '官方 API 接口连接'
export const DEEPSEEK_ACCOUNT_PLAN_LABEL = '官方账户登录'
export const DEEPSEEK_API_LABEL = `${DEEPSEEK_CARD_LABEL} · ${DEEPSEEK_API_PLAN_LABEL}`
export const DEEPSEEK_ACCOUNT_LABEL = `${DEEPSEEK_CARD_LABEL} · ${DEEPSEEK_ACCOUNT_PLAN_LABEL}`

const DEEPSEEK_VENDOR = {
  vendor: 'deepseek',
  vendor_label: DEEPSEEK_CARD_LABEL,
  vendor_summary:
    '国内直连、便宜、够用，没别的偏好就选它。两种连法：用 DeepSeek 账号登录（不用建 key），或者去开放平台建一把 API key。',
} as const

/**
 * 这些是 WP152 之前存下来的默认名字（老用户的 `models.json` 里原样留着，不改存储）。
 * 显示时换成新叫法；用户自己改过的名字（比如「我的 DeepSeek 代理」）原样显示。
 */
const DEEPSEEK_API_LEGACY_LABELS: ReadonlySet<string> = new Set([
  'DeepSeek 官方',
  'DeepSeek 官方（环境变量）',
  DEEPSEEK_API_LABEL,
])

/**
 * WP152：一条已配的模型来源在界面上叫什么（「已配的」列表与「哪件事用哪个模型」的下拉同一个名字）。
 *
 * - 账号登录那条（`deepseek_account`）：一律「DeepSeek 官方 · 官方账户登录」（它没有名字可改）；
 * - DeepSeek 官方 API key 那条：还是默认名字的 → 「DeepSeek 官方 · 官方 API 接口连接」；改过名的照旧；
 * - 其余原样。
 */
export function providerDisplayLabel(config: { kind: string; label: string }): string {
  if (config.kind === 'deepseek_account') return DEEPSEEK_ACCOUNT_LABEL
  if (config.kind === 'deepseek' && DEEPSEEK_API_LEGACY_LABELS.has(config.label.trim())) {
    return DEEPSEEK_API_LABEL
  }
  return config.label
}

export const MODEL_TEMPLATES: readonly ModelProviderTemplate[] = [
  {
    kind: 'deepseek',
    label: DEEPSEEK_API_LABEL,
    summary: '去 DeepSeek 开放平台建一把 API key 填进来，按量计费。',
    ...DEEPSEEK_VENDOR,
    // WP152：排第二（第一是「官方账户登录」——不用建 key，对非开发者最省事）
    plan_label: DEEPSEEK_API_PLAN_LABEL,
    plan_order: 2,
    auth: 'api_key',
    default_base_url: 'https://api.deepseek.com',
    default_model: 'deepseek-flash',
    region: 'cn',
    steps: [
      '打开 platform.deepseek.com，用手机号注册登录',
      '左边找到"API keys"，点"创建 API key"',
      '复制那一串（只显示一次，关掉就看不到了）',
      '粘进下面的表单，点保存',
      '点"测试"——回了模型名和延迟就是通了',
    ],
    links: [{ label: 'DeepSeek 开放平台', url: 'https://platform.deepseek.com/api_keys' }],
  },
  {
    kind: 'openai_compatible',
    label: 'OpenAI 兼容（自定义）',
    summary: '任何"OpenAI 格式"的服务都能接：Moonshot、通义千问、智谱，以及这台电脑上跑的 Ollama。',
    vendor: 'openai-compatible',
    vendor_label: 'OpenAI 兼容（自定义）',
    vendor_summary:
      '任何"OpenAI 格式"的服务都能接：Moonshot、通义千问、智谱，以及这台电脑上跑的 Ollama。',
    plan_label: '自己填地址与 key',
    plan_order: 1,
    auth: 'api_key',
    /*
     * WP90：默认地址从 `api.openai.com/v1` 改成 Moonshot。
     *
     * **不是口味问题**：OpenAI 从这一版起有了自己的卡（订阅登录 + API key 两个方案），
     * 这张"任何 OpenAI 兼容网关"的卡再默认指向 OpenAI，就变成同一家有两处能加、
     * 而且两处的"编号"建议一模一样（`templateSlug` 按接口地址认卡，撞了就等于
     * 两个方案共用一个身份）。同理，下面的预设里那条 `openai` 也去掉了——
     * 要接 OpenAI 就去 OpenAI 那张卡，那里还顺带告诉你订阅登录这条路。
     */
    default_base_url: 'https://api.moonshot.cn/v1',
    default_model: 'moonshot-v1-8k-vision-preview',
    region: 'cn',
    steps: [
      '去你要用的那家的控制台，创建一个 API key',
      '找到它文档里写的"接口地址"（一般以 /v1 结尾）',
      '把地址、模型名、key 填进下面的表单',
      '境外的服务把"数据驻留"选 global，境内的选 cn',
      '点"测试"确认能通',
    ],
    links: [
      { label: 'Moonshot（Kimi）', url: 'https://platform.moonshot.cn' },
      { label: '通义千问（DashScope）', url: 'https://help.aliyun.com/zh/model-studio/' },
      { label: '智谱 GLM', url: 'https://open.bigmodel.cn' },
      { label: 'Ollama（本地跑）', url: 'https://ollama.com' },
    ],
    presets: [
      {
        id: 'moonshot',
        label: 'Moonshot / Kimi',
        base_url: 'https://api.moonshot.cn/v1',
        model: 'moonshot-v1-8k-vision-preview',
        region: 'cn',
      },
      {
        id: 'qwen',
        label: '通义千问',
        base_url: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
        model: 'qwen-vl-plus',
        region: 'cn',
      },
      {
        id: 'zhipu',
        label: '智谱 GLM',
        base_url: 'https://open.bigmodel.cn/api/paas/v4',
        model: 'glm-4v-plus',
        region: 'cn',
      },
      {
        id: 'ollama',
        label: '本机 Ollama',
        base_url: 'http://127.0.0.1:11434/v1',
        model: 'llama3.2-vision',
        region: 'cn',
      },
    ],
  },
  /*
   * WP88：**阿里云百炼**给三张卡——「标准（按量）」「Token Plan（订阅）」「Coding Plan（订阅）」。
   *
   * 上面那张「OpenAI 兼容（自定义）」的预设里本来就有一条「通义千问」，为什么还要
   * 单开？因为那条预设只解决"地址填什么"，而百炼真正会卡住人的是另外几件事：
   *
   * 1. **一把 key 同时能调两家**：通义（qwen-*）与 DeepSeek（deepseek-*）在百炼上是
   *    同一个接口地址、同一把 key、同一份账单。用过 DeepSeek 官方的人会以为要再
   *    去 platform.deepseek.com 办一把——不用。这件事只有卡上写出来才知道。
   * 2. **国内 / 国际两个地址**，选错了 key 不通（两边的 key 也不通用），而"数据归属"
   *    也跟着变：北京那条是 `cn`，新加坡那条是 `global`（22 §2 的 `data_residency`
   *    在 `cn` 时会直接拦下 `global` 的 provider）。
   * 3. **按量与两个订阅档是三套互不通用的东西**（后两张卡）：地址不同、key 不同、
   *    计费方式也不同。**Luoye 实测**：Token Plan 的 key（`sk-sp-` 开头、114 字符）
   *    打标准口，国内国际都回 `401 invalid_api_key`；官方也明说混用会认证失败或
   *    产生意料之外的扣费。所以不能做成同一张卡上的几个预设——那等于把"选错要么
   *    打不通要么乱扣钱"留给用户自己避。
   * 4. **标准口没有 `GET /models`**：官方文档从头到尾只有 `/chat/completions`。点"拉取
   *    模型列表"会空手而归，于是模型名要手打——所以拉不到时退回内置价目表里那份
   *    核实过的清单（`catalogModels`），用户照旧是在下拉框里选。
   *    （两个订阅档那两条口反倒有 `/models`，正常拉就行。）
   *
   * 形态仍是 OpenAI 兼容，所以 `kind` 还是 `openai_compatible`——复用同一套 provider
   * 实现与保存路径，卡是给人看的，不是给代码分支用的。
   */
  {
    kind: 'openai_compatible',
    label: '阿里云百炼（标准，按量计费）',
    summary: '一把 key 同时调通义千问与 DeepSeek，账单也在一处，用多少算多少。',
    ...BAILIAN_VENDOR,
    plan_label: '按量计费（标准）',
    plan_order: 2,
    auth: 'api_key',
    default_base_url: BAILIAN_CN_BASE_URL,
    default_model: BAILIAN_DEFAULT_MODEL,
    region: 'cn',
    steps: [
      '打开百炼控制台 bailian.console.aliyun.com，用阿里云账号登录并开通',
      '右上角选好地域（北京 / 新加坡），进"API-KEY"页点"创建我的 API-KEY"',
      '复制那一串（`sk-` 开头），粘进下面的表单',
      '地址按地域选：国内用北京那条，海外用新加坡那条（两边的 key 不通用）',
      '选模型名 → 点"测试"，回了模型名和延迟就是通了',
    ],
    links: [
      {
        label: '百炼控制台（拿 API Key）',
        url: 'https://bailian.console.aliyun.com/?tab=model#/api-key',
      },
      { label: '模型列表与计费', url: 'https://help.aliyun.com/zh/model-studio/models' },
      {
        label: 'DeepSeek 在百炼上怎么调',
        url: 'https://help.aliyun.com/zh/model-studio/deepseek-api',
      },
    ],
    presets: [
      {
        id: 'bailian',
        label: '百炼 · 北京（国内）',
        base_url: BAILIAN_CN_BASE_URL,
        model: BAILIAN_DEFAULT_MODEL,
        region: 'cn',
      },
      {
        id: 'bailian-intl',
        label: '百炼 · 新加坡（国际站）',
        base_url: BAILIAN_INTL_BASE_URL,
        model: BAILIAN_DEFAULT_MODEL,
        region: 'global',
      },
    ],
  },
  /*
   * 百炼的订阅档之一：**Token Plan**（按 Credits 扣）。与上面那张的区别全写在
   * {@link BAILIAN_TOKEN_PLAN_BASE_URL} 的注释里，一句话：**三套东西，别混**。
   *
   * 这张卡存在的理由就是那句"别混"——把几个地址塞进同一张卡的预设里，用户点错一次
   * 就是一次 401，或者一次意料之外的扣费。
   *
   * 它**没有预设**：官方只支持华北2（北京）一个地域，只有一个地址可填；给一排按钮
   * 让人选，反而像是在暗示还有别的选择。
   */
  {
    kind: 'openai_compatible',
    label: '阿里云百炼 Token Plan（订阅）',
    summary:
      '买了 Token Plan 订阅的走这张：按 Credits 扣，不按 token 花钱。专属 key（sk-sp- 开头）配专属地址，和按量那张完全不通用。',
    ...BAILIAN_VENDOR,
    plan_label: 'Token Plan（订阅）',
    plan_order: 1,
    auth: 'api_key',
    default_base_url: BAILIAN_TOKEN_PLAN_BASE_URL,
    default_model: BAILIAN_TOKEN_PLAN_DEFAULT_MODEL,
    region: 'cn',
    steps: [
      '在百炼控制台开通 Token Plan（订阅制，按 Credits 计量）',
      '进 Token Plan 页面拿"专属 API Key"——sk-sp- 开头，和按量那把不是同一把',
      '把 key 粘进下面的表单；地址保持这张卡预填的那条（带 token-plan 的）',
      '点"拉取模型列表"，订阅里能用哪几个就会列出来，选一个',
      '点"测试"确认能通。价格三个框留 0 就对——Credits 扣的不是 token 钱',
    ],
    links: [
      {
        label: 'Token Plan 快速开始（拿专属 key 与地址）',
        url: 'https://help.aliyun.com/zh/model-studio/token-plan-personal-quick-start',
      },
      {
        label: 'Token Plan 概述与 Credits 计量',
        url: 'https://help.aliyun.com/zh/model-studio/token-plan-overview',
      },
    ],
  },
  /*
   * 百炼的订阅档之二：**Coding Plan**（按次数配额扣）。与 Token Plan 是两个独立产品，
   * 官方明说不能互转——买了哪个走哪张卡。
   */
  {
    kind: 'openai_compatible',
    label: '阿里云百炼 Coding Plan（订阅）',
    summary:
      '买了 Coding Plan 订阅的走这张：按次数配额，不按 token 花钱。key 与地址同样和别的档不通用。',
    ...BAILIAN_VENDOR,
    plan_label: 'Coding Plan（订阅）',
    plan_order: 3,
    auth: 'api_key',
    default_base_url: BAILIAN_CODING_BASE_URL,
    default_model: BAILIAN_CODING_DEFAULT_MODEL,
    region: 'cn',
    steps: [
      '在百炼控制台开通 Coding Plan（订阅制，官网写明按次数配额）',
      '进 Coding Plan 页面点"获取 API Key"——同样是 sk-sp- 开头的专属 key',
      '把 key 粘进表单；地址保持预填的那条（带 coding、没有 compatible-mode）',
      '点"拉取模型列表"，订阅里有哪几个模型就会列出来，选一个',
      '点"测试"确认能通。价格三个框留 0 就对——配额扣的不是 token 钱',
    ],
    links: [
      {
        label: 'Coding Plan 说明与配额',
        url: 'https://help.aliyun.com/zh/model-studio/coding-plan',
      },
      {
        label: '常见问题（含国际站地址）',
        url: 'https://help.aliyun.com/zh/model-studio/coding-plan-faq',
      },
    ],
    presets: [
      {
        id: 'bailian-coding',
        label: 'Coding Plan · 国内',
        base_url: BAILIAN_CODING_BASE_URL,
        model: BAILIAN_CODING_DEFAULT_MODEL,
        region: 'cn',
      },
      {
        id: 'bailian-coding-intl',
        label: 'Coding Plan · 国际站',
        base_url: BAILIAN_CODING_INTL_BASE_URL,
        model: BAILIAN_CODING_DEFAULT_MODEL,
        region: 'global',
      },
    ],
  },
  /*
   * WP90（55 §9 Q8）：**OpenAI 一张卡，两个方案**——用 ChatGPT 的订阅登录，
   * 或者填 API key 按量付费。
   *
   * 订阅那个方案排第一：很多人已经在付 ChatGPT 的钱，再买一份 API 额度是白花。
   * 但它**只在个人档**能用，而且卡上必须写明风险（见 `SUBSCRIPTION_RISK_NOTE`）——
   * 第三方工具用订阅登录没有得到 OpenAI 的明文授权。
   */
  {
    kind: 'openai-codex',
    label: '用 ChatGPT 订阅登录（Plus / Pro）',
    summary: '已经在付 ChatGPT 的钱就不用再买 API 额度：登录一次，按订阅额度跑。',
    ...OPENAI_VENDOR,
    plan_label: '用 ChatGPT 订阅登录（Plus / Pro）',
    plan_order: 1,
    auth: 'subscription',
    subscription_provider: 'openai-codex',
    default_base_url: CHATGPT_SUBSCRIPTION_URL,
    default_model: 'gpt-5.4',
    region: 'global',
    steps: [
      '确认你的 ChatGPT 账号是 Plus 或 Pro（免费档没有这条路）',
      '点下面的"用设备码登录"——会给你一个网址和一串码',
      '在手机或另一台电脑上打开那个网址，输入那串码，确认授权',
      '这一页会自己变成"已登录"，然后选一个模型',
      '要退出就点"登出"：本机那条授权记录当场销毁',
    ],
    links: [
      { label: 'ChatGPT 订阅档位', url: 'https://openai.com/chatgpt/pricing' },
      { label: 'Codex CLI（这条登录路的出处）', url: 'https://github.com/openai/codex' },
    ],
  },
  {
    kind: 'openai_compatible',
    label: 'OpenAI（API key，按量计费）',
    summary: '在 platform.openai.com 建一把 key，按 token 付费。与 ChatGPT 的订阅是两笔钱。',
    ...OPENAI_VENDOR,
    plan_label: 'API key（按量计费）',
    plan_order: 2,
    auth: 'api_key',
    default_base_url: 'https://api.openai.com/v1',
    default_model: 'gpt-4o-mini',
    region: 'global',
    steps: [
      '打开 platform.openai.com，登录后进 API keys',
      '建一把 key，复制那一串（只显示一次）',
      '粘进下面的表单，地址保持预填的那条',
      '点"拉取模型列表"选一个模型',
      '点"测试"确认能通',
    ],
    links: [{ label: 'OpenAI API keys', url: 'https://platform.openai.com/api-keys' }],
  },
  /*
   * WP90：**Anthropic 一张卡，两个方案**——用 Claude 的订阅登录，或者填 API key。
   *
   * 订阅那条**没有设备码**（实测：`pi-ai` 的 anthropic 流只有浏览器 + 贴授权码），
   * 所以卡上只会出现"用浏览器登录"一个按钮——方式清单由服务端给，不在前端写死。
   */
  {
    kind: 'anthropic',
    label: '用 Claude 订阅登录（Pro / Max）',
    summary: '已经在付 Claude 的钱就不用再买 API 额度：登录一次，按订阅额度跑。',
    ...ANTHROPIC_VENDOR,
    plan_label: '用 Claude 订阅登录（Pro / Max）',
    plan_order: 1,
    auth: 'subscription',
    subscription_provider: 'anthropic',
    default_base_url: CLAUDE_SUBSCRIPTION_URL,
    default_model: 'claude-sonnet-4-5',
    region: 'global',
    steps: [
      '确认你的 Claude 账号是 Pro 或 Max（免费档没有这条路）',
      '点下面的"用浏览器登录"——会打开 Claude 的授权页',
      '授权完成后这一页会自己变成"已登录"；浏览器在别的机器上就把授权码贴回来',
      '选一个模型',
      '要退出就点"登出"：本机那条授权记录当场销毁',
    ],
    links: [{ label: 'Claude 订阅档位', url: 'https://claude.ai/upgrade' }],
  },
  {
    kind: 'openai_compatible',
    label: 'Anthropic（API key，按量计费）',
    summary:
      'Anthropic 官方的 OpenAI 兼容口：把地址指到 api.anthropic.com/v1、填一把 Anthropic 的 key 就能用。',
    ...ANTHROPIC_VENDOR,
    plan_label: 'API key（按量计费）',
    plan_order: 2,
    auth: 'api_key',
    default_base_url: ANTHROPIC_OPENAI_COMPAT_URL,
    default_model: 'claude-sonnet-4-5',
    region: 'global',
    steps: [
      '打开 console.anthropic.com，进 API keys 建一把',
      '复制那一串，粘进下面的表单',
      '地址保持预填的那条（官方的 OpenAI 兼容口，以 /v1 结尾）',
      '选一个模型名（claude-sonnet-4-5 之类）',
      '点"测试"确认能通',
    ],
    links: [
      { label: 'Anthropic Console', url: 'https://console.anthropic.com/settings/keys' },
      {
        label: 'OpenAI SDK 兼容层说明',
        url: 'https://docs.anthropic.com/en/api/openai-sdk',
      },
    ],
  },
  /*
   * WP134（Luoye 09-24）：**用我的 DeepSeek 账号登录**——第三种模型来源。
   *
   * 没有表单、没有 key：点一下，系统浏览器里走 DeepSeek 官方的授权页（dsh 官方模块
   * `@deepseek-ai/dsh-deepseek-account-platform`），回来显示账号与余额，接着跑三步验证。
   * 令牌只存在 dsh 自己的本机凭据库里。
   *
   * WP152（Luoye 09-26）起**挂上 `vendor: 'deepseek'`**：与 API key 那条合成一张「DeepSeek 官方」卡，
   * 卡里二选一，这一条排第一、默认选中。kind / provider id 不变。
   */
  {
    kind: 'deepseek_account',
    label: DEEPSEEK_ACCOUNT_LABEL,
    summary: '不用建 key：用 DeepSeek 账号在浏览器里登录一次，按你账号里的余额扣。',
    ...DEEPSEEK_VENDOR,
    plan_label: DEEPSEEK_ACCOUNT_PLAN_LABEL,
    plan_order: 1,
    auth: 'account',
    default_base_url: DEEPSEEK_ACCOUNT_BASE_URL,
    default_model: DEEPSEEK_ACCOUNT_DEFAULT_MODEL,
    region: 'cn',
    steps: [
      '点"用 DeepSeek 账号登录"——会在浏览器里打开 DeepSeek 的授权页',
      '在那一页上登录你的 DeepSeek 账号、点同意',
      '回到这里：显示账号名与余额，接着自动验证三步（连通 → 文字 → 看图）',
      '钱从你 DeepSeek 账号的余额里扣；要退出就点"登出"',
    ],
    links: [{ label: 'DeepSeek 开放平台', url: 'https://platform.deepseek.com' }],
  },
  /*
   * 49 M2 第三张卡：**用 agentsws 的**。
   *
   * 与前两张唯一的差别是"要准备什么"那一栏——**什么都不用准备**：不填 key、
   * 不去谁的控制台注册、不复制粘贴任何一串字符。关联一次账号（WP58），
   * 这张卡就能用，按积分扣。
   *
   * 它照样是 OpenAI 兼容形态，所以复用同一个 provider 实现（49 M3 的理由）。
   */
  {
    kind: 'agentsws_cloud',
    label: 'agentsws 云（用积分）',
    summary: '不填 key、不注册。关联一次账号就能用，按积分扣，随时切回自己的 key。',
    vendor: 'agentsws-cloud',
    vendor_label: 'agentsws 云（用积分）',
    vendor_summary: '不填 key、不注册。关联一次账号就能用，按积分扣，随时切回自己的 key。',
    plan_label: '按积分',
    plan_order: 1,
    auth: 'api_key',
    default_base_url: `${DEFAULT_CLOUD_BASE_URL}/v1/ai`,
    default_model: 'deepseek-flash',
    region: 'cn',
    steps: [
      '在"设置 → 账号与积分"里关联 agentsws 账号',
      '回到这里点"启用"',
      '选一个模型（清单是云上给的，按积分价排）',
      '用起来——每次调用扣多少积分，在"账号与积分"里看得到',
      '想换回自己的 key，随时删掉这一条即可（切回后不再产生扣费）',
    ],
    links: [{ label: '价目表与余额', url: '/settings' }],
  },
]

/**
 * 给界面的那份模板。与 {@link MODEL_TEMPLATES} 的差别只有一处：
 * 云那张卡的地址跟着 `AGENTSWS_CLOUD_BASE_URL` 走（自建 / 联调时指到别处）。
 */
export function templatesFor(env: Record<string, string | undefined>): ModelProviderTemplate[] {
  return MODEL_TEMPLATES.map((t) =>
    t.kind === 'agentsws_cloud' ? { ...t, default_base_url: cloudAiBaseUrl(env) } : { ...t },
  )
}

// ── 小工具 ─────────────────────────────────────────────────────────────

/** `provider_id/model`——网关的价目表与 `findProvider` 都按这个键。 */
export function modelIdOf(config: { id: string; model: string }): string {
  return `${config.id}/${config.model}`
}

/** 价目表的键一律小写：各家页面上的大小写不一致（`GLM-5.3` / `glm-5.3`）。 */
function lowerKeys(prices: Record<string, CatalogPrice>): Record<string, CatalogPrice> {
  return Object.fromEntries(Object.entries(prices).map(([k, v]) => [k.toLowerCase(), v]))
}

class ModelsError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly details?: unknown,
  ) {
    super(message)
    this.name = 'ModelsError'
  }
}

const notFound = (m: string): ModelsError => new ModelsError('not_found', m)
const invalid = (m: string, d?: unknown): ModelsError => new ModelsError('invalid_input', m, d)

/**
 * 只留下真的想改的那几个键。
 *
 * `exactOptionalPropertyTypes` 下 `{ a: undefined }` 与 `{}` 是两回事，
 * 所以返回类型也把 `undefined` 从值里摘掉——不然赋回去还是不合法。
 */
function defined<T extends object>(
  input: T,
): Partial<{ [K in keyof T]: Exclude<T[K], undefined> }> {
  return Object.fromEntries(Object.entries(input).filter(([, v]) => v !== undefined)) as Partial<{
    [K in keyof T]: Exclude<T[K], undefined>
  }>
}

/** 今天零点（按 UTC；工作区时区的日切在 work 那边，这里只是个默认起点）。 */
function startOfDay(at: string): string {
  return `${at.slice(0, 10)}T00:00:00.000Z`
}

const EMPTY_ROW = (purpose: ModelPurpose): ModelUsageRow => ({
  purpose,
  calls: 0,
  input_tokens: 0,
  output_tokens: 0,
  cached_tokens: 0,
  cost_base: 0,
})

// ── 装配 ───────────────────────────────────────────────────────────────

export function createModels(options: ModelsOptions): ModelsAssembly {
  const { clock, gateway, secrets, env } = options
  const stateFile = options.dbDir === undefined ? undefined : join(options.dbDir, 'models.json')
  /**
   * WP143：DeepSeek Messages 口的 Files 复用，这个品牌一份（同一张图在这台机器上只传一次，直到过期）。
   * 有目录就落 `deepseek-files.json`（0600，只有哈希与 file id；不进备份、不上云），否则只在内存。
   */
  const deepseekFiles = new DeepSeekFileStore(
    options.dbDir === undefined
      ? {}
      : { index: jsonFileUploadIndex(join(options.dbDir, 'deepseek-files.json')) },
  )

  let state: ModelsStateFile = { version: 1, providers: [], defaults: {}, tests: {} }
  if (stateFile !== undefined) {
    try {
      const parsed = JSON.parse(readFileSync(stateFile, 'utf8')) as ModelsStateFile
      state = {
        version: 1,
        providers: parsed.providers ?? [],
        defaults: parsed.defaults ?? {},
        tests: parsed.tests ?? {},
        ...(parsed.pricing === undefined ? {} : { pricing: parsed.pricing }),
      }
    } catch {
      // 第一次跑，或者文件坏了：从空开始。加密库里的 key 不受影响
    }
  }
  const flush = (): void => {
    if (stateFile === undefined) return
    mkdirSync(dirname(stateFile), { recursive: true })
    writeFileSync(stateFile, `${JSON.stringify(state, null, 2)}\n`, 'utf8')
  }

  const keyOf = (id: string): string => `${MODEL_KEY_PREFIX}${id}`

  /**
   * 这条是不是"用 agentsws 的"那一种。
   *
   * 它的凭据不在 `model_provider:` 前缀下，而是 WP58 那把工作区服务令牌
   * （{@link CLOUD_TOKEN_SECRET_ID}）——所以取 key 与判"有没有 key"都要先问这一句。
   */
  const isCloud = (id: string): boolean =>
    state.providers.find((p) => p.id === id)?.kind === 'agentsws_cloud'

  /** WP134：这条是不是「用我的 DeepSeek 账号登录」那一种（凭据在 dsh 凭据库里，不在我们这儿）。 */
  const isAccount = (id: string): boolean =>
    state.providers.find((p) => p.id === id)?.kind === 'deepseek_account'

  /** 关联过账号没有（不读值，只看在不在）。 */
  const hasCloudToken = (): boolean =>
    secrets.available && secrets.record(CLOUD_TOKEN_SECRET_ID) !== undefined

  /** 这条 provider 有没有 key（不读值，只看在不在）。 */
  const hasKey = (id: string): boolean => {
    if (isCloud(id)) return hasCloudToken()
    if (isAccount(id)) return options.deepseekAccount?.signedIn() === true
    if (id === ENV_PROVIDER_ID && envKey() !== undefined) return true
    if (!secrets.available) return false
    return secrets.record(keyOf(id)) !== undefined
  }

  const envKey = (): string | undefined => {
    const raw = env[DEEPSEEK_KEY_ENV]
    return raw === undefined || raw.trim() === '' ? undefined : raw.trim()
  }

  /**
   * key 的取值回调。**每次请求现取**：改完设置下一次调用自然就是新的，
   * 而且 key 不在任何配置对象里长住。
   */
  const keySource = (id: string) => (): string | undefined => {
    if (isCloud(id)) {
      // 云那条取的是工作区服务令牌（WP58 关联账号时存进去的），不是用户填的 key
      if (!secrets.available) return undefined
      try {
        const token = secrets.get(CLOUD_TOKEN_SECRET_ID)?.token
        return token === undefined || token === '' ? undefined : token
      } catch {
        return undefined
      }
    }
    if (secrets.available) {
      try {
        const fields = secrets.get(keyOf(id))
        const key = fields?.api_key
        if (key !== undefined && key !== '') return key
      } catch {
        // 换过秘密库密钥：当成"没有 key"，界面上那条会显示 inactive
      }
    }
    // 环境变量兜底只对那条固定 id 生效（无界面部署走这条）
    return id === ENV_PROVIDER_ID ? envKey() : undefined
  }

  /** 环境变量给了 key 但设置页里还没有这条：兜出一条，界面上标 from_env。 */
  const effectiveConfigs = (): ModelProviderConfig[] => {
    const rows = [...state.providers]
    if (envKey() !== undefined && !rows.some((p) => p.id === ENV_PROVIDER_ID)) {
      rows.unshift({
        id: ENV_PROVIDER_ID,
        kind: 'deepseek',
        label: 'DeepSeek 官方（环境变量）',
        base_url: 'https://api.deepseek.com',
        model: 'deepseek-flash',
        region: 'cn',
        price_in: 0.27,
        price_out: 1.1,
        price_cached: 0.07,
      })
    }
    return rows
  }

  const fromEnvOnly = (id: string): boolean =>
    id === ENV_PROVIDER_ID && !state.providers.some((p) => p.id === ENV_PROVIDER_ID)

  /**
   * 一条配置 → 一个真 provider。缺 key 就不装（网关上没有它，选它会报没注册）。
   *
   * `model` 可以覆盖：同一家可能被按 purpose 挑了好几个模型（WP42），
   * 每个都要有自己的 provider 实例——网关按 `provider/model` 找，
   * 找不到精确的才退回"同一家的第一个"，而那一个发出去的模型名是它自己的。
   */
  const buildProvider = (
    config: ModelProviderConfig,
    model = config.model,
  ): ModelProvider | undefined => {
    if (!hasKey(config.id)) return undefined
    const vision = visionOf(config, model)
    const account = options.deepseekAccount
    if (config.kind === 'deepseek_account') {
      if (account === undefined) return undefined
      /*
       * WP134：这一路**不走 OpenAI 兼容客户端**。令牌每次请求现取自官方 `resolveToken`
       * （只对 api.deepseek.com 给值），发到官方的 Messages 口、放在 `x-dsh-auth-token` 头里。
       */
      return deepseekAccountProvider({
        ...(vision === undefined ? {} : { capabilities: { vision, image_generation: false } }),
        resolveToken: (url) => account.resolveToken(url),
        // WP150：推理 401 → 报回官方，失效了就走"登录过期了"那条路
        ...(account.rejectToken === undefined
          ? {}
          : { rejectToken: (token: string) => account.rejectToken?.(token) ?? Promise.resolve() }),
        baseUrl: config.base_url,
        model,
        provider: config.id,
        // WP143：真网络才开 Files 复用；注入了替身（测试 / demo）就照旧内联
        ...(account.fetch === undefined ? { files: deepseekFiles } : { fetch: account.fetch }),
      })
    }
    if (deepseekUsesMessages(config, env)) {
      // WP143：DeepSeek 官方 API key 改走 Messages 口（开关见 DEEPSEEK_MESSAGES_ENV，默认关）
      return deepseekMessagesProvider({
        ...(vision === undefined ? {} : { capabilities: { vision, image_generation: false } }),
        credential: { kind: 'api_key', apiKey: keySource(config.id) },
        baseUrl: DEEPSEEK_ACCOUNT_BASE_URL,
        model,
        provider: config.id,
        ...(options.fetch === undefined
          ? { files: deepseekFiles }
          : { fetch: options.fetch as unknown as AccountFetch }),
      })
    }
    return openaiCompatibleProvider({
      // WP127：上一次验证的结论就是能力声明；没验证过就不声明（网关照常放行）
      ...(vision === undefined ? {} : { capabilities: { vision, image_generation: false } }),
      baseUrl: config.base_url,
      apiKey: keySource(config.id),
      model,
      provider: config.id,
      region: config.region,
      env,
      ...(options.fetch === undefined ? {} : { fetch: options.fetch }),
      ...(config.embedding_model === undefined ? {} : { embeddingModel: config.embedding_model }),
      ...(config.transcription_model === undefined
        ? {}
        : { transcriptionModel: config.transcription_model }),
      /*
       * 49 M3 数据驻留：云那条带上工作区选的驻留（22 §2）。
       * 服务入口按它拦——选了"数据不出境"就只允许境内可用的模型，
       * 打境外模型回 422 + 一句人话，而不是悄悄换一家。
       */
      ...(config.kind === 'agentsws_cloud'
        ? {
            extraHeaders: {
              'X-Agentsws-Region':
                (state.defaults.data_residency ?? 'cn') === 'cn' ? 'cn' : 'global',
            },
          }
        : {}),
    })
  }

  /**
   * WP127：按上一次验证，这家的这个模型能不能看图。**只认测的正是这个模型的那一次**——
   * 换了模型名，上一次的结论就不算数（回 `undefined` = 没验证过）。
   */
  const visionOf = (config: ModelProviderConfig, model = config.model): boolean | undefined => {
    const test = state.tests[config.id]
    if (test?.vision === undefined) return undefined
    return test.model === `${config.id}/${model}` ? test.vision : undefined
  }

  const visionStatusOf = (config: ModelProviderConfig, model = config.model): ModelVisionStatus => {
    const vision = visionOf(config, model)
    return vision === undefined ? 'unchecked' : vision ? 'ok' : 'no'
  }

  /** WP127：官方接口一张图多少积分（`pricing.json` 的 `ai.image`；界面常显）。 */
  const creditsPerImage = (): number | undefined => creditsFor(buildPricing(), 'ai.image', 1)

  /** WP127：生图那一档现在挂哪一条（配了、而且那一条现在能用才有）。 */
  const imageConfig = (): { config: ModelProviderConfig; model: string } | undefined => {
    const picked = state.defaults.image
    if (picked === undefined) return undefined
    const config = activeConfigs().find((c) => c.id === picked.provider_id)
    if (config === undefined || !IMAGE_CAPABLE_KINDS.includes(config.kind)) return undefined
    return { config, model: picked.model }
  }

  const imageView = (): ModelImageView => {
    const picked = state.defaults.image
    const live = imageConfig()
    const credits = creditsPerImage()
    const choices = activeConfigs()
      .filter((c) => IMAGE_CAPABLE_KINDS.includes(c.kind))
      .map((c) => ({
        provider_id: c.id,
        label: providerDisplayLabel(c),
        official: c.kind === 'agentsws_cloud',
        default_model: DEFAULT_IMAGE_MODEL,
      }))
    let unavailable_reason: string | undefined
    if (picked === undefined) unavailable_reason = NO_IMAGE_MODEL_ZH
    else if (live === undefined)
      unavailable_reason = `生图用的那一条（${picked.provider_id}）现在用不了：没填 key、没关联账号，或者已经删了。去上面重新配好，或者换一条。`
    return {
      configured: live !== undefined,
      ...(picked === undefined ? {} : { provider_id: picked.provider_id, model: picked.model }),
      official: live?.config.kind === 'agentsws_cloud',
      ...(credits === undefined ? {} : { credits_per_image: credits }),
      choices,
      ...(unavailable_reason === undefined ? {} : { unavailable_reason }),
    }
  }

  /** 这家现在**已知**有哪些模型：拉过清单就是那一份，没拉过就只有配置里那一个。 */
  const knownModels = (config: ModelProviderConfig): string[] => {
    const listed = config.models ?? []
    return listed.includes(config.model) ? listed : [config.model, ...listed]
  }

  /**
   * 这家**真的要挂上网关**的那几个模型：配置里的主模型 + 被默认 / 按 purpose 选中的。
   *
   * 为什么不是"已知的全部"：OpenAI 的 `/models` 一口气回八十条，
   * 每条都建一个 provider、每条都要一行价格，等于把一份下拉框的数据塞进运行时。
   * 选中的才装。
   */
  const selectedModels = (config: ModelProviderConfig): string[] => {
    const picked = new Set([config.model])
    const ids = [state.defaults.default, ...Object.values(state.defaults.by_purpose ?? {})]
    for (const id of ids) {
      if (id === undefined || id === '') continue
      const at = id.indexOf('/')
      if (at <= 0 || id.slice(0, at) !== config.id) continue
      const model = id.slice(at + 1)
      if (knownModels(config).includes(model)) picked.add(model)
    }
    return [...picked]
  }

  const activeConfigs = (): ModelProviderConfig[] => effectiveConfigs().filter((c) => hasKey(c.id))

  /** 现在应该用哪个 ModelRef 当默认。一个都没配就是 stub（运行时据此落回 stub）。 */
  const defaultRef = (): ModelRef => {
    const active = activeConfigs()
    const wanted = state.defaults.default
    const byId = wanted === undefined ? undefined : active.find((c) => modelIdOf(c) === wanted)
    const picked = byId ?? active[0]
    if (picked === undefined) return STUB_REF
    return { provider: picked.id, model: picked.model, region: picked.region }
  }

  /**
   * `provider_id/model` → ModelRef。**认这家已知的任何一个模型**（WP42）——
   * 拉过清单之后，按 purpose 可以挑同一家的另一个模型，而不必再建一条 provider。
   */
  const refOf = (id: string | undefined): ModelRef | undefined => {
    if (id === undefined) return undefined
    const at = id.indexOf('/')
    if (at <= 0 || at === id.length - 1) return undefined
    const config = activeConfigs().find((c) => c.id === id.slice(0, at))
    if (config === undefined) return undefined
    const model = id.slice(at + 1)
    if (!knownModels(config).includes(model)) return undefined
    return { provider: config.id, model, region: config.region }
  }

  const policyOf = (): ModelGatewayPolicy => {
    const prices: ModelGatewayPolicy['prices'] = { ...STUB_PRICES }
    for (const c of activeConfigs()) {
      // 主模型用用户填的价；同一家被按 purpose 挑中的其它模型没有单独的价，按 0 记
      // （记 0 好过记错——记错会让预算按一个假数字拦人）
      for (const model of selectedModels(c)) {
        prices[`${c.id}/${model}`] =
          model === c.model
            ? { in: c.price_in ?? 0, out: c.price_out ?? 0, cached: c.price_cached ?? 0 }
            : { in: 0, out: 0, cached: 0 }
      }
    }
    const by_purpose: Partial<Record<ModelPurpose, ModelRef>> = {}
    for (const [purpose, id] of Object.entries(state.defaults.by_purpose ?? {})) {
      const ref = refOf(id)
      if (ref !== undefined) by_purpose[purpose as ModelPurpose] = ref
    }
    const budget = state.defaults.budget ?? {}
    return {
      default: defaultRef(),
      ...(Object.keys(by_purpose).length === 0 ? {} : { by_purpose }),
      // 一条都没配时驻留仍按 cn（stub 是 cn），配了境外模型就得允许 any
      data_residency: state.defaults.data_residency ?? 'cn',
      prices,
      budget: defined(budget),
    }
  }

  /**
   * 把当前配置推给网关。**这就是"热更新"**——保存 / 删除 / 改默认之后各调一次。
   *
   * 一条 provider 都装不上时仍然挂一个 stub：运行时与会议管线拿到的网关永远是能用的，
   * 只是回的是确定性假话（而且首页会有一条黄条告诉用户去接模型）。
   */
  const reassemble = (): void => {
    const providers: ModelProvider[] = []
    for (const config of activeConfigs()) {
      for (const model of selectedModels(config)) {
        const provider = buildProvider(config, model)
        if (provider !== undefined) providers.push(provider)
      }
    }
    if (providers.length === 0) providers.push(stubProvider({ seed: 7 }))
    // WP127：生图单独一档。没配就退回网关装配时那一条（生产上是"没有图片模型"那句人话，
    // demo 里是占位图）
    const image = imageConfig()
    gateway.reconfigure({
      providers,
      policy: policyOf(),
      images:
        image === undefined
          ? null
          : openaiImageProvider({
              baseUrl: image.config.base_url,
              apiKey: keySource(image.config.id),
              model: image.model,
              provider: image.config.id,
              region: image.config.region,
              ...(options.fetch === undefined ? {} : { fetch: options.fetch }),
              ...(image.config.kind === 'agentsws_cloud'
                ? {
                    extraHeaders: {
                      'X-Agentsws-Region':
                        (state.defaults.data_residency ?? 'cn') === 'cn' ? 'cn' : 'global',
                    },
                  }
                : {}),
            }),
    })
  }

  reassemble()

  /** WP66（52 O4）：端一份快照。深拷一遍，调用方改它不会动到这个品牌的状态。 */
  const exportSettings = (): ModelSettingsSnapshot =>
    JSON.parse(
      JSON.stringify({ providers: state.providers, defaults: state.defaults }),
    ) as ModelSettingsSnapshot

  /**
   * 去这家的 `/models` 拉一次清单（WP42）。
   *
   * `probe` 是"还没保存就先拉"那条路：用户刚把地址与 key 填进表单、还没点保存，
   * 就想看看有哪些模型可选。key 的走法和保存那条路一模一样——只在
   * `openaiCompatibleProvider` 的 `apiKey()` 回调里出现一次，直接进 header，
   * 不落盘、不进返回值、不进日志。
   *
   * **拉不到不抛**：回一条 `ok: false` + 一句人话，界面据此退回手填。
   *
   * WP88 起多一层：拉不到而**内置价目表认得出这一家**时，把价目表里那份模型名当兜底
   * 清单一起回去（`ok` 仍然是 `false`，界面照旧显示"为什么没拉到"）。百炼的 OpenAI
   * 兼容口没有 `GET /models`，没有这一层用户就得对着一个空框自己去官网抄模型名。
   */
  const listModelsOf = async (
    id: string,
    probe?: DiscoverModelsInput,
    fallback?: ModelProviderConfig,
  ): Promise<ModelListing> => {
    const checked_at = clock.now()
    /*
     * WP134：账号登录那一路没有 `/models` 可拉（令牌只对 Messages 口给值）。清单就是官方
     * `dsh-llm-deepseek` 目录里那两条——`ok: false` 如实说明它不是上游报的（WP88 同一条纪律）。
     */
    if (fallback?.kind === 'deepseek_account' || isAccount(id)) {
      return {
        ok: false,
        models: DEEPSEEK_ACCOUNT_MODELS.map((m) => m.id),
        reason: `账号登录这一路不去拉清单。下面是 DeepSeek 官方组件自带的目录（${DEEPSEEK_ACCOUNT_DEFAULT_MODEL} 能看图），能不能用以"测试"为准。`,
        checked_at,
      }
    }
    const base_url = probe?.base_url?.trim() ?? fallback?.base_url ?? ''
    if (base_url === '') {
      return { ok: false, models: [], reason: '还没填接口地址，填了才知道去哪儿拉', checked_at }
    }
    const probeKey = probe?.api_key?.trim()
    const hasProbeKey = probeKey !== undefined && probeKey !== ''
    if (!hasProbeKey && !hasKey(id)) {
      return { ok: false, models: [], reason: '还没填 API key，先填一把再拉', checked_at }
    }
    // 值只在这个回调里活一次：取 → 进 header → 结束
    const apiKey = hasProbeKey ? () => probeKey : keySource(id)
    const provider = openaiCompatibleProvider({
      baseUrl: base_url,
      apiKey,
      model: fallback?.model ?? 'probe',
      provider: id,
      region: probe?.region ?? fallback?.region ?? 'cn',
      env,
      timeoutMs: DISCOVER_TIMEOUT_MS,
      ...(options.fetch === undefined ? {} : { fetch: options.fetch }),
    })
    /**
     * 拉不到时的兜底：内置价目表里这一家有哪几个模型（WP88）。
     *
     * 回的 `ok` 仍然是 `false`——这份不是上游报的，是我们内置的，**用户有权知道差别**
     * （价目表可能落后于上游）。所以原因那句话后面缀一句说明，而不是假装拉成功了。
     */
    const withCatalogFallback = (reason: string): ModelListing => {
      const models = catalogModels(base_url)
      const vendor = vendorForBaseUrl(base_url)
      if (models.length === 0 || vendor === undefined) {
        return { ok: false, models: [], reason, checked_at }
      }
      return {
        ok: false,
        models,
        reason: `${reason}下面这 ${models.length} 个是内置价目表里${vendor.label}那份（${vendor.as_of} 核对官网），照它选就行；不在里面的手打也一样能用。`,
        checked_at,
      }
    }
    try {
      const rows = (await provider.listModels?.()) ?? []
      if (rows.length === 0) {
        return withCatalogFallback('这家没回模型列表（有的服务没有这个接口）。')
      }
      return { ok: true, models: rows.map((r) => r.id), checked_at }
    } catch (e) {
      return withCatalogFallback(`${humanizeModelError(codeOf(e), messageOf(e))} `)
    }
  }

  /** 拉一次并把结果记在这条配置上（拉不到也记：界面要显示"为什么没拉到"）。 */
  const refreshListing = async (
    config: ModelProviderConfig,
    probe?: DiscoverModelsInput,
  ): Promise<ModelListing> => {
    const listing = await listModelsOf(config.id, probe, config)
    const saved = state.providers.find((p) => p.id === config.id)
    const target = saved ?? config
    target.last_listing = listing
    // WP88：兜底清单（`ok: false` 但有名字）也记下来——下拉框照它画，
    // 用户不用每次打开表单都再点一次"拉取"
    if (listing.ok || listing.models.length > 0) target.models = listing.models
    if (saved !== undefined) {
      flush()
      // 清单变了，能选的模型跟着变——但只有被选中的那几个才真的挂上网关
      reassemble()
    }
    return listing
  }

  // ── 价：内置价目表 + 上次抓回来的覆盖（WP42 交付 2）────────────────

  /** 一条能填进表单的价：三个数字 + 币种 + 出处 + 日期。 */
  interface PriceHit extends CatalogPrice {
    currency: string
    source_url: string
    as_of: string
  }

  /**
   * 查这个（地址, 模型）的价。**抓回来的优先，内置价兜底。**
   *
   * 查不到就是查不到——不猜、不套一条"差不多的"。价宁可没有：
   * 没有价只是算不出花了多少钱，有一条错的价会让预算按假数字拦人。
   */
  const priceHit = (base_url: string, model: string): PriceHit | undefined => {
    const vendor = PRICE_CATALOG.vendors.find((v) => {
      const host = hostOf(base_url)
      return host !== '' && v.hosts.some((h) => host === h || host.endsWith(`.${h}`))
    })
    if (vendor === undefined) return undefined
    const overlay = state.pricing?.vendors[vendor.id]
    const fresh = overlay?.prices?.[model.trim().toLowerCase()] ?? overlay?.prices?.[model.trim()]
    if (fresh !== undefined) {
      return {
        ...fresh,
        currency: vendor.currency,
        source_url: vendor.source_url,
        as_of: (overlay?.at ?? vendor.as_of).slice(0, 10),
      }
    }
    const name = model.trim().toLowerCase()
    const undated = name.replace(/-\d{4}-\d{2}-\d{2}$/, '')
    const builtin = vendor.models.find(
      (m) =>
        m.model.toLowerCase() === name ||
        m.model.toLowerCase() === undated ||
        (m.aliases ?? []).some((a) => a.toLowerCase() === name),
    )
    if (builtin === undefined) return undefined
    return {
      in: builtin.in,
      out: builtin.out,
      cached: builtin.cached,
      currency: vendor.currency,
      source_url: vendor.source_url,
      as_of: vendor.as_of,
    }
  }

  /** 内置价目表 + 覆盖，端给界面（表单照它自动填）。 */
  const pricingView = (): ModelPricingView => {
    const vendors: ModelPricingVendorView[] = PRICE_CATALOG.vendors.map((v) => {
      const overlay = state.pricing?.vendors[v.id]
      const fresh = overlay?.prices
      const models =
        fresh === undefined
          ? v.models.map((m) => ({ ...m }))
          : [
              ...v.models.map((m) => {
                const hit = fresh[m.model.toLowerCase()] ?? fresh[m.model]
                return hit === undefined ? { ...m } : { ...m, ...hit }
              }),
              // 官网上新出的、内置表里还没有的
              ...Object.entries(fresh)
                .filter(([name]) => !v.models.some((m) => m.model.toLowerCase() === name))
                .map(([model, price]) => ({ model, ...price })),
            ]
      return {
        id: v.id,
        label: v.label,
        currency: v.currency,
        hosts: [...v.hosts],
        source_url: v.source_url,
        as_of: overlay?.ok === true ? overlay.at.slice(0, 10) : v.as_of,
        ...(overlay === undefined
          ? {}
          : {
              last_refresh: {
                at: overlay.at,
                ok: overlay.ok,
                models: overlay.models,
                ...(overlay.reason === undefined ? {} : { reason: overlay.reason }),
              },
            }),
        models,
      }
    })
    return {
      vendors,
      ...(state.pricing === undefined ? {} : { refreshed_at: state.pricing.refreshed_at }),
    }
  }

  const viewOf = (config: ModelProviderConfig): ModelProviderView => {
    const has_key = hasKey(config.id)
    const test = state.tests[config.id]
    return {
      id: config.id,
      kind: config.kind,
      // WP152：显示名（存储里的 label 不动）
      label: providerDisplayLabel(config),
      base_url: config.base_url,
      model: config.model,
      ...(config.embedding_model === undefined ? {} : { embedding_model: config.embedding_model }),
      ...(config.transcription_model === undefined
        ? {}
        : { transcription_model: config.transcription_model }),
      region: config.region,
      has_key,
      active: has_key,
      ...(has_key
        ? {}
        : {
            inactive_reason:
              // 云那条不是"没填 key"——它本来就不填 key，是还没关联账号
              config.kind === 'agentsws_cloud'
                ? '还没关联 agentsws 账号。去"设置 → 账号与积分"里关联一次就能用。'
                : config.kind === 'deepseek_account'
                  ? '还没用 DeepSeek 账号登录（或者已经登出）。点"用 DeepSeek 账号登录"，在浏览器里登录一次就能用。'
                  : secrets.available
                    ? '还没填 API key'
                    : `这台机器没有秘密库密钥（环境变量 ${SECRETS_KEY_ENV}），key 无处安全存放`,
          }),
      ...(config.price_in === undefined ? {} : { price_in: config.price_in }),
      ...(config.price_out === undefined ? {} : { price_out: config.price_out }),
      ...(config.price_cached === undefined ? {} : { price_cached: config.price_cached }),
      ...defined({
        price_source: config.price_source,
        price_currency: config.price_currency,
        price_source_url: config.price_source_url,
        price_as_of: config.price_as_of,
      }),
      ...(config.models === undefined ? {} : { models: config.models }),
      ...(config.last_listing === undefined ? {} : { last_listing: config.last_listing }),
      ...(test === undefined ? {} : { last_test: test }),
      vision_status: visionStatusOf(config),
      ...(fromEnvOnly(config.id) ? { from_env: true } : {}),
    }
  }

  const defaultsView = (): ModelDefaultsView => {
    const active = activeConfigs()
    const budget = state.defaults.budget ?? {}
    return {
      default: state.defaults.default ?? (active[0] === undefined ? '' : modelIdOf(active[0])),
      by_purpose: { ...state.defaults.by_purpose },
      data_residency: state.defaults.data_residency ?? 'cn',
      budget: defined(budget),
      // WP42：拉过清单的，这家的每一个模型都能选（没拉过就只有配置里那一个）
      choices: active.flatMap((c) =>
        knownModels(c).map((model) => ({
          id: `${c.id}/${model}`,
          label: `${providerDisplayLabel(c)}（${model}）`,
        })),
      ),
    }
  }

  /**
   * 保存时这三个价填什么（WP42 交付 2）。
   *
   * - 用户在表单里动过价（`price_source: 'manual'`）→ **原样存**，并且标上"手动"：
   *   每周那次官网刷新一条都不动它。
   * - 没动过 → 按（地址, 模型）去价目表查，查到就自动填上，并记下币种与出处；
   * - 查不到、但用户填了数字 → 那也只能算"手动"（我们说不出这个数字是哪来的）。
   */
  const priceFieldsFor = (
    input: SaveModelProviderInput,
    existing: ModelProviderConfig | undefined,
    base_url: string,
  ): Partial<ModelProviderConfig> => {
    const given = {
      price_in: input.price_in,
      price_out: input.price_out,
      price_cached: input.price_cached,
    }
    const typed = Object.values(given).some((v) => v !== undefined)
    if (input.price_source === 'manual') {
      return defined({ ...given, price_source: 'manual' as const })
    }
    const hit = priceHit(base_url, input.model.trim())
    if (hit !== undefined && (input.price_source === 'catalog' || !typed)) {
      return {
        price_in: hit.in,
        price_out: hit.out,
        price_cached: hit.cached,
        price_source: 'catalog',
        price_currency: hit.currency,
        price_source_url: hit.source_url,
        price_as_of: hit.as_of,
      }
    }
    if (typed) return defined({ ...given, price_source: 'manual' as const })
    // 什么都没给、也查不到：保留上一次的（改个模型名不该把价清掉）
    return defined({
      price_in: existing?.price_in,
      price_out: existing?.price_out,
      price_cached: existing?.price_cached,
      price_source: existing?.price_source,
      price_currency: existing?.price_currency,
      price_source_url: existing?.price_source_url,
      price_as_of: existing?.price_as_of,
    })
  }

  const port: ModelsPort = {
    templates: () => templatesFor(env),

    providers: () => effectiveConfigs().map(viewOf),

    /**
     * **唯一接触 key 原文的方法。**
     *
     * `input.api_key` 进来之后只做一件事：写进本机 AES-256-GCM 加密库。
     * 不抄进 `state`（那是明文 JSON）、不进事件、不进返回值、不进日志。
     * 不给 `api_key` 就是"别动已经存着的那一把"——改个模型名不用重填 key。
     */
    async save(
      _actor: ModelsActor,
      id: string,
      input: SaveModelProviderInput,
    ): Promise<ModelProviderView> {
      if (!/^[a-z0-9][a-z0-9_-]{0,31}$/.test(id)) {
        throw invalid('provider 的 id 只能是小写字母、数字、下划线和短横线（32 位以内）')
      }
      /*
       * 哪一张模板卡（WP88）。
       *
       * 在这之前是 `find(t => t.kind === input.kind)`——`kind` 当时一张卡一个，
       * 所以"种类"和"卡"是一回事。现在不是了：OpenAI 兼容那张、百炼三张，四张卡
       * 同一个 `kind`。再按 `kind` 取第一张，请求里没给的字段（`region` / `label`）
       * 就会拿**别人家**的默认值来兜——保存一条百炼的配置，`region` 兜成通用 OpenAI
       * 那张的 `global`，然后 22 §2 的 `data_residency: cn` 当场把它拦下来，
       * 用户看到的是一句"禁止出境"，而他填的明明是北京的地址。
       *
       * 所以先按**接口地址**认是哪一张（地址正是这几张卡真正不同的地方），
       * 认不出来才退回按 `kind` 取第一张（没给地址的老调用照旧能过）。
       *
       * 认到卡之后还要再往里认一层：卡上那几个"点一下就填好"的预设各有自己的地域
       * （百炼北京是 `cn`、新加坡是 `global`）。认到哪个预设，兜底就用哪个预设的。
       */
      const wantUrl = input.base_url?.trim() ?? state.providers.find((p) => p.id === id)?.base_url
      const sameKind = templatesFor(env).filter((t) => t.kind === input.kind)
      const wantHost = wantUrl === undefined ? '' : hostOf(wantUrl)
      const matches = (t: ModelProviderTemplate): boolean =>
        wantHost !== '' &&
        [t.default_base_url, ...(t.presets ?? []).map((p) => p.base_url)].some(
          (u) => hostOf(u) === wantHost,
        )
      const template = sameKind.find(matches) ?? sameKind[0]
      if (template === undefined) throw invalid(`不认识的模型种类：${input.kind}`)
      // 卡内的那一条预设（认不到就按卡本身的默认值兜）
      const preset = (template.presets ?? []).find((p) => hostOf(p.base_url) === wantHost)
      /*
       * 49 M2：**"用 agentsws 的"这一条不填 key。**
       *
       * 它的凭据是关联账号时拿到的那把工作区服务令牌，由 WP58 存进秘密库。
       * 这里显式拒掉而不是默默忽略——用户如果真往里填了什么，他该知道那没生效。
       */
      /*
       * WP134：**账号登录这一条也不填 key。** 凭据是 dsh 官方模块登录的产物，只在 dsh 本机凭据库里。
       * 没装这条路的进程（公司档 / 托管档镜像）直接拒；没登录也拒——先登录、再存这一条。
       */
      if (input.kind === 'deepseek_account') {
        if (input.api_key !== undefined && input.api_key.trim() !== '') {
          throw invalid('"用 DeepSeek 账号登录"这一条不用填 key——点登录，在浏览器里登录一次即可。')
        }
        if (options.deepseekAccount === undefined) {
          throw invalid('这个服务进程没有装配"用 DeepSeek 账号登录"。')
        }
        if (!options.deepseekAccount.signedIn()) {
          throw invalid(
            '还没用 DeepSeek 账号登录。先点"用 DeepSeek 账号登录"，在浏览器里登录一次。',
          )
        }
      }
      if (input.kind === 'agentsws_cloud') {
        if (input.api_key !== undefined && input.api_key.trim() !== '') {
          throw invalid(
            '"agentsws 云"这一条不用填 key——它用的是关联账号时拿到的工作区令牌。去"设置 → 账号与积分"里关联一次即可。',
          )
        }
        if (!hasCloudToken()) {
          throw invalid('还没关联 agentsws 账号。先去"设置 → 账号与积分"里关联一次。')
        }
      }
      const key = input.api_key?.trim()
      if (key !== undefined && key !== '') {
        if (!secrets.available) {
          throw invalid(
            `这台机器没有秘密库密钥（环境变量 ${SECRETS_KEY_ENV}），API key 无处安全存放。` +
              '桌面壳会在首次启动时生成它；直接跑服务进程时请自己生成一把 32 字节密钥再启动。',
          )
        }
        // 值在这里第一次也是最后一次被本模块持有
        secrets.put(keyOf(id), { api_key: key })
      }
      const existing = state.providers.find((p) => p.id === id)
      const base_url = input.base_url?.trim() ?? existing?.base_url ?? template.default_base_url
      // 换了地址就等于换了一家：上一份模型清单跟着作废，重新拉
      const keepList = existing !== undefined && existing.base_url === base_url
      const config: ModelProviderConfig = {
        id,
        kind: input.kind,
        label: input.label?.trim() ?? existing?.label ?? preset?.label ?? template.label,
        base_url,
        model: input.model.trim(),
        region: input.region ?? existing?.region ?? preset?.region ?? template.region,
        ...defined({
          embedding_model: input.embedding_model ?? existing?.embedding_model,
          transcription_model: input.transcription_model ?? existing?.transcription_model,
          models: keepList ? existing.models : undefined,
          last_listing: keepList ? existing.last_listing : undefined,
        }),
        ...priceFieldsFor(input, existing, base_url),
      }
      if (existing === undefined) state.providers.push(config)
      else state.providers[state.providers.indexOf(existing)] = config
      // 第一条能用的 provider 自动成为默认，用户不用再去下拉框里点一次
      if (state.defaults.default === undefined && hasKey(id)) {
        state.defaults.default = modelIdOf(config)
      }
      flush()
      reassemble()
      // WP42：保存时顺手拉一次模型清单（还没拉过、或刚换了地址的才拉）。
      // 拉不到不影响保存——它只是让下一次打开表单时"模型名"是个下拉。
      if (config.models === undefined) {
        const listing = await refreshListing(config)
        // 模板里的默认模型名不一定还存在（DeepSeek 官网已不列 deepseek-chat）：
        // 接口回的清单才是真的，不在清单里就换成清单第一个，别让用户看到一个接口不认的名字
        const saved = state.providers.find((p) => p.id === config.id) ?? config
        // WP88：拿**这一次认出来的那张卡**的默认值比（同一个 kind 现在有好几张卡，
        // 按 kind 取第一张会比错人：比的是别人家的默认模型名）
        const untouchedDefault = template.default_model === saved.model
        // 只兜模板默认值；用户自己填的名字（哪怕清单里没有）照他的来
        if (
          untouchedDefault &&
          listing.ok &&
          listing.models.length > 0 &&
          !listing.models.includes(saved.model)
        ) {
          const before = modelIdOf(saved)
          saved.model = listing.models[0] as string
          if (state.defaults.default === before) state.defaults.default = modelIdOf(saved)
          flush()
          reassemble()
        }
      }
      return viewOf(config)
    },

    remove(_actor, id) {
      const at = state.providers.findIndex((p) => p.id === id)
      if (at < 0 && !fromEnvOnly(id)) throw notFound(`没有这个 provider：${id}`)
      if (fromEnvOnly(id)) {
        throw invalid(
          `这一条是环境变量 ${DEEPSEEK_KEY_ENV} 给的，界面上删不掉；把那个环境变量去掉再重启即可`,
        )
      }
      const removed = state.providers[at]
      state.providers.splice(at, 1)
      delete state.tests[id]
      if (removed !== undefined && state.defaults.default === modelIdOf(removed)) {
        delete state.defaults.default
      }
      for (const [purpose, value] of Object.entries(state.defaults.by_purpose ?? {})) {
        if (removed !== undefined && value === modelIdOf(removed)) {
          delete state.defaults.by_purpose?.[purpose as ModelPurpose]
        }
      }
      if (secrets.available) secrets.remove(keyOf(id))
      flush()
      reassemble()
    },

    /**
     * 验证三步（WP127，70 §2.2）：连通 → 一次最小文字请求 → **一次带图的最小请求**。
     * 向导第 ① 步与设置页「测试」都走这一个（`checkModel` 在网关包里，模拟场景也用它）。
     *
     * 为什么经网关而不是直接打 provider：要一并验证驻留策略、预算、价目表都配对了——
     * 用户点"测试"要的是"这条路整条通不通"，不是"这个 URL 能不能连"。
     * 带图那一次标 `capability_probe`：网关不按上一次的结论拦它（问的正是"现在还看不看得了"）。
     *
     * 看不了图的**不通过**：Agents 工坊只支持多模态模型（Luoye 09-23）。
     * 回的是三步结果、延迟与模型名，**永远没有 key**。
     */
    async test(actor, id): Promise<ModelTestResult> {
      const config = effectiveConfigs().find((c) => c.id === id)
      if (config === undefined) throw notFound(`没有这个 provider：${id}`)
      const checked_at = clock.now()
      if (!hasKey(id)) {
        const result: ModelTestResult = {
          ok: false,
          reason: 'no_key',
          detail:
            config.kind === 'deepseek_account'
              ? '还没用 DeepSeek 账号登录（或者已经登出），先登录再测'
              : '还没填 API key，先保存一把再测',
          checked_at,
        }
        state.tests[id] = result
        flush()
        return result
      }
      const startedAt = Date.parse(clock.now())
      const ref = { provider: config.id, model: config.model, region: config.region }
      const outcome = await checkModel({
        complete: (messages) =>
          gateway.complete({
            model: ref,
            messages,
            capability_probe: true,
            meta: {
              workspace_id: actor.workspace_id,
              assignment_id: actor.assignment_id,
              role_id: actor.role_id,
              run_id: `run_model_test_${id}`,
              purpose: 'judge',
            },
          }),
        describe: (e) => ({ reason: codeOf(e), detail: messageOf(e) }),
      })
      const duration_ms = Math.max(0, Date.parse(clock.now()) - startedAt)
      const result: ModelTestResult = outcome.ok
        ? {
            ok: true,
            reason: 'ok',
            model: modelIdOf(config),
            duration_ms,
            detail: `通了：连得上、文字能回、图也看得懂（用了 ${outcome.tokens} 个 token）`,
            checked_at,
            steps: outcome.steps,
            vision: true,
          }
        : {
            ok: false,
            reason: outcome.reason ?? 'provider_error',
            model: modelIdOf(config),
            // 上游报错原文里不会有 key（provider 只把它放进 header），但仍然截短
            detail:
              outcome.reason === NO_VISION_REASON
                ? noVisionMessage()
                : humanizeModelError(outcome.reason ?? 'provider_error', outcome.detail ?? ''),
            duration_ms,
            checked_at,
            steps: outcome.steps,
            ...(outcome.vision === undefined ? {} : { vision: outcome.vision }),
          }
      state.tests[id] = result
      flush()
      // 结论变了，能力声明跟着变：下一次带图的请求按新结论走
      reassemble()
      return result
    },

    /** WP127：生图那一档。 */
    image: () => imageView(),

    /**
     * WP127：改生图那一档。**保存即生效**（`reassemble` 换掉网关的图片槽）。
     *
     * 只收已配、有 key、有生图口的那几条（OpenAI 兼容口与官方接口）；DeepSeek 与订阅登录
     * 没有生图口，选了也出不了图——当场拒并说清楚，而不是存下来等出图时再失败。
     */
    setImage(_actor, input: SetModelImageInput) {
      const id = input.provider_id.trim()
      if (id === '') {
        delete state.defaults.image
      } else {
        const config = activeConfigs().find((c) => c.id === id)
        if (config === undefined) throw invalid(`这一条现在用不了（没配或者没填 key）：${id}`)
        if (!IMAGE_CAPABLE_KINDS.includes(config.kind)) {
          throw invalid(
            `${providerDisplayLabel(config)} 没有生图接口。生图请选 Agents 工坊官方接口，或者一条 OpenAI 兼容口。`,
          )
        }
        state.defaults.image = {
          provider_id: id,
          model: input.model?.trim() || DEFAULT_IMAGE_MODEL,
        }
      }
      flush()
      reassemble()
      return imageView()
    },

    /**
     * WP42：去这家的 `/models` 拉一次可用模型清单。
     *
     * 两种用法：已经保存过的那条什么都不给（用存着的地址与加密库里的 key）；
     * 还没保存的把地址与 key 带上（`api_key` 只走这一次，不落盘）。
     */
    async discover(_actor, id, input): Promise<ModelListing> {
      const config = effectiveConfigs().find((c) => c.id === id)
      if (config === undefined) {
        // 还没保存的那条：没有配置可依，全靠请求体里带来的地址与 key
        return listModelsOf(id, input)
      }
      return refreshListing(config, input)
    },

    defaults: () => defaultsView(),

    setDefaults(_actor, input: SetModelDefaultsInput) {
      if (input.default !== undefined) {
        if (refOf(input.default) === undefined) {
          throw invalid(`这个模型现在用不了（没配或者没填 key）：${input.default}`)
        }
        state.defaults.default = input.default
      }
      if (input.by_purpose !== undefined) {
        const next: Partial<Record<ModelPurpose, string>> = {}
        for (const [purpose, id] of Object.entries(input.by_purpose)) {
          if (id === undefined || id === '') continue
          if (refOf(id) === undefined) throw invalid(`这个模型现在用不了：${id}`)
          next[purpose as ModelPurpose] = id
        }
        state.defaults.by_purpose = next
      }
      if (input.data_residency !== undefined) state.defaults.data_residency = input.data_residency
      if (input.budget !== undefined) state.defaults.budget = defined(input.budget)
      flush()
      reassemble()
      return defaultsView()
    },

    async usage(actor, since): Promise<ModelUsageView> {
      const from = since ?? startOfDay(clock.now())
      const rows = new Map<ModelPurpose, ModelUsageRow>()
      for (const record of gateway.records()) {
        if (record.workspace_id !== actor.workspace_id) continue
        if (record.at < from) continue
        const row = rows.get(record.purpose) ?? EMPTY_ROW(record.purpose)
        row.calls += 1
        row.input_tokens += record.input_tokens
        row.output_tokens += record.output_tokens
        row.cached_tokens += record.cached_tokens
        row.cost_base += record.cost_base
        rows.set(record.purpose, row)
      }
      const list = [...rows.values()].sort((a, b) => b.cost_base - a.cost_base)
      const total = list.reduce<ModelUsageRow | undefined>((acc, row) => {
        if (acc === undefined) return { ...row, purpose: row.purpose }
        return {
          purpose: acc.purpose,
          calls: acc.calls + row.calls,
          input_tokens: acc.input_tokens + row.input_tokens,
          output_tokens: acc.output_tokens + row.output_tokens,
          cached_tokens: acc.cached_tokens + row.cached_tokens,
          cost_base: acc.cost_base + row.cost_base,
        }
      }, undefined)
      return {
        since: from,
        rows: list,
        total,
        budget: await gateway.budget({ workspace_id: actor.workspace_id }),
      }
    },

    pricing: () => pricingView(),

    /**
     * 去各家官网抓一次价（WP42 交付 2）。
     *
     * 三条边界：
     * 1. **普通 HTTP GET，不经模型**——抓回来的网页交给几十行的解析器，
     *    不交给 Agent「读懂」。价目表是拿来算钱的，不能是模型编出来的数字。
     * 2. **出站受急停管**（28 §1 的 `outbound` 档）：停着就一次请求都不发，
     *    并且明说是被急停拦下的，而不是装作"抓不到"。
     * 3. **标了"手动"的价一条都不动**——用户改过的数字不该被后台任务悄悄覆盖。
     */
    async refreshPricing(_actor): Promise<ModelPricingRefreshResult> {
      const at = clock.now()
      if (options.halt?.isHalted('outbound') === true) {
        return {
          at,
          ok: false,
          vendors: [],
          updated_providers: 0,
          reason: '出站急停开着，这一轮没去抓。解除急停之后再点一次。',
        }
      }
      const results = await refreshPriceCatalog({
        ...(options.pageFetch === undefined ? {} : { fetch: options.pageFetch }),
      })
      const vendors: PricingOverlay['vendors'] = { ...state.pricing?.vendors }
      for (const r of results) {
        vendors[r.vendor_id] = {
          at,
          ok: r.ok,
          models: r.models,
          ...(r.reason === undefined ? {} : { reason: r.reason }),
          // 抓失败时保留上一次抓到的价（内置价永远在底下兜着）
          ...(r.ok
            ? { prices: lowerKeys(r.prices) }
            : defined({ prices: vendors[r.vendor_id]?.prices })),
        }
      }
      state.pricing = { refreshed_at: at, vendors }

      // 跟着把 provider 上的价刷一遍——手动的跳过
      let updated_providers = 0
      for (const config of state.providers) {
        if (config.price_source === 'manual') continue
        const hit = priceHit(config.base_url, config.model)
        if (hit === undefined) continue
        if (
          config.price_in === hit.in &&
          config.price_out === hit.out &&
          config.price_cached === hit.cached
        ) {
          continue
        }
        config.price_in = hit.in
        config.price_out = hit.out
        config.price_cached = hit.cached
        config.price_source = 'catalog'
        config.price_currency = hit.currency
        config.price_source_url = hit.source_url
        config.price_as_of = hit.as_of
        updated_providers += 1
      }
      flush()
      reassemble()

      // 事件里**只有条数与来源**：没有页面正文、没有价、没有任何凭据
      options.appendEvent?.({
        schema_version: 1,
        workspace_id: options.workspace_id?.() ?? 'ws_local',
        type: 'pricing.refreshed',
        actor: { kind: 'system', id: 'models.pricing' },
        correlation: { trace_id: `pricing_${at}` },
        payload: {
          vendors_ok: results.filter((r) => r.ok).length,
          vendors_total: results.length,
          models: results.reduce((n, r) => n + r.models, 0),
          updated_providers,
          sources: results.filter((r) => r.ok).map((r) => r.source_url),
        },
      })

      return {
        at,
        ok: results.some((r) => r.ok),
        vendors: results.map((r) => ({
          id: r.vendor_id,
          label: r.vendor_label,
          ok: r.ok,
          models: r.models,
          ...(r.reason === undefined ? {} : { reason: r.reason }),
        })),
        updated_providers,
      }
    },

    configured: () => activeConfigs().length > 0,
  }

  return {
    port,
    configured: () => activeConfigs().length > 0,
    defaultRef,
    visionStatus: () => {
      const ref = defaultRef()
      const config = activeConfigs().find((c) => c.id === ref.provider)
      return config === undefined ? 'unchecked' : visionStatusOf(config, ref.model)
    },
    exportSettings,
    accountChanged: () => {
      reassemble()
    },
    purposeRef: (purpose) => policyOf().by_purpose?.[purpose] ?? defaultRef(),
    dropAccountProvider(reason) {
      const rows = state.providers.filter((p) => p.kind === 'deepseek_account')
      if (rows.length === 0) return false
      for (const row of rows) port.remove(DROP_ACTOR, row.id)
      // 事件里只有"哪条、为什么"：没有账号名、没有令牌
      options.appendEvent?.({
        schema_version: 1,
        workspace_id: options.workspace_id?.() ?? 'ws_local',
        type: 'model.account_signed_out',
        actor: { kind: 'system', id: 'models.deepseek_account' },
        correlation: { trace_id: `dsa_${reason}_${clock.now()}` },
        payload: { providers: rows.map((r) => r.id), reason },
      })
      return true
    },
    importSettings(snapshot) {
      // 只往空的里写：已经配过的品牌一条都不动（复制是一次性的，不是同步）
      if (state.providers.length > 0) return 0
      const rows = snapshot.providers.filter((p) => p.id !== ENV_PROVIDER_ID)
      if (rows.length === 0) return 0
      state.providers = JSON.parse(JSON.stringify(rows)) as ModelProviderConfig[]
      state.defaults = JSON.parse(JSON.stringify(snapshot.defaults)) as ModelsStateFile['defaults']
      flush()
      // key 还没填，所以这一轮多半只装得上 stub——填完 key 下一次保存自然就换过来
      reassemble()
      return state.providers.length
    },
  }
}

// ── 错误 → 人话 ────────────────────────────────────────────────────────

function codeOf(e: unknown): string {
  if (typeof e === 'object' && e !== null && 'code' in e) {
    const code = (e as { code: unknown }).code
    if (typeof code === 'string') return code
  }
  return 'provider_error'
}

/**
 * 试跑失败时**真正的**那句原文。
 *
 * 坑在这里：网关把每一次 provider 失败都收进 `details.attempts`，自己只抛一句
 * `provider_unavailable: all providers failed`。照那句话翻，用户点"测试"永远只看到
 * "连不上这个地址"——哪怕真实原因是 key 填错了（401）或者余额不足（402）。
 * 所以先钻进 `attempts` 拿最后一次的 status 与原文，钻不进去才用外层那句。
 */
function messageOf(e: unknown): string {
  const attempt = lastAttempt(e)
  if (attempt !== undefined) {
    const status = attempt.status === undefined ? '' : `HTTP ${attempt.status} `
    return `${status}${attempt.message}`.slice(0, 200)
  }
  return (e instanceof Error ? e.message : String(e)).slice(0, 200)
}

/** 网关 `ProviderDownPayload.attempts` 的最后一条（降级链上最后一次尝试）。 */
function lastAttempt(e: unknown): { status?: number; message: string } | undefined {
  if (typeof e !== 'object' || e === null || !('details' in e)) return undefined
  const details = (e as { details: unknown }).details
  if (typeof details !== 'object' || details === null || !('attempts' in details)) return undefined
  const attempts = (details as { attempts: unknown }).attempts
  if (!Array.isArray(attempts) || attempts.length === 0) return undefined
  const last = attempts[attempts.length - 1] as { status?: unknown; message?: unknown }
  if (typeof last.message !== 'string') return undefined
  return {
    ...(typeof last.status === 'number' ? { status: last.status } : {}),
    message: last.message,
  }
}

/** 试跑失败的中文人话。原文只在括号里当补充。 */
export function humanizeModelError(code: string, message: string): string {
  const lower = message.toLowerCase()
  if (lower.includes('401') || lower.includes('unauthorized') || lower.includes('invalid api key'))
    return `API key 不对或者已经失效，去控制台重新生成一把（${message}）`
  if (lower.includes('402') || lower.includes('insufficient') || lower.includes('balance'))
    return `这个账号余额不足，去控制台充一点（${message}）`
  if (lower.includes('404') || lower.includes('model not found'))
    return `模型名或接口地址不对：这家没有你填的那个模型（${message}）`
  if (lower.includes('429')) return `请求太频繁了，等一会儿再点一次（${message}）`
  switch (code) {
    case 'residency_blocked':
    case 'forbidden':
      return `数据驻留设成了"只用境内"，但这个模型在境外。要么换模型，要么把驻留改成 any（${message}）`
    case 'budget_exhausted':
      return `预算用完了，先把上限调高再测（${message}）`
    case 'provider_unavailable':
      return `连不上这个地址：检查接口地址、网络，本地模型的话看看它起来了没有（${message}）`
    case 'invalid_input':
      return `配置不完整：${message}`
    // WP150：provider 自己已经说成人话了（DeepSeek 账号登录过期 / 没登录），原样给
    case 'unauthenticated':
      return message
    default:
      return `没通：${message}`
  }
}
