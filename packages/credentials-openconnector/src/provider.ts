/**
 * `credentials-openconnector`：官方 `ctx.credentials` 的 provider（55 §4 凭据段）。
 *
 * ## 实测结论：这个 seam 是**单 provider** 的
 *
 * 55 §4 留了一句"未验证：官方 seam 是单 provider，本机凭据（模型 key）与
 * OpenConnector 能否分层，做的时候实测"。实测了：**不能分层**。
 * `CredentialProvider extends Service`，服务名是 `credentials`；一棵 Cordis 树上
 * 挂第二个当场抛 `service "credentials" has been registered at <…>`，第一个继续有效。
 *
 * 所以这里做的是**一个组合 provider**（{@link CompositeCredentials}）：
 *
 * | 半边 | 谁答 | 为什么 |
 * |---|---|---|
 * | `CredentialRef`（环境变量名） | 本机引用层（`envRefSource` 或调用方给的） | 模型 key、SMTP 密码是这台机器上的配置，与外部 SaaS 授权无关 |
 * | `CredentialKey`（`<owner>/<id>` 记录） | OpenConnector | 外部连接的授权在它那儿，13 §4 的边界就在这条线上 |
 *
 * ## 记录半边的三条硬规矩
 *
 * 1. **`readRecord` 只出 `{ access, expires }`，没有 refresh token。**
 *    平台的 refresh token 从头到尾在 OpenConnector 的凭据库里；我们连见都见不到
 *    （`access` 本身也只是一把 agentsws runtime token，见 `source.ts`）。
 * 2. **`modifyRecord` 只能触发"让 OpenConnector 刷新"，不能往 dsh 侧写新 token。**
 *    官方把 `modifyRecord` 定义成"读—决定—替换"的跨进程读改写，正是为了 token 轮换；
 *    我们保留那个形状，但把"替换"这一步**交还给 OpenConnector**：mutate 回
 *    `undefined` = 不动，回任何别的 = "这把过期了，去换一把"。它返回的 payload
 *    一律**不采用**——采用了就等于 dsh 侧能写凭据，13 §4 的边界当场破掉。
 * 3. **跨工作区读不到。** owner 段就是 workspace id；不是本 source 那个工作区的
 *    一律当"没有这条记录"（不是报错——报错会泄漏"那边有没有这条连接"）。
 */
import type { Context } from '@deepseek-ai/cordis'
import type {
  CredentialInfo,
  CredentialKey,
  CredentialRecord,
  CredentialRecordEntry,
  CredentialRecordInfo,
  CredentialRef,
  ResolvedCredential,
} from '@deepseek-ai/dsh-credentials'
import {
  CredentialProvider,
  credentialKey,
  credentialKeyId,
  credentialKeyScope,
  isCredentialKeySegment,
} from '@deepseek-ai/dsh-credentials'
import type {
  CredentialRefSource,
  OpenConnectorGrant,
  OpenConnectorSource,
  SubscriptionRecordSource,
} from './source.js'

/**
 * WP90（55 §9 Q8）：订阅登录那一族记录的 owner 段。
 *
 * 这个串不是我们起的——是上游 `dsh-llm-pi-ai` 的 `RECORD_SCOPE`
 * （`auth.ts`：「the plugin's registered name」）。官方按它写、我们按它认，
 * 写死一个常量就是为了**它哪天改了，这里立刻对不上**，而不是悄悄少存一条。
 */
export const SUBSCRIPTION_RECORD_SCOPE = 'llm-pi-ai'

/** 这个 provider 自己的错误（调用方按 code 分流；message 是人话）。 */
export class CredentialsBoundaryError extends Error {
  constructor(
    readonly code: 'read_only' | 'not_supported' | 'forbidden',
    message: string,
  ) {
    super(message)
    this.name = 'CredentialsBoundaryError'
  }
}

/**
 * `<owner>/<id>` 的两段都得过官方的 `[a-z][a-z0-9-]*`。
 * workspace id（`ws_local`）与 kind（`shopify_admin`、`mcp:my-tools`）都可能带别的字符，
 * 所以两边**同一个**归一化函数——写进去与读出来必须是同一串。
 */
export function credentialSegment(value: string): string {
  const mapped = value
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, '-')
    .replace(/^-+|-+$/g, '')
  const safe = mapped === '' ? 'x' : mapped
  return /^[a-z]/.test(safe) ? safe : `x-${safe}`
}

