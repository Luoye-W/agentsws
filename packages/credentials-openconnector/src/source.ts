/**
 * 这个包要的两个"上游"：**本机的引用层**与 **OpenConnector 的记录层**。
 *
 * 两个都是窄接口，不是具体实现——目的就是让 provider 那一半不知道也不关心
 * 凭据到底存在哪（13 §4.3：转手一次，不留引用）。
 */
import type { AssignmentId, Connect, WorkspaceId } from '@agentsws/contracts'

/** 一次解析的结果（与官方 `ResolvedCredential` 同形）。 */
export interface RefHit {
  value: string
  /** 来源层的名字（`env` / `store` / …），给配置界面看的；**不是值**。 */
  source: string
}

/**
 * 引用层（`CredentialRef`，一个环境变量名 → 一个值）。
 *
 * 模型 key、SMTP 密码这类"本机的东西"走这里。**不经 OpenConnector**：
 * 它管的是外部 SaaS 的授权，不是这台机器上的配置。
 */
export interface CredentialRefSource {
  resolve(name: string): Promise<RefHit | undefined>
  /** 只回"有没有、从哪来、能不能改"，**永远不回值**。 */
  describe(name: string): Promise<{ configured: boolean; source?: string; writable: boolean }>
  /** 不实现 = 这一层只读（`set` / `unset` 会被拒）。 */
  set?(name: string, value: string): Promise<void>
  unset?(name: string): Promise<void>
}

/**
 * OpenConnector 侧的一条连接现在的**可用凭据**。
 *
 * `access` 是一把 agentsws runtime token（`oct_…`），不是平台的 access token：
 * 平台的 access / refresh token 从头到尾在 OpenConnector 的凭据库里，
 * 一个字节都不经过这个进程。这正是 08「凭据边界」那一条的实现方式——
 * 我们能给出去的最强的东西，也只是"按这条职责的范围代我去调"的一把凭证。
 */
export interface OpenConnectorGrant {
  access: string
  /** ISO8601；没有就是"这把没有到期时间"（不会出现在我们签的 token 上）。 */
  expires_at?: string
}

/** 记录层（`CredentialKey` = `<workspace>/<kind>`）。 */
export interface OpenConnectorSource {
  /** 这个 source 只服务这一个工作区；别的 owner 一律读不到（跨工作区隔离）。 */
  workspace_id: WorkspaceId
  /** 现在连上了哪些 kind（目录里那些 `mode: 'openconnector_provider'` 的）。 */
  kinds(): Promise<readonly string[]>
  /** 取这条连接现在能用的那把（没连 / 不可用回 `undefined`）。 */
  grant(kind: string): Promise<OpenConnectorGrant | undefined>
  /** 让 OpenConnector 换一把新的（**我们不写 token，只让它自己换**）。 */
  refresh(kind: string): Promise<OpenConnectorGrant | undefined>
}

/** {@link openConnectorSource} 的参数。 */
export interface OpenConnectorSourceOptions {
  workspace_id: WorkspaceId
  /** 按哪条分配签 token（范围就是这条职责的范围，08 §2.5）。 */
  assignment_id: AssignmentId
  /** kind → 这条 kind 允许的 Action id（签 token 时的 `allowed_actions`）。 */
  actionsOf(kind: string): readonly string[]
  /** token 有效期；缺省 15 分钟——它只在一次运行里活着。 */
  ttlSeconds?: number
  /** 现在时间（注入点，26 §3 一切随机 / 时间经注入）。 */
  now(): string
}

/** 一条连接在缓存里的样子（**只有到期时间和那把 token，没有别的**）。 */
interface CachedGrant {
  grant: OpenConnectorGrant
  connection_id: string
}

/**
 * 把一个 `Connect` 适配器（`@agentsws/connect-adapter` 的 OpenConnector 实现，
 * 或者一致性套件里的 mock）接成 {@link OpenConnectorSource}。
 *
 * 一条连接一把 token，按 kind 缓存到快过期为止；`refresh` 就是**再签一把**
 * ——上游的 runtime token 没有 refresh 这个概念，"刷新"在 OpenConnector 那一侧
 * 是它自己拿 refresh token 去换平台的 access token，我们看不见也不该看见。
 */
