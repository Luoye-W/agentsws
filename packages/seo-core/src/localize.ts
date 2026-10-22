/**
 * WP449（docs/109 §5.1 #5）：多语言——**给另一个市场的版本**对不对得上那个市场。
 *
 * 写是模型的事（技能 `content-localize`：译完再本地化）；这里只放规则能判的那几样，发布前质检用：
 *
 * 1. **这篇是给谁的**：认语言（常用词计数，不经模型）→ 品牌档案里说这种语言的市场；
 *    档案里只有一个市场（或几个市场同一种语言）= 没配多市场，不出多语言建议（{@link localizationTargets}）。
 * 2. **市场写法**（{@link checkLocaleText}）：货币（德国写欧元，不写美元价）、计量单位（公制市场不写
 *    英寸 / 磅 / 华氏度）、数字写法（德语小数用逗号、千位用点）、日期（美国以外不写「月/日/年」）、
 *    称呼（同一篇里 Sie / du 不混）。
 * 3. **换了写法的数还是那个数**（{@link figureValues} / {@link factFigureVariants}）：事实卡上写 `10,000 mAh`、
 *    德语版写 `10.000 mAh`；卡上写 `86°F`、德语版写 `30 °C`——按数值与固定换算比，不让换写法的数被当成「编的数」。
 *
 * 方法借鉴 AgriciDaniel/claude-blog（MIT）的 blog-translate（各地数字 / 日期 / 货币写法表）、blog-localize
 * （称呼、货币、法规口径）、blog-locale-audit（逐项对一遍）；**代码一行没搬**（上游是提示词 + Python）。
 */

import type { ContentQualityIssue } from '@agentsws/contracts'
import { normalizeMarkets } from '@agentsws/contracts'

/* ------------------------------------------------------------------ */
/* 认语言                                                              */
/* ------------------------------------------------------------------ */

/** 各语言最常见的虚词（只认这几种：跨境独立站最常写的）。 */
const STOPWORDS: Readonly<Record<string, readonly string[]>> = {
  en: [
    'the',
    'and',
    'is',
    'are',
    'with',
    'for',
    'you',
    'your',
    'this',
    'that',
    'of',
    'to',
    'it',
    'on',
    'can',
  ],
  de: [
    'der',
    'die',
    'das',
    'und',
    'ist',
    'mit',
    'für',
    'sie',
    'du',
    'nicht',
    'ein',
    'eine',
    'auf',
    'den',
    'dem',
    'auch',
    'oder',
    'wie',
  ],
  fr: [
    'le',
    'la',
    'les',
    'et',
    'est',
    'avec',
    'pour',
    'vous',
    'une',
    'des',
    'du',
    'que',
    'pas',
    'sur',
    'dans',
  ],
  es: [
    'el',
    'la',
    'los',
    'las',
    'y',
    'es',
    'con',
    'para',
    'una',
    'que',
    'del',
    'por',
    'tu',
    'su',
    'más',
  ],
  it: [
    'il',
    'lo',
    'gli',
    'e',
    'è',
    'con',
    'per',
    'una',
    'che',
    'del',
    'della',
    'non',
    'sono',
    'anche',
  ],
  nl: [
    'de',
    'het',
    'en',
    'is',
    'met',
    'voor',
    'je',
    'een',
    'niet',
    'van',
    'op',
    'ook',
    'zijn',
    'jouw',
  ],
  pt: ['o', 'os', 'as', 'e', 'é', 'com', 'para', 'uma', 'que', 'do', 'da', 'não', 'você', 'seu'],
}

/**
 * 这段文字是哪种语言（ISO 639-1）。中日韩看字形；其余数常见虚词，第一名要明显领先第二名才算，
 * 认不准回 `undefined`（宁可不判，也不拿错的市场去卡人家）。
 */
export function detectLanguage(text: string): string | undefined {
  const sample = text.slice(0, 20_000)
  const kana = (sample.match(/[぀-ヿ]/g) ?? []).length
  const hangul = (sample.match(/[가-힯]/g) ?? []).length
  const han = (sample.match(/[㐀-鿿]/g) ?? []).length
  const latinWords = sample.toLowerCase().match(/[a-zà-öø-ÿß]+/g) ?? []
  const cjk = kana + hangul + han
  if (cjk > latinWords.length) {
    if (kana > cjk * 0.1) return 'ja'
    if (hangul > cjk * 0.3) return 'ko'
    return 'zh'
  }
  if (latinWords.length < 8) return undefined
  const counts = Object.entries(STOPWORDS).map(([lang, words]) => {
    const set = new Set(words)
    return [lang, latinWords.filter((w) => set.has(w)).length] as const
  })
  counts.sort((a, b) => b[1] - a[1])
  const [first, second] = counts
  if (first === undefined || first[1] < 3) return undefined
  if (second !== undefined && first[1] < second[1] * 1.5) return undefined
  return first[0]
}