/** 这条连接在 `ctx.credentials` 里的地址。 */
export function connectionCredentialKey(workspace_id: string, kind: string): CredentialKey {
  return credentialKey(credentialSegment(workspace_id), credentialSegment(kind))
}

/** `readRecord` 回去的那个 payload 的形状（**这就是全部**，没有第四个字段）。 */
export interface ConnectionGrantPayload {
  /** 这条连接是哪一类（`shopify` / `email`）。 */
  kind: string
  /** 代这条职责去调的那把凭证。 */
  access: string
  /** ISO8601；没有就是没有到期时间。 */
  expires?: string
}

function payloadOf(kind: string, grant: OpenConnectorGrant): ConnectionGrantPayload {
  return {
    kind,
    access: grant.access,
    ...(grant.expires_at === undefined ? {} : { expires: grant.expires_at }),
  }
}

export interface CompositeCredentialsConfig {
  /** 引用半边（环境变量名）。 */
  refs: CredentialRefSource
  /** 记录半边（OpenConnector）。不给 = 这棵树上没有外部连接的凭据可读。 */
  connector?: OpenConnectorSource
  /**
   * WP90：记录半边的**第三条路**——`llm-pi-ai/<provider>`（ChatGPT / Claude 订阅登录）
   * 走本机加密秘密库，不走 OpenConnector（20：个人身份类凭据留本机）。
   *
   * 不给 = 这棵树上没有订阅登录：读一律"不存在"、写一律拒，与公司档同一个答案。
   */
  subscriptions?: SubscriptionRecordSource
}

/**
 * 组合 provider：引用走本机、记录走 OpenConnector。
 *
 * 挂法与官方 provider 一样——一棵树上**只有它一个**：
 * ```ts
 * root.plugin(CompositeCredentials, { refs: envRefSource(), connector })
 * ```
 */
export class CompositeCredentials extends CredentialProvider {
  private readonly refs: CredentialRefSource
  private readonly connector: OpenConnectorSource | undefined
  /** WP90：订阅登录那一族记录（`llm-pi-ai/*`）的本机库。 */
  private readonly subscriptions: SubscriptionRecordSource | undefined
  /** OpenConnector 那个工作区在 `<owner>/<id>` 里的那一段。 */
  private readonly owner: string | undefined

  constructor(ctx: Context, config: CompositeCredentialsConfig) {
    super(ctx)
    this.refs = config.refs
    this.connector = config.connector
    this.subscriptions = config.subscriptions
    this.owner =
      config.connector === undefined ? undefined : credentialSegment(config.connector.workspace_id)
  }

  // ── 记录半边之三：订阅登录（WP90，55 §9）────────────────────────────

  /**
   * 这个 key 是不是"一条订阅登录记录"，而且**现在允许碰**。
   *
   * 两件事一起判，返回 `undefined` 就是"这条路不通"：既包括"这不是订阅记录"，
   * 也包括"是，但这台机器 / 这个人不该读它"。调用方据此一律回"不存在"——
   * 分开报会泄漏"这台机器上有人登录过 ChatGPT"。
   */
  private subscriptionIdOf(key: CredentialKey): string | undefined {
    if (this.subscriptions === undefined) return undefined
    if (credentialKeyScope(key) !== SUBSCRIPTION_RECORD_SCOPE) return undefined
    if (!this.subscriptions.enabled()) return undefined
    const id = credentialKeyId(key)
    return isCredentialKeySegment(id) ? id : undefined
  }

  /** 这个 key 落在订阅那一族里（不管现在允不允许碰）。写那一半要区分它。 */
  private isSubscriptionKey(key: CredentialKey): boolean {
    return credentialKeyScope(key) === SUBSCRIPTION_RECORD_SCOPE
  }

  // ── 引用半边（本机）─────────────────────────────────────────────────

  async resolve(ref: CredentialRef): Promise<ResolvedCredential | undefined> {
    return this.refs.resolve(String(ref))
  }

  async describe(ref: CredentialRef): Promise<CredentialInfo> {
    const info = await this.refs.describe(String(ref))
    return {
      configured: info.configured,
      ...(info.source === undefined ? {} : { source: info.source }),
      writable: info.writable,
    }
  }