export function openConnectorSource(
  connect: Connect,
  options: OpenConnectorSourceOptions,
): OpenConnectorSource {
  const ttl = options.ttlSeconds ?? 900
  const cache = new Map<string, CachedGrant>()

  const connectionOf = async (kind: string): Promise<string | undefined> => {
    const list = await connect.connections(options.workspace_id)
    // `service` 就是目录里那一列（`catalog.ts` 的 service → kind 表由调用方对上）
    const hit = list.find((c) => c.service === kind && c.status === 'active')
    return hit?.id
  }

  const issue = async (kind: string): Promise<CachedGrant | undefined> => {
    const connection_id = await connectionOf(kind)
    if (connection_id === undefined) return undefined
    const token = await connect.issueToken({
      assignment_id: options.assignment_id,
      kind: 'role-read',
      allowed_actions: [...options.actionsOf(kind)],
      allowed_connections: [connection_id],
      expires_in_seconds: ttl,
    })
    return {
      connection_id,
      grant: { access: token.token, expires_at: token.expires_at },
    }
  }

  const fresh = (cached: CachedGrant | undefined): boolean => {
    if (cached === undefined) return false
    const at = cached.grant.expires_at
    if (at === undefined) return true
    // 留 30 秒余量：一把马上过期的 token 等于没有
    return Date.parse(at) - Date.parse(options.now()) > 30_000
  }

  return {
    workspace_id: options.workspace_id,
    async kinds() {
      const list = await connect.connections(options.workspace_id)
      return [...new Set(list.filter((c) => c.status === 'active').map((c) => c.service))].sort()
    },
    async grant(kind) {
      const cached = cache.get(kind)
      if (fresh(cached)) return cached?.grant
      const issued = await issue(kind)
      if (issued === undefined) {
        cache.delete(kind)
        return undefined
      }
      cache.set(kind, issued)
      return issued.grant
    },
    async refresh(kind) {
      cache.delete(kind)
      const issued = await issue(kind)
      if (issued === undefined) return undefined
      cache.set(kind, issued)
      return issued.grant
    },
  }
}

/**
 * 最小的本机引用层：进程环境 + 一张注入的表（测试与"没有本机凭据库"的档位）。
 *
 * 为什么不直接用官方 `dsh-credentials-local`：它是一个 **Service**（自己注册
 * `ctx.credentials`），而官方这个 seam 是**单 provider** 的——一棵树上第二个
 * `CredentialProvider` 直接抛。所以本机那一半在这里只能是一个**非服务**的对象，
 * 由 {@link CompositeCredentials} 统一发到 `ctx.credentials` 上。
 */
export function envRefSource(table?: Record<string, string>): CredentialRefSource {
  const extra = { ...table }
  const read = (name: string): { value: string; source: string } | undefined => {
    const fromEnv = process.env[name]
    if (fromEnv !== undefined && fromEnv !== '') return { value: fromEnv, source: 'env' }
    const stored = extra[name]
    // 官方的 seam 规矩：**空值等于没有**（空串不能冒充"配好了"）
    if (stored !== undefined && stored !== '') return { value: stored, source: 'store' }
    return undefined
  }
  return {
    async resolve(name) {
      return read(name)
    },
    async describe(name) {
      const hit = read(name)
      // 启动环境给的那一层不可写（与官方 `credentials-local` 同一条：inherited env wins）
      const writable = process.env[name] === undefined || process.env[name] === ''
      return hit === undefined
        ? { configured: false, writable }
        : { configured: true, source: hit.source, writable }
    },
    async set(name, value) {
      if (process.env[name] !== undefined && process.env[name] !== '') {
        throw new Error(`凭据 ${name} 由启动环境提供，改不了（先在 shell 里清掉它）`)
      }
      extra[name] = value
    },
    async unset(name) {
      if (process.env[name] !== undefined && process.env[name] !== '') {
        throw new Error(`凭据 ${name} 由启动环境提供，删不掉（先在 shell 里清掉它）`)
      }
      delete extra[name]
    },
  }
}

/**
 * WP90（55 §9 Q8）：**订阅登录的记录层**——`llm-pi-ai/<provider>` 那一族记录。
 *
 * 为什么不走上面那条 OpenConnector 的路：ChatGPT Plus / Claude Pro 的账号**是人的**，
 * 不是公司的一条外部连接（20「个人身份类凭据留本机」）。它们的 access / refresh token
 * 由官方 `pi-ai` 自己生成、自己刷新，我们只提供一个**本机加密**的存放处。
 *
 * 所以这一层的形状与上面那两条都不同：**它是个真正的读写库**（官方
 * `modifyRecord` 的"读—决定—替换"要落地，刷新才跑得起来），但它只服务
 * 一个人、一台机器：
 *
 * - `enabled` 为假（公司档 / 托管档 / 没有秘密库密钥 / 不是本人）→ 读一律"不存在"、
 *   写一律拒。**不报"你没权限"**——那会泄漏"这台机器上有人登录过"。
 * - `payload` 原样 JSON 进出：格式是 `pi-ai` 的，我们一个字段都不解释、不改写
 *   （官方 `auth.ts` 的原话：the seam treats it as opaque JSON）。
 */
export interface SubscriptionRecordSource {
  /**
   * 这台机器、这个人、这一刻允不允许读写订阅凭据。
   *
   * 公司档 / 托管档（`AGENTSWS_RUNTIME_MODE=docker|hosted`）永远是 `false`：
   * 那里的"个人订阅账号"只能是被代持的共享账号，违反 OpenAI / Anthropic 的条款。
   */
  enabled(): boolean
  /** 读一条（`<provider>`，比如 `openai-codex`）。没有就 `undefined`。 */
  read(provider: string): Promise<unknown | undefined>
  /** 写一条（原样 JSON）。 */
  write(provider: string, payload: unknown): Promise<void>
  /** 删一条；没有就当删过了。 */
  remove(provider: string): Promise<void>
  /** 现在存了哪几个 provider（排序后）。 */
  list(): Promise<readonly string[]>
}
