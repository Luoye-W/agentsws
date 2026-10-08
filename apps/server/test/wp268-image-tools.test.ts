/**
 * WP268（决策 213）：生图 / 改图 / 素材库三个工具 + 挑图卡 / 超额卡被决定之后。
 *
 * 全部替身：生图是确定性占位图（`stubImageProvider`），审批总线与事项是内存里的小替身，
 * 店里商品图走进程内假店（`resolveFakeShop`）。不联网、不花钱。
 */
import type { ApprovalItem, ImageProvider, RunRequest } from '@agentsws/contracts'
import { encodePng, ProviderError, stubImageProvider } from '@agentsws/model-gateway'
import { beforeEach, describe, expect, it } from 'vitest'
import { type BrandAssets, createBrandAssets } from '../src/brand-assets.js'
import { createDesignStore } from '../src/design.js'
import { createImageService, type ImagePricing, type ImageService } from '../src/image-tools.js'
import { demoShop, resolveFakeShop } from '../src/shop-admin-stand-in.js'

const WS = 'ws_1' as never
const NOW = '2026-10-08T09:00:00.000Z'

const req = (role_id = 'site.shopify-theme', id = 'run_1'): RunRequest =>
  ({
    id,
    actor: { person_id: 'per_owner', assignment_id: `asg_${role_id}`, role_id },
    work_item: { id: 'mat_1' },
  }) as unknown as RunRequest

const tinyPng = (seed: number): Uint8Array =>
  encodePng(2, 2, new Uint8Array([0, seed, 0, 0, seed, 0, 0, 0, 0, seed, 0, 0, 0, 0]), 'rgb')

let assets: BrandAssets
let cards: ApprovalItem[]
let onCard: string[]
let notes: string[]
let provider: ImageProvider
let pricing: ImagePricing
let placed: unknown[]
let edits: { images: number; fidelity?: string; size?: string }[]
let fetched: string[]
let svc: ImageService

const busCreate = async (input: Record<string, unknown>): Promise<ApprovalItem> => {
  const item = {
    ...input,
    id: `apr_${cards.length + 1}`,
    revision: 1,
    state: 'pending',
    deliveries: [],
    links: { children: [] },
    created_at: NOW,
    updated_at: NOW,
  } as unknown as ApprovalItem
  cards.push(item)
  return item
}

const build = (over: Partial<Parameters<typeof createImageService>[0]> = {}): ImageService =>
  createImageService({
    workspace_id: WS,
    clock: { now: () => NOW },
    assets,
    images: () => provider,
    pricing: () => pricing,
    approvals: () => ({ create: busCreate }) as never,
    work: () =>
      ({
        onCard: (ref: { id: string }) => {
          onCard.push(ref.id)
          return {}
        },
        appendEvent: (_m: string, e: { text: string }) => {
          notes.push(e.text)
        },
      }) as never,
    shopReader: async () => {
      const shop = demoShop()
      return {
        query: async (op: { document: string; variables?: Record<string, unknown> }) => {
          const name = /query\s+(\w+)/.exec(op.document)?.[1] ?? ''
          return resolveFakeShop(shop, name, op.variables ?? {}) as never
        },
      }
    },
    fetch: async (url) => {
      fetched.push(url)
      return { ok: true, status: 200, arrayBuffer: async () => tinyPng(9).slice().buffer }
    },
    place: async (input) => {
      placed.push(input)
      return { ok: true, message: '挂好了（替身）' }
    },
    ...over,
  })

beforeEach(() => {
  assets = createBrandAssets({
    workspace_id: WS,
    store: createDesignStore({ workspace_id: WS }),
    clock: { now: () => NOW },
    random: () => 0.5,
    extraImageHosts: /^cdn\.shopify\.test$/,
  })
  cards = []
  onCard = []
  notes = []
  placed = []
  edits = []
  fetched = []
  pricing = { official: true, model: 'gpt-image-1', per_image: 0.5, per_edit: 0.6 }
  const stub = stubImageProvider({
    seed: 3,
    ref: { provider: 'agentsws_cloud', model: 'gpt-image-1' },
  })
  provider = {
    ...stub,
    edit: async (r) => {
      edits.push({
        images: r.images.length,
        ...(r.fidelity === undefined ? {} : { fidelity: r.fidelity }),
        ...(r.size === undefined ? {} : { size: r.size }),
      })
      return (stub.edit as NonNullable<ImageProvider['edit']>)(r)
    },
  }
  svc = build()
})

const run = (name: string, input: Record<string, unknown>, r = req()) =>
  svc.executeTool({ name, input, request: r })

