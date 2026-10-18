/**
 * WP406（私有 docs/107 §7）：云上「岗位更新」那几条路的 demo 替身——订阅（开通 / 状态）、清单原始字节、签名、
 * 按哈希取文件、摘要（不查订阅）。包是截图脚本现打、现签的（钥匙只活在那个进程里），不出网、不扣真积分。
 */
import type { ContentManifest, ContentSubscriptionView } from '@agentsws/contracts'
import {
  CONTENT_SUBSCRIPTION_PATH,
  OFFICIAL_CONTENT_PATHS,
  parseContentPositionsQuery,
  summarizeOfficialContent,
} from '@agentsws/contracts'

export interface OfficialContentStandInOptions {
  /** 清单原始字节（签名就是对它签的）。 */
  manifest: Uint8Array
  signature: string
  blobs: ReadonlyMap<string, Uint8Array>
  /** 一开始订没订（默认没订：演「没订阅那一行小字 → 订阅」）。 */
  subscribed?: boolean
  credits_per_month?: number
}

export interface OfficialContentStandInReply {
  status: number
  body?: unknown
  bytes?: Uint8Array
  headers?: Record<string, string>
}

export interface OfficialContentStandIn {
  handle(
    method: string,
    path: string,
    query: URLSearchParams,
  ): OfficialContentStandInReply | undefined
}

export function officialContentStandIn(
  options: OfficialContentStandInOptions,
  now: () => string,
): OfficialContentStandIn {
  let subscribed = options.subscribed === true
  const manifest = JSON.parse(new TextDecoder().decode(options.manifest)) as ContentManifest
  const view = (): ContentSubscriptionView => ({
    service_id: 'content.official.monthly',
    status: subscribed ? 'active' : 'none',
    usable: subscribed,
    credits_per_month: options.credits_per_month ?? 30,
    cancel_at_period_end: false,
  })
  const gate = (): OfficialContentStandInReply | undefined =>
    subscribed
      ? undefined
      : {
          status: 402,
          body: {
            code: 'payment_required',
            message: '还没订阅岗位更新，已经用上的内容一条都不动。',
          },
        }
  return {
    handle(method, path, query) {
      if (path === CONTENT_SUBSCRIPTION_PATH) {
        if (method === 'POST') subscribed = true
        if (method === 'DELETE') subscribed = false
        return { status: 200, body: { data: view() } }
      }
      if (method !== 'GET') return undefined
      if (path === OFFICIAL_CONTENT_PATHS.summary) {
        const positions = parseContentPositionsQuery(query.get('positions'))
        return {
          status: 200,
          body: {
            data: summarizeOfficialContent(manifest, {
              now: now(),
              ...(positions === undefined || positions === null ? {} : { positions }),
            }),
          },
        }
      }
      if (path === OFFICIAL_CONTENT_PATHS.manifest)
        return (
          gate() ?? {
            status: 200,
            bytes: options.manifest,
            headers: { 'content-type': 'application/json; charset=utf-8' },
          }
        )
      if (path === OFFICIAL_CONTENT_PATHS.signature)
        return (
          gate() ?? {
            status: 200,
            bytes: new TextEncoder().encode(options.signature),
            headers: { 'content-type': 'text/plain; charset=utf-8' },
          }
        )
      if (path.startsWith(OFFICIAL_CONTENT_PATHS.blobs)) {
        const denied = gate()
        if (denied !== undefined) return denied
        const blob = options.blobs.get(path.slice(OFFICIAL_CONTENT_PATHS.blobs.length))
        return blob === undefined
          ? { status: 404, body: { code: 'not_found', message: '没有这个文件。' } }
          : { status: 200, bytes: blob, headers: { 'content-type': 'application/octet-stream' } }
      }
      return undefined
    },
  }
}
