import type { FetchLike } from './http.js'

/**
 * 31 §3.5 / 08 §5 安装器策略。
 *
 * 上游 `SECURITY.md` 与 09-09 实测：**admin 与 runtime 鉴权默认关**，无
 * `OOMOL_CONNECT_ENCRYPTION_KEY` 时凭据明文，每个 provider 的 proxy 默认全开。
 * 因此 server 装配前必须过这一关；不过则拒绝启动。
 */
export type HardeningReason =
  | 'runtime_unreachable'
  | 'runtime_unhealthy'
  | 'admin_auth_disabled'
  | 'runtime_auth_disabled'
  | 'encryption_disabled'
  | 'admin_token_env_missing'
  | 'proxies_not_blocked'

export interface HardeningCheck {
  name: string
  ok: boolean
  detail: string
}

export interface HardeningReport {
  ok: boolean
  reasons: HardeningReason[]
  checks: HardeningCheck[]
}

export interface HardeningOptions {
  fetchImpl?: FetchLike
  /** 只从环境变量名读；默认用上游的名字。 */
  adminTokenEnv?: string
  encryptionKeyEnv?: string
  blockedProxiesEnv?: string
  env?: NodeJS.ProcessEnv
  timeoutMs?: number
  /**
   * runtime 的 `/v1/health` 目前**不报告加密状态**（实测只有 `{ ok, runtime }`）。
   * 无法从 health 判断时按派工单要求退回"环境变量必须存在"。将来 health 若加了字段，
   * 这里会优先采信 health。
   */
  requireEncryptionKeyEnv?: boolean
}

interface HealthBody {
  ok?: boolean
  runtime?: string
  encryption?: unknown
  encrypted?: unknown
  encryptionEnabled?: unknown
}

function readHealthEncryption(body: unknown): boolean | undefined {
  if (typeof body !== 'object' || body === null) return undefined
  const b = body as HealthBody
  for (const v of [b.encryption, b.encrypted, b.encryptionEnabled]) {
    if (typeof v === 'boolean') return v
    if (v === 'enabled') return true
    if (v === 'disabled' || v === 'off' || v === 'none') return false
  }
  return undefined
}

/**
 * 三件事必须为真才 `ok`：runtime 活着、admin 与 runtime 端点都要鉴权、静态加密已开
 * （或至少加密密钥的环境变量存在）。proxy 未封是一条独立理由。
 */
export async function assertRuntimeHardened(
  baseUrl: string,
  opts: HardeningOptions = {},
): Promise<HardeningReport> {
  const fetchImpl = opts.fetchImpl ?? (globalThis.fetch as unknown as FetchLike)
  const env = opts.env ?? process.env
  const adminTokenEnv = opts.adminTokenEnv ?? 'OOMOL_CONNECT_ADMIN_TOKEN'
  const encryptionKeyEnv = opts.encryptionKeyEnv ?? 'OOMOL_CONNECT_ENCRYPTION_KEY'
  const blockedProxiesEnv = opts.blockedProxiesEnv ?? 'OOMOL_CONNECT_BLOCKED_PROXIES'
  const timeoutMs = opts.timeoutMs ?? 5000
  const base = baseUrl.replace(/\/+$/, '')

  const reasons: HardeningReason[] = []
  const checks: HardeningCheck[] = []
  const add = (name: string, ok: boolean, detail: string, reason?: HardeningReason): void => {
    checks.push({ name, ok, detail })
    if (!ok && reason !== undefined && !reasons.includes(reason)) reasons.push(reason)
  }

  const probe = async (path: string): Promise<{ status: number; body: unknown } | undefined> => {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), timeoutMs)
    try {
      const res = await fetchImpl(`${base}${path}`, {
        method: 'GET',
        headers: { accept: 'application/json' },
        signal: controller.signal,
      })
      const text = await res.text()
      let body: unknown
      try {
        body = text.length === 0 ? undefined : JSON.parse(text)
      } catch {
        body = undefined
      }
      return { status: res.status, body }
    } catch {
      return undefined
    } finally {
      clearTimeout(timer)
    }
  }

  // `/v1/health` 匿名探一次，同时得到两件事：runtime 活着 + `/v1` 是否强制鉴权。
  // 实测：runtime 里一旦存在任何持久 token，连 `/v1/health` 都要 bearer（401）——
  // 所以 401/403 恰恰是"鉴权已开"的证据，不是失败。
  const health = await probe('/v1/health')
  if (health === undefined) {
    add('health', false, `${base}/v1/health 不可达`, 'runtime_unreachable')
    return { ok: false, reasons, checks }
  }
  const guardedRuntime = health.status === 401 || health.status === 403
  const healthData =
    typeof health.body === 'object' && health.body !== null && 'data' in health.body
      ? (health.body as { data: unknown }).data
      : health.body
  const healthy =
    guardedRuntime ||
    (health.status === 200 &&
      typeof healthData === 'object' &&
      healthData !== null &&
      (healthData as HealthBody).ok === true)
  add(
    'health',
    healthy,
    guardedRuntime
      ? `HTTP ${health.status}（鉴权已开，匿名读不到 health）`
      : `HTTP ${health.status}`,
    'runtime_unhealthy',
  )
  add(
    'runtime_auth',
    guardedRuntime,
    `匿名访问 /v1/health 得到 HTTP ${health.status}；要求 401/403`,
    'runtime_auth_disabled',
  )

  // admin 面必须要 token（无 Authorization 应当被拒）
  const admin = await probe('/api/connections')
  const adminGuarded = admin !== undefined && (admin.status === 401 || admin.status === 403)
  add(
    'admin_auth',
    adminGuarded,
    admin === undefined ? '探测失败' : `匿名访问 /api/connections 得到 HTTP ${admin.status}`,
    'admin_auth_disabled',
  )

  // 静态加密：health 说了算；health 说不了（读不到或没这个字段）就要求环境变量存在
  const fromHealth = guardedRuntime ? undefined : readHealthEncryption(healthData)
  if (fromHealth === undefined) {
    const required = opts.requireEncryptionKeyEnv ?? true
    const present = (env[encryptionKeyEnv] ?? '').length > 0
    add(
      'encryption',
      !required || present,
      present
        ? `health 不报告加密状态，改判环境变量 ${encryptionKeyEnv}：已设置`
        : `health 不报告加密状态，且环境变量 ${encryptionKeyEnv} 未设置`,
      'encryption_disabled',
    )
  } else {
    add('encryption', fromHealth, `health 报告加密：${fromHealth}`, 'encryption_disabled')
  }

  const adminTokenPresent = (env[adminTokenEnv] ?? '').length > 0
  add(
    'admin_token_env',
    adminTokenPresent,
    `${adminTokenEnv} ${adminTokenPresent ? '已设置' : '未设置'}`,
    'admin_token_env_missing',
  )

  const blocked = env[blockedProxiesEnv] ?? ''
  const proxiesBlocked = blocked.split(',').some((s) => s.trim() === '*')
  add(
    'proxies_blocked',
    proxiesBlocked,
    `${blockedProxiesEnv}=${blocked === '' ? '(未设置)' : blocked}；安装器要求 "*"`,
    'proxies_not_blocked',
  )

  return { ok: reasons.length === 0, reasons, checks }
}
