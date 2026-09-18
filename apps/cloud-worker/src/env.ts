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
  /** Cloudflare Email Sending（`[[send_email]] name = "EMAIL"`）。没绑 = 发不了信。 */
  EMAIL?: CloudflareEmailBinding

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
}

/** `env` 里那些字符串项 → 现有代码认的那种 `Record`。 */
export function envRecord(env: WorkerEnv): Record<string, string | undefined> {
  const out: Record<string, string | undefined> = {}
  for (const [k, v] of Object.entries(env as unknown as Record<string, unknown>))
    if (typeof v === 'string') out[k] = v
  return out
}
