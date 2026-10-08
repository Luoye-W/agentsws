/**
 * WP274（决策 255）：走用户自己的 key 出图时的计费口径——不预扣积分、不出积分口径的超额卡
 * （张数上限仍在），本机记张数与估算美元（素材来源 + 事件 + 设计岗数据看板那一行）。
 *
 * 替身同 WP268 那一组（确定性占位图、内存审批总线、进程内假店），不联网、不花钱。
 */
import type { ApprovalItem, ImageProvider, RunRequest } from '@agentsws/contracts'
import { encodePng, ProviderError, stubImageProvider } from '@agentsws/model-gateway'
import { beforeEach, describe, expect, it } from 'vitest'
import { type BrandAssets, createBrandAssets } from '../src/brand-assets.js'
import { createDesignStore, designDeckData } from '../src/design.js'
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

const OWN: ImagePricing = { official: false, model: 'gemini-nano-banana-2.1' }

describe('自己的 key：不扣积分，记张数与估算美元', () => {
  let events: { type: string; payload: Record<string, unknown> }[]
  beforeEach(() => {
    events = []
    pricing = OWN
    provider = stubImageProvider({
      seed: 4,
      ref: { provider: 'google', model: 'gemini-nano-banana-2.1' },
    })
    svc = build({ appendEvent: (type, payload) => events.push({ type, payload }) })
  })

  it('出图：0 积分、卡上说不扣积分；素材记 own_key + 一张的估算美元；事件带整批估算', async () => {
    const out = await run('generate_image', { prompt: 'poster', aspect_ratio: '1:1', n: 2 })
    expect(out.data).toMatchObject({ kind: 'image_pick', credits: 0 })
    expect((out.data as { message: string }).message).toContain('不扣积分')
    const card = cards.at(-1) as ApprovalItem & {
      payload: { own_key?: boolean; again_credits: number }
    }
    expect(card.summary).toContain('不扣积分')
    expect(card.summary).not.toContain('约 ')
    expect(card.payload.own_key).toBe(true)
    expect(card.payload.again_credits).toBe(0)
    const a = assets.list()[0]
    expect(a?.provenance.credits).toBeUndefined()
    expect(a?.provenance.own_key).toBe(true)
    expect(a?.provenance.est_usd).toBe(0.0336)
    const ev = events.find((e) => e.type === 'image.generated')
    expect(ev?.payload).toMatchObject({ images: 2, credits: 0, own_key: true, est_usd: 0.0672 })
  })

  it('张数上限仍在：一次运行超 8 张出卡问，但卡上没有积分口径', async () => {
    await run('generate_image', { prompt: 'a', n: 4 })
    await run('generate_image', { prompt: 'b', n: 4 })
    const over = await run('generate_image', { prompt: 'c', n: 2 })
    expect(over.data).toMatchObject({ kind: 'image_budget', status: 'needs_approval', credits: 0 })
    expect((over.data as { message: string }).message).toContain('不扣积分')
    expect((over.data as { message: string }).message).not.toContain('约 ')
    const budget = cards.at(-1) as ApprovalItem & { payload: { reason: string; own_key?: boolean } }
    expect(budget.kind).toBe('image_budget')
    expect(budget.title).toBe('还要再出 2 张图吗？')
    expect(budget.payload.reason).toBe('per_run_images')
    expect(budget.payload.own_key).toBe(true)
  })

  it('不按积分上限拦：官方价下早该问的量，用自己的 key 照出', async () => {
    const ref = await assets.importUpload({ bytes: tinyPng(2) })
    // 官方价下 6 张改图 = 3.6+ 积分会先到积分上限；自己的 key 不看积分
    await run('edit_image', { prompt: 'a', asset_ids: [ref.id], n: 4 })
    const second = await run('edit_image', { prompt: 'b', asset_ids: [ref.id], n: 3 })
    expect((second.data as { kind: string }).kind).toBe('image_pick')
    expect(cards.filter((c) => c.kind === 'image_budget')).toHaveLength(0)
  })

  it('数据看板：设计岗这一周用自己的账号出了几张、估算多少美元', async () => {
    await run('generate_image', { prompt: 'a', n: 3 }, req('design.dtc'))
    const store = createDesignStore({ workspace_id: WS })
    // 素材库就是设计岗那张素材表：把同一批记录放进一份新的表里算投影
    for (const a of assets.list()) store.saveAsset(a)
    const week = designDeckData(store, { now: NOW }).weekly
    expect(week.own_key).toEqual({ images: 3, est_usd: 0.1 })
  })

  it('官方接口那一路不变：照样扣积分、素材不记 own_key', async () => {
    pricing = { official: true, per_image: 0.5 }
    await run('generate_image', { prompt: 'a', n: 1 })
    const a = assets.list()[0]
    expect(a?.provenance.credits).toBe(0.5)
    expect(a?.provenance.own_key).toBeUndefined()
    expect(a?.provenance.est_usd).toBeUndefined()
  })
})
