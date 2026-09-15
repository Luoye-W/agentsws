/**
 * 云端公共红人库的客户端**接口**（48 §5.3 / 49 M2）。
 *
 * 本 WP 只立接口 + 一个假实现。真接线等 WP61（`packages/kol-public` 与
 * `/v1/data/*` 路由）合并之后另开——那时换的是注入进来的实现，
 * 这个文件里的三个方法名与形状**一个字不改**。
 *
 * 形状照 WP61 的三条路由立：
 *
 * | 方法 | 路由 | 收费（49 M4） |
 * |---|---|---|
 * | `browse` | `GET /v1/data/kol/creators` | 免费 |
 * | `audit` | `POST /v1/data/kol/audit` | 免费（体检报告） |
 * | `reveal` | `POST /v1/data/kol/reveal` | `data.kol.lookup` 扣积分 |
 *
 * 两条纪律：
 *
 * 1. **`reveal` 回的是加密库 key 名，不是邮箱**。付了积分拿回来的明文由宿主
 *    当场写进本机加密库，这个接口的返回值里永远没有一个真地址——
 *    与 `CreatorContact.value_ref` 是同一条（48 §5.2）。
 * 2. **没开托管档就是没开**。假实现回 `{ ok: false, reason: 'not_linked' }`
 *    + 一句人话，不假装查过。49 M5 那条"一个数字都不自己算"在这里的样子。
 */
import type { KolChannel } from '@agentsws/contracts'

export type PublicLibraryFailure =
  | 'not_linked'
  | 'not_implemented'
  | 'insufficient_credits'
  | 'not_found'
  | 'upstream_error'

export interface PublicLibraryError {
  ok: false
  reason: PublicLibraryFailure
  message: string
}

export interface PublicLibraryOk<T> {
  ok: true
  data: T
  /** 这一次花了多少积分（免费的那两个恒为 0）。 */
  credits_spent: number
}

export type PublicLibraryResult<T> = PublicLibraryOk<T> | PublicLibraryError

/** 公共库里的一条（去标识化：没有联系方式）。 */
export interface PublicCreatorRow {
  /** 公共库里的 id（与本地的 `creator_id` 不是一回事）。 */
  public_id: string
  channel: KolChannel
  handle: string
  display_name: string
  followers?: number
  engagement_rate?: number
  category?: string
  language?: string
  region?: string
  observed_at: string
  /** 有没有人回填过联系方式（有的话 `reveal` 才拿得到东西）。 */
  has_contact: boolean
}

export interface BrowseQuery {
  channel?: KolChannel
  q?: string
  category?: string
  language?: string
  region?: string
  followers_band?: { min: number; max: number }
  limit?: number
  cursor?: string
}

export interface BrowseResult {
  rows: PublicCreatorRow[]
  next_cursor?: string
}

/** 免费体检报告（48 §5.3「免费体检报告」）。 */
export interface AuditReport {
  public_id: string
  channel: KolChannel
  handle: string
  /** 0–100，公共库自己的分（与本地 `scoring.ts` 那一份**不是**同一个数，界面上分开说）。 */
  health: number
  /** 各项结论，一句一条人话。 */
  findings: string[]
  /** k-匿名基准里同量级账号的中位互动率（样本不够时没有）。 */
  benchmark_engagement_rate?: number
  sample_size?: number
}

/** 付费 reveal 的结果。**没有明文**，见文件头第 1 条。 */
export interface RevealResult {
  public_id: string
  contacts: {
    kind: 'email' | 'dm' | 'form'
    /** 宿主把明文写进加密库之后的 key 名。 */
    value_ref: string
    source: string
    verified_at?: string
  }[]
}

export interface PublicLibraryClient {
  /** 现在连着云端公共库没有（49 M2 那个开关）。 */
  linked(): boolean
  browse(query: BrowseQuery): Promise<PublicLibraryResult<BrowseResult>>
  audit(input: { channel: KolChannel; handle: string }): Promise<PublicLibraryResult<AuditReport>>
  reveal(input: { public_id: string }): Promise<PublicLibraryResult<RevealResult>>
}

/** 没关联云端账号时那一句话（三个方法共用一句，界面上才一致）。 */
export const NOT_LINKED_MESSAGE =
  '还没连 agentsws 的公共红人库（这是托管档的服务）。没连也能用：找人靠导入你手上的表与各渠道自己的接口，建联、合作、审核、归因一样不少。'

/**
 * 假实现：三个方法都回 `not_linked`。
 *
 * 它不是占位符里的 `throw new Error('TODO')`——它是**默认实现**：
 * 本地档（免费）的用户永远拿到的就是它，而且那是正确行为。
 * WP61 合并之后，连上云的用户拿到的是另一个实现，这个仍然留着。
 */
export function createUnlinkedPublicLibrary(): PublicLibraryClient {
  const err = async <T>(): Promise<PublicLibraryResult<T>> => ({
    ok: false,
    reason: 'not_linked',
    message: NOT_LINKED_MESSAGE,
  })
  return {
    linked: () => false,
    browse: err<BrowseResult>,
    audit: err<AuditReport>,
    reveal: err<RevealResult>,
  }
}
