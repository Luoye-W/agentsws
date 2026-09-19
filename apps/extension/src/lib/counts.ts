/**
 * 页面上那串数字 → 一个数（`1.2万位订阅者` → `12000`）。
 *
 * 两条铁律（照 KOLAgents 同一套，错一处就会把该发现的人滤掉）：
 *
 * 1. **解析只在本机发生，解析结果绝不上行**。往本机服务与公共红人库报的是
 *    页面上那串**原文**（`followers_text`）。理由很直白：解析错了一条，
 *    错的数就进了所有人共用的库；而原文错不了——它就是页面上印的字。
 * 2. **认不出来 ≠ 0**。回 `undefined`。搜索结果页的视频行本来就不印订阅数，
 *    把它当 0 会让「订阅数 ≥ 1000」这条筛选把它们全部滤掉，
 *    而那些正是这个功能最擅长发现的人。
 *
 * 认的写法：`1,234` / `1.2K` / `3.4M` / `1.2万` / `2亿` / `1.234` (de)
 * / `1 234` (fr，含窄空格与 NBSP)。拉丁单位必须**整词**——`1234 members` 里
 * 那个 m 不是百万。
 */

/** 数字部分：允许普通空格 / NBSP / 窄 NBSP 当千分位。 */
const NUMBER_PATTERN = /(\d[\d.,   ]*\d|\d)/

/** 拉丁单位必须整词匹配，`k` 后面不能直接跟别的字母。 */
const LATIN_UNIT = /^[a-zA-Z]+/

const LATIN_MULTIPLIERS: Record<string, number> = {
  k: 1e3,
  thousand: 1e3,
  thousands: 1e3,
  m: 1e6,
  mn: 1e6,
  mio: 1e6,
  mil: 1e6,
  million: 1e6,
  millions: 1e6,
  b: 1e9,
  bn: 1e9,
  billion: 1e9,
  billions: 1e9,
}

/** 数字之后那一段的倍率。CJK 看首字符，拉丁看整词。 */
function unitMultiplier(rest: string): number {
  const head = rest.charAt(0)
  if (head === '万' || head === '萬' || head === '만') return 1e4
  if (head === '亿' || head === '億') return 1e8
  if (head === '千') return 1e3
  const word = LATIN_UNIT.exec(rest)?.[0]
  if (word === undefined) return 1
  return LATIN_MULTIPLIERS[word.toLowerCase()] ?? 1
}

/**
 * 把一串页面文本解析成数。认不出来回 `undefined`（**不是 0**）。
 */
export function parseCompactCount(raw: string | undefined | null): number | undefined {
  if (raw === undefined || raw === null) return undefined
  const text = raw.trim()
  if (text === '') return undefined

  const match = NUMBER_PATTERN.exec(text)
  if (match?.[1] === undefined) return undefined
  const digits = match[1]
  const rest = text.slice(match.index + digits.length).trimStart()
  const multiplier = unitMultiplier(rest)

  // 先剥掉空格类千分位（fr / ru）
  let normalized = digits.replace(/[   ]/g, '')

  if (/^\d{1,3}(,\d{3})+(\.\d+)?$/.test(normalized)) {
    // en 风格：逗号是千分位
    normalized = normalized.replace(/,/g, '')
  } else if (multiplier === 1 && /^\d{1,3}(\.\d{3})+(,\d+)?$/.test(normalized)) {
    // de / es 风格：点是千分位、逗号是小数点。
    // **只在没有单位时**才这么认——`1.234M` 的点必须当小数点，否则会算成 12.34 亿。
    normalized = normalized.replace(/\./g, '').replace(',', '.')
  } else {
    // 剩下的情况里逗号只可能是小数点
    normalized = normalized.replace(',', '.')
  }

  const value = Number(normalized)
  if (!Number.isFinite(value) || value < 0) return undefined
  return Math.round(value * multiplier)
}

/** 把数字写回人看的样子（卡片上用；导出那一行用整数原值）。 */
export function formatCount(value: number | undefined): string {
  if (value === undefined || !Number.isFinite(value)) return '-'
  if (value >= 1e8) return `${(value / 1e8).toFixed(1)}亿`
  if (value >= 1e4) return `${(value / 1e4).toFixed(1)}万`
  return new Intl.NumberFormat('zh-CN').format(Math.round(value))
}
