/**
 * 58 §2 `library.ts`：素材库索引（按品牌 / 用途 / 尺寸 / 定稿状态）。
 *
 * 索引而不是存储：字节在 blob store（41 §2），这个模块只在内存里对一串
 * {@link DesignAsset} 做分组、筛选与查重。落盘那一侧在 `apps/server`。
 *
 * 一条纪律：**定稿的判据只有一份**——`isDesignAssetFinal`（契约里那个函数）。
 * 这个文件里所有"已定稿"的地方都调它，没有一处自己判 `status === 'published'`。
 * 少判一件（人点没点过）就等于让 Agent 自己定了稿。
 */

import type { DesignAsset, DesignDuty, DesignSpec } from '@agentsws/contracts'
import { isDesignAssetFinal } from '@agentsws/contracts'
import { resolveSpec } from './specs.js'

export interface LibraryFilter {
  duty?: DesignDuty
  spec_id?: string
  /** 按用途标筛（`hero` / `banner` / `story`）。 */
  tag?: string
  brief_id?: string
  request_id?: string
  /** 只看定稿的（判据是 `isDesignAssetFinal`，不是 `status`）。 */
  final_only?: boolean
  /** 只看这几个状态。 */
  status?: readonly DesignAsset['status'][]
}

/** 按筛选条件取一批。顺序：新的在前（`created_at` 倒序，同刻按 id 稳定）。 */
export function filterAssets(
  assets: readonly DesignAsset[],
  filter: LibraryFilter = {},
): readonly DesignAsset[] {
  return assets
    .filter((a) => {
      if (filter.duty !== undefined && a.duty !== filter.duty) return false
      if (filter.spec_id !== undefined && a.spec_id !== filter.spec_id) return false
      if (filter.tag !== undefined && !(a.tags ?? []).includes(filter.tag)) return false
      if (filter.brief_id !== undefined && a.brief_id !== filter.brief_id) return false
      if (filter.request_id !== undefined && a.request_id !== filter.request_id) return false
      if (filter.status !== undefined && !filter.status.includes(a.status)) return false
      if (filter.final_only === true && !isDesignAssetFinal(a)) return false
      return true
    })
    .slice()
    .sort((a, b) =>
      a.created_at === b.created_at
        ? a.id.localeCompare(b.id)
        : b.created_at.localeCompare(a.created_at),
    )
}

/** 素材库的一格（界面上的一个分组）。 */
export interface LibraryGroup {
  key: string
  zh: string
  en: string
  count: number
  /** 这一格里定稿了几张（其余是还在挑的变体）。 */
  final: number
  assets: readonly DesignAsset[]
}

/**
 * 按**用途**分组（58 §3 素材库那一块「按用途」）。
 *
 * 用途 = `tags` 的第一个标；没打标的归「没打标」那一格而不是被藏起来——
 * 一张没人打标的素材照样在库里占位置，藏起来的结果是三个月后有人重做一遍。
 */
export function groupByUse(assets: readonly DesignAsset[]): readonly LibraryGroup[] {
  return groupBy(assets, (a) => {
    const tag = a.tags?.[0]
    return tag === undefined || tag === ''
      ? { key: '__untagged', zh: '没打标', en: 'Untagged' }
      : { key: tag, zh: tag, en: tag }
  })
}

/** 按**尺寸**分组（规格名；认不出的规格原样显示 id，不丢）。 */
export function groupBySpec(assets: readonly DesignAsset[]): readonly LibraryGroup[] {
  return groupBy(assets, (a) => {
    const spec: DesignSpec | undefined = resolveSpec(a.spec_id)
    return { key: a.spec_id, zh: spec?.zh ?? a.spec_id, en: spec?.en ?? a.spec_id }
  })
}

/** 按**定稿状态**分组（待挑 / 已选 / 已入库 / 否掉了）。 */
export function groupByStatus(assets: readonly DesignAsset[]): readonly LibraryGroup[] {
  const label: Record<DesignAsset['status'], { zh: string; en: string }> = {
    variant: { zh: '待挑', en: 'Waiting to be picked' },
    picked: { zh: '人选了，还没入库', en: 'Picked, not published' },
    published: { zh: '已入库', en: 'In the library' },
    rejected: { zh: '都不行，否掉了', en: 'Rejected' },
  }
  return groupBy(assets, (a) => ({ key: a.status, ...label[a.status] }))
}

function groupBy(
  assets: readonly DesignAsset[],
  keyOf: (a: DesignAsset) => { key: string; zh: string; en: string },
): readonly LibraryGroup[] {
  const map = new Map<string, LibraryGroup>()
  for (const asset of assets) {
    const { key, zh, en } = keyOf(asset)
    const group = map.get(key) ?? { key, zh, en, count: 0, final: 0, assets: [] }
    group.count += 1
    if (isDesignAssetFinal(asset)) group.final += 1
    group.assets = [...group.assets, asset]
    map.set(key, group)
  }
  return [...map.values()].sort((a, b) => b.count - a.count || a.key.localeCompare(b.key))
}

/**
 * 本周产出（58 §3 面板最后一块）。
 *
 * 数的是**定稿**不是出图张数：一天出三十张变体、一张都没定，这一周的产出是 0。
 * 把出图张数当产出的结果是这个数永远好看，而没有一张图真的上线了。
 */
export interface WeeklyOutput {
  since: string
  /** 定稿了几张（`isDesignAssetFinal`）。 */
  final: number
  /** 出了几张变体（分母，给人看"挑了多少才定下来一张"）。 */
  variants: number
  /** 按用途分（界面上那一行小字）。 */
  by_use: readonly { key: string; zh: string; count: number }[]
}

export function weeklyOutput(assets: readonly DesignAsset[], since: string): WeeklyOutput {
  const inWindow = assets.filter((a) => a.created_at >= since)
  const final = inWindow.filter(isDesignAssetFinal)
  return {
    since,
    final: final.length,
    variants: inWindow.length,
    by_use: groupByUse(final).map((g) => ({ key: g.key, zh: g.zh, count: g.count })),
  }
}

/**
 * 查重：同一个 (brief, 规格, 提示词哈希) 已经出过的那几张。
 *
 * 为什么按提示词哈希而不是按图：同一段提示词出两遍，出来的两张图字节不同
 * （种子不同），但它们是同一次尝试。人挑图的时候看到"这个我上周挑过了"
 * 才不会来回打转。
 */
export function duplicatesOf(
  assets: readonly DesignAsset[],
  probe: { spec_id: string; prompt_sha256?: string },
): readonly DesignAsset[] {
  if (probe.prompt_sha256 === undefined) return []
  return assets.filter(
    (a) => a.spec_id === probe.spec_id && a.provenance.prompt_sha256 === probe.prompt_sha256,
  )
}

/**
 * blob 的 key 怎么拼（41 §2：按品牌分前缀）。
 *
 * `design/<workspace>/<duty>/<asset_id>.<ext>`——品牌在最前面，
 * 因为删一个品牌就是删一个前缀（21 §4 的 crypto-shredding 之外，
 * 目录这一层也要能一刀切干净）。
 */
export function assetBlobKey(asset: {
  workspace_id: string
  duty: DesignDuty
  id: string
  content_type?: string
}): string {
  const ext = EXT[asset.content_type ?? 'image/png'] ?? 'bin'
  return `design/${asset.workspace_id}/${asset.duty}/${asset.id}.${ext}`
}

const EXT: Record<string, string> = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/webp': 'webp',
  'image/svg+xml': 'svg',
  'application/pdf': 'pdf',
}
