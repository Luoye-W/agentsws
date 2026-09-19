/**
 * **哪条路要先扣钱**（WP116 / 64 §10.2 两段式的第一步）。
 *
 * 官方托管形态下，预扣发生在**入口 Worker**里（钱在 `WalletDO`，库在
 * `KolPublicDO`，两个对象）。于是入口必须在还没碰库之前就知道"这一条要扣哪个
 * 能力、扣几份"。这张表就是那个答案，而且它**必须与 `service.ts` 里实际扣的
 * 那几笔一一对应**——多一条等于白扣，少一条等于漏扣。
 *
 * 所以它跟服务放在同一个包里：改 `service.ts` 的收费点时，这个文件就在隔壁，
 * 而 `charge-map.test.ts` 会把两边对不上的情况直接测红。
 *
 * **浏览、免费体检、基准、上报、回填、争议、插件配对一律不在这张表里**——
 * 它们要么免费（记一条 0 积分的计量事件，49 §3），要么是往库里加事实。
 * 免费的东西不该因为余额而用不了。
 */

import {
  KOL_AUDIT_CAPABILITY,
  KOL_LOOKUP_CAPABILITY,
  KOL_UNIT,
  SOCIAL_FETCH_CAPABILITY,
} from '@agentsws/contracts'
import { KOL_PREFIX } from './routes.js'

/** 要先预扣的那一笔（`credits` 由钱那一侧按价目表算——入口不认识价钱）。 */
export interface KolCharge {
  capability: string
  unit: string
  quantity: number
}

/**
 * 三条收费路由的**末段**。整条路径长成
 * `/v1/data/kol/creators/<渠道>/<handle>/<末段>`。
 *
 * 为什么按末段匹配而不是拿 Hono 再解一遍：入口 Worker 里没有路由器，
 * 它只需要"这一条要不要扣、扣哪个"。多一个路由器 = 两份真源。
 */
const PAID_TAILS: Record<string, KolCharge> = {
  reveal: { capability: KOL_LOOKUP_CAPABILITY, unit: KOL_UNIT, quantity: 1 },
  'deep-audit': { capability: KOL_AUDIT_CAPABILITY, unit: KOL_UNIT, quantity: 1 },
  refresh: { capability: SOCIAL_FETCH_CAPABILITY, unit: KOL_UNIT, quantity: 1 },
}

/** 这条路属于公共红人库吗（入口按它决定去不去 `KolPublicDO`）。 */
export function isKolPath(pathname: string): boolean {
  return pathname === KOL_PREFIX || pathname.startsWith(`${KOL_PREFIX}/`)
}

/**
 * 这一条要先预扣哪一笔？不收费的路回 `undefined`。
 *
 * 只认 `POST`：三条收费路由都是 POST，而 `GET …/audit`（免费体检）与
 * `POST …/deep-audit`（付费深度体检）只差一个末段——按方法判一次，
 * 免得哪天有人给免费那条加一个 POST 别名就变成了白送。
 */
export function kolChargeFor(method: string, pathname: string): KolCharge | undefined {
  if (method.toUpperCase() !== 'POST') return undefined
  if (!isKolPath(pathname)) return undefined
  const rest = pathname
    .slice(KOL_PREFIX.length)
    .split('/')
    .filter((one) => one !== '')
  // creators / <渠道> / <handle> / <末段>
  if (rest.length !== 4 || rest[0] !== 'creators') return undefined
  const tail = rest[3]
  return tail === undefined ? undefined : PAID_TAILS[tail]
}

/** 这三条能力（后台那一页按它筛计量事件）。 */
export const KOL_CAPABILITIES: readonly string[] = [
  KOL_LOOKUP_CAPABILITY,
  KOL_AUDIT_CAPABILITY,
  SOCIAL_FETCH_CAPABILITY,
]
