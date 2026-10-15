/**
 * WP251（决策 91）：一轮运行「卡在缺连接 / 缺凭据上」的结构化标记。
 *
 * WP244 的「卡住了」部分靠认 AI 最后那句话（「没接上 / 交不出来 / 没权限」）——会误判：
 * AI 说「Shopify 还没连上，所以先用公开数据查了一版」也被算成卡住；反过来 AI 没明说的也漏掉。
 * 现在改成看**工具真回了什么**：宿主执行器回 `not_connected`（或缺凭据那几种）时，运行时把
 * 「哪个工具、缺哪个连接」记在这一轮上，收尾时写一条带 `blocked` 的时间线事件。
 *
 * 认的只是**机器码**（工具回执的 `reason` 开头那个词，或回执数据里 `{ ok: false, reason }`），
 * 不认人话——人话是给模型和人看的，机器码才是工具对「为什么做不了」的正式回答。
 */
import { BUILTIN_CONNECT_NEEDS, type ConnectNeed, type MatterRunBlock } from '@agentsws/contracts'
import type { ToolExecution } from '@agentsws/stand-ins'

/** 没连上（`not_connected：这个工作区还没有连上店铺后台…` 这种也认——认的是开头那个码）。 */
const NOT_CONNECTED = /^\s*not[_ ]connected\b/i
/** 缺凭据 / 凭据坏了（钥匙没填、过期、被拒）——人要做的事和「没连上」一样：去连接页补上。 */
const MISSING_CREDENTIAL =
  /^\s*(?:missing[_ ]credentials?|no[_ ]credentials?|no[_ ]key|missing[_ ]api[_ ]key|missing cloud workspace token|needs[_ ]developer[_ ]token|bad[_ ]credentials|token[_ ]stale|account[_ ]token[_ ]invalid|unauthenticated)\b/i

/** 一个机器码 → 卡在哪一种（不是这两种就是 `undefined`）。 */
export function blockReasonOf(code: unknown): MatterRunBlock['reason'] | undefined {
  if (typeof code !== 'string') return undefined
  if (NOT_CONNECTED.test(code)) return 'not_connected'
  if (MISSING_CREDENTIAL.test(code)) return 'missing_credential'
  return undefined
}

/**
 * 一次工具回执是不是「缺连接 / 缺凭据」。
 *
 * - 没跑成（`error` / `blocked`）：看 `reason`；
 * - 跑成了但数据里说做不了（渠道适配器的 `{ ok: false, reason: 'not_connected' }`）：看数据。
 *   降级成功的（比如红人搜索没连渠道、回了本地库）`ok` 不是 `false`，不算。
 */
export function blockedByTool(
  res: Pick<ToolExecution, 'status' | 'reason' | 'data'>,
): MatterRunBlock['reason'] | undefined {
  if (res.status !== 'ok') return blockReasonOf(res.reason)
  const data = res.data
  if (data === null || typeof data !== 'object') return undefined
  const rec = data as { ok?: unknown; reason?: unknown }
  return rec.ok === false ? blockReasonOf(rec.reason) : undefined
}

/**
 * WP324（决策 690）：工具说「缺一步设置 / 缺一样能就地连的东西」——**结构化**的那几种（不认人话）：
 *
 * - 通用：回执数据里 `{ needs_setup: '<设置目标>' }`（或 `reason` 以 `needs_setup:<目标>` 开头）→ 配置卡；
 *   `{ needs_connection: '<service>' }` → 连接卡（连接页 service / `im:feishu` / `extension`…）。
 *   往后谁要「先设好 / 先连上才能做」，照这两格回就行（WP322 / WP323 对齐用）；
 * - 建站工具（WP253）：`data.needs` 是 `install_cli` / `node` / `login` → 连接卡（建站工具），`store` → 配置卡（选店）；
 * - 管店工具（WP261）：`data.needs` 是 `install_cli` / `authorize` → 连接卡（管店授权）；
 * - 开发信（WP176）：排队原因 `company_address` → 配置卡（公司实体地址）。
 */
export type SetupNeed = (
  | { kind: 'connect'; need: ConnectNeed }
  | { kind: 'setup'; target: string }
) & {
  /** WP334：AI 要卡时给的那一句为什么。 */
  why?: string
  /** WP334：AI 给的配置卡建议值（只对 `setup` 有用）。 */
  suggestions?: Record<string, string>
}

/** WP334：工坊账号没关联（工具回执里 `reason: 'not_linked'` 的那几处：红人公共库、官方数据接口…）。 */
const WORKSHOP_ACCOUNT_NEED: ConnectNeed = {
  ...(BUILTIN_CONNECT_NEEDS.workshop_account as Omit<ConnectNeed, 'required'>),
  required: true,
}
/** WP334：DeepSeek 账号登录过期 / 没登录（用账号跑的那一次以 `unauthenticated` 失败）→ 卡里就地重新登录。 */
export const DEEPSEEK_ACCOUNT_NEED: ConnectNeed = {
  ...(BUILTIN_CONNECT_NEEDS.deepseek_account as Omit<ConnectNeed, 'required'>),
  required: true,
}
/** 「用我的 DeepSeek 账号登录」那条模型来源的 id（与 `deepseek-account.ts` 的 `DEEPSEEK_ACCOUNT_PROVIDER_ID` 同一个）。 */
export const DEEPSEEK_ACCOUNT_RUN_PROVIDER = 'deepseek-account'
/** WP334：没接发信邮箱（开发信排队原因 `sender_choice`、又没出选邮箱卡 = 一只邮箱都没有）。 */
const MAILBOX_NEED: ConnectNeed = {
  kind: 'email',
  service: 'imap_smtp',
  name: '发信邮箱',
  required: true,
}

