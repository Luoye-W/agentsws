/**
 * 48 §5.3 / 49 §6 WP61 **公共红人库服务**的契约（云侧那一份，`/v1/data/kol/*`）。
 *
 * 这个文件只描述**公共库自己的形状**。红人在本地本体里的六个对象类型
 * （`creator` / `platform_account` / `creator_contact` / `collaboration` /
 * `deliverable` / `tracked_link`）是 WP67 的事，在 `kol.ts` 里定义——
 * 公共库这边一个都不 import：
 *
 * - 公共库是**跨租户**的一层事实，本地那六个对象是**一个工作区自己的**归属数据，
 *   两层的生命周期、可见性、删除语义都不一样（48 §1.2「双层：共享事实 + 私有归属」）；
 * - 所以这里指一个红人用的是**自足键** `{ channel, handle }`（{@link PublicCreatorKey}）
 *   而不是任何一侧的 id。两个包各自能编译、各自能测，合并时不会撞同一个文件。
 *
 * 三条隐私纪律在类型上就能看见（21 §1 / §5）：
 *
 * 1. **邮箱不以明文存在于任何一个类型上**——库里只有 {@link PublicCreatorContact}
 *    的 `email_sha256` + `email_cipher`，明文只在付费 reveal 的响应里出现一次
 *    （{@link RevealedContact}）；
 * 2. **插件令牌只有哈希**（{@link PluginPairing} 上没有 `token` 这一格，明文在
 *    {@link IssuedPluginToken} 里出现一次）；
 * 3. **观察里没有正文**：{@link PUBLIC_OBSERVATION_FIELDS} 是一张白名单，
 *    多一个键就拒——评论、私信、视频文案一个字都不收（48 §1.3 第 4 条）。
 */

import type { Iso8601, WorkspaceId } from './common.js'
import type { KolChannel } from './kol.js'

/** 48 §5.1 的五条渠道。库按它分区，同一个人在两个渠道是两条记录。 */

/**
 * 指一个红人的**自足键**：渠道 + 该渠道上的 handle。
 *
 * 没有 id 这一格是有意的：公共库跨租户，本地那六个对象各租户一份，
 * 两边谁都不该把自己的主键塞给对方（40 §1「真源只有一个」）。
 */
export interface PublicCreatorKey {
  channel: KolChannel
  /** 渠道内唯一的账号名（`@` 去掉、小写）。 */
  handle: string
}

/** 一条公开资料是怎么来的。可信度按它分档（{@link SOURCE_CONFIDENCE}）。 */
export type KolObservationSource = 'plugin' | 'official_api' | 'apify' | 'manual'

export const KOL_OBSERVATION_SOURCES: readonly KolObservationSource[] = [
  'plugin',
  'official_api',
  'apify',
  'manual',
]

/** 各来源的基准可信度（0–1）。官方口最高，人工填的最低——它没有第二个人核过。 */
export const SOURCE_CONFIDENCE: Record<KolObservationSource, number> = {
  official_api: 1,
  apify: 0.8,
  plugin: 0.7,
  manual: 0.5,
}

/**
 * 一条**观察**：某个来源在某一刻看到的公开资料快照。
 *
 * 字段白名单 {@link PUBLIC_OBSERVATION_FIELDS} 就是这个接口的键——多一个键**拒收**。
 * 这是"不接受任何正文"唯一可执行的形式（与 49 M6 的 `assertMeteringEvent` 同一条纪律）：
 * 类型挡住笔误，运行时挡住"把整个页面 spread 一把过来"。
 */
export interface PublicCreatorObservation {
  channel: KolChannel
  handle: string
  followers: number
  /**
   * 近 30 天发布数。
   *
   * WP130：**只对插件来源（`source: 'plugin'`）可缺**——浏览器插件在一个页面上看不到
   * 「近 30 天发了几条」「互动率」，逼它报就只能编一个 0。缺的行照样进库、照样更新
   * 卡面上看得见的那几格，但**k-匿名基准跳过它**（缺不是 0），体检也不拿它下判断。
   * 其余来源（官方 / apify / 工作区手填）照旧必须给。
   */
  posts_30d?: number
  /** 互动率（0–1 的小数，不是百分数）。可缺的规则同 `posts_30d`。 */
  engagement_rate?: number
  /** BCP-47 的主语言（`en` / `zh-CN`），认不出就不给这一格。 */
  language?: string
  /** ISO-3166 的两位地区码。 */
  region?: string
  /** 类目（自由词，最多 {@link MAX_CATEGORIES} 个）。 */
  categories?: string[]
  /**
   * WP487（决策 1661 补）：红人**主页上公开写着的**联系方式——公开邮箱、网站、其它平台主页、
   * 商务合作入口、经纪 / 代理联系。只收 {@link PublicContactLink} 那三格，最多
   * {@link MAX_PUBLIC_CONTACTS} 条；私信内容、账号凭据、用户自己的数据没有一格能落进来。
   * 发出去之前先过 {@link sanitizePublicContacts}（本机那一跳就过，云端再按同一套规矩判一次）。
   */
  public_contacts?: PublicContactLink[]
  /**
   * WP495（1707b，只加）：展示名（频道名 / 昵称；`handle` 是账号名）。最长 {@link PUBLIC_DISPLAY_NAME_MAX} 字。
   * 表格导入的红人带来的那一格；发出去之前先过 {@link sanitizePublicProfile}。
   */
  display_name?: string
  /** WP495（1707b，只加）：这个账号的主页链接（http(s)，同 {@link sanitizePublicContacts} 那套链接规矩）。 */
  profile_url?: string
  /** 这份资料**被看到**的时刻（不是被写进库的时刻）。 */
  observed_at: Iso8601
}

