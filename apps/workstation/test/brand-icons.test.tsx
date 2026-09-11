/**
 * 品牌图标（WP45 起，WP48 加官方图那一层）。
 *
 * 四条断言：
 * 1. **连接目录里的每一个 provider id 都有专属图标**——id 不是抄在这个文件里的常量，
 *    而是当场从 `apps/server/src/catalog.ts` 里读出来的（工作台不依赖 server 包，
 *    所以按文本抓 `service: '...'`）。以后目录里加一家却忘了配图标，这条会红。
 *    设置页那两张模型卡的 `kind` 同理，从 `packages/api/src/routes/models.ts` 里读。
 * 2. **`MANIFEST.json` 里记了抓到官方图的每一个 provider，磁盘上真有那个文件，
 *    界面上真渲染成 `<img>`**——同样不抄清单，当场读 `assets/brand/MANIFEST.json`。
 *    重抓一轮少了一张图、或者有人手删了文件，这条会红而不是悄悄退回矢量图。
 * 3. **不在 MANIFEST 里的退回 Simple Icons 的矢量图**（眼下是 Meta），
 *    **认不出的 id 落通用插头**，且回落画的确实不是某家的标志。
 *
 * 外加商标纪律的回归（`docs/36` §8）：图标一律 `aria-hidden`（读屏念的是旁边那行
 * 品牌文字）、`alt` 是空串、尺寸两档、官方图 `object-fit: contain` 不拉伸、
 * 矢量兜底的 `fill` 就是官方那个色不跟主题变、中性徽标走 `currentColor`。
 */
import { existsSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { render, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { BrandIcon, hasBrandIcon, hasOfficialIcon } from '@/components/brand-icons'

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..')
const brandDir = join(repoRoot, 'apps/workstation/src/assets/brand')

function read(relative: string): string {
  return readFileSync(join(repoRoot, relative), 'utf8')
}

/** 构建期抓回来的官方图清单（`scripts/fetch-brand-icons.mjs` 写的）。 */
function manifest(): {
  icons: Record<string, { file: string; format: string; width: number | null; bytes: number }>
  fallbacks: Record<string, { reason: string }>
} {
  return JSON.parse(readFileSync(join(brandDir, 'MANIFEST.json'), 'utf8'))
}

/** 连接目录里所有 provider 的 id（`CatalogEntry.service`）。 */
function catalogServices(): string[] {
  const source = read('apps/server/src/catalog.ts')
  const ids = [...source.matchAll(/^\s{4}service: '([a-z0-9_]+)',$/gm)].map((m) => m[1] as string)
  return [...new Set(ids)]
}

/** 设置页两张模型卡的 `kind`（`ModelProviderKind`）。 */
function modelKinds(): string[] {
  const source = read('packages/api/src/routes/models.ts')
  const line = /const KIND = z\.enum\(\[([^\]]+)\]\)/.exec(source)?.[1] ?? ''
  return [...line.matchAll(/'([a-z0-9_]+)'/g)].map((m) => m[1] as string)
}

describe('BrandIcon', () => {
  it('连接目录里的每个 provider 都有专属图标（不是回落）', () => {
    const services = catalogServices()
    // 目录本身别读空了：WP45 当时是六个（shopify_admin / imap_smtp / gmail / ga4 / gsc / meta_ads）
    expect(services.length).toBeGreaterThanOrEqual(6)
    expect(services).toContain('shopify_admin')

    for (const service of services) {
      expect(hasBrandIcon(service), `${service} 还没配图标`).toBe(true)
      const { unmount } = render(<BrandIcon provider={service} />)
      const icon = screen.getByTestId('brand-icon')
      expect(icon.getAttribute('data-provider')).toBe(service)
      expect(icon.getAttribute('data-icon'), `${service} 落到了通用插头`).not.toBe('fallback')
      unmount()
    }
  })

  it('模型卡的每个 kind 也有专属图标', () => {
    const kinds = modelKinds()
    expect(kinds).toEqual(['deepseek', 'openai_compatible'])
    for (const kind of kinds) {
      expect(hasBrandIcon(kind), `${kind} 还没配图标`).toBe(true)
      const { unmount } = render(<BrandIcon provider={kind} />)
      expect(screen.getByTestId('brand-icon').getAttribute('data-icon')).not.toBe('fallback')
      unmount()
    }
  })

  it('MANIFEST 里的每个 provider：文件在、渲染成 <img>', () => {
    const { icons } = manifest()
    const providers = Object.keys(icons)
    // 这一轮抓到五张（shopify_admin / gmail / ga4 / gsc / deepseek）；少了要当场知道
    expect(providers.length).toBeGreaterThanOrEqual(5)
    expect(providers).toContain('shopify_admin')

    for (const [provider, entry] of Object.entries(icons)) {
      expect(entry.file, `${provider} 的文件名该是 id + 后缀`).toBe(`${provider}.${entry.format}`)
      expect(existsSync(join(brandDir, entry.file)), `${brandDir}/${entry.file} 不在`).toBe(true)
      expect(readFileSync(join(brandDir, entry.file)).byteLength).toBe(entry.bytes)
      // PNG 得够大：再小的图放到 20px 卡片上更糊，宁可退回矢量
      if (entry.format === 'png') expect(entry.width ?? 0).toBeGreaterThanOrEqual(64)

      expect(hasOfficialIcon(provider), `${provider} 有文件却没被组件认出来`).toBe(true)
      const { unmount } = render(<BrandIcon provider={provider} />)
      const icon = screen.getByTestId('brand-icon')
      expect(icon.tagName).toBe('IMG')
      expect(icon.getAttribute('data-icon')).toBe('official')
      // 图从仓库里来：要么是打包后的本地 URL，要么被 Vite 编成 data: URI（小图省一次请求）。
      // **绝不能是 http(s) 外站地址**——运行时一条外发请求都不该有（本地优先 / 隐私 / 离线）。
      const src = icon.getAttribute('src') ?? ''
      expect(src).not.toBe('')
      expect(src.startsWith('http'), `${provider} 的图指到外站去了：${src.slice(0, 60)}`).toBe(
        false,
      )
      expect(src.startsWith('data:') || src.includes(provider)).toBe(true)
      // 商标不变形：非正方的官方图按原比例放进方格，不是拉满
      expect((icon as HTMLImageElement).style.objectFit).toBe('contain')
      // 图标不承担信息：空 alt + aria-hidden，读屏念的是旁边那行品牌文字
      expect(icon.getAttribute('alt')).toBe('')
      expect(icon.getAttribute('aria-hidden')).toBe('true')
      unmount()
    }
  })

  it('没抓到官方图的退回 Simple Icons 的矢量图（眼下是 Meta）', () => {
    const { icons, fallbacks } = manifest()
    expect(Object.keys(fallbacks)).toContain('meta_ads')
    expect(fallbacks.meta_ads?.reason ?? '').not.toBe('')
    expect(Object.keys(icons)).not.toContain('meta_ads')

    expect(hasOfficialIcon('meta_ads')).toBe(false)
    expect(hasBrandIcon('meta_ads')).toBe(true)
    render(<BrandIcon provider="meta_ads" />)
    const icon = screen.getByTestId('brand-icon')
    expect(icon.tagName).toBe('svg')
    expect(icon.getAttribute('data-icon')).toBe('meta')
    // Simple Icons 给 Meta 的品牌色，写死不走 currentColor
    expect(icon.querySelector('path')?.getAttribute('fill')).toBe('#0467DF')
  })

  it('认不出的 id 回落到通用插头', () => {
    expect(hasBrandIcon('some_future_saas')).toBe(false)
    render(<BrandIcon provider="some_future_saas" />)
    const icon = screen.getByTestId('brand-icon')
    expect(icon.getAttribute('data-icon')).toBe('fallback')
    expect(icon.getAttribute('data-provider')).toBe('some_future_saas')
    // 回落画的是 lucide 的线条插头，不是谁家的标志
    expect(icon.querySelector('path[fill^="#"]')).toBeNull()
  })

  it('通用邮箱不挂任何一家的标志', () => {
    render(<BrandIcon provider="imap_smtp" />)
    expect(screen.getByTestId('brand-icon').getAttribute('data-icon')).toBe('mail')
  })

  it('图标 aria-hidden，尺寸默认 20px / 列表行 16px，官方图也不例外', () => {
    const { unmount } = render(<BrandIcon provider="shopify_admin" />)
    const icon = screen.getByTestId('brand-icon')
    expect(icon.getAttribute('aria-hidden')).toBe('true')
    expect(icon.getAttribute('width')).toBe('20')
    expect(icon.getAttribute('height')).toBe('20')
    // WP48：Shopify 现在用的是官网自己那张图（WP45 那条 Simple Icons 的 path 退成兜底）
    expect(icon.getAttribute('data-icon')).toBe('official')
    expect(icon.getAttribute('src') ?? '').toContain('shopify_admin')
    expect((icon.getAttribute('src') ?? '').startsWith('http')).toBe(false)
    unmount()

    render(<BrandIcon provider="ga4" size={16} />)
    const ga4 = screen.getByTestId('brand-icon')
    expect(ga4.getAttribute('width')).toBe('16')
    expect(ga4.getAttribute('height')).toBe('16')
    expect(ga4.getAttribute('data-icon')).toBe('official')
  })

  it('没有 CC0 品牌图标的（OpenAI 兼容）走首字母单色徽标，跟着主题走', () => {
    render(<BrandIcon provider="openai_compatible" />)
    const icon = screen.getByTestId('brand-icon')
    expect(icon.getAttribute('data-icon')).toBe('letter-o')
    expect(icon.textContent).toBe('O')
    // 单色徽标一律 currentColor：深色模式下跟着文字变，不冒充谁的品牌色
    expect(icon.querySelector('circle')?.getAttribute('stroke')).toBe('currentColor')
    expect(icon.querySelector('text')?.getAttribute('fill')).toBe('currentColor')
  })
})
