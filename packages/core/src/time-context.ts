/**
 * WP180：每次运行的上下文里写一次「现在时间 + 公司时区」（ContextItem `time`）。
 *
 * **为什么不直接挂官方 `@deepseek-ai/dsh-time-context`**（出处：它的 README「Summary / Use this package」
 * 与 `lib/types/index.d.ts`）——三条都是硬伤，不是嫌麻烦：
 *
 * 1. 它是 dsh agent-loop 的 `agent/pre-step` 监听器，**只有 dsh 一档挂得上**；stub / direct 两档没有这个钩子，
 *    挂了就破三运行时同一份提示词（模拟 parity、回放铁律 17 §6.1 都靠这一条）。
 * 2. 它自己读墙钟（`Date.now`），模拟与回放用的是注入的时钟——提示词每跑一次都不一样，基线与金样没法钉。
 * 3. 它按"这一轮请求里浏览器报的时区"定时区，缺了就用 `timeZone` 配置 / 进程时区；我们的运行没有浏览器时区记录，
 *    公司时区在工作区档案里（`Workspace.tz`）。
 *
 * 所以意思照官方（时间 + 时区 + "不带时区的日期按这个时区理解"），落点换成**一条 ContextItem**：三个运行时都按
 * 同一个装配函数渲染（`@agentsws/stand-ins` 的 `assemblePrompt` / dsh 的 `systemPrompt.context`），逐字相同。
 * 官方的默认刷新频率是 10 分钟（`refreshIntervalMs` 缺省 600000）；我们一次运行只写一次、**按小时取整**——
 * 22 §2 缓存纪律（`truncateToHour`）：时间戳类内容截到小时，否则每分钟都换提示词前缀、缓存永不命中。
 *
 * 时区：公司档案（工作区）里有、而且认得出就用它；没有 / 认不出就用本机时区（再不行 UTC）。
 */
import type { ContextItem, Iso8601 } from '@agentsws/contracts'

/** 这一条 ContextItem 的 id（一次运行只有一条）。 */
export const TIME_CONTEXT_ID = 'now'

/** 本机时区（`Intl` 认不出就 UTC）。 */
export function hostTimeZone(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC'
  } catch {
    return 'UTC'
  }
}

function validZone(zone: string | undefined): zone is string {
  if (zone === undefined || zone.trim() === '') return false
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: zone })
    return true
  } catch {
    return false
  }
}

/** 公司时区：档案里的认得出就用它，否则本机时区。 */
export function resolveTimeZone(
  companyTz: string | undefined,
  host: string = hostTimeZone(),
): { zone: string; source: 'company' | 'host' } {
  if (validZone(companyTz)) return { zone: companyTz, source: 'company' }
  return { zone: validZone(host) ? host : 'UTC', source: 'host' }
}

const WEEKDAY_ZH = ['周日', '周一', '周二', '周三', '周四', '周五', '周六']

/** 某一刻在某个时区里的年月日、星期、小时，以及 UTC 偏移（`+08:00`）。 */
function localParts(iso: Iso8601, zone: string) {
  const at = new Date(iso)
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: zone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    hourCycle: 'h23',
    weekday: 'short',
    timeZoneName: 'longOffset',
  }).formatToParts(at)
  const get = (t: Intl.DateTimeFormatPartTypes): string =>
    parts.find((p) => p.type === t)?.value ?? ''
  const days = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']
  const offset = get('timeZoneName').replace(/^GMT/, '') || '+00:00'
  return {
    date: `${get('year')}-${get('month')}-${get('day')}`,
    hour: get('hour'),
    weekday: WEEKDAY_ZH[days.indexOf(get('weekday'))] ?? '',
    offset,
  }
}

/** 这一条的正文（按小时取整）。 */
export function timeContextText(input: { now: Iso8601; zone: string }): string {
  const p = localParts(input.now, input.zone)
  return (
    `现在是 ${p.date}（${p.weekday}）${p.hour}:00 前后，公司时区 ${input.zone}（UTC${p.offset}）。` +
    '没写时区的日期和时间都按这个时区理解。'
  )
}

/**
 * 组这一条 ContextItem。`now` 用运行的时钟（生产是墙钟，模拟 / 回放是注入的时钟）；
 * `companyTz` 是工作区档案里的时区；`hostTz` 只给测试用。
 */
export function timeContextItem(input: {
  now: Iso8601
  companyTz?: string | undefined
  hostTz?: string | undefined
}): ContextItem {
  const { zone } = resolveTimeZone(input.companyTz, input.hostTz ?? hostTimeZone())
  const content = timeContextText({ now: input.now, zone })
  return {
    id: TIME_CONTEXT_ID,
    kind: 'time',
    source_ref: 'clock',
    sensitivity: 'internal',
    content,
    bytes: new TextEncoder().encode(content).byteLength,
  }
}
