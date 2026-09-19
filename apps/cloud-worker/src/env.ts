/**
 * Worker 的绑定与环境变量（WP114）。
 *
 * **仓库里一个密钥值都没有**：`wrangler.toml` 的 `[vars]` 只放非敏感项
 * （对外地址、上游地址、版本），其余一律 `wrangler secret put`，由人在自己的
 * 终端里敲一次。`.dev.vars.example` 里全是空值。
 *
 * 发信那一块**根本没有密钥**：Cloudflare Email Sending 在 Worker 里是一个
 * binding（`[[send_email]]`），不需要 API key。
 */

import type { CloudflareEmailBinding } from '@agentsws/cloud/workers-kit'

/** Durable Object 的命名空间（只有 `idFromName` / `get` 这两件事）。 */
export interface DoNamespaceLike {
  idFromName(name: string): DoIdLike
  get(id: DoIdLike): { fetch(request: Request): Promise<Response> }
}

export interface DoIdLike {
  toString(): string
}

export interface WorkerEnv {
  /** 账号 / 组织 / 链接令牌 / magic link / 限流 / 幂等（**单例**）。 */
  ACCOUNTS: DoNamespaceLike
  /** 钱包：lots / reservations / 计量事件。**每个 org 一个**（`idFromName(org_id)`）。 */
  WALLET: DoNamespaceLike
  /**
   * 计量事件的只读副本（**单例**，WP115 / 65 §9）。
   *
   * 钱按组织切开之后没有一张跨全部组织的表，而后台的总览 / 台账要的正是那个。
   * 所以每条计量事件抄一份进这个对象，后台只读它。没绑这个 binding 也能跑——
   * 那时后台的看板页回 503（比画一堆 0 诚实），钱那一侧一个字不受影响。
   */
  LEDGER?: DoNamespaceLike
  /**
   * 公共红人库（**单例**，WP116 / 64 §10.2）。
   *
   * 这张红人表是跨租户共享的一层事实，所以只有一个对象。没绑这个 binding
   * 也能跑——那时 `/v1/data/kol/*` 回 404、health 里 `kol_public: false`
   * （**如实说没开通**，不假装有）。
   */
  KOL_PUBLIC?: DoNamespaceLike
  /** Cloudflare Email Sending（`[[send_email]] name = "EMAIL"`）。没绑 = 发不了信。 */
  EMAIL?: CloudflareEmailBinding
  /**
   * 运营后台的静态产物（`[assets] binding = "ASSETS"`，WP115）。
   *
   * `run_worker_first` 把 `/admin/*` 先交给 Worker，所以这个 binding 只在
   * **确认过有后台会话之后**才被调用——无权的人看到的是 404，连 index.html
   * 都拿不到（65 §8）。
   */
  ASSETS?: { fetch(request: Request): Promise<Response> }

  // ── [vars]：非敏感，进仓库 ─────────────────────────────────────────
  /** 云的对外地址，例如 `https://cloud.agentsws.com`。 */
  AGENTSWS_CLOUD_BASE_URL?: string
  /** 发件地址，例如 `agentsws <login@agentsws.com>`。不是密钥。 */
  AGENTSWS_CLOUD_MAIL_FROM?: string
  /** 模型上游的 OpenAI 兼容口根地址。内测期直接指一家官方（如 DeepSeek）。 */
  AGENTSWS_NEWAPI_BASE_URL?: string
  /** 付完跳回哪儿。 */
  AGENTSWS_CLOUD_PUBLIC_URL?: string
  AGENTSWS_VERSION?: string

  // ── secrets：`wrangler secret put`，仓库里只有名字 ──────────────────
  /** 打模型上游的那把 key。 */
  AGENTSWS_NEWAPI_KEY?: string
  /** 管理员手动发积分那条路由的钥匙；没配这条路由**根本不挂**。 */
  AGENTSWS_CLOUD_ADMIN_TOKEN?: string
  STRIPE_SECRET_KEY?: string
  STRIPE_WEBHOOK_SECRET?: string
  /**
   * 公共红人库的邮箱密钥（AES-256-GCM 的 32 字节，hex 或 base64url）。
   *
   * 没配就**不存邮箱**（`nodeKolSecrets` 的 `encrypt` 回 `undefined`，
   * 落库那一层一个字节都不写），health 里那一格标黄。绝不降级成明文。
   */
  AGENTSWS_KOL_EMAIL_KEY?: string
  /** YouTube Data API v3 的 key。没配就没有官方口（只查库或走 Apify）。 */
  AGENTSWS_YOUTUBE_API_KEY?: string
  /** Apify 的 token（降级口）。没配就不降级。 */
  APIFY_TOKEN?: string
  /** YouTube 官方口一天给多少配额单位（非敏感，可以进 `[vars]`）。 */
  AGENTSWS_YOUTUBE_UNITS_PER_DAY?: string
}

/** `env` 里那些字符串项 → 现有代码认的那种 `Record`。 */
export function envRecord(env: WorkerEnv): Record<string, string | undefined> {
  const out: Record<string, string | undefined> = {}
  for (const [k, v] of Object.entries(env as unknown as Record<string, unknown>))
    if (typeof v === 'string') out[k] = v
  return out
}