describe('工具面', () => {
  it('设计岗与网页模板才有；生图没配一个都不摆；模型不会改图就不摆 edit_image', async () => {
    expect(await svc.offered('site.shopify-theme')).toEqual([
      'edit_image',
      'generate_image',
      'list_brand_assets',
    ])
    expect(await svc.offered('design.social')).toHaveLength(3)
    expect(await svc.offered('dtc.store')).toEqual([])
    provider = { ...provider, available: false, unavailable_reason: '生图还没配' }
    expect(await svc.offered('design.ads')).toEqual([])
    const { edit: _drop, ...noEdit } = stubImageProvider({ seed: 1 })
    provider = noEdit
    expect(await svc.offered('design.ads')).toEqual(['generate_image', 'list_brand_assets'])
  })

  it('别的职责调：blocked', async () => {
    const out = await run('generate_image', { prompt: 'x' }, req('dtc.store'))
    expect(out.status).toBe('blocked')
  })
})

describe('生成', () => {
  it('出图 → 进素材库（来源 / 提示词 / 模型 / 积分）→ 挑图卡挂在事项上', async () => {
    const out = await run('generate_image', {
      prompt: 'A storage box on a sunny shelf, text "Fold. Store. Go."',
      aspect_ratio: '16:9',
      n: 3,
      tags: ['hero'],
      place: { file: 'templates/index.json', section: 'hero', setting: 'image' },
    })
    expect(out.status).toBe('ok')
    const data = out.data as {
      kind: string
      status: string
      asset_ids: string[]
      credits: number
      message: string
    }
    expect(data).toMatchObject({ kind: 'image_pick', status: 'awaiting_pick', credits: 1.5 })
    expect(data.message).toContain('首页「hero」')
    const rows = assets.list()
    expect(rows).toHaveLength(3)
    const a = rows[0]
    expect(a?.width).toBe(1536)
    expect(a?.height).toBe(1024)
    expect(a?.status).toBe('variant')
    expect(a?.tags).toEqual(['hero'])
    expect(a?.provenance).toMatchObject({
      source: 'generated',
      operation: 'generate',
      prompt: 'A storage box on a sunny shelf, text "Fold. Store. Go."',
      credits: 0.5,
      matter_id: 'mat_1',
      run_id: 'run_1',
      role_id: 'site.shopify-theme',
      model: { model: 'gpt-image-1' },
    })
    expect(cards).toHaveLength(1)
    const card = cards[0] as ApprovalItem & {
      payload: { variants: { url: string }[]; upload: boolean; again_credits: number }
    }
    expect(card.kind).toBe('image_pick')
    expect(card.subject.matter_id).toBe('mat_1')
    expect(card.options?.map((o) => o.label)).toEqual(['第 1 张', '第 2 张', '第 3 张', '再来一版'])
    expect(card.payload.upload).toBe(true)
    expect(card.payload.again_credits).toBe(1.5)
    expect(card.payload.variants[0]?.url).toMatch(/^\/v1\/brand-assets\/dasset_.+\/file$/)
    expect(card.summary).toContain('花了 1.5 积分')
    expect(card.summary).toContain('传到店铺「文件」')
    expect(onCard).toEqual([card.id])
    // 字节在库里取得出来，是一张 PNG
    const bytes = await assets.bytes(a?.id ?? '')
    expect(bytes?.content_type).toBe('image/png')
  })

  it('自己的接口不扣积分：卡上照实说', async () => {
    pricing = { official: false, model: 'gpt-image-1' }
    const out = await run('generate_image', { prompt: 'poster', n: 1 }, req('design.social'))
    expect((out.data as { credits: number }).credits).toBe(0)
    expect(cards[0]?.summary).toContain('不扣积分')
    expect(assets.list()[0]?.provenance.credits).toBeUndefined()
    // 设计岗出的图归它那条职责
    expect(assets.list()[0]?.duty).toBe('social')
  })

  it('品牌禁忌词：不出图、让模型重写（不花钱）', async () => {
    svc = build({ forbidden: () => ['cheap'] })
    const out = await run('generate_image', { prompt: 'a cheap looking box' })
    expect(out.status).toBe('blocked')
    expect(out.reason).toContain('cheap')
    expect(assets.list()).toHaveLength(0)
  })

  it('place 只给网页模板；写得不对照实说', async () => {
    const a = await run(
      'generate_image',
      { prompt: 'x', place: { file: 'templates/index.json', section: 'hero', setting: 'image' } },
      req('design.dtc'),
    )
    expect(a.status).toBe('blocked')
    const b = await run('generate_image', {
      prompt: 'x',
      place: { file: '../evil.json', setting: 'image' },
    })
    expect(b.status).toBe('error')
    const c = await run('generate_image', {
      prompt: 'x',
      place: { file: 'templates/index.json', setting: 'image' },
    })
    expect(c.reason).toContain('section')
  })

  it('失败：没配生图说那句人话；上游拒了不进库、不出卡', async () => {
    provider = { ...provider, available: false, unavailable_reason: '生图还没配：去设置' }
    expect((await run('generate_image', { prompt: 'x' })).reason).toContain('生图还没配')
    provider = {
      ...provider,
      available: true,
      generate: async () => {
        throw new ProviderError('provider http 402: insufficient credits', { status: 402 })
      },
    }
    const out = await run('generate_image', { prompt: 'x' })
    expect(out.status).toBe('error')
    expect(out.reason).toContain('402')
    expect(assets.list()).toHaveLength(0)
    expect(cards).toHaveLength(0)
  })
})