/** 建站工具那一路（装 CLI / 登录 Shopify / 选店）在卡上用一整块现成的接法。 */
export const SITE_THEME_NEED: ConnectNeed = {
  kind: 'site_theme',
  service: 'site_theme',
  name: 'Shopify 建站工具',
  required: true,
}
/** 管店授权（CLI 一键授权管理商品和页面）。 */
export const SHOP_ADMIN_NEED: ConnectNeed = {
  kind: 'shop_admin',
  service: 'shop_admin',
  name: 'Shopify 管店授权',
  required: true,
}

const NEEDS_SETUP = /^\s*needs[_ ]setup:([a-z0-9_.:-]+)/i
/** WP334：`needs_connection:<service>`（与上面对称；`im:wecom` 这种带冒号的也认）。 */
const NEEDS_CONNECTION = /^\s*needs[_ ]connection:([a-z0-9_.:-]+)/i
/** WP334：工坊账号没关联的机器码（`not_linked：…` 开头，或回执数据里 `{ ok: false, reason: 'not_linked' }`）。 */
const NOT_LINKED = /^\s*not[_ ]linked\b/i

/** 一样「要连的」：内置那几样用内置的名字，连接目录里的按 service 当 kind。 */
function connectNeedOf(service: string, name: unknown): ConnectNeed {
  const builtin = BUILTIN_CONNECT_NEEDS[service]
  return {
    kind: builtin?.kind ?? service,
    service,
    name: typeof name === 'string' && name !== '' ? name : (builtin?.name ?? service),
    required: true,
  }
}

/** WP334：AI 要卡时带的「为什么 / 建议值」（只认字符串）。 */
function askedOf(
  data: Record<string, unknown> | undefined,
): Pick<SetupNeed, 'why' | 'suggestions'> {
  const why =
    typeof data?.setup_why === 'string' && data.setup_why !== '' ? data.setup_why : undefined
  const raw = recOf(data?.suggestions)
  const suggestions =
    raw === undefined
      ? undefined
      : Object.fromEntries(
          Object.entries(raw).filter((e): e is [string, string] => typeof e[1] === 'string'),
        )
  return {
    ...(why === undefined ? {} : { why }),
    ...(suggestions === undefined || Object.keys(suggestions).length === 0 ? {} : { suggestions }),
  }
}

const recOf = (v: unknown): Record<string, unknown> | undefined =>
  v !== null && typeof v === 'object' && !Array.isArray(v)
    ? (v as Record<string, unknown>)
    : undefined

/** 一次工具回执里有没有「缺一步设置 / 缺一样能就地连的」（没有就 `undefined`）。 */
export function setupNeedOf(
  tool: string,
  res: Pick<ToolExecution, 'status' | 'reason' | 'data'>,
): SetupNeed | undefined {
  const data = recOf(res.data)
  const fromReason = typeof res.reason === 'string' ? NEEDS_SETUP.exec(res.reason)?.[1] : undefined
  const target = typeof data?.needs_setup === 'string' ? data.needs_setup : fromReason
  if (target !== undefined && target !== '') return { kind: 'setup', target, ...askedOf(data) }
  const connectFromReason =
    typeof res.reason === 'string' ? NEEDS_CONNECTION.exec(res.reason)?.[1] : undefined
  const service =
    typeof data?.needs_connection === 'string' ? data.needs_connection : connectFromReason
  if (typeof service === 'string' && service !== '')
    return {
      kind: 'connect',
      need: connectNeedOf(service, data?.connection_name),
      ...askedOf(data),
    }
  // WP334（决策 726）：工坊账号没关联 → 连接卡里关联（认码：`not_linked`）
  if (
    (typeof res.reason === 'string' && NOT_LINKED.test(res.reason)) ||
    (data?.ok === false && data.reason === 'not_linked')
  )
    return { kind: 'connect', need: WORKSHOP_ACCOUNT_NEED }
  const needs = data?.needs
  if (res.status !== 'ok' && typeof needs === 'string') {
    if (tool.startsWith('theme_')) {
      if (needs === 'store') return { kind: 'setup', target: 'site.store' }
      if (needs === 'install_cli' || needs === 'node' || needs === 'login')
        return { kind: 'connect', need: SITE_THEME_NEED }
    }
    if (tool.startsWith('shop_') && (needs === 'install_cli' || needs === 'authorize'))
      return { kind: 'connect', need: SHOP_ADMIN_NEED }
  }
  if (res.status === 'ok' && data?.queued_reason === 'company_address')
    return { kind: 'setup', target: 'company.address' }
  // WP334（决策 726）：一只邮箱都没有（有邮箱时出的是「用哪只发」选择卡，不归这里）→ 连接卡接一只
  if (
    res.status === 'ok' &&
    data?.queued_reason === 'sender_choice' &&
    data.approval_item_id === undefined
  )
    return { kind: 'connect', need: MAILBOX_NEED }
  return undefined
}

