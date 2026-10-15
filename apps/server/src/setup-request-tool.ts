/**
 * WP334（决策 724，Luoye 10-15）：`request_setup` 真接上——**AI 自己要连接卡 / 配置卡**（定义在 `@agentsws/stand-ins`
 * 的 `runtime/setup-request.ts`）。
 *
 * 这里只做三件事：认出 AI 要的是哪一样（连接目录 / 内置那几样 / 登记过的设置目标）、已经好了就说一声、
 * 没好就回一格**结构化缺项**（`needs_connection` / `needs_setup` + 为什么 + 建议值）。卡由运行时在这一轮收尾时
 * 照 WP324 的规则出（`setupCards.onRunBlocked`：同一缺项只一张、补完按原话接着做）——AI 要卡与工具撞上缺项走同一条路。
 *
 * 纪律：没有一格收凭据。「为什么」「建议值」里像口令 / 密钥的整条拒收（回话里不回显那段字）；
 * 像秘密的设置键（{@link isSecretLikeSetupKey}）也拒——那些只能在卡上的本机原生表单里填。
 */
import {
  BUILTIN_CONNECT_NEEDS,
  builtinConnectNeed,
  type ConnectNeed,
  isSecretLikeSetupKey,
  looksLikeSecretValue,
} from '@agentsws/contracts'
import {
  REQUEST_SETUP_TOOL,
  type SetupRequestData,
  type ToolExecution,
  type ToolExecutor,
} from '@agentsws/stand-ins'

export interface SetupRequestToolOptions {
  /** 连接目录里能就地连的那几样（`service` → 人话名、kind）。 */
  directory(): Promise<readonly { kind: string; service: string; name: string }[]>
  /** 这一样现在连上了没有（认不出回 `undefined`）。 */
  isConnected(need: ConnectNeed): Promise<boolean | undefined>
  /** 一个设置目标（登记过才有）。 */
  target(
    id: string,
  ): Promise<{ id: string; name: string; satisfied(): Promise<boolean> } | undefined>
  /** 登记过的设置目标（认不出时列给模型看）。 */
  targetIds(): Promise<readonly string[]>
}

const WHY_MAX = 80

const str = (v: unknown): string | undefined =>
  typeof v === 'string' && v.trim() !== '' ? v.trim() : undefined

const refuse = (reason: string): ToolExecution => ({ status: 'error', reason })

/** 建议值两种写法都认：`[{ key, value }]`（dsh 严格参数表）或 `{ key: value }`。 */
function suggestionsOf(raw: unknown): Record<string, string> {
  const out: Record<string, string> = {}
  if (Array.isArray(raw)) {
    for (const row of raw) {
      const o = row !== null && typeof row === 'object' ? (row as Record<string, unknown>) : {}
      const key = str(o.key)
      const value = typeof o.value === 'string' ? o.value.trim() : undefined
      if (key !== undefined && value !== undefined && value !== '') out[key] = value
    }
  } else if (raw !== null && typeof raw === 'object') {
    for (const [k, v] of Object.entries(raw as Record<string, unknown>))
      if (typeof v === 'string' && v.trim() !== '') out[k.trim()] = v.trim()
  }
  return out
}

/** WP348：每个建议值的一句理由（`[{ key, value, why }]` 那一种才有）。 */
function reasonsOf(raw: unknown): Record<string, string> {
  const out: Record<string, string> = {}
  if (!Array.isArray(raw)) return out
  for (const row of raw) {
    const o = row !== null && typeof row === 'object' ? (row as Record<string, unknown>) : {}
    const key = str(o.key)
    const why = str(o.why)
    if (key !== undefined && why !== undefined) out[key] = why.slice(0, 40)
  }
  return out
}

const SECRET_REFUSED =
  'secret_in_input：参数里像是夹着口令 / 密钥，这一次没收。口令只能由用户在卡上的本机表单里自己填——不要写进任何参数，也不要让用户把它发在对话里。'

