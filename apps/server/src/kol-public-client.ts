/**
 * WP68（49 M2 / 48 §5.3）：**本地这一侧真的连上云端公共红人库**。
 *
 * WP67 立了 `PublicLibraryClient` 这个接口与一个永远回 `not_linked` 的默认实现；
 * WP61 把云上那一半建好了（`packages/kol-public`，`/v1/data/kol/*`）。
 * 这个文件是把两半接起来的那一跳——接口的三个方法名与形状**一个字没改**。
 *
 * 五条纪律：
 *
 * 1. **令牌只在一行里出现**：这个品牌那把 `cloud.workspace_token`（WP66 每品牌一把），
 *    取出来直接进 `Authorization`，函数返回之后没人再引用它。
 * 2. **只带红人以外的零个本地数据**。请求里只有渠道、handle、几个筛选条件——
 *    店铺、订单、客户、事项一个字节都不过去（21 §1 的同一条）。
 * 3. **明文不落这一层**。付费 reveal 拿回来的邮箱在**同一个函数里**写进本机加密库，
 *    返回值里只有 `value_ref`——与 `CreatorContact.value_ref` 是同一条纪律。
 * 4. **没给 `data` 权限不是"云坏了"**。403 + `required_scope: data` 翻成一句
 *    人话："关联账号的时候没给数据服务权限，去设置 → 账号与积分重新关联一次。"
 *    这一句要让人知道去哪儿点，而不是看到一个 403。
 * 5. **计费照实回**（WP126）：官方数据接口没有免费动作了——浏览 / 体检都按次扣
 *    积分，`credits_spent` 从云侧响应里带回来，本地一个数字都不自己算。
 */
import type { Clock, KolChannel, WorkspaceId } from '@agentsws/contracts'
import { KOL_LOOKUP_CAPABILITY, KOL_PUBLIC_SCOPE } from '@agentsws/contracts'
import type {
  AuditReport,
  BrowseQuery,
  BrowseResult,
  PublicCreatorRow,
  PublicLibraryClient,
  PublicLibraryFailure,
  PublicLibraryResult,
  RevealResult,
} from '@agentsws/kol-core'
import { cloudBaseUrl } from './cloud.js'
import { CLOUD_TOKEN_SECRET_ID } from './cloud-account.js'
import { CONTACT_SECRET_FIELD, contactSecretId } from './kol-service.js'
import type { SecretStore } from './secret-store.js'

/** 云上公共库的路径前缀（真源在 `packages/kol-public` 的 `KOL_PREFIX`）。 */
export const KOL_PUBLIC_PREFIX = '/v1/data/kol'

/** 打云侧最多等多久。 */
export const KOL_PUBLIC_TIMEOUT_MS = 10_000

export type KolPublicFetch = (
  input: string,
  init: { method: string; headers: Record<string, string>; body?: string; signal?: AbortSignal },
) => Promise<{ ok: boolean; status: number; text(): Promise<string> }>

/** 没给 `data` 权限时那一句（要让人知道去哪儿点）。 */
export const NO_DATA_SCOPE_MESSAGE =
  '关联 agentsws 账号的时候没给"数据服务"这一项权限，所以公共红人库现在进不去。去"设置 → 账号与积分"重新关联一次就好。'

/** 没关联账号时那一句（与 `kol-core` 的 `NOT_LINKED_MESSAGE` 同义，措辞更具体）。 */
export const NOT_LINKED_MESSAGE =
  '还没关联 agentsws 账号，所以用不了公共红人库（那是托管档的服务）。没连也能用：找人靠导入你手上那张表与各渠道自己的接口，建联、合作、审核、归因一样不少。'

export interface KolPublicClientOptions {
  workspace_id: WorkspaceId
  clock: Clock
  /** 这个品牌那一段加密库：令牌从这里取，reveal 回来的明文也写回这里。 */
  secrets: SecretStore
  env: Record<string, string | undefined>
  /** 测试注入（指向内存版云进程）；生产不传，走全局 fetch。 */
  fetch?: KolPublicFetch
  /**
   * reveal 拿回来的明文要挂到哪条本地联系方式上。
   *
   * 由宿主给（`kol-service` 那一侧建记录、分配 id），这个文件只负责**写密文**——
   * 谁建记录谁给 id，两处各管一段。
   */
  newContactId(): string
}

interface Envelope<T> {
  data?: T
}

interface ErrorBody {
  code?: string
  message?: string
  details?: { required_scope?: string }
}

/** 云侧的错误码 → 接口上的失败原因。认不出来的一律 `upstream_error`，不编。 */
function failureOf(code: string | undefined, status: number): PublicLibraryFailure {
  if (code === 'insufficient_credits' || status === 402) return 'insufficient_credits'
  if (code === 'not_found' || status === 404) return 'not_found'
  if (code === 'unauthenticated' || status === 401) return 'not_linked'
  return 'upstream_error'
}