/* ------------------------------------------------------------------ */
/* 市场写法                                                            */
/* ------------------------------------------------------------------ */

export interface MarketConvention {
  /** ISO 4217。 */
  currency: string
  /** 用公制（美国不是；英国路程与饮料还用英制，不查单位）。 */
  metric: boolean | 'mixed'
  /** 日期顺序。 */
  date: 'mdy' | 'dmy' | 'ymd'
}

const EURO = [
  'AT',
  'BE',
  'CY',
  'DE',
  'EE',
  'ES',
  'FI',
  'FR',
  'GR',
  'HR',
  'IE',
  'IT',
  'LT',
  'LU',
  'LV',
  'MT',
  'NL',
  'PT',
  'SI',
  'SK',
]

/** 跨境卖家常选的那一批市场的写法（表里没有的市场：货币 / 日期不查，单位按公制查）。 */
export const MARKET_CONVENTIONS: Readonly<Record<string, MarketConvention>> = {
  ...Object.fromEntries(EURO.map((c) => [c, { currency: 'EUR', metric: true, date: 'dmy' }])),
  US: { currency: 'USD', metric: false, date: 'mdy' },
  GB: { currency: 'GBP', metric: 'mixed', date: 'dmy' },
  CA: { currency: 'CAD', metric: true, date: 'ymd' },
  AU: { currency: 'AUD', metric: true, date: 'dmy' },
  NZ: { currency: 'NZD', metric: true, date: 'dmy' },
  CH: { currency: 'CHF', metric: true, date: 'dmy' },
  SE: { currency: 'SEK', metric: true, date: 'ymd' },
  NO: { currency: 'NOK', metric: true, date: 'dmy' },
  DK: { currency: 'DKK', metric: true, date: 'dmy' },
  PL: { currency: 'PLN', metric: true, date: 'dmy' },
  CZ: { currency: 'CZK', metric: true, date: 'dmy' },
  JP: { currency: 'JPY', metric: true, date: 'ymd' },
  KR: { currency: 'KRW', metric: true, date: 'ymd' },
  CN: { currency: 'CNY', metric: true, date: 'ymd' },
  HK: { currency: 'HKD', metric: true, date: 'dmy' },
  TW: { currency: 'TWD', metric: true, date: 'ymd' },
  SG: { currency: 'SGD', metric: true, date: 'dmy' },
  MX: { currency: 'MXN', metric: true, date: 'dmy' },
  BR: { currency: 'BRL', metric: true, date: 'dmy' },
  AE: { currency: 'AED', metric: true, date: 'dmy' },
  SA: { currency: 'SAR', metric: true, date: 'dmy' },
}

/** 货币怎么写出来（符号与代码；`$` 几家共用，按「不是这家」才报）。 */
const CURRENCY_MARKS: Readonly<Record<string, readonly string[]>> = {
  USD: ['US$', 'USD', '$'],
  EUR: ['€', 'EUR', 'Euro'],
  GBP: ['£', 'GBP'],
  CAD: ['C$', 'CA$', 'CAD', '$'],
  AUD: ['A$', 'AU$', 'AUD', '$'],
  NZD: ['NZ$', 'NZD', '$'],
  CHF: ['CHF'],
  JPY: ['¥', '円', 'JPY'],
  CNY: ['¥', '元', 'CNY', 'RMB'],
  SEK: ['SEK', 'kr'],
  NOK: ['NOK', 'kr'],
  DKK: ['DKK', 'kr'],
  PLN: ['PLN', 'zł'],
  MXN: ['MXN', '$'],
  BRL: ['R$', 'BRL'],
  HKD: ['HK$', 'HKD', '$'],
  SGD: ['S$', 'SGD', '$'],
}

/** 小数点写逗号的语言（千位用点或空格）。 */
const DECIMAL_COMMA = new Set([
  'de',
  'fr',
  'es',
  'it',
  'nl',
  'pt',
  'pl',
  'sv',
  'da',
  'no',
  'fi',
  'cs',
  'ru',
  'tr',
])

export function usesDecimalComma(language: string): boolean {
  return DECIMAL_COMMA.has(language.split('-')[0] ?? language)
}

/* ------------------------------------------------------------------ */
/* 给谁写：品牌档案里的市场                                            */
/* ------------------------------------------------------------------ */