/** 观察的字段白名单。运行时逐键比对：不在这张表里的一律拒。 */
export const PUBLIC_OBSERVATION_FIELDS = [
  'channel',
  'handle',
  'followers',
  'posts_30d',
  'engagement_rate',
  'language',
  'region',
  'categories',
  // WP487（决策 1661 补，只加）：主页上公开的联系方式
  'public_contacts',
  // WP495（1707b，只加）：表格导入带来的资料——名字、主页链接（类目 / 语言 / 地区本来就在上面）
  'display_name',
  'profile_url',
  'observed_at',
] as const satisfies readonly (keyof PublicCreatorObservation)[]

/**
 * WP495（1707b）：**生意数据**——报价、备注、合作状态、日期、负责人。公共库**永远不收**：
 * 观察的白名单（{@link PUBLIC_OBSERVATION_FIELDS}）与一条联系方式的白名单（{@link PUBLIC_CONTACT_FIELDS}）
 * 跟这张表一个键都不许重（本机与云端两边都有测试钉住）。这张表只用来钉，不是「黑名单放行其余」——
 * 收什么只看白名单。
 */
export const PUBLIC_LIBRARY_BUSINESS_KEYS: readonly string[] = [
  // 报价 / 金额
  'price',
  'rate',
  'quote',
  'quoted_price',
  'fee',
  'amount',
  'cost',
  'budget',
  'currency',
  'paid',
  'payment',
  // 备注
  'note',
  'notes',
  'remark',
  'remarks',
  'comment',
  'memo',
  // 合作状态
  'status',
  'stage',
  'collab_status',
  'collaboration_status',
  'collaboration',
  'deal',
  'contract',
  'campaign',
  'campaign_id',
  // 日期
  'date',
  'agreed_at',
  'contacted_at',
  'paid_at',
  'start_date',
  'end_date',
  'due_date',
  'published_date',
  // 负责人
  'owner',
  'owner_id',
  'assignee',
  'manager',
  'person_id',
]

/**
 * WP487（决策 1661 补）：主页上公开的一条联系方式是哪一种。
 *
 * - `email`：主页 / 简介 / 「关于」里公开写着的邮箱；
 * - `website`：个人或品牌官网、link-in-bio 页；
 * - `social`：同一个人在别的平台的主页；
 * - `business`：商务合作入口（「For business inquiries」后面那个邮箱或表单链接）；
 * - `agent`：经纪 / 代理公司的联系（邮箱或链接）。
 */
export type PublicContactKind = 'email' | 'website' | 'social' | 'business' | 'agent'

export const PUBLIC_CONTACT_KINDS: readonly PublicContactKind[] = [
  'email',
  'website',
  'social',
  'business',
  'agent',
]

/** 一条公开联系方式。**就这三格**——没有「从哪个私信里看到的」这种东西。 */
export interface PublicContactLink {
  kind: PublicContactKind
  /** 邮箱（小写）或 `https://` / `http://` 链接（去掉了 `#…` 与跟踪参数）。 */
  value: string
  /** 页面上写在它旁边的那几个字（「Business inquiries」「Managed by …」），最多 {@link PUBLIC_CONTACT_LABEL_MAX} 字。 */
  label?: string
}

/** 一条公开联系方式的字段白名单（云端逐键比对，多一个键整批拒）。 */
export const PUBLIC_CONTACT_FIELDS = [
  'kind',
  'value',
  'label',
] as const satisfies readonly (keyof PublicContactLink)[]

/** 一条观察最多带几条公开联系方式。 */
export const MAX_PUBLIC_CONTACTS = 10
/** 一条联系方式的值最长多少字符。 */
export const PUBLIC_CONTACT_VALUE_MAX = 300
/** 旁边那几个字最长多少字。 */
export const PUBLIC_CONTACT_LABEL_MAX = 60

const PUBLIC_EMAIL_RE = /^[^\s@<>()[\],;:"']+@[^\s@.<>()[\],;:"']+(\.[^\s@.<>()[\],;:"']+)+$/

/** 只是跟踪用的参数：去掉，不算这条链接的一部分。 */
const TRACKING_PARAM_RE =
  /^(utm_[a-z_]*|fbclid|gclid|dclid|msclkid|igsh|igshid|si|ref|ref_src|ref_url|feature|_t|_r|mc_cid|mc_eid)$/i

/**
 * 像是凭据 / 会话的参数名。链接上带了它就**整条不收**——一条带着登录令牌的「网站」
 * 不是红人的公开联系方式，是谁的会话被抄下来了。
 */
const CREDENTIAL_PARAM_RE =
  /(token|secret|passw|pwd|session|signature|apikey|api_key|access_key|credential|jwt|bearer|cookie)|^(auth|code|key|sid|sig|otp|login|state|nonce)$/i

/**
 * 私信 / 收件箱这一类**私人页面**的路径。红人主页上不会公开挂一条通向别人收件箱的链接；
 * 出现了就是把谁自己的私信页抄进来了——不收。（`m.me/<name>`、`wa.me/<号码>` 这种「给我发消息」的
 * 公开入口不在这里：那是主页上公开挂的商务入口。）
 */
const PRIVATE_PATH_RE =
  /\/(direct|messages|message|inbox|chat|conversations?|dm|dms|notifications|settings|account|login|signin|sign-in|oauth|checkpoint)(\/|$)/i

/** 邮箱：小写、形状对才算；`mailto:` 前缀与 `?subject=…` 去掉。 */
function publicEmailOf(raw: string): string | undefined {
  const bare =
    raw
      .replace(/^mailto:/i, '')
      .split('?')[0]
      ?.trim()
      .toLowerCase() ?? ''
  return bare.length <= 254 && PUBLIC_EMAIL_RE.test(bare) ? bare : undefined
}