export function createSetupRequestTool(options: SetupRequestToolOptions): ToolExecutor {
  return async (call) => {
    const bare = call.name.includes('.')
      ? call.name.slice(call.name.lastIndexOf('.') + 1)
      : call.name
    if (bare !== REQUEST_SETUP_TOOL) return refuse(`unsupported_tool：${call.name}`)
    const input = call.input
    const connect = str(input.connect)
    const setting = str(input.setting)
    const why = str(input.why)
    if (why === undefined) return refuse('invalid_input：why 要写一句为什么（给用户看）。')
    const suggestions = suggestionsOf(input.suggestions)
    const reasons = reasonsOf(input.suggestions)
    // 纪律：任何一格像秘密，整条拒收（不回显）
    if (
      looksLikeSecretValue(why) ||
      Object.entries(suggestions).some(
        ([k, v]) => isSecretLikeSetupKey(k) || looksLikeSecretValue(v),
      ) ||
      Object.values(reasons).some((v) => looksLikeSecretValue(v))
    )
      return refuse(SECRET_REFUSED)
    if ((connect === undefined) === (setting === undefined))
      return refuse('invalid_input：connect（要连的）和 setting（要设的）给一个，只给一个。')
    const shortWhy = why.length > WHY_MAX ? `${why.slice(0, WHY_MAX)}…` : why

    if (connect !== undefined) {
      const service = connect.toLowerCase()
      const dir = await options.directory().catch(() => [])
      const hit = dir.find((d) => d.service === service)
      const need: ConnectNeed | undefined =
        hit !== undefined
          ? { kind: hit.kind, service: hit.service, name: hit.name, required: true }
          : builtinConnectNeed(service)
      if (need === undefined) {
        const known = [
          ...new Set([...dir.map((d) => d.service), ...Object.keys(BUILTIN_CONNECT_NEEDS)]),
        ]
        return refuse(`invalid_input：认不出「${connect}」。能要的：${known.join('、')}。`)
      }
      if ((await options.isConnected(need).catch(() => undefined)) === true) {
        const data: SetupRequestData = {
          ok: true,
          already: true,
          message: `${need.name}已经连上了，不用卡，直接接着做。`,
        }
        return { status: 'ok', data }
      }
      const data: SetupRequestData = {
        ok: false,
        needs_connection: need.service ?? need.kind,
        connection_name: need.name,
        setup_why: shortWhy,
        message: `会在这件事下面出一张卡让用户连上${need.name}，连好会自动接着做。先停在这儿，跟用户说一声。`,
      }
      return { status: 'ok', data }
    }

    const target = await options.target(setting ?? '').catch(() => undefined)
    if (target === undefined) {
      const known = await options.targetIds().catch(() => [] as readonly string[])
      return refuse(`invalid_input：认不出设置「${setting}」。能要的：${known.join('、')}。`)
    }
    const satisfied = await target.satisfied().catch(() => false)
    // WP348（决策 841 并进来）：已经设好了、AI 给了新值 → 出「我打算改成这样」的卡（人确认才生效）
    if (satisfied && Object.keys(suggestions).length === 0) {
      const data: SetupRequestData = {
        ok: true,
        already: true,
        message: `${target.name}已经设好了，不用卡，直接接着做。要改就带上 suggestions（新值）再调一次。`,
      }
      return { status: 'ok', data }
    }
    const data: SetupRequestData = {
      ok: false,
      needs_setup: target.id,
      setup_name: target.name,
      setup_why: shortWhy,
      ...(Object.keys(suggestions).length === 0 ? {} : { suggestions }),
      ...(Object.keys(reasons).length === 0 ? {} : { suggestion_why: reasons }),
      ...(satisfied ? { change: true } : {}),
      message: satisfied
        ? `会在这件事下面出一张「我打算改成这样」的卡（现值 → 新值），用户点头才生效。先停在这儿，跟用户说一声。`
        : `会在这件事下面出一张「我打算这样设」的方案卡（工坊先查过一遍，你给的值压过它查到的），用户点头就存、自动接着做。先停在这儿，跟用户说一声。`,
    }
    return { status: 'ok', data }
  }
}