export interface LocaleBrand {
  /** 品牌自己的语言（源稿的语言）。 */
  language: string
  /** 品牌档案里的目标市场。 */
  markets?: readonly string[]
  /** 档案里按市场覆盖的语言。 */
  market_languages?: Readonly<Record<string, string>>
}

/** 一个市场说什么语言（档案覆盖的优先，其次常用表；只取主语言 `de`、`zh-tw` 记成 `zh`）。 */
function languageOfMarket(
  code: string,
  brand: LocaleBrand,
  primary: (c: string) => string | undefined,
): string | undefined {
  const lang = brand.market_languages?.[code] ?? primary(code)
  return lang?.split('-')[0]
}

/**
 * 要不要出多语言建议、出哪几种：品牌档案里**说别的语言**的市场按语言分组。
 * 空 = 没配多市场（只有一个市场，或几个市场同一种语言），这一类建议不出。
 */
export function localizationTargets(
  brand: LocaleBrand,
  primary: (code: string) => string | undefined,
): { language: string; markets: string[] }[] {
  const markets = normalizeMarkets(brand.markets ? [...brand.markets] : [])
  if (markets.length < 2) return []
  const own = brand.language.split('-')[0]
  const groups = new Map<string, string[]>()
  for (const m of markets) {
    const lang = languageOfMarket(m, brand, primary)
    if (lang === undefined || lang === own) continue
    groups.set(lang, [...(groups.get(lang) ?? []), m])
  }
  return [...groups].map(([language, ms]) => ({ language, markets: ms }))
}

/** 一篇稿子的语言 → 品牌档案里说这种语言的市场（没有 = 空）。 */
export function marketsForLanguage(
  language: string,
  brand: LocaleBrand,
  primary: (code: string) => string | undefined,
): string[] {
  const lang = language.split('-')[0]
  return normalizeMarkets(brand.markets ? [...brand.markets] : []).filter(
    (m) => languageOfMarket(m, brand, primary) === lang,
  )
}

/* ------------------------------------------------------------------ */
/* 数：换了写法还是那个数                                              */
/* ------------------------------------------------------------------ */

/**
 * 一个数字串（`extractFigures` 取出来的）可能是哪几个数。按这种语言的写法读；
 * 认不准写法的（`1,234` 在德语里也可能是 1.234）两种都给。
 */
