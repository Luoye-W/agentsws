import type { DesignAsset } from '@agentsws/contracts'
import { describe, expect, it } from 'vitest'
import {
  assetBlobKey,
  duplicatesOf,
  filterAssets,
  groupBySpec,
  groupByStatus,
  groupByUse,
  weeklyOutput,
} from '../src/index.js'

const asset = (over: Partial<DesignAsset> & { id: string }): DesignAsset => ({
  workspace_id: 'ws_1',
  duty: 'social',
  spec_id: 'social.ig.square',
  status: 'variant',
  provenance: { source: 'generated', prompt_sha256: 'h1' },
  created_at: '2026-09-15T10:00:00Z',
  ...over,
})

const picked = (id: string, over: Partial<DesignAsset> = {}): DesignAsset =>
  asset({
    id,
    status: 'published',
    provenance: {
      source: 'generated',
      prompt_sha256: 'h1',
      picked_by: 'p_1',
      picked_at: '2026-09-16T10:00:00Z',
    },
    ...over,
  })

const all: readonly DesignAsset[] = [
  asset({ id: 'a1', tags: ['hero'] }),
  asset({ id: 'a2', tags: ['hero'], created_at: '2026-09-16T10:00:00Z' }),
  asset({ id: 'a3', spec_id: 'social.ig.story' }),
  picked('a4', { tags: ['banner'], created_at: '2026-09-16T11:00:00Z' }),
  // 状态到了但**没人点过**——它不是定稿
  asset({ id: 'a5', status: 'published', tags: ['banner'] }),
]

describe('58 §2 素材库索引', () => {
  it('新的在前', () => {
    expect(filterAssets(all).map((a) => a.id)).toEqual(['a4', 'a2', 'a1', 'a3', 'a5'])
  })

  it('筛：按用途标 / 按规格 / 按状态', () => {
    expect(filterAssets(all, { tag: 'hero' }).map((a) => a.id)).toEqual(['a2', 'a1'])
    expect(filterAssets(all, { spec_id: 'social.ig.story' }).map((a) => a.id)).toEqual(['a3'])
    expect(filterAssets(all, { status: ['published'] }).map((a) => a.id)).toEqual(['a4', 'a5'])
  })

  it('「定稿」的判据是 isDesignAssetFinal，不是 status', () => {
    expect(filterAssets(all, { final_only: true }).map((a) => a.id)).toEqual(['a4'])
  })

  it('没打标的归「没打标」，不藏起来', () => {
    const groups = groupByUse(all)
    expect(groups.find((g) => g.key === '__untagged')?.count).toBe(1)
  })

  it('按规格分组显示规格的中文名，认不出的原样显示 id', () => {
    const groups = groupBySpec([...all, asset({ id: 'a6', spec_id: 'weird.one' })])
    expect(groups.find((g) => g.key === 'social.ig.square')?.zh).toBe('Instagram 方图')
    expect(groups.find((g) => g.key === 'weird.one')?.zh).toBe('weird.one')
  })

  it('按状态分组，每格都带「这格里定稿了几张」', () => {
    const published = groupByStatus(all).find((g) => g.key === 'published')
    expect(published?.count).toBe(2)
    expect(published?.final).toBe(1)
  })

  it('本周产出数的是**定稿**，不是出图张数', () => {
    const out = weeklyOutput(all, '2026-09-16T00:00:00Z')
    expect(out.variants).toBe(2)
    expect(out.final).toBe(1)
    expect(out.by_use).toEqual([{ key: 'banner', zh: 'banner', count: 1 }])
  })

  it('查重按提示词哈希，不按字节', () => {
    expect(
      duplicatesOf(all, { spec_id: 'social.ig.square', prompt_sha256: 'h1' }).map((a) => a.id),
    ).toEqual(['a1', 'a2', 'a4', 'a5'])
    expect(duplicatesOf(all, { spec_id: 'social.ig.square' })).toEqual([])
  })

  it('blob key 把品牌放在最前面（删一个品牌就是删一个前缀）', () => {
    expect(
      assetBlobKey({ workspace_id: 'ws_1', duty: 'amazon', id: 'a1', content_type: 'image/png' }),
    ).toBe('design/ws_1/amazon/a1.png')
    expect(assetBlobKey({ workspace_id: 'ws_1', duty: 'dtc', id: 'a2' })).toBe(
      'design/ws_1/dtc/a2.png',
    )
  })
})