  async set(ref: CredentialRef, value: string): Promise<void> {
    if (value === '') throw new CredentialsBoundaryError('not_supported', '空值存不进来，用 unset')
    if (this.refs.set === undefined) {
      throw new CredentialsBoundaryError('read_only', '这台机器的凭据层是只读的')
    }
    await this.refs.set(String(ref), value)
    this.notifyUpdated(ref)
  }

  async unset(ref: CredentialRef): Promise<void> {
    if (this.refs.unset === undefined) {
      throw new CredentialsBoundaryError('read_only', '这台机器的凭据层是只读的')
    }
    await this.refs.unset(String(ref))
    this.notifyUpdated(ref)
  }

  // ── 记录半边（OpenConnector）────────────────────────────────────────

  /** 这个 key 是不是"本工作区的一条连接"；不是就当没有（跨工作区读不到）。 */
  private kindOf(key: CredentialKey): string | undefined {
    if (this.connector === undefined || this.owner === undefined) return undefined
    if (credentialKeyScope(key) !== this.owner) return undefined
    const id = credentialKeyId(key)
    return isCredentialKeySegment(id) ? id : undefined
  }

  /** 归一化过的 id 反查回真正的 kind（`shopify-admin` → `shopify_admin`）。 */
  private async rawKindOf(id: string): Promise<string | undefined> {
    const kinds = await (this.connector?.kinds() ?? Promise.resolve([]))
    return kinds.find((k) => credentialSegment(k) === id)
  }

  async readRecord(key: CredentialKey): Promise<CredentialRecord | undefined> {
    const subscription = this.subscriptionIdOf(key)
    if (subscription !== undefined) {
      const payload = await this.subscriptions?.read(subscription)
      // payload 是 pi-ai 的格式，我们一个字段都不解释、不改写（原样进原样出）
      return payload === undefined ? undefined : { kind: 'grant', payload }
    }
    if (this.isSubscriptionKey(key)) return undefined
    const id = this.kindOf(key)
    if (id === undefined) return undefined
    const kind = await this.rawKindOf(id)
    if (kind === undefined) return undefined
    const grant = await this.connector?.grant(kind)
    if (grant === undefined) return undefined
    return { kind: 'grant', payload: payloadOf(kind, grant) }
  }

  async describeRecord(key: CredentialKey): Promise<CredentialRecordInfo> {
    const subscription = this.subscriptionIdOf(key)
    if (subscription !== undefined) {
      const payload = await this.subscriptions?.read(subscription)
      // 值一个字都不在这个返回里——登没登录、能不能改，就是全部
      return payload === undefined
        ? { configured: false, writable: true }
        : { configured: true, kind: 'grant', writable: true }
    }
    if (this.isSubscriptionKey(key)) return { configured: false, writable: false }
    const id = this.kindOf(key)
    if (id === undefined) return { configured: false, writable: false }
    const kind = await this.rawKindOf(id)
    if (kind === undefined) return { configured: false, writable: false }
    const grant = await this.connector?.grant(kind)
    // 值一个字都不在这个返回里——`configured` / `kind` / `writable` 就是全部
    return grant === undefined
      ? { configured: false, writable: false }
      : { configured: true, kind: 'grant', writable: true }
  }

  async listRecords(): Promise<readonly CredentialRecordEntry[]> {
    const entries: CredentialRecordEntry[] = []
    // WP90：订阅登录那一族（公司档 / 托管档 / 非本人一条都不列）
    if (this.subscriptions?.enabled() === true) {
      for (const id of await this.subscriptions.list()) {
        if (!isCredentialKeySegment(id)) continue
        entries.push({ key: credentialKey(SUBSCRIPTION_RECORD_SCOPE, id), kind: 'grant' as const })
      }
    }
    if (this.connector !== undefined) {
      const kinds = await this.connector.kinds()
      // 只列这一个工作区的（`owner` 段就是它）——别的工作区在这个 provider 上不存在
      for (const k of kinds) {
        entries.push({
          key: connectionCredentialKey(this.connector.workspace_id, k),
          kind: 'grant' as const,
        })
      }
    }
    return entries.sort((a, b) => String(a.key).localeCompare(String(b.key)))
  }