/** 链接：只要 http(s)、不带账号密码、不通向私信页、不带凭据参数；去掉 `#…` 与跟踪参数。 */
function publicUrlOf(raw: string): string | undefined {
  let url: URL
  try {
    url = new URL(raw.trim())
  } catch {
    return undefined
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') return undefined
  if (url.username !== '' || url.password !== '') return undefined
  if (!url.hostname.includes('.')) return undefined
  if (PRIVATE_PATH_RE.test(url.pathname)) return undefined
  const keep = new URLSearchParams()
  for (const [k, v] of url.searchParams) {
    if (CREDENTIAL_PARAM_RE.test(k)) return undefined
    if (!TRACKING_PARAM_RE.test(k)) keep.append(k, v)
  }
  url.hash = ''
  const query = keep.toString()
  url.search = query === '' ? '' : `?${query}`
  const out = url.toString()
  return out.length <= PUBLIC_CONTACT_VALUE_MAX ? out : undefined
}

/**
 * WP487（决策 1661 补）：一串「主页上公开的联系方式」→ 能上云的那几条。
 *
 * 纯函数、同一份规矩两边用：本机服务在转发前用它**筛**（不合格的那条丢掉，别的照送），
 * 云端用它**判**（筛完和原样不一样 = 这一批不合格，整批拒）。规矩：
 *
 * 1. 只认 {@link PUBLIC_CONTACT_KINDS} 那五种；每条只留 `kind` / `value` / `label`（别的键一律不带）；
 * 2. `email` 必须是邮箱；`website` / `social` 必须是 http(s) 链接；`business` / `agent` 两样都行；
 * 3. 链接上带账号密码、通向私信 / 收件箱 / 登录页、或带像凭据的参数（token、session、key…）——**整条不收**；
 *    `#…` 与 `utm_*` 这类跟踪参数去掉；
 * 4. 同一种同一个值只留一条，最多 {@link MAX_PUBLIC_CONTACTS} 条。
 */
export function sanitizePublicContacts(raw: unknown): PublicContactLink[] {
  if (!Array.isArray(raw)) return []
  const out: PublicContactLink[] = []
  const seen = new Set<string>()
  for (const one of raw) {
    if (out.length >= MAX_PUBLIC_CONTACTS) break
    if (one === null || typeof one !== 'object' || Array.isArray(one)) continue
    const r = one as Record<string, unknown>
    const kind = PUBLIC_CONTACT_KINDS.find((k) => k === r.kind)
    if (kind === undefined || typeof r.value !== 'string') continue
    const text = r.value.trim()
    if (text === '' || text.length > PUBLIC_CONTACT_VALUE_MAX) continue
    const looksMail =
      /^mailto:/i.test(text) || (!/^[a-z][a-z0-9+.-]*:\/\//i.test(text) && text.includes('@'))
    let value: string | undefined
    if (kind === 'email') value = publicEmailOf(text)
    else if (kind === 'website' || kind === 'social')
      value = looksMail ? undefined : publicUrlOf(text)
    else value = looksMail ? publicEmailOf(text) : publicUrlOf(text)
    if (value === undefined) continue
    const key = `${kind}|${value}`
    if (seen.has(key)) continue
    seen.add(key)
    const label =
      typeof r.label === 'string'
        ? Array.from(r.label.replace(/\s+/g, ' ').trim())
            .slice(0, PUBLIC_CONTACT_LABEL_MAX)
            .join('')
        : ''
    out.push({ kind, value, ...(label === '' ? {} : { label }) })
  }
  return out
}

/** 一条观察最多带几个类目。 */
export const MAX_CATEGORIES = 8

/* ── WP495（1707b）：表格导入的公开资料 → 云端收的形状 ── */

/** 展示名最长多少字（与云端搬家那一格同一顶帽子）。 */
export const PUBLIC_DISPLAY_NAME_MAX = 200
/** 一个类目词最长多少字（云端 `MAX_CATEGORY_LENGTH`）。 */
export const PUBLIC_CATEGORY_MAX = 40

/** 表格里常见的语言写法 → BCP-47 主码。认不出的不送（不猜）。 */
const LANGUAGE_NAMES: Record<string, string> = {
  english: 'en',
  英语: 'en',
  英文: 'en',
  chinese: 'zh',
  中文: 'zh',
  汉语: 'zh',
  mandarin: 'zh',
  spanish: 'es',
  西班牙语: 'es',
  french: 'fr',
  法语: 'fr',
  german: 'de',
  德语: 'de',
  japanese: 'ja',
  日语: 'ja',
  korean: 'ko',
  韩语: 'ko',
  portuguese: 'pt',
  葡萄牙语: 'pt',
  italian: 'it',
  意大利语: 'it',
  russian: 'ru',
  俄语: 'ru',
  arabic: 'ar',
  阿拉伯语: 'ar',
  hindi: 'hi',
  indonesian: 'id',
  印尼语: 'id',
  thai: 'th',
  泰语: 'th',
  vietnamese: 'vi',
  越南语: 'vi',
  dutch: 'nl',
  荷兰语: 'nl',
  turkish: 'tr',
  土耳其语: 'tr',
  polish: 'pl',
  波兰语: 'pl',
}

/** 表格里常见的国家 / 地区写法 → ISO-3166 两位码。认不出的不送。 */
const REGION_NAMES: Record<string, string> = {
  美国: 'US',
  usa: 'US',
  'united states': 'US',
  america: 'US',
  英国: 'GB',
  uk: 'GB',
  'united kingdom': 'GB',
  'great britain': 'GB',
  england: 'GB',
  加拿大: 'CA',
  canada: 'CA',
  澳大利亚: 'AU',
  澳洲: 'AU',
  australia: 'AU',
  德国: 'DE',
  germany: 'DE',
  法国: 'FR',
  france: 'FR',
  日本: 'JP',
  japan: 'JP',
  韩国: 'KR',
  korea: 'KR',
  'south korea': 'KR',
  中国: 'CN',
  china: 'CN',
  西班牙: 'ES',
  spain: 'ES',
  意大利: 'IT',
  italy: 'IT',
  墨西哥: 'MX',
  mexico: 'MX',
  巴西: 'BR',
  brazil: 'BR',
  印度: 'IN',
  india: 'IN',
  新加坡: 'SG',
  singapore: 'SG',
  马来西亚: 'MY',
  malaysia: 'MY',
  印尼: 'ID',
  印度尼西亚: 'ID',
  indonesia: 'ID',
  泰国: 'TH',
  thailand: 'TH',
  越南: 'VN',
  vietnam: 'VN',
  菲律宾: 'PH',
  philippines: 'PH',
  荷兰: 'NL',
  netherlands: 'NL',
  新西兰: 'NZ',
  'new zealand': 'NZ',
  阿联酋: 'AE',
  uae: 'AE',
  沙特: 'SA',
  'saudi arabia': 'SA',
}

const BCP47_RE = /^[a-z]{2,3}(?:-[a-z0-9]{2,8})*$/i
// biome-ignore lint/suspicious/noControlCharactersInRegex: 就是要挡掉控制字符
const CONTROL_RE = /[\u0000-\u001f\u007f]/g

/** 展示名：收空白、去控制字符、截到 {@link PUBLIC_DISPLAY_NAME_MAX} 字；空了就没有。 */
export function publicDisplayNameOf(raw: unknown): string | undefined {
  if (typeof raw !== 'string') return undefined
  const text = Array.from(raw.replace(CONTROL_RE, ' ').replace(/\s+/g, ' ').trim())
    .slice(0, PUBLIC_DISPLAY_NAME_MAX)
    .join('')
    .trim()
  return text === '' ? undefined : text
}

/** 主页链接：同 {@link sanitizePublicContacts} 的链接规矩（只要 http(s)、不带凭据、不通私信页，去跟踪参数）。 */
export function publicProfileUrlOf(raw: unknown): string | undefined {
  return typeof raw === 'string' && raw.trim() !== '' ? publicUrlOf(raw) : undefined
}

/** 语言：BCP-47 的形状就用（`en` / `zh-CN`），常见写法（English / 英语）换成主码；别的不送。 */
export function publicLanguageOf(raw: unknown): string | undefined {
  if (typeof raw !== 'string') return undefined
  const text = raw.trim()
  if (text === '') return undefined
  const named = LANGUAGE_NAMES[text.toLowerCase()]
  if (named !== undefined) return named
  if (text.length > 20 || !BCP47_RE.test(text)) return undefined
  const [primary, ...rest] = text.split('-')
  return [primary?.toLowerCase(), ...rest.map((p) => (p.length === 2 ? p.toUpperCase() : p))].join(
    '-',
  )
}

/** 地区：两位码就用（大写；`UK` → `GB`），常见写法（美国 / United States）换成两位码；别的不送。 */
export function publicRegionOf(raw: unknown): string | undefined {
  if (typeof raw !== 'string') return undefined
  const text = raw.trim()
  const named = REGION_NAMES[text.toLowerCase()]
  if (named !== undefined) return named
  return /^[A-Za-z]{2}$/.test(text) ? text.toUpperCase() : undefined
}

/** 类目：按 `, ， / 、 ; ； |` 拆开，小写、去重，每个不超过 {@link PUBLIC_CATEGORY_MAX} 字，最多 {@link MAX_CATEGORIES} 个。 */
export function publicCategoriesOf(raw: unknown): string[] | undefined {
  const parts = Array.isArray(raw)
    ? raw.filter((x): x is string => typeof x === 'string')
    : typeof raw === 'string'
      ? raw.split(/[,，/、;；|]/)
      : []
  const out: string[] = []
  for (const part of parts) {
    const word = part.replace(/\s+/g, ' ').trim().toLowerCase()
    if (word === '' || word.length > PUBLIC_CATEGORY_MAX || out.includes(word)) continue
    out.push(word)
    if (out.length >= MAX_CATEGORIES) break
  }
  return out.length === 0 ? undefined : out
}

/** 一条导入红人的资料（本机红人库里那几格的原样）。 */
export interface PublicProfileInput {
  display_name?: string | undefined
  url?: string | undefined
  category?: string | undefined
  language?: string | undefined
  region?: string | undefined
}

/** 能上云的资料那几格（{@link PUBLIC_OBSERVATION_FIELDS} 里的键）。 */
export type PublicProfileFields = Pick<
  PublicCreatorObservation,
  'display_name' | 'profile_url' | 'categories' | 'language' | 'region'
>

/**
 * WP495（1707b）：表格导入带来的资料 → 公共库收的那几格。**只看这五格的入参**，生意数据（报价、备注、
 * 合作状态、日期、负责人）在入参里就没有位置。每一格各自规整，认不出的那一格丢掉、别的照送
 * （云端「拒而不改」：一格不合格整批拒，所以本机这边先筛干净）。
 */
export function sanitizePublicProfile(input: PublicProfileInput): PublicProfileFields {
  const display_name = publicDisplayNameOf(input.display_name)
  const profile_url = publicProfileUrlOf(input.url)
  const categories = publicCategoriesOf(input.category)
  const language = publicLanguageOf(input.language)
  const region = publicRegionOf(input.region)
  return {
    ...(display_name === undefined ? {} : { display_name }),
    ...(profile_url === undefined ? {} : { profile_url }),
    ...(categories === undefined ? {} : { categories }),
    ...(language === undefined ? {} : { language }),
    ...(region === undefined ? {} : { region }),
  }
}

/** 一次最多上报多少条观察。 */
export const MAX_OBSERVATIONS_PER_BATCH = 100

/**
 * 公共库里对外的那张卡。
 *
 * **没有邮箱**：有没有联系方式只用 `has_contact` 一个布尔表示，
 * 明文要付费 reveal（`data.kol.lookup`）。
 */
export interface PublicCreatorCard {
  channel: KolChannel
  handle: string
  followers: number
  posts_30d: number
  engagement_rate: number
  language?: string
  region?: string
  categories: string[]
  /** 最近一次被看到的时刻。 */
  observed_at: Iso8601
  /** 现在这张卡的资料是哪个来源写的。 */
  source: KolObservationSource
  /** 一共有几条观察落在这个红人上（体检报告的样本量）。 */
  observations: number
  /** 0–1。来源档 + 观察条数 + 新鲜度三项合成。 */
  confidence: number
  /** 库里有没有这个人的联系方式（**只说有没有，不说是什么**）。 */
  has_contact: boolean
  updated_at: Iso8601

  /*
   * ↓ WP116 搬家（48 §5.3 / 64 §10.2）新增的几格。全是**可选**：本系统自己攒的
   * 行一格都不给，只有从别处搬进来的才有。加它们的理由是搬家那一刻必须无损——
   * 丢掉 `external_id` 之后"同一个人改了 handle"就再也认不回来了。
   */

  /**
   * 平台原生 id（YouTube 的 channelId、IG / TikTok 的 user id）。
   *
   * 库的主键仍然是 `{ channel, handle }`（自足键那条纪律不动），这一格只是
   * **搬家与去重的锚**：handle 会被改，原生 id 不会。
   */
  external_id?: string
  /** 展示名（频道名 / 昵称）。`handle` 是账号名，这一格是给人看的那个名字。 */
  name?: string
  /** 头像地址。**只存地址不存图**——图会过期，而我们不做图床。 */
  avatar_url?: string
  /** 国家 / 地区（ISO-3166 两位）；与 `region` 同义，搬家来的那一批填这一格。 */
  country?: string
  /** 同一个人在多个渠道的分组 id（库内分组，不对外解释成"这就是同一个人"）。 */
  person_id?: string
  /**
   * 对不上我们字段的那些公开事实。
   *
   * **只放标量**（数、串、真假），不放正文、不放数组、不放嵌套对象——
   * `extra` 是一个"别丢掉"的兜底，不是一个可以往里塞任何东西的口袋。
   */
  extra?: Record<string, string | number | boolean>
  /** 这一行是从哪儿搬来的（`kolagents`）。空 = 本系统自己攒的。 */
  imported_from?: string

  /**
   * WP202（只加）：卡上**哪几格其实没有数**。
   *
   * `posts_30d` / `engagement_rate` 在这张卡上是必填的数（老契约，不改），可插件报的观察
   * 与搬家来的那一批常常没有这两个数，主表里只能垫 0。有这一格时，列在里面的那几个数
   * **是垫的、不是真的 0**：客户端当它「没有」（界面显示「—」），别当 0% 算。
   * 没有这一格 = 两个数都是真的。
   */
  metrics_missing?: PublicCreatorMetric[]
}

/** WP202：卡上可能「其实没有」的那两格。 */
export type PublicCreatorMetric = 'posts_30d' | 'engagement_rate'

/** 浏览的过滤条件（全是可选的；`limit` 有上限 {@link MAX_CREATOR_LIMIT}）。 */
export interface PublicCreatorQuery {
  channel?: KolChannel
  /** 在 handle 与类目里找（子串，大小写不敏感）。 */
  q?: string
  min_followers?: number
  category?: string
  limit?: number
}

export const DEFAULT_CREATOR_LIMIT = 20
export const MAX_CREATOR_LIMIT = 100

/**
 * 库里的联系方式。**明文一个字节都没有**：
 * `email_sha256` 用来去重与"同一人合并"（48 §1.2），`email_cipher` 是云侧
 * 租户无关的服务密钥加出来的密文（密钥只从环境变量读，见包的 README）。
 */
export interface PublicCreatorContact {
  channel: KolChannel
  handle: string
  /** 小写化邮箱的 sha256（十六进制）。 */
  email_sha256: string
  /** `iv.tag.ciphertext`（都是 base64url）。 */
  email_cipher: string
  source: KolObservationSource
  /** 谁回填的（给贡献奖励用；不进任何对外响应）。 */
  contributed_by: WorkspaceId
  at: Iso8601

  /*
   * ↓ WP116 搬家新增，全可选。合规上最要紧的是 `source_url`：
   * "这个邮箱你从哪儿看到的" 是任何一次移除请求的第一个问题。
   */

  /** 贡献者当时看到这个邮箱的**公开页面**地址（合规审计线索）。 */
  source_url?: string
  /**
   * 比 `source` 更细的一档（`plugin_manual` / `observation_email` /
   * `youtube_channel_description` / `apify_tiktok_bio` / `manual`）。
   *
   * 为什么不把 `source` 的枚举扩开：那四档是**可信度的档位**（`SOURCE_CONFIDENCE`
   * 按它查表），细分路径是另一件事。混成一个枚举等于每加一条采集路径就要
   * 重新校准一次可信度。
   */
  source_detail?: string
  /** 0–1。搬家来的那一批按原系统的确认 / 报错数折出来。 */
  confidence?: number
  /** 有几个人确认过这条是对的。 */
  confirmations?: number
  /** 有几个人报过错。 */
  disputes?: number
}

/**
 * 一条**内容样本**（WP116 搬家：`public_content` 那一层）。
 *
 * 为什么公共库里要有内容：判断一个红人值不值得合作，"他最近发的东西大概长什么样、
 * 播放量在什么量级"比粉丝数有用得多。而这些是**创作者自己公开发布的元数据**
 * （标题、封面、时长、播放数），不是 48 §1.3 第 4 条挡的那种正文（评论 / 私信 /
 * 视频文案）——**这里一个字的评论都不收**。
 */
export interface PublicContentSample {
  channel: KolChannel
  /** 归属的红人（自足键的另一半）。 */
  handle: string
  /** 平台原生内容 id（YouTube 的 videoId、IG 的 shortcode）。 */
  external_id: string
  content_type: 'video' | 'post' | 'reel'
  /** 标题。它是创作者给自己作品起的名字，不是正文。 */
  title?: string
  url?: string
  thumbnail_url?: string
  /** 从标题里摘出来的话题标签（**不带 `#`**）。 */
  tags?: string[]
  orientation?: 'landscape' | 'portrait'
  duration_seconds?: number
  published_at?: Iso8601
  views?: number
  likes?: number
  comments?: number
  shares?: number
  /**
   * WP129：页面上有没有「含付费推广」这一类广告标识（平台自己打的那个标，
   * 不是我们猜的）。没看到 / 没采到就没有这一格——`false` 是"看过、没有"。
   */
  paid_promotion?: boolean
  /** WP129：有没有带货（商品标签 / 购物车 / 商品链接那一类平台原生入口）。语义同上。 */
  shoppable?: boolean
  /** 这份快照**被看到**的时刻。 */
  observed_at: Iso8601
  source: KolObservationSource
  updated_at: Iso8601
}

/**
 * 一条**内容观测**（WP129）：插件在视频页看到的那一刻的数，经本机服务转发进公共库。
 *
 * 与 {@link PublicCreatorObservation} 同一条纪律：键就是白名单
 * （{@link PUBLIC_CONTENT_OBSERVATION_FIELDS}），多一个键整批拒——**没有评论这一格**，
 * 也没有页面地址 / 封面地址（带平台的一次性参数）与任何用户自己写的备注。
 * `comments` 是评论**数**，不是评论。
 */
export interface PublicContentObservation {
  channel: KolChannel
  /** 作者在这条渠道上的 handle（自足键的另一半；只认 handle，不认平台内部 id）。 */
  handle: string
  /** 平台原生内容 id（YouTube 的 videoId、IG 的 shortcode）。 */
  external_id: string
  content_type: 'video' | 'post' | 'reel'
  /** 标题。创作者给自己作品起的名字，不是正文。 */
  title?: string
  published_at?: Iso8601
  duration_seconds?: number
  orientation?: 'landscape' | 'portrait'
  views?: number
  likes?: number
  comments?: number
  shares?: number
  paid_promotion?: boolean
  shoppable?: boolean
  /** 这一刻**被看到**的时间。幂等按它分桶（{@link CONTENT_OBSERVATION_BUCKET}）。 */
  observed_at: Iso8601
}

/** 内容观测的字段白名单。运行时逐键比对：不在这张表里的一律拒。 */
export const PUBLIC_CONTENT_OBSERVATION_FIELDS = [
  'channel',
  'handle',
  'external_id',
  'content_type',
  'title',
  'published_at',
  'duration_seconds',
  'orientation',
  'views',
  'likes',
  'comments',
  'shares',
  'paid_promotion',
  'shoppable',
  'observed_at',
] as const satisfies readonly (keyof PublicContentObservation)[]

/**
 * 内容观测的幂等分桶：**同一条内容（渠道 + external_id）同一个 UTC 日只算一条**。
 *
 * 与本机 `content_observation` 的去重同一个口径（插件离线攒的队列补传、多人同一天
 * 看同一条视频，都不会让一条事实变成几条）。桶内重复报只刷新卡上的数、不再多记
 * 一行指标、也不算贡献奖励。
 */
export const CONTENT_OBSERVATION_BUCKET = 'utc_day' as const

/**
 * 一条**指标快照**（WP116 搬家：`public_creator_metric` 那一层）。
 *
 * 与 {@link PublicCreatorObservation} 刻意分开，理由只有一条：观察要带
 * `posts_30d` 与 `engagement_rate`，而搬进来的那一批**没有这两个数**。
 * 把 0 填进观察表会让 k-匿名基准的中位互动率变成 0——一个编出来的数比
 * 没有数坏得多（21 §4）。所以它们落在自己这张表上，只出现在"粉丝增长"
 * 这类看得见来源的地方。
 */
export interface PublicCreatorMetricSnapshot {
  channel: KolChannel
  handle: string
  followers?: number
  /** 近期作品的平均播放量。 */
  avg_views?: number
  /** 账号累计作品数（不是近 30 天）。 */
  video_count?: number
  /** 账号累计播放量。 */
  total_views?: number
  observed_at: Iso8601
  source: KolObservationSource
}

/** 同一个人在多个渠道的分组（WP116 搬家：`public_person`）。**只分组，不下结论**。 */
export interface PublicPerson {
  id: string
  display_name?: string
  created_at: Iso8601
  updated_at: Iso8601
}

/**
 * 搬家的一行。NDJSON 一行一条，`kind` 是判别键。
 *
 * 为什么是一个联合而不是六个接口 / 六个路由：搬家是**一次性**的，而一次性的东西
 * 越少入口越好。一个 `POST /v1/admin/kol/import` 收所有 kind，脚本一趟推完，
 * 顺序由脚本保证（先 person / creator，再 contact / content / metric）。
 */
export type KolImportRecord =
  | ({ kind: 'person' } & PublicPerson)
  | ({
      kind: 'creator'
      /** 落库用的自足键的一半；没有 handle 的账号用 `external_id` 顶上。 */
      handle: string
      channel: KolChannel
      external_id?: string
      name?: string
      avatar_url?: string
      country?: string
      language?: string
      person_id?: string
      followers?: number
      posts_30d?: number
      engagement_rate?: number
      categories?: string[]
      observed_at?: Iso8601
      extra?: Record<string, string | number | boolean>
    } & Record<string, unknown>)
  | ({
      kind: 'contact'
      channel: KolChannel
      handle: string
      /** **明文**（只在导入的那一趟里出现；落库前就变成哈希 + 密文）。 */
      email: string
      source?: KolObservationSource
      source_url?: string
      source_detail?: string
      confirmations?: number
      disputes?: number
      at?: Iso8601
    } & Record<string, unknown>)
  | ({ kind: 'content' } & Partial<PublicContentSample> & {
        channel: KolChannel
        handle: string
        external_id: string
      })
  | ({ kind: 'content_metric' } & {
      channel: KolChannel
      handle: string
      /** 归属内容的平台原生 id。 */
      content_external_id: string
      views?: number
      likes?: number
      comments?: number
      shares?: number
      observed_at?: Iso8601
      source?: KolObservationSource
    })
  | ({ kind: 'metric' } & Partial<PublicCreatorMetricSnapshot> & {
        channel: KolChannel
        handle: string
      })

/** 搬家一趟的结果。**坏行不让整趟失败**，但要数出来。 */
export interface KolImportResult {
  received: number
  inserted: number
  updated: number
  skipped: number
  /** 一条一句人话（同一个理由合并计数）。 */
  rejected: { reason: string; count: number }[]
  at: Iso8601
}

/** 一次搬家最多推多少行（脚本按它分块）。 */
export const MAX_KOL_IMPORT_BATCH = 500

/** 公共红人库在运营后台那一页看到的那几个数（65 / WP116）。 */
export interface KolLibraryStats {
  creators: number
  contacts: number
  contents: number
  observations: number
  /** 从别处搬进来的红人行数。 */
  imported: number
  /** 被移除过（opt-out）的条数。 */
  removed: number
  new_7d: number
  new_30d: number
  by_channel: { channel: KolChannel; creators: number; contacts: number }[]
  at: Iso8601
}

/** 付费 reveal 的返回：明文**只在这里出现一次**。 */
export interface RevealedContact {
  channel: KolChannel
  handle: string
  email: string
  source: KolObservationSource
  at: Iso8601
  /** 这一次扣了多少积分（0 = 这个组织本次没有被计费，见响应里的说明）。 */
  credits: number
}

/** 体检报告的风险标记。**只标不判**——是不是不合作由用户自己定。 */
export type AuditRiskFlag =
  | 'no_recent_posts'
  | 'engagement_far_below_peers'
  | 'engagement_far_above_peers'
  | 'follower_spike'
  | 'single_source'
  | 'stale_data'

/**
 * 体检报告（免费那份 `depth: 'basic'`；付费深度体检这一版也是 `basic` 的骨架 +
 * 基准分位，真的深度分析留给后续 WP）。
 *
 * **数据不足就明说**：`insufficient_samples` 为真时几个估计值一格都没有，
 * 而不是给一个编出来的数（21 §4「说不出来就说说不出来」）。
 */
export interface AuditReport {
  channel: KolChannel
  handle: string
  depth: 'basic' | 'deep'
  /** 这份报告基于几条观察。 */
  sample_size: number
  insufficient_samples: boolean
  /** 粉丝真实度估计（0–1）。样本不够就没有这一格。 */
  follower_authenticity?: number
  /** 互动率在同渠道同粉丝量级里的分位（0–100）。基准桶不够 k 就没有这一格。 */
  engagement_percentile?: number
  /** 近 30 天有没有发布。 */
  active_30d: boolean
  risk_flags: AuditRiskFlag[]
  /** 深度体检才有：这个桶的分位数（k-匿名过关时）。 */
  benchmark?: Benchmark
  /** 一句人话，说清楚这份报告能信到什么程度。 */
  note: string
  /**
   * 这一次扣了多少积分（WP126 起体检报告按 `data.kol.audit` 收；老调用方
   * 看不到这一格时当 0 处理——字段是后加的，契约只加不删）。
   */
  credits?: number
  generated_at: Iso8601
}

/** 出一份可用的体检报告至少要几条观察。 */
export const MIN_AUDIT_SAMPLES = 3

/** 一条资料多久算"旧"（体检报告会标 `stale_data`）。 */
export const STALE_AFTER_DAYS = 90

/** 粉丝量级分桶（k-匿名基准按它分组）。 */
export type FollowersBand = '0-10k' | '10k-100k' | '100k-1m' | '1m+'

export const FOLLOWERS_BANDS: readonly FollowersBand[] = ['0-10k', '10k-100k', '100k-1m', '1m+']

/** 一个粉丝数落在哪个桶。 */
export function followersBandOf(followers: number): FollowersBand {
  if (followers < 10_000) return '0-10k'
  if (followers < 100_000) return '10k-100k'
  if (followers < 1_000_000) return '100k-1m'
  return '1m+'
}

/**
 * k-匿名基准（21）。
 *
 * **每个桶至少 {@link BENCHMARK_MIN_SAMPLES} 条观察才出数**，否则
 * `insufficient_samples: true` 且分位数一格都没有。只回分位数，不回个体——
 * 一个桶里只有三个人的时候，"p50 是多少"就等于把那三个人的数报出去了。
 */
export interface Benchmark {
  channel: KolChannel
  category: string
  followers_band: FollowersBand
  sample_size: number
  insufficient_samples: boolean
  engagement_rate?: { p25: number; p50: number; p75: number }
  followers?: { p25: number; p50: number; p75: number }
  computed_at: Iso8601
}

/** k 的那个 k。低于它不出数。 */
export const BENCHMARK_MIN_SAMPLES = 20

/** 类目没填时用的那一档（基准按渠道 + 量级出，不按类目）。 */
export const ANY_CATEGORY = 'any'

/**
 * 插件配对（48 §5.3「插件采集汇聚」）。
 *
 * 用工作区服务令牌换一把**插件令牌**：短期（{@link PLUGIN_TOKEN_TTL_MS}）、
 * 可撤、库里**只有哈希**。明文只在 {@link IssuedPluginToken} 里出现一次。
 * 为什么不让插件直接拿工作区令牌：插件跑在浏览器里，那把令牌能调模型、能看余额——
 * 一个装在几千台电脑上的扩展不该握着它（18 §1 最小动作集）。
 */
export interface PluginPairing {
  id: string
  workspace_id: WorkspaceId
  org_id: string
  account_id: string
  /** 给人看的名字（"Chrome 上的采集插件"）。 */
  label: string
  token_sha256: string
  issued_at: Iso8601
  expires_at: Iso8601
  revoked_at?: Iso8601
  /** 累计有效观察条数（贡献奖励按它算）。 */
  valid_observations: number
  /** 累计已发的奖励积分。 */
  granted_credits: number
}

/** 配对的返回：明文只在这里出现一次。 */
export interface IssuedPluginToken {
  pairing: PluginPairing
  /** `plg_…`。不进日志、不进事件、不进任何库。 */
  token: string
  expires_at: Iso8601
}

/** 插件令牌前缀。 */
export const PLUGIN_TOKEN_PREFIX = 'plg_'

/** 插件令牌有效期：30 天（18 §1「短期」，没有"永不过期"这一档）。 */
export const PLUGIN_TOKEN_TTL_MS = 30 * 24 * 60 * 60 * 1000

/** 每个插件每天最多上报多少条观察；超了 429。 */
export const MAX_PLUGIN_OBSERVATIONS_PER_DAY = 500

/**
 * 贡献发不发积分奖励。**09-23 Luoye 定：不发**——红人观测、联系方式、内容观测一律
 * 不返 `granted` 积分（推翻 48 §5.3「免费（有贡献奖励）」、49 §3「贡献奖励发 granted」、
 * 75 §2 口径③）。贡献照旧免费、照旧不预扣；「贡献了什么」照旧记账（配额表的累计数、
 * 配对行的有效条数、每次结算回执里的 received / accepted）。下面几个奖励常量留着
 * （契约只加不删），只是不再生效。
 */
export const CONTRIBUTION_REWARDS_ENABLED = false

/** 多少条**有效**观察换 1 积分。（09-23 起停发，见 {@link CONTRIBUTION_REWARDS_ENABLED}） */
export const OBSERVATIONS_PER_CREDIT = 100

/** 同一个 handle 多久之内重复上报不算有效（风控）。 */
export const OBSERVATION_DEDUPE_HOURS = 24

/** 一个贡献者一天最多拿多少奖励积分（风控）。 */
export const MAX_DAILY_REWARD_CREDITS = 5

/** 奖励积分是"送的"那一类：{@link CONTRIBUTION_CREDIT_TTL_DAYS} 天到期清零（49 §3）。 */
export const CONTRIBUTION_CREDIT_TTL_DAYS = 90

/** 回填一条新联系方式给多少积分。 */
export const CONTACT_REWARD_CREDITS = 1

/**
 * 一次贡献结算的结果（上报观察 / 回填联系方式都回它）。
 *
 * `rejected` 里是**为什么没算**，一条一句人话——风控不该是一个静默的 0。
 */
export interface ContributionEvent {
  /** WP129 加 `content`（内容观测；契约只加不删）。 */
  kind: 'observation' | 'contact' | 'content'
  /** 收到几条。 */
  received: number
  /** 其中几条算有效（过了去重与白名单）。 */
  accepted: number
  /** 这一次发了多少奖励积分。09-23 起恒为 0（{@link CONTRIBUTION_REWARDS_ENABLED}）。 */
  credits_granted: number
  /** 今天还能拿多少（到 {@link MAX_DAILY_REWARD_CREDITS} 封顶）。09-23 起恒为 0。 */
  daily_reward_remaining: number
  /** 今天这个插件还能报多少条。 */
  daily_quota_remaining: number
  rejected: { reason: string; count: number }[]
  at: Iso8601
}

/** 争议：某条公开资料不对。**只记不裁**——owner 后台看，系统不自动改数据。 */
export interface Dispute {
  id: string
  channel: KolChannel
  handle: string
  /** 哪一格不对（`followers` / `region` / `contact` …）。 */
  field: string
  /** 一句话说明。**不收正文**：最长 {@link MAX_DISPUTE_CLAIM} 个字。 */
  claim: string
  reported_by: WorkspaceId
  org_id: string
  status: 'open'
  at: Iso8601
}

export const MAX_DISPUTE_CLAIM = 500

/** 三条能力名（价目表 `pricing.json` 里本来就有这三条，WP59 留的）。 */
export const KOL_LOOKUP_CAPABILITY = 'data.kol.lookup'
export const KOL_AUDIT_CAPABILITY = 'data.kol.audit'
/** 联系方式揭示（09-23 Luoye 按 docs/77 定，从 lookup 里单开：0.8 积分 / 次）。 */
export const KOL_REVEAL_CAPABILITY = 'data.kol.reveal'
export const SOCIAL_FETCH_CAPABILITY = 'social.fetch'

/** 计价单位（价目表里那三条都是按次）。 */
export const KOL_UNIT = 'call'

/**
 * YouTube 官方 API 的**全站**日配额（单位，不是次数）。耗尽自动降级到 Apify。
 *
 * 为什么是全站一个池子而不是按租户分：配额本来就是我们这把 key 的配额，
 * 按租户切只会让第一个租户把别人的份额也占着（48 §1.2 的原文做法）。
 */
export const YOUTUBE_UNITS_PER_DAY = 10_000

/** 一次搜索 / 一次频道读各消耗多少单位（YouTube Data API 的官方口径）。 */
export const YOUTUBE_UNIT_COST = { search: 100, channel: 1 } as const

/**
 * @deprecated 决策 291（WP281）：「数据不出境」删了，本机不再发这个头，云端收到也忽略。
 * 私有云 `packages/kol-public/src/routes.ts` 还在 import，等那边（WP280）去掉再删。
 */
export const KOL_REGION_HEADER = 'X-Agentsws-Region'

/** 公共库这一组要的动作集（18 §1 最小动作集）。 */
export const KOL_PUBLIC_SCOPE = 'data'
