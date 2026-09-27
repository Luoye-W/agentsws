/**
 * WP166（Luoye 09-27 定）：**目标市场一处定、处处用**。
 *
 * 真源只有一个：`WorkspaceProfile.markets`（大写两位国家码）。初始化时我们从官网 / Amazon 链接推一份，
 * 让用户看见、能增删；店铺连上后用店里配的市场 / 配送区域校正一次。违规宣称规则开组、SERP 与
 * AI 问答探测、每日判断里的搜索结果页人群核对，全读这一份。
 *
 * 这个文件只放大家都要认的那几样：国家码清单、归一化、以及「这份市场是从哪看出来的」。
 */
import type { Iso8601 } from './common.js'

/**
 * ISO 3166-1 alpha-2 全部正式分配的国家 / 地区码（界面的国家选择器与归一化都认它）。
 * 中文 / 英文国名不写死：界面与解析都用 `Intl.DisplayNames` 现取。
 */
export const MARKET_COUNTRY_CODES: readonly string[] = (
  'AD AE AF AG AI AL AM AO AQ AR AS AT AU AW AX AZ BA BB BD BE BF BG BH BI BJ BL BM BN BO BQ BR BS ' +
  'BT BV BW BY BZ CA CC CD CF CG CH CI CK CL CM CN CO CR CU CV CW CX CY CZ DE DJ DK DM DO DZ EC EE ' +
  'EG EH ER ES ET FI FJ FK FM FO FR GA GB GD GE GF GG GH GI GL GM GN GP GQ GR GS GT GU GW GY HK HM ' +
  'HN HR HT HU ID IE IL IM IN IO IQ IR IS IT JE JM JO JP KE KG KH KI KM KN KP KR KW KY KZ LA LB LC ' +
  'LI LK LR LS LT LU LV LY MA MC MD ME MF MG MH MK ML MM MN MO MP MQ MR MS MT MU MV MW MX MY MZ NA ' +
  'NC NE NF NG NI NL NO NP NR NU NZ OM PA PE PF PG PH PK PL PM PN PR PS PT PW PY QA RE RO RS RU RW ' +
  'SA SB SC SD SE SG SH SI SJ SK SL SM SN SO SR SS ST SV SX SY SZ TC TD TF TG TH TJ TK TL TM TN TO ' +
  'TR TT TV TW TZ UA UG UM US UY UZ VA VC VE VG VI VN VU WF WS YE YT ZA ZM ZW'
).split(' ')

/** 跨境卖家最常选的那一批（选择器里排在最前面；其余按国名排）。 */
export const COMMON_MARKETS: readonly string[] = [
  'US',
  'GB',
  'CA',
  'AU',
  'DE',
  'FR',
  'JP',
  'NL',
  'IT',
  'ES',
  'SE',
  'IE',
  'NZ',
  'SG',
  'CH',
  'KR',
  'MX',
  'AE',
  'SA',
  'CN',
  'HK',
  'TW',
]

const KNOWN = new Set(MARKET_COUNTRY_CODES)

/** 归一化一份市场清单：去空白、大写、只认清单里的两位码（`UK` 按 `GB` 认）、去重、保序。 */
export function normalizeMarkets(list: readonly string[] | undefined): string[] {
  const out: string[] = []
  for (const raw of list ?? []) {
    const code = raw.trim().toUpperCase()
    const cc = code === 'UK' ? 'GB' : code
    if (KNOWN.has(cc) && !out.includes(cc)) out.push(cc)
  }
  return out
}

/**
 * 这份市场是从哪看出来的（界面问号里那一句「我们从 xx 看出来的」）。
 *
 * - `site`：官网（语言切换 / hreflang / 国家域名 / 配送政策 / 「Ships to …」/ 结账币种）；
 * - `amazon`：Amazon 链接的站点（amazon.co.uk → 英国）；
 * - `store`：店铺后台里配的市场 / 配送区域（连上店以后校正的那一次）；
 * - `human`：人自己在档案卡或设置页里改的（之后自动的都不再覆盖它）。
 */
export interface MarketsSource {
  from: 'site' | 'amazon' | 'store' | 'human'
  /** 出处（同 `BrandIntakeEvidence` 的形状：哪个网址、哪一层、原文片段）。 */
  evidence?: { url: string; locator: string; quote?: string }[]
  /** 校正时那一句人话（「店里还配了 加拿大，已加上」）。 */
  note?: string
  at: Iso8601
}