/** 一轮运行里攒下的卡点（同一个工具撞几次只记一次）。 */
export class RunBlockLog {
  readonly #tools = new Set<string>()
  readonly #connections = new Set<string>()
  readonly #needs = new Map<string, ConnectNeed>()
  readonly #targets = new Set<string>()
  readonly #suggestions = new Map<string, Record<string, string>>()
  #why: string | undefined
  #reason: MatterRunBlock['reason'] | undefined

  /** 记一笔：哪个工具、哪一种、缺哪几个连接（认不出就给空）。 */
  note(
    tool: string,
    reason: MatterRunBlock['reason'],
    connections: readonly string[],
    needs: readonly ConnectNeed[] = [],
  ): void {
    this.#tools.add(tool)
    for (const c of connections) if (c.trim() !== '') this.#connections.add(c.trim())
    for (const n of needs) if (!this.#needs.has(n.kind)) this.#needs.set(n.kind, n)
    // 「没连上」比「缺凭据」更根本，缺凭据又比缺一步设置更根本：几样都撞上时说最根本的
    const rank = { not_connected: 0, missing_credential: 1, needs_setup: 2 } as const
    if (this.#reason === undefined || rank[reason] < rank[this.#reason]) this.#reason = reason
  }

  /** WP324：记一笔「缺一步设置 / 缺一样能就地连的」。 */
  noteSetup(tool: string, need: SetupNeed): void {
    // WP334：AI 要卡时的那一句为什么（第一句为准）与建议值
    if (need.why !== undefined && this.#why === undefined) this.#why = need.why
    if (need.kind === 'setup' && need.suggestions !== undefined)
      this.#suggestions.set(need.target, {
        ...this.#suggestions.get(need.target),
        ...need.suggestions,
      })
    if (need.kind === 'setup') {
      this.#targets.add(need.target)
      this.note(tool, 'needs_setup', [])
      return
    }
    this.note(tool, 'needs_setup', [need.need.name], [need.need])
  }

  /** WP324：能就地连的那几样（出连接卡用）。 */
  connectNeeds(): ConnectNeed[] {
    return [...this.#needs.values()]
  }

  /** WP324：缺的设置目标（出配置卡用）。 */
  setupTargets(): string[] {
    return [...this.#targets]
  }

  /** WP334：AI 要卡时给的「为什么 / 建议值」（没有就是空对象，出卡用默认那句）。 */
  asked(): { why?: string; suggestions?: Record<string, Record<string, string>> } {
    return {
      ...(this.#why === undefined ? {} : { why: this.#why }),
      ...(this.#suggestions.size === 0
        ? {}
        : { suggestions: Object.fromEntries(this.#suggestions) }),
    }
  }

  /** 这一轮卡住了没有；卡住了回标记。 */
  block(): MatterRunBlock | undefined {
    if (this.#reason === undefined) return undefined
    const services = [...this.#needs.values()].flatMap((n) =>
      n.service === undefined ? [] : [n.service],
    )
    return {
      reason: this.#reason,
      connections: [...this.#connections],
      tools: [...this.#tools],
      ...(services.length === 0 ? {} : { services }),
    }
  }
}

/** 时间线上那一句人话（标记本身在 `blocked` 里）。 */
export function blockedLine(block: MatterRunBlock): string {
  const what = block.connections.length > 0 ? block.connections.join('、') : undefined
  // WP324：出了连接卡 / 配置卡——就在下面那张卡上补，补完自动接着做（不再叫人去连接页）
  if (block.card_id !== undefined) {
    if (block.reason === 'needs_setup' && what === undefined)
      return '这次缺一步设置：在下面这张卡上填好，我就接着做。'
    return what === undefined
      ? '这次卡在缺连接上：在下面这张卡上连好，我就接着做。'
      : `这次卡在缺连接上（${what}）：在下面这张卡上连好，我就接着做。`
  }
  if (block.reason === 'needs_setup')
    return what === undefined
      ? '这次缺一步设置，补上再让它接着做。'
      : `这次缺一步设置（${what}），补上再让它接着做。`
  if (block.reason === 'missing_credential')
    return what === undefined
      ? '这次卡在缺凭据上：去「连接」页把钥匙补上，再让它接着做。'
      : `这次卡在缺凭据上（${what}）：去「连接」页补上，再让它接着做。`
  return what === undefined
    ? '这次卡在缺连接上：去「连接」页连上，再让它接着做。'
    : `这次卡在缺连接上（${what}）：去「连接」页连上，再让它接着做。`
}