export function createKolPublicClient(options: KolPublicClientOptions): PublicLibraryClient {
  const base = `${cloudBaseUrl(options.env)}${KOL_PUBLIC_PREFIX}`
  const doFetch: KolPublicFetch =
    options.fetch ??
    ((input, init) =>
      globalThis.fetch(input, init as RequestInit) as unknown as ReturnType<KolPublicFetch>)

  /** 这个品牌那把工作区服务令牌。取值即用，不缓存。 */
  const tokenOf = (): string | undefined => {
    if (!options.secrets.available) return undefined
    try {
      const token = options.secrets.get(CLOUD_TOKEN_SECRET_ID)?.token
      return token === undefined || token === '' ? undefined : token
    } catch {
      // 换过秘密库密钥：当成"没关联"
      return undefined
    }
  }

  const notLinked = <T>(): PublicLibraryResult<T> => ({
    ok: false,
    reason: 'not_linked',
    message: NOT_LINKED_MESSAGE,
  })

  async function call<T>(
    path: string,
    init: { method: 'GET' | 'POST' } = { method: 'GET' },
  ): Promise<PublicLibraryResult<T>> {
    const token = tokenOf()
    if (token === undefined) return notLinked<T>()
    const controller = new AbortController()
    const timer = setTimeout(() => {
      controller.abort()
    }, KOL_PUBLIC_TIMEOUT_MS)
    try {
      // 令牌只在这一行进头
      const res = await doFetch(`${base}${path}`, {
        method: init.method,
        headers: { Authorization: `Bearer ${token}`, accept: 'application/json' },
        signal: controller.signal,
      })
      const text = await res.text()
      let parsed: unknown
      try {
        parsed = text.trim() === '' ? {} : JSON.parse(text)
      } catch {
        parsed = {}
      }
      if (!res.ok) {
        const body = parsed as ErrorBody
        // 403 + required_scope：不是云坏了，是关联那一步少给了一项权限
        if (res.status === 403 && body.details?.required_scope === KOL_PUBLIC_SCOPE)
          return { ok: false, reason: 'not_linked', message: NO_DATA_SCOPE_MESSAGE }
        return {
          ok: false,
          reason: failureOf(body.code, res.status),
          message: body.message ?? `公共红人库那边没给回数据（HTTP ${res.status}）`,
        }
      }
      return { ok: true, data: (parsed as Envelope<T>).data as T, credits_spent: 0 }
    } catch {
      return {
        ok: false,
        reason: 'upstream_error',
        message: '连不上 agentsws 云（网络不通，或者云那边暂时不可用）。稍后再试一次。',
      }
    } finally {
      clearTimeout(timer)
    }
  }

  /** 云上那张卡 → 接口上的那一行。两边的字段名不一样，只有这一处翻译。 */
  const rowOf = (card: {
    channel: KolChannel
    handle: string
    followers?: number
    engagement_rate?: number
    categories?: string[]
    language?: string
    region?: string
    observed_at: string
    has_contact: boolean
  }): PublicCreatorRow => ({
    // 公共库里一个人的自足键就是 `{channel, handle}`（WP61 的契约里没有 id）
    public_id: `${card.channel}:${card.handle}`,
    channel: card.channel,
    handle: card.handle,
    // 公共库里没有"显示名"这一格（去标识化），所以拿 handle 当名字用
    display_name: card.handle,
    ...(card.followers === undefined ? {} : { followers: card.followers }),
    ...(card.engagement_rate === undefined ? {} : { engagement_rate: card.engagement_rate }),
    ...(card.categories?.[0] === undefined ? {} : { category: card.categories[0] }),
    ...(card.language === undefined ? {} : { language: card.language }),
    ...(card.region === undefined ? {} : { region: card.region }),
    observed_at: card.observed_at,
    has_contact: card.has_contact,
  })

  /** `youtube:gadgetjonas` → `{channel, handle}`；形状不对回 `undefined`。 */
  const keyOf = (public_id: string): { channel: string; handle: string } | undefined => {
    const at = public_id.indexOf(':')
    if (at <= 0) return undefined
    const channel = public_id.slice(0, at)
    const handle = public_id.slice(at + 1)
    return handle === '' ? undefined : { channel, handle }
  }

  return {
    linked: () => tokenOf() !== undefined,

    async browse(query: BrowseQuery): Promise<PublicLibraryResult<BrowseResult>> {
      const params = new URLSearchParams()
      if (query.channel !== undefined) params.set('channel', query.channel)
      if (query.q !== undefined && query.q !== '') params.set('q', query.q)
      if (query.category !== undefined) params.set('category', query.category)
      if (query.followers_band !== undefined)
        params.set('min_followers', String(query.followers_band.min))
      if (query.limit !== undefined) params.set('limit', String(query.limit))
      const q = params.toString()
      const out = await call<{ creators: Parameters<typeof rowOf>[0][] }>(
        `/creators${q === '' ? '' : `?${q}`}`,
      )
      if (!out.ok) return out
      // WP126：浏览 / 搜索按 `data.kol.lookup` 收（0.2 / 次），云侧算了多少回多少
      return {
        ok: true,
        credits_spent: (out.data as { credits?: number }).credits ?? 0,
        data: {
          rows: ((out.data as { creators?: unknown[] }).creators ?? []).map((c) =>
            rowOf(c as Parameters<typeof rowOf>[0]),
          ),
        },
      }
    },

    async audit(input: {
      channel: KolChannel
      handle: string
    }): Promise<PublicLibraryResult<AuditReport>> {
      const out = await call<{
        channel: KolChannel
        handle: string
        sample_size: number
        insufficient_samples: boolean
        follower_authenticity?: number
        engagement_percentile?: number
        active_30d: boolean
        risk_flags: string[]
        note: string
        credits?: number
        benchmark?: { p50_engagement_rate?: number; sample_size?: number }
      }>(`/creators/${encodeURIComponent(input.channel)}/${encodeURIComponent(input.handle)}/audit`)
      if (!out.ok) return out
      const report = out.data
      return {
        ok: true,
        // WP126：体检报告按 `data.kol.audit` 收，云侧在报告里带回 credits
        credits_spent: report.credits ?? 0,
        data: {
          public_id: `${report.channel}:${report.handle}`,
          channel: report.channel,
          handle: report.handle,
          /*
           * 体检报告的 `health` 是**我们这一侧算的一个概括数**，而云那边给的是
           * 分项（真实度 / 分位 / 活跃 / 风险标记）。粉丝真实度没有就按 50 起
           * 并把风险标记扣下去——**样本不够那一条会在 `findings` 里明说**，
           * 所以这个数不会被当成"体检通过"。
           */
          health: Math.max(
            0,
            Math.min(
              100,
              Math.round((report.follower_authenticity ?? 0.5) * 100) -
                report.risk_flags.length * 10,
            ),
          ),
          findings: [report.note, ...report.risk_flags.map(riskText)],
          ...(report.benchmark?.p50_engagement_rate === undefined
            ? {}
            : { benchmark_engagement_rate: report.benchmark.p50_engagement_rate }),
          ...(report.sample_size === undefined ? {} : { sample_size: report.sample_size }),
        },
      }
    },

    async reveal(input: { public_id: string }): Promise<PublicLibraryResult<RevealResult>> {
      const key = keyOf(input.public_id)
      if (key === undefined)
        return {
          ok: false,
          reason: 'not_found',
          message: `认不出这是谁（${input.public_id}）。公共库里一个人的键是「渠道:账号名」。`,
        }
      if (!options.secrets.available)
        return {
          ok: false,
          reason: 'upstream_error',
          message:
            '这台机器的加密库还没开（缺 AGENTSWS_SECRETS_KEY），取回来的邮箱没地方安全地放，所以这一步不做——也就不会扣积分。',
        }
      const out = await call<{ email?: string; source?: string; at?: string; credits?: number }>(
        `/creators/${encodeURIComponent(key.channel)}/${encodeURIComponent(key.handle)}/reveal`,
        { method: 'POST' },
      )
      if (!out.ok) return out
      const email = out.data.email
      if (email === undefined || email === '')
        return {
          ok: false,
          reason: 'not_found',
          message: '库里还没有这个人的联系方式。没有取到就不收钱——这一次没有扣积分。',
        }
      /*
       * **明文在这一行落进加密库，然后就不再出现**。
       * 返回值里只有 key 名——与 `CreatorContact.value_ref` 是同一条纪律。
       */
      const contact_id = options.newContactId()
      const value_ref = contactSecretId(contact_id)
      options.secrets.put(value_ref, { [CONTACT_SECRET_FIELD]: email.trim() })
      return {
        ok: true,
        credits_spent: out.data.credits ?? 0,
        data: {
          public_id: input.public_id,
          contacts: [
            {
              kind: 'email',
              value_ref,
              source: 'public_library',
              ...(out.data.at === undefined ? {} : { verified_at: out.data.at }),
            },
          ],
        },
      }
    },
  }
}

/** 风险标记 → 一句人话。**只标不判**——是不是不合作由用户自己定（48 §5.3）。 */
function riskText(flag: string): string {
  switch (flag) {
    case 'no_recent_posts':
      return '近 30 天没发过东西。'
    case 'engagement_far_below_peers':
      return '互动率明显低于同量级的同行。'
    case 'engagement_far_above_peers':
      return '互动率明显高于同量级的同行——可能是真的好，也可能是刷的。'
    case 'follower_spike':
      return '粉丝数出现过一次跳涨。'
    case 'single_source':
      return '这份资料只有一个来源看到过，可信度有限。'
    case 'stale_data':
      return '这份资料有点旧了。'
    default:
      return flag
  }
}

/** 这一次 reveal 要花多少积分（价目从云上那一份来，本地不自己算）。 */
export const REVEAL_CAPABILITY = KOL_LOOKUP_CAPABILITY
