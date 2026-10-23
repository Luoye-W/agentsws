/** 移植自 agentsws-extension `src/lib/kol/countryFlag.ts` @ 57fca9c（源自 KOLAgents 旧插件 d25b877）。决策 1739 A：只搬采集器与指标算法；开源仓这一份只改 import 路径（与注释里点名私有插件 / 模板的几个词），本体逐字不动。 */
/** 移植自 KOLAgents 浏览器插件（Browser Extension - Influencer Assistant） `src/lib/countryFlag.ts` @ d25b877（原移植基准 6a7de9b；与 d25b877 相比只差 import 路径与下面写明的本仓改动）。 */
/**
 * Country name / ISO code → flag emoji. YouTube exposes a localized country
 * name ("United States" / "美国"), TikTok a 2-letter region code ("US") — map
 * both to the regional-indicator flag. Returns "" when unrecognized.
 */
const NAME_TO_CODE: Record<string, string> = {
  // English
  "united states": "US",
  "united states of america": "US",
  usa: "US",
  "united kingdom": "GB",
  uk: "GB",
  england: "GB",
  canada: "CA",
  australia: "AU",
  germany: "DE",
  france: "FR",
  spain: "ES",
  italy: "IT",
  netherlands: "NL",
  ireland: "IE",
  austria: "AT",
  switzerland: "CH",
  sweden: "SE",
  norway: "NO",
  denmark: "DK",
  finland: "FI",
  poland: "PL",
  portugal: "PT",
  brazil: "BR",
  mexico: "MX",
  argentina: "AR",
  chile: "CL",
  colombia: "CO",
  japan: "JP",
  "south korea": "KR",
  korea: "KR",
  china: "CN",
  "hong kong": "HK",
  taiwan: "TW",
  singapore: "SG",
  malaysia: "MY",
  indonesia: "ID",
  thailand: "TH",
  vietnam: "VN",
  philippines: "PH",
  india: "IN",
  pakistan: "PK",
  "united arab emirates": "AE",
  "saudi arabia": "SA",
  turkey: "TR",
  "türkiye": "TR",
  israel: "IL",
  egypt: "EG",
  "south africa": "ZA",
  nigeria: "NG",
  russia: "RU",
  ukraine: "UA",
  "new zealand": "NZ",
  // Chinese
  美国: "US",
  英国: "GB",
  加拿大: "CA",
  澳大利亚: "AU",
  德国: "DE",
  法国: "FR",
  西班牙: "ES",
  意大利: "IT",
  荷兰: "NL",
  日本: "JP",
  韩国: "KR",
  中国: "CN",
  香港: "HK",
  台湾: "TW",
  新加坡: "SG",
  马来西亚: "MY",
  印度尼西亚: "ID",
  泰国: "TH",
  越南: "VN",
  菲律宾: "PH",
  印度: "IN",
  阿联酋: "AE",
  土耳其: "TR",
  巴西: "BR",
  墨西哥: "MX",
  俄罗斯: "RU"
}

export function countryFlag(country?: string): string {
  if (!country) return ""
  const trimmed = country.trim()
  const code =
    /^[A-Za-z]{2}$/.test(trimmed) && trimmed === trimmed.toUpperCase()
      ? trimmed
      : NAME_TO_CODE[trimmed.toLowerCase()] || NAME_TO_CODE[trimmed]
  if (!code || !/^[A-Z]{2}$/.test(code)) return ""
  return String.fromCodePoint(
    ...[...code].map((ch) => 0x1f1e6 + ch.charCodeAt(0) - 65)
  )
}
