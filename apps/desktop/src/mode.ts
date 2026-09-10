/**
 * 「本机」还是「连公司服务器」（40 §1.3、41 §2.1、13 §5 三档部署）。
 *
 * 在这之前桌面壳只有一种活法：本机拉一个 sidecar、本机生成一把服务密钥、
 * 窗口连 `127.0.0.1`。40 §1.3 说得很直白——多人公司今天**还没有正确的部署形态**：
 * 服务进程该跑在公司那台常开的机器 / NAS 上，员工电脑只是客户端，
 * **电脑上不存真源**（40 三条规则的第一条）。
 *
 * 于是壳有两种模式：
 *
 * | | `local` | `remote` |
 * |---|---|---|
 * | 服务进程 | 本机 sidecar，壳负责起停 | 公司那台机器上跑，壳一个进程都不拉 |
 * | 本机密钥 | 生成四把（safeStorage） | **一把都不生成**——没有本机服务要喂 |
 * | 登录 | 会话密钥换 cookie（token 不进渲染进程） | 邀请链接 / magic-link，cookie 由服务端设 |
 * | 数据 | 就在这台机器上 | 在公司机器上；这台电脑只有偏好与未发草稿 |
 *
 * 判定全在这个文件里（所以能测）：`main.ts` 只按结果分叉。
 */

/** 公司服务器地址的环境变量；给了就覆盖配置（运维与 e2e 都靠它）。 */
export const SERVER_URL_ENV = 'AGENTSWS_SERVER_URL'

export type DesktopMode = 'local' | 'remote'

export interface ModeSource {
  /** `config.json` 里存的（首启向导写进去的那一份）。 */
  mode?: DesktopMode | undefined
  serverUrl?: string | undefined
}

export interface ResolvedMode {
  mode: DesktopMode
  /** `remote` 时窗口连这个地址（已规范化：没有尾斜杠）；`local` 时没有——端口要等 sidecar 报。 */
  serverUrl?: string
  /** 从哪来的。环境变量赢过配置，配置赢过默认。 */
  from: 'env' | 'config' | 'default'
}

/**
 * 只认 http / https，去掉尾斜杠与路径。
 *
 * 去路径是有意的：这个地址要拿来当**源**用（allowedOrigins、cookie 的 url、
 * CSP 的 `'self'` 都按源算），带上 `/app` 之类的尾巴只会让三处判定各不相同。
 */
export function normalizeServerUrl(raw: string | undefined): string | undefined {
  const text = raw?.trim()
  if (text === undefined || text === '') return undefined
  let url: URL
  try {
    url = new URL(text)
  } catch {
    return undefined
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return undefined
  return url.origin
}

/** 从环境变量表里取公司服务器地址。 */
export function serverUrlFrom(
  env: Readonly<Record<string, string | undefined>>,
): string | undefined {
  return normalizeServerUrl(env[SERVER_URL_ENV])
}

/**
 * 定下这次启动是哪一档。
 *
 * 环境变量给了地址 = 直接 remote，**不看配置**：运维把这台电脑指到公司服务器上，
 * 不该被一份旧的 `config.json` 拖回本机档。配置里写了 remote 但地址是坏的 →
 * 退回 local：宁可起一个本机的、能用的，也不要一个连不上任何地方的窗口。
 */
export function resolveMode(
  config: ModeSource,
  env: Readonly<Record<string, string | undefined>> = {},
): ResolvedMode {
  const fromEnv = serverUrlFrom(env)
  if (fromEnv !== undefined) return { mode: 'remote', serverUrl: fromEnv, from: 'env' }
  if (config.mode === 'remote') {
    const url = normalizeServerUrl(config.serverUrl)
    if (url !== undefined) return { mode: 'remote', serverUrl: url, from: 'config' }
    return { mode: 'local', from: 'config' }
  }
  return { mode: 'local', from: config.mode === 'local' ? 'config' : 'default' }
}

/**
 * 首启向导要不要出：**这台电脑还没选过**，而且环境变量也没替它选。
 *
 * 判据是「配置文件在不在」，不是「配置里有没有 mode」——一个装过老版本的机器
 * 已经在本机档跑着了，升级之后不该被拦一道问卷。
 */
export function needsWizard(input: {
  configExists: boolean
  env?: Readonly<Record<string, string | undefined>>
}): boolean {
  if (input.configExists) return false
  return serverUrlFrom(input.env ?? {}) === undefined
}

/** 向导的结果：选本机，或选公司服务器并给一个地址。 */
export type WizardChoice =
  | { mode: 'local' }
  | { mode: 'remote'; serverUrl: string }
  /** 关掉窗口 / 没填地址：什么都不写，下次启动再问。 */
  | { mode: 'cancelled' }

/** 向导交回来的东西 → 要写进 `config.json` 的那几个字段（`cancelled` 什么都不写）。 */
export function configPatchOf(
  choice: WizardChoice,
): { mode: DesktopMode; serverUrl: string } | undefined {
  if (choice.mode === 'cancelled') return undefined
  if (choice.mode === 'local') return { mode: 'local', serverUrl: '' }
  const url = normalizeServerUrl(choice.serverUrl)
  return url === undefined ? undefined : { mode: 'remote', serverUrl: url }
}

/**
 * 托盘上「已连接 X」里的那个 X。
 *
 * 登录之前拿不到公司名（`/v1/me` 要会话），所以退到地址的主机名——
 * 「已连接 nas.company.lan」比「已连接（未知）」有用得多。
 */
export function companyLabel(input: {
  serverUrl?: string | undefined
  workspaceName?: string | undefined
}): string {
  const name = input.workspaceName?.trim()
  if (name !== undefined && name !== '') return name
  const url = normalizeServerUrl(input.serverUrl)
  if (url === undefined) return ''
  return new URL(url).host
}