describe('改图', () => {
  it('素材库里的图当参考：字节喂给 edit、要求保持产品；积分按改图单价', async () => {
    const ref = await assets.importUpload({
      bytes: tinyPng(1),
      filename: 'box.png',
      matter_id: 'mat_1',
    })
    expect(ref.provenance.origin?.kind).toBe('matter_upload')
    const out = await run('edit_image', {
      prompt: 'same box, on a marble table',
      asset_ids: [ref.id],
      aspect_ratio: '1:1',
      n: 2,
    })
    expect(out.status).toBe('ok')
    expect(edits).toEqual([{ images: 1, fidelity: 'high', size: '1024x1024' }])
    const made = assets.list({ source: 'generated' })
    expect(made).toHaveLength(2)
    expect(made[0]?.provenance).toMatchObject({
      operation: 'edit',
      reference_asset_ids: [ref.id],
      credits: 0.6,
    })
    expect((out.data as { credits: number }).credits).toBe(1.2)
  })

  it('店里商品图：只读取图进素材库（来源记商品），同一张不取第二次', async () => {
    const r1 = await run('edit_image', {
      prompt: 'lifestyle',
      product_id: 'gid://shopify/Product/1001',
      n: 1,
    })
    expect(r1.status).toBe('ok')
    const ext = assets.list({ source: 'external' })
    expect(ext).toHaveLength(1)
    expect(ext[0]?.provenance.origin).toMatchObject({
      kind: 'shop_product',
      ref: 'gid://shopify/Product/1001',
    })
    await run('edit_image', { prompt: 'again', product_id: 'gid://shopify/Product/1001', n: 1 })
    expect(assets.list({ source: 'external' })).toHaveLength(1)
    expect(fetched).toHaveLength(1)
  })

  it('没有参考图 / 参考图不存在 / 模型不会改图：照实说、不花钱', async () => {
    expect((await run('edit_image', { prompt: 'x' })).reason).toContain('参考图')
    expect((await run('edit_image', { prompt: 'x', asset_ids: ['dasset_nope'] })).reason).toContain(
      'list_brand_assets',
    )
    const { edit: _drop, ...noEdit } = stubImageProvider({ seed: 1 })
    provider = noEdit
    expect((await run('edit_image', { prompt: 'x', asset_ids: ['a'] })).reason).toContain(
      '不会拿参考图改图',
    )
    expect(cards).toHaveLength(0)
  })
})

describe('上限：花积分前判，超了出卡问', () => {
  it('一次运行超 8 张 → 超额卡、不出图；批了照卡出图并出挑图卡；不批一分不花', async () => {
    await run('generate_image', { prompt: 'a', n: 4 })
    await run('generate_image', { prompt: 'b', n: 4 })
    expect(assets.list()).toHaveLength(8)
    const over = await run('generate_image', { prompt: 'c', n: 2 })
    expect(over.data).toMatchObject({ kind: 'image_budget', status: 'needs_approval', credits: 1 })
    expect(assets.list()).toHaveLength(8)
    const budget = cards.at(-1) as ApprovalItem
    expect(budget.kind).toBe('image_budget')
    expect(budget.title).toContain('约 1 积分')
    expect(budget.subject.matter_id).toBe('mat_1')

    // 不批：什么都不花
    expect(await svc.onDecided({ ...budget, state: 'rejected' })).toBe(true)
    expect(assets.list()).toHaveLength(8)
    expect(notes.at(-1)).toContain('不出了')

    // 批了：照卡上那一份出图，出挑图卡
    await svc.onDecided({
      ...budget,
      state: 'approved',
      decision: { action: 'approve', by: 'per_owner', at: NOW, via: 'workstation' },
    } as ApprovalItem)
    expect(assets.list()).toHaveLength(10)
    expect(cards.at(-1)?.kind).toBe('image_pick')
  })

  it('积分先到上限（改图单价高）也问', async () => {
    pricing = { official: true, per_image: 0.5, per_edit: 1.5 }
    const ref = await assets.importUpload({ bytes: tinyPng(2) })
    await run('edit_image', { prompt: 'a', asset_ids: [ref.id], n: 2 }) // 3 积分
    const over = await run('edit_image', { prompt: 'b', asset_ids: [ref.id], n: 1 }) // 再 1.5 > 4
    expect((over.data as { kind: string }).kind).toBe('image_budget')
    expect((cards.at(-1)?.payload as { reason: string }).reason).toBe('per_run_credits')
  })
})

