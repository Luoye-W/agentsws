/**
 * 收费点那一节的文件头注（改这里之前先改它）：
 *
 * WP126 起官方数据接口没有免费动作了。浏览 / 搜索 / 基准按 `lookup` 计，
 * 体检报告（GET audit 与 POST deep-audit）按 `audit` 计，reveal 按 `reveal`（09-23 单开），
 * 外部刷新按 `social.fetch`。上报、回填、争议、插件配对仍然不收——
 * 它们是往库里加事实，不是从库里取价值。空结果与失败由服务那一侧
 * 预扣释放（`service.ts`），入口这一侧只管预扣。
 */

import {
  KOL_AUDIT_CAPABILITY,
  KOL_LOOKUP_CAPABILITY,
  KOL_REVEAL_CAPABILITY,
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
 * 收费路由的**末段**（POST）与**读路由**（GET，WP126 起）。
 *
 * POST 那三条：`reveal` / `deep-audit` / `refresh`，整条路径长成
 * `/v1/data/kol/creators/<渠道>/<handle>/<末段>`。
 *
 * GET 那三条是 WP126 计费改造加进来的：浏览 / 搜索（`creators`）、
 * 体检报告（`audit`）、类目基准（`benchmarks`）从免费改按次收——官方
 * 数据接口本身就是增值服务，命中缓存与未命中同价。为什么按末段匹配
 * 而不是拿 Hono 再解一遍：入口 Worker 里没有路由器，它只需要
 * "这一条要不要扣、扣哪个"。多一个路由器 = 两份真源。
 */
const PAID_TAILS: Record<string, KolCharge> = {
  reveal: { capability: KOL_REVEAL_CAPABILITY, unit: KOL_UNIT, quantity: 1 },
  'deep-audit': { capability: KOL_AUDIT_CAPABILITY, unit: KOL_UNIT, quantity: 1 },
  refresh: { capability: SOCIAL_FETCH_CAPABILITY, unit: KOL_UNIT, quantity: 1 },
  // GET …/audit：体检报告（WP126 起与 deep-audit 同价）。POST …/audit 不存在，
  // 万一哪天有人加了也不会被当成免费的付费路由——它在这张表里就是收费的。
  audit: { capability: KOL_AUDIT_CAPABILITY, unit: KOL_UNIT, quantity: 1 },
}

/** GET 的读路由：路径段数与对应的那一笔（浏览 / 搜索与基准都按 `lookup` 计）。 */
const PAID_READS: Record<string, KolCharge> = {
  creators: { capability: KOL_LOOKUP_CAPABILITY, unit: KOL_UNIT, quantity: 1 },
  benchmarks: { capability: KOL_LOOKUP_CAPABILITY, unit: KOL_UNIT, quantity: 1 },
}

/** 这条路属于公共红人库吗（入口按它决定去不去 `KolPublicDO`）。 */
export function isKolPath(pathname: string): boolean {
  return pathname === KOL_PREFIX || pathname.startsWith(`${KOL_PREFIX}/`)
}

/**
 * 这一条要先预扣哪一笔？不收费的路回 `undefined`。
 *
 * POST 认 `creators/…/<末段>` 四段那几条；GET 认读路由那三条
 * （`creators` / `creators/…/audit` / `benchmarks`）。**免费与写入的
 * 路由（observations / contact / disputes / plugins）不在这张表里**。
 */
export function kolChargeFor(method: string, pathname: string): KolCharge | undefined {
  if (!isKolPath(pathname)) return undefined
  const rest = pathname
    .slice(KOL_PREFIX.length)
    .split('/')
    .filter((one) => one !== '')
  if (method.toUpperCase() === 'GET') {
    // creators / benchmarks（一段）；creators / <渠道> / <handle> / audit（四段）。
    // 四段的 GET 只有 audit 是收费读：reveal / refresh 是 POST 专属，GET 上不存在。
    if (rest.length === 1) return PAID_READS[rest[0] ?? '']
    if (rest.length === 4 && rest[0] === 'creators' && rest[3] === 'audit') return PAID_TAILS.audit
    return undefined
  }
  if (method.toUpperCase() !== 'POST') return undefined
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