export function figureValues(raw: string, language?: string): number[] {
  const s = raw.replace(/[%\s_']/g, '').replace(/ | /g, '')
  const out = new Set<number>()
  const read = (decimalComma: boolean): number | undefined => {
    let t = s
    if (decimalComma) t = t.replace(/\./g, '').replace(/,/g, '.')
    else t = t.replace(/,/g, '')
    if (!/^\d+(\.\d+)?$/.test(t)) return undefined
    return Number(t)
  }
  const comma = language !== undefined && usesDecimalComma(language)
  const first = read(comma)
  if (first !== undefined) out.add(first)
  // 只有一个分隔符、后面正好三位：两种读法都有可能
  if (/^\d{1,3}[.,]\d{3}$/.test(s)) {
    const other = read(!comma)
    if (other !== undefined) out.add(other)
  }
  if (out.size === 0) {
    const fallback = read(!comma)
    if (fallback !== undefined) out.add(fallback)
  }
  return [...out]
}

/** 小数位数（按这种语言的写法数）。 */
export function figureDecimals(raw: string, language?: string): number {
  const s = raw.replace(/[%\s_']/g, '')
  const sep = language !== undefined && usesDecimalComma(language) ? ',' : '.'
  const i = s.lastIndexOf(sep)
  if (i < 0) return 0
  const tail = s.slice(i + 1)
  // 「10.000」在德语里是千位分隔，不是小数
  if (sep === '.' && /^\d{3}$/.test(tail) && /^\d{1,3}(\.\d{3})+$/.test(s)) return 0
  return tail.length
}

/** 英制 → 公制的固定换算（只收商品页常见的几样）。 */
const CONVERSIONS: readonly { re: RegExp; to: (v: number) => number[] }[] = [
  {
    re: /(\d+(?:[.,]\d+)?)\s*(?:-|\s)?(?:inch(?:es)?|in\.|″|")/gi,
    to: (v) => [v * 2.54, v * 25.4],
  },
  { re: /(\d+(?:[.,]\d+)?)\s*(?:lbs?|pounds?)\b/gi, to: (v) => [v * 0.45359237, v * 453.59237] },
  { re: /(\d+(?:[.,]\d+)?)\s*(?:fl\.?\s*oz)\b/gi, to: (v) => [v * 29.5735] },
  { re: /(\d+(?:[.,]\d+)?)\s*(?:oz|ounces?)\b/gi, to: (v) => [v * 28.349523125] },
  { re: /(\d+(?:[.,]\d+)?)\s*(?:ft|feet|foot)\b/gi, to: (v) => [v * 0.3048, v * 30.48] },
  { re: /(\d+(?:[.,]\d+)?)\s*(?:miles?|mi)\b/gi, to: (v) => [v * 1.609344] },
  { re: /(\d+(?:[.,]\d+)?)\s*mph\b/gi, to: (v) => [v * 1.609344] },
  { re: /(\d+(?:[.,]\d+)?)\s*(?:gallons?|gal)\b/gi, to: (v) => [v * 3.785411784] },
  { re: /(\d+(?:[.,]\d+)?)\s*°\s*F\b/gi, to: (v) => [((v - 32) * 5) / 9] },
]

/**
 * 一张事实卡里的数，换成公制之后可能写成什么（`6.1 inch` → 15.494 cm / 154.94 mm）。
 * 只给换算后的**精确值**；比的时候按稿子里那个数的小数位四舍五入（{@link figureMatchesValue}）。
 */
export function factFigureVariants(statement: string): number[] {
  const out: number[] = []
  for (const c of CONVERSIONS)
    for (const m of statement.matchAll(c.re)) {
      const v = Number((m[1] ?? '').replace(',', '.'))
      if (Number.isFinite(v)) out.push(...c.to(v))
    }
  return out
}

/** 稿子里的这个数（按它自己的小数位）是不是这几个值之一四舍五入来的。 */
export function figureMatchesValue(
  raw: string,
  language: string | undefined,
  known: readonly number[],
): boolean {
  const decimals = figureDecimals(raw, language)
  const values = figureValues(raw, language)
  const f = 10 ** decimals
  return values.some((v) =>
    known.some((k) => Math.abs(Math.round(k * f) / f - v) < 1e-9 || Math.abs(k - v) < 1e-9),
  )
}

/* ------------------------------------------------------------------ */
/* 逐句查市场写法                                                      */
/* ------------------------------------------------------------------ */

const IMPERIAL =
  /(\d[\d.,]*\s*(?:-|\s)?(?:inch(?:es)?|lbs?|pounds?|oz|ounces?|ft|feet|miles?|mph|gallons?|°\s*F)\b)|\b(?:fahrenheit)\b/i

/** 德 / 法 / 西 / 荷的「您」与「你」（同一篇里只许一种）。 */
const ADDRESS: Readonly<
  Record<string, { formal: RegExp; informal: RegExp; formalName: string; informalName: string }>
> = {
  // 句首的 Sie 也可能是「她 / 他们」，只数句中大写的那几个
  de: {
    formal: /(?<=\S\s)(?:Sie|Ihnen|Ihr|Ihre|Ihren|Ihrem|Ihrer)\b/,
    informal:
      /\b(?:du|dich|dir|dein|deine|deinen|deinem|deiner|Du|Dich|Dir|Dein|Deine|Deinen|Deinem|Deiner)\b/,
    formalName: 'Sie',
    informalName: 'du',
  },
  fr: {
    formal: /\b(?:vous|votre|vos)\b/i,
    informal: /\b(?:tu|toi|ton|ta|tes)\b/i,
    formalName: 'vous',
    informalName: 'tu',
  },
  es: {
    formal: /\b(?:usted|ustedes)\b/i,
    informal: /\b(?:tú|te|ti|tu|tus|contigo)\b/i,
    formalName: 'usted',
    informalName: 'tú',
  },
  nl: {
    formal: /\b(?:u|uw)\b/,
    informal: /\b(?:je|jij|jou|jouw)\b/i,
    formalName: 'u',
    informalName: 'je',
  },
}

export interface LocaleCheckInput {
  sentences: readonly { text: string }[]
  /** 这篇的语言（`de`）。 */
  language: string
  /** 给哪几个市场（品牌档案里说这种语言的那几个）。 */
  markets: readonly string[]
  /** 品牌定了用「您」还是「你」（不给 = 只查前后一致）。 */
  address?: 'formal' | 'informal'
}

function currencyIssues(sentence: string, markets: readonly string[]): string | undefined {
  const allowed = new Set(
    markets.map((m) => MARKET_CONVENTIONS[m]?.currency).filter((c): c is string => c !== undefined),
  )
  if (allowed.size === 0) return undefined
  const okMarks = new Set([...allowed].flatMap((c) => CURRENCY_MARKS[c] ?? []))
  for (const [code, marks] of Object.entries(CURRENCY_MARKS)) {
    if (allowed.has(code)) continue
    for (const mark of marks) {
      if (okMarks.has(mark)) continue
      const esc = mark.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
      const re = /^[A-Za-z]+$/.test(mark)
        ? new RegExp(`(\\b${esc}\\s?\\d|\\d[\\d.,]*\\s?${esc}\\b)`)
        : new RegExp(`(${esc}\\s?\\d|\\d[\\d.,]*\\s?${esc})`)
      if (re.test(sentence))
        return `这一版给 ${markets.join(' / ')}，价钱要写 ${[...allowed].join(' / ')}，这里写的是 ${code}（「${mark}」）。事实卡里没有当地价就别写价，链到商品页。`
    }
  }
  return undefined
}

/** 逐句查一个市场版本的写法（货币 / 单位 / 数字 / 日期 / 称呼）。纯规则。 */
export function checkLocaleText(input: LocaleCheckInput): ContentQualityIssue[] {
  const issues: ContentQualityIssue[] = []
  const conv = input.markets
    .map((m) => MARKET_CONVENTIONS[m])
    .filter((c): c is MarketConvention => c !== undefined)
  const metric = conv.length > 0 ? conv.every((c) => c.metric === true) : true
  const dateOrder = conv[0]?.date
  const comma = usesDecimalComma(input.language)
  const lang = input.language.split('-')[0] ?? input.language
  const address = ADDRESS[lang]
  const formal: string[] = []
  const informal: string[] = []
  for (const { text } of input.sentences) {
    const push = (detail: string) =>
      issues.push({ rule: 'locale_mismatch', sentence: text, detail })
    const money = currencyIssues(text, input.markets)
    if (money !== undefined) push(money)
    const imp = IMPERIAL.exec(text)
    if (metric && imp !== null)
      push(
        `这一版给 ${input.markets.join(' / ')}，用公制：「${imp[0].trim()}」要换成厘米 / 克 / 摄氏度（换算由事实卡上的数算，别估）。`,
      )
    if (comma) {
      // 英文写法的小数（4.5）与千位（10,000）
      // 「USB 3.2」「Bluetooth 5.3」「PD3.0」这类型号不算（前面紧挨着字母）
      const dec =
        /(?<![\d.,])(?<!\b(?:USB|USB-C|Bluetooth|BT|PD|QC|Qi|Qi2|iOS|Android|Wi-?Fi|HDMI|DisplayPort|Thunderbolt|Version|v|V)\s?)\d+\.\d{1,2}(?![\d.,]*\d)/.exec(
          text,
        )
      if (dec !== null)
        push(`数字写法：这一版小数点用逗号，「${dec[0]}」要写成「${dec[0].replace('.', ',')}」。`)
      const thou = /(?<![\d.,])\d{1,3}(?:,\d{3})+(?![\d,]*\d)(?!,\d)/.exec(text)
      if (thou !== null && dec === null)
        push(`数字写法：这一版千位用点，「${thou[0]}」要写成「${thou[0].replace(/,/g, '.')}」。`)
    }
    if (dateOrder !== undefined && dateOrder !== 'mdy') {
      const us = /\b(0?[1-9]|1[0-2])\/(0?[1-9]|[12]\d|3[01])\/(\d{4}|\d{2})\b/.exec(text)
      if (us !== null && Number(us[2]) > 12)
        push(`日期写法：「${us[0]}」是美国的「月/日/年」，这一版要写「日.月.年」或写出月份名。`)
    }
    if (address !== undefined) {
      if (address.formal.test(text)) formal.push(text)
      if (address.informal.test(text)) informal.push(text)
    }
  }
  if (address !== undefined) {
    const want = input.address
    if (want === 'formal' && informal[0] !== undefined)
      issues.push({
        rule: 'locale_mismatch',
        sentence: informal[0],
        detail: `称呼：品牌定的是「${address.formalName}」，这句用了「${address.informalName}」。`,
      })
    else if (want === 'informal' && formal[0] !== undefined)
      issues.push({
        rule: 'locale_mismatch',
        sentence: formal[0],
        detail: `称呼：品牌定的是「${address.informalName}」，这句用了「${address.formalName}」。`,
      })
    else if (want === undefined && formal.length > 0 && informal.length > 0) {
      const minor = formal.length <= informal.length ? formal[0] : informal[0]
      const name = formal.length <= informal.length ? address.formalName : address.informalName
      issues.push({
        rule: 'locale_mismatch',
        sentence: minor ?? '',
        detail: `称呼前后不一致：同一篇里「${address.formalName}」和「${address.informalName}」混着用，这句是「${name}」。整篇定一种。`,
      })
    }
  }
  return issues
}
