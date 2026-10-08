/**
 * WP268：挑中的图挂到网站——传店铺「文件」（staged upload → fileCreate → 等 READY）→ 写进主题 JSON 那一格 →
 * 推未发布预览。店是进程内假店（`resolveFakeShop`），主题工坊是内存里的小替身。不联网。
 */
import type { DesignAsset, ImagePlaceTarget } from '@agentsws/contracts'
import { encodePng } from '@agentsws/model-gateway'
import { beforeEach, describe, expect, it } from 'vitest'
import { type BrandAssets, createBrandAssets } from '../src/brand-assets.js'
import { createDesignStore } from '../src/design.js'
import { createImagePlacer, setThemeImage } from '../src/image-place.js'
import { demoShop, type FakeShop, resolveFakeShop } from '../src/shop-admin-stand-in.js'
import { FILE_CREATE, filenameOfUrl } from '../src/shop-files.js'
import type { SiteThemeAssembly } from '../src/site-theme.js'

const NOW = '2026-10-08T09:00:00.000Z'
const HERO: ImagePlaceTarget = { file: 'templates/index.json', section: 'hero', setting: 'image' }

describe('setThemeImage（纯函数）', () => {
  it('模板：sections.<分区>.settings.<设置>；Shopify 加的头注释原样留着', () => {
    const src = `/*\n * auto-generated\n */\n{"sections":{"hero":{"type":"hero","settings":{"heading":"Hi"}}},"order":["hero"]}`
    const out = setThemeImage(src, HERO, 'shopify://shop_images/a.png')
    expect(out.startsWith('/*\n * auto-generated\n */\n')).toBe(true)
    const doc = JSON.parse(out.slice(out.indexOf('{')))
    expect(doc.sections.hero.settings).toEqual({
      heading: 'Hi',
      image: 'shopify://shop_images/a.png',
    })
  })

  it('嵌套块（agentsws-theme 的 hero → hero-image）', () => {
    const src = JSON.stringify({
      sections: {
        hero: {
          type: 'container',
          blocks: { 'hero-image': { type: 'image', settings: { aspect: 'portrait' } } },
        },
      },
    })
    const out = setThemeImage(src, { ...HERO, block: 'hero-image' }, 'shopify://shop_images/b.png')
    expect(JSON.parse(out).sections.hero.blocks['hero-image'].settings).toEqual({
      aspect: 'portrait',
      image: 'shopify://shop_images/b.png',
    })
  })

  it('主题设置：current.<设置>；预设名写不了', () => {
    const out = setThemeImage(
      '{"current":{"logo":""}}',
      { file: 'config/settings_data.json', setting: 'logo' },
      'x',
    )
    expect(JSON.parse(out).current.logo).toBe('x')
    expect(() =>
      setThemeImage(
        '{"current":"Default"}',
        { file: 'config/settings_data.json', setting: 'logo' },
        'x',
      ),
    ).toThrow(/预设名/)
  })

  it('没有那个分区 / 块、不是 JSON：照实报，不凭空建', () => {
    expect(() => setThemeImage('{"sections":{}}', HERO, 'x')).toThrow(/没有「hero」/)
    expect(() => setThemeImage('{"sections":{"hero":{}}}', { ...HERO, block: 'img' }, 'x')).toThrow(
      /img/,
    )
    expect(() => setThemeImage('not json', HERO, 'x')).toThrow(/JSON/)
  })

  it('CDN 地址里的文件名（去掉查询串）', () => {
    expect(filenameOfUrl('https://cdn.shopify.com/s/files/1/0/files/agentsws-x_1.png?v=17')).toBe(
      'agentsws-x_1.png',
    )
    expect(FILE_CREATE).toContain('mutation AgentswsFileCreate')
  })
})