describe('挑图卡被决定', () => {
  const pickCard = async (place = true) => {
    await run('generate_image', {
      prompt: 'hero',
      n: 2,
      ...(place
        ? { place: { file: 'templates/index.json', section: 'hero', setting: 'image' } }
        : {}),
    })
    return cards.at(-1) as ApprovalItem
  }
  const decided = (card: ApprovalItem, option: string): ApprovalItem =>
    ({
      ...card,
      state: 'approved_edited',
      decision: {
        action: 'approve_edited',
        by: 'per_boss',
        at: NOW,
        via: 'workstation',
        edited_payload: { selected_option_id: option },
      },
    }) as ApprovalItem

  it('选一张：素材记「选中」（谁点的按决定人盖）、交给挂网站那一步', async () => {
    const card = await pickCard()
    const option = card.options?.[1]?.id ?? ''
    await svc.onDecided(decided(card, option))
    const picked = assets.get(option.replace('asset:', ''))
    expect(picked?.status).toBe('picked')
    expect(picked?.provenance.picked_by).toBe('per_boss')
    expect(placed).toHaveLength(1)
    expect(placed[0]).toMatchObject({
      target: { file: 'templates/index.json', section: 'hero', setting: 'image' },
      matter_id: 'mat_1',
    })
    expect(notes.at(-1)).toBe('挂好了（替身）')
    // 另一张还在库里（没被当成「不要」）
    expect(assets.list().filter((a) => a.status === 'variant')).toHaveLength(1)
  })

  it('不带 place 的只记选中、不挂网站', async () => {
    const card = await pickCard(false)
    await svc.onDecided(decided(card, card.options?.[0]?.id ?? ''))
    expect(placed).toHaveLength(0)
    expect(notes.at(-1)).toContain('进素材库了')
  })

  it('再来一版：这一批记「不要」，照原参数再出一批、再出一张挑图卡', async () => {
    const card = await pickCard()
    await svc.onDecided(decided(card, 'again'))
    expect(assets.list().filter((a) => a.status === 'rejected')).toHaveLength(2)
    expect(assets.list().filter((a) => a.status === 'variant')).toHaveLength(2)
    expect(cards).toHaveLength(2)
    expect(cards[1]?.kind).toBe('image_pick')
    expect(notes.at(-1)).toContain('又出了一版')
  })

  it('都不要：这一批记「不要」，不挂', async () => {
    const card = await pickCard()
    await svc.onDecided({ ...card, state: 'rejected' })
    expect(assets.list().every((a) => a.status === 'rejected')).toBe(true)
    expect(placed).toHaveLength(0)
  })

  it('别的卡不归它管', async () => {
    expect(await svc.onDecided({ kind: 'seo_topic', workspace_id: WS } as ApprovalItem)).toBe(false)
  })
})

describe('素材库工具', () => {
  it('list_brand_assets：只列这个品牌的、不列「不要」的；能按事项筛', async () => {
    await assets.importUpload({ bytes: tinyPng(1), matter_id: 'mat_1', tags: ['product'] })
    await assets.importUpload({ bytes: tinyPng(2), matter_id: 'mat_2' })
    const all = await run('list_brand_assets', {})
    expect((all.data as { assets: unknown[] }).assets).toHaveLength(2)
    const mine = await run('list_brand_assets', { this_matter: true })
    const rows = (mine.data as { assets: { source: string; tags: string[] }[] }).assets
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({ source: 'dragged_in', tags: ['product'] })
  })

  it('上传只收图片（看文件头）、≤ 20 MB', async () => {
    await expect(assets.importUpload({ bytes: new TextEncoder().encode('hello') })).rejects.toThrow(
      /不是图片/,
    )
    const ok = await assets.importUpload({ bytes: tinyPng(3) })
    expect(ok).toMatchObject({ status: 'picked', width: 2, height: 2, content_type: 'image/png' })
  })

  it('网址取图只认 Shopify 图片 CDN', async () => {
    await expect(
      assets.importFromUrl({
        url: 'https://evil.example.com/a.png',
        origin: { kind: 'shop_product' },
        fetch: async () => ({ ok: true, status: 200, arrayBuffer: async () => new ArrayBuffer(0) }),
      }),
    ).rejects.toThrow(/cdn\.shopify\.com/)
  })
})