/**
 * WP169（Luoye 09-27 定）：每个市场的**主要语言**（ISO 639-1 小写）。每周 AI 问答探测用它问
 * （问题由模型从品牌语言翻过来），每日搜索结果页（SERP）的 `language` 也按它。
 *
 * 多语国家取第一语言（加拿大 → 英语、瑞士 → 德语、比利时 → 荷兰语、新加坡 / 印度 → 英语）；
 * 台湾 / 香港 / 澳门带地区子标签（繁体：`zh-tw` / `zh-hk`），大陆是 `zh`。
 * 档案里可以按市场覆盖（`WorkspaceProfile.market_languages`）。表里没有的市场按品牌语言问。
 */
export const MARKET_PRIMARY_LANGUAGE: Readonly<Record<string, string>> = {
  US: 'en',
  GB: 'en',
  CA: 'en',
  AU: 'en',
  NZ: 'en',
  IE: 'en',
  SG: 'en',
  IN: 'en',
  ZA: 'en',
  PH: 'en',
  NG: 'en',
  KE: 'en',
  MT: 'en',
  JM: 'en',
  TT: 'en',
  DE: 'de',
  AT: 'de',
  CH: 'de',
  LI: 'de',
  LU: 'de',
  FR: 'fr',
  BE: 'nl',
  MC: 'fr',
  SN: 'fr',
  CI: 'fr',
  MA: 'ar',
  DZ: 'ar',
  TN: 'ar',
  NL: 'nl',
  IT: 'it',
  SM: 'it',
  VA: 'it',
  ES: 'es',
  AD: 'ca',
  PT: 'pt',
  BR: 'pt',
  MX: 'es',
  AR: 'es',
  CL: 'es',
  CO: 'es',
  PE: 'es',
  UY: 'es',
  PY: 'es',
  BO: 'es',
  EC: 'es',
  VE: 'es',
  CR: 'es',
  PA: 'es',
  GT: 'es',
  HN: 'es',
  SV: 'es',
  NI: 'es',
  DO: 'es',
  PR: 'es',
  CU: 'es',
  SE: 'sv',
  NO: 'no',
  DK: 'da',
  FI: 'fi',
  IS: 'is',
  EE: 'et',
  LV: 'lv',
  LT: 'lt',
  PL: 'pl',
  CZ: 'cs',
  SK: 'sk',
  HU: 'hu',
  RO: 'ro',
  MD: 'ro',
  BG: 'bg',
  GR: 'el',
  CY: 'el',
  HR: 'hr',
  SI: 'sl',
  RS: 'sr',
  BA: 'bs',
  ME: 'sr',
  MK: 'mk',
  AL: 'sq',
  UA: 'uk',
  BY: 'be',
  RU: 'ru',
  KZ: 'kk',
  TR: 'tr',
  IL: 'he',
  GE: 'ka',
  AM: 'hy',
  AZ: 'az',
  AE: 'ar',
  SA: 'ar',
  QA: 'ar',
  KW: 'ar',
  BH: 'ar',
  OM: 'ar',
  JO: 'ar',
  LB: 'ar',
  EG: 'ar',
  IQ: 'ar',
  IR: 'fa',
  JP: 'ja',
  KR: 'ko',
  CN: 'zh',
  HK: 'zh-hk',
  TW: 'zh-tw',
  MO: 'zh-hk',
  TH: 'th',
  VN: 'vi',
  ID: 'id',
  MY: 'ms',
  BD: 'bn',
  PK: 'ur',
  LK: 'si',
  NP: 'ne',
  KH: 'km',
  MN: 'mn',
}

/** ISO 639-1（可带地区子标签，如 `zh-tw`；与搜索数据接口认的同一个口径）。 */
const LANGUAGE_CODE = /^[a-z]{2,3}(-[a-z0-9]{2,8})?$/

/** 归一化档案里的覆盖表：国家码按 {@link normalizeMarkets} 认、语言码小写（`de` / `zh-tw`）；认不出的丢掉。 */
export function normalizeMarketLanguages(
  map: Readonly<Record<string, string>> | undefined,
): Record<string, string> {
  const out: Record<string, string> = {}
  for (const [k, v] of Object.entries(map ?? {})) {
    const [code] = normalizeMarkets([k])
    const lang = typeof v === 'string' ? v.trim().toLowerCase() : ''
    if (code !== undefined && LANGUAGE_CODE.test(lang)) out[code] = lang
  }
  return out
}

/** 一个市场用什么语言问：档案里覆盖的优先，其次表里的第一语言；都没有回 `undefined`（按品牌语言）。 */
export function marketLanguage(
  code: string,
  overrides?: Readonly<Record<string, string>> | undefined,
): string | undefined {
  const cc = code.trim().toUpperCase() === 'UK' ? 'GB' : code.trim().toUpperCase()
  return normalizeMarketLanguages(overrides)[cc] ?? MARKET_PRIMARY_LANGUAGE[cc]
}