describe('createImagePlacer', () => {
  let shop: FakeShop
  let assets: BrandAssets
  let asset: DesignAsset
  let files: Record<string, string>
  let pushes: { name: string; matter?: string }[]
  let uploads: string[]
  let scopes: string[]
  let mutations: string[]

  const theme = (): SiteThemeAssembly =>
    ({
      readFile: async (path: string) => {
        if (files[path] === undefined) throw new Error(`工作目录里没有 ${path}`)
        return { path, content: files[path] }
      },
      writeFile: async (path: string, content: string) => {
        files[path] = content
        return { path, bytes: content.length, created: false }
      },
      readiness: async () => ({
        last_push: {
          theme_id: '77',
          theme_name: '首页草稿（agentsws-theme）',
          at: NOW,
          changed_files: [],
        },
      }),
      push: async (input: { name: string; request?: { work_item?: { id: string } } }) => {
        pushes.push({
          name: input.name,
          ...(input.request?.work_item?.id === undefined
            ? {}
            : { matter: input.request.work_item.id }),
        })
        return {
          theme_id: '77',
          theme_name: input.name,
          preview_url: 'https://x.myshopify.com?preview_theme_id=77',
          at: NOW,
          changed_files: ['templates/index.json'],
        }
      },
    }) as unknown as SiteThemeAssembly

  const placer = () =>
    createImagePlacer({
      workspace_id: 'ws_1' as never,
      assets,
      clock: { now: () => NOW },
      shop: async () => ({
        scopes: async () => scopes,
        admin: async () => ({
          store: 'rollout-test.myshopify.com',
          query: async (op) =>
            resolveFakeShop(
              shop,
              /query\s+(\w+)/.exec(op.document)?.[1] ?? '',
              op.variables ?? {},
            ) as never,
          mutate: async (op) => {
            const name = /mutation\s+(\w+)/.exec(op.document)?.[1] ?? ''
            mutations.push(name)
            return resolveFakeShop(shop, name, op.variables ?? {}) as never
          },
        }),
      }),
      theme: async () => theme(),
      uploadFetch: async (url) => {
        uploads.push(url)
        return { ok: true, status: 204 }
      },
      sleep: async () => undefined,
    })

  beforeEach(async () => {
    shop = demoShop()
    files = {
      'templates/index.json':
        '{"sections":{"hero":{"type":"hero","settings":{}}},"order":["hero"]}\n',
    }
    pushes = []
    uploads = []
    mutations = []
    scopes = ['read_products', 'write_files']
    assets = createBrandAssets({
      workspace_id: 'ws_1' as never,
      store: createDesignStore({ workspace_id: 'ws_1' as never }),
      clock: { now: () => NOW },
      random: () => 0.3,
    })
    asset = await assets.importUpload({
      bytes: encodePng(2, 2, new Uint8Array(14), 'rgb'),
      tags: ['hero'],
    })
  })

  it('传店铺文件 → 写进模板 → 推到上一次那份未发布副本；素材记下店铺文件与挂在哪', async () => {
    const out = await placer()({ asset, target: HERO, matter_id: 'mat_1' })
    expect(out.ok).toBe(true)
    expect(out.message).toContain('挂好了')
    expect(mutations).toEqual(['AgentswsStagedUploads', 'AgentswsFileCreate'])
    expect(uploads).toEqual(['https://uploads.shopify.test/upload'])
    const name = `agentsws-${asset.id}.png`
    expect(shop.files?.[0]?.filename).toBe(name)
    expect(JSON.parse(files['templates/index.json'] ?? '').sections.hero.settings.image).toBe(
      `shopify://shop_images/${name}`,
    )
    expect(pushes).toEqual([{ name: '首页草稿（agentsws-theme）', matter: 'mat_1' }])
    const saved = assets.get(asset.id)
    expect(saved?.shop_file).toMatchObject({
      filename: name,
      theme_ref: `shopify://shop_images/${name}`,
      store: 'rollout-test.myshopify.com',
    })
    expect(saved?.shop_file?.url).toContain('cdn.shopify.com')
    expect(saved?.placed).toMatchObject({ ...HERO, theme_id: '77' })
  })

  it('同一张图传过就不再传（只改模板、再推）', async () => {
    await placer()({ asset, target: HERO })
    const again = assets.get(asset.id) as DesignAsset
    await placer()({ asset: again, target: HERO })
    expect(mutations.filter((m) => m === 'AgentswsFileCreate')).toHaveLength(1)
    expect(pushes).toHaveLength(2)
  })

  it('撞名时以 Shopify 读回来的文件名为准', async () => {
    shop.files = [
      {
        id: 'gid://x',
        filename: `agentsws-${asset.id}.png`,
        url: 'https://cdn.shopify.com/a.png',
        polled: 1,
      },
    ]
    await placer()({ asset, target: HERO })
    const ref = assets.get(asset.id)?.shop_file?.theme_ref ?? ''
    expect(ref).not.toBe(`shopify://shop_images/agentsws-${asset.id}.png`)
    expect(JSON.parse(files['templates/index.json'] ?? '').sections.hero.settings.image).toBe(ref)
  })

  it('授权里没有「上传文件」：一个字节不传，说去重新授权', async () => {
    scopes = ['read_products']
    const out = await placer()({ asset, target: HERO })
    expect(out.ok).toBe(false)
    expect(out.message).toContain('重新授权')
    expect(mutations).toEqual([])
  })

  it('模板里没有那一格：图已传、照实说没写进去，不推', async () => {
    const out = await placer()({ asset, target: { ...HERO, section: 'banner' } })
    expect(out.ok).toBe(false)
    expect(out.message).toContain('传到店铺「文件」了')
    expect(out.message).toContain('banner')
    expect(pushes).toEqual([])
  })
})