  /**
   * 读改写：**唯一允许的写就是"让 OpenConnector 刷新"**。
   *
   * `mutate` 拿到的是当前这条记录（与 `readRecord` 同一份，同样没有 refresh token）。
   * - 回 `undefined` → 什么都不做，原样返回当前记录（官方语义）。
   * - 回**任何别的** → 当成"这把不能用了，去换一把"：我们调 OpenConnector 的刷新，
   *   把它给的新 grant 返回去。**`mutate` 返回的 payload 一律丢弃**——采用它就等于
   *   dsh 侧能往凭据库里写东西，13 §4 的边界就没了。
   * - 回一条 `api-key` 记录 → 直接拒（那是"我要存一把新钥匙"，这个 provider 不干这事）。
   */
  async modifyRecord(
    key: CredentialKey,
    mutate: (current: CredentialRecord | undefined) => Promise<CredentialRecord | undefined>,
  ): Promise<CredentialRecord | undefined> {
    const subscription = this.subscriptionIdOf(key)
    if (subscription !== undefined) {
      /*
       * WP90：**这一条是真的读改写**——官方 `pi-ai` 的 token 刷新就跑在这里面
       * （`auth.ts` 的 `modify()`：read → mutate → 提交，一次往返里含一次网络请求）。
       * 上面 OpenConnector 那一半之所以"只能触发刷新、不能写"，是因为那边的
       * refresh token 不归我们；这边归——它就存在本机加密库里，除了这里没有第二个写入方。
       *
       * `mutate` 回 `undefined` = 什么都不做（官方语义）；回一条 `grant` = 原样落盘。
       * `api-key` 不收：订阅登录产不出 api key，收了只会让格式变脏。
       */
      const current = await this.readRecord(key)
      const wanted = await mutate(current)
      if (wanted === undefined) return current
      if (wanted.kind !== 'grant') {
        throw new CredentialsBoundaryError(
          'not_supported',
          '订阅登录只存授权记录，这里写不了 API key（55 §9）',
        )
      }
      await this.subscriptions?.write(subscription, wanted.payload)
      // 官方 `authorization.begin()` 靠这条事件确认"这一次真的提交了"，少发一次登录就报 NOT_COMMITTED
      this.notifyRecordUpdated(key)
      return wanted
    }
    if (this.isSubscriptionKey(key)) {
      throw new CredentialsBoundaryError(
        'forbidden',
        '这台机器不允许用个人订阅账号登录（公司档 / 托管档；账号只属于你本人）',
      )
    }
    const id = this.kindOf(key)
    if (id === undefined) {
      throw new CredentialsBoundaryError('forbidden', `这条记录不属于这个工作区：${String(key)}`)
    }
    const kind = await this.rawKindOf(id)
    if (kind === undefined) {
      throw new CredentialsBoundaryError('forbidden', `没有这条连接：${String(key)}`)
    }
    const current = await this.readRecord(key)
    const wanted = await mutate(current)
    if (wanted === undefined) return current
    if (wanted.kind !== 'grant') {
      throw new CredentialsBoundaryError(
        'not_supported',
        '外部连接的凭据存在 OpenConnector 里，这里写不了新钥匙（13 §4）',
      )
    }
    const refreshed = await this.connector?.refresh(kind)
    if (refreshed === undefined) return undefined
    this.notifyRecordUpdated(key)
    return { kind: 'grant', payload: payloadOf(kind, refreshed) }
  }

  /**
   * 删一条：**这个 provider 不删**。
   *
   * 官方语义是"不存在就 no-op"，那一半照办；真存在的那条不能从这里删——
   * 断开一条连接是连接页的事（`Connect.removeConnection`，凭据随之在
   * OpenConnector 侧删掉）。从这里删只会删掉我们这一侧的影子，人以为断了，其实没断。
   */
  async deleteRecord(key: CredentialKey): Promise<void> {
    const subscription = this.subscriptionIdOf(key)
    if (subscription !== undefined) {
      // 登出 = 把记录销毁。这一条**必须能删**（上面那半不能删是因为删了会骗人：
      // 连接其实还连着。订阅这边删掉就是真的退出登录，下一次运行连不上，正是本意）
      await this.subscriptions?.remove(subscription)
      this.notifyRecordUpdated(key)
      return
    }
    if (this.isSubscriptionKey(key)) return
    const existing = await this.readRecord(key)
    if (existing === undefined) return
    throw new CredentialsBoundaryError(
      'not_supported',
      '要断开这条连接请走连接页（凭据在 OpenConnector 侧删除），这里删不了',
    )
  }
}

export default CompositeCredentials
