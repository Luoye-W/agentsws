/**
 * 品牌图标（WP45）。
 *
 * 两条断言：
 * 1. **连接目录里的每一个 provider id 都有专属图标**——id 不是抄在这个文件里的常量，
 *    而是当场从 `apps/server/src/catalog.ts` 里读出来的（工作台不依赖 server 包，
 *    所以按文本抓 `service: '...'`）。以后目录里加一家却忘了配图标，这条会红。
 *    设置页那两张模型卡的 `kind` 同理，从 `packages/api/src/routes/models.ts` 里读。
 * 2. **认不出的 id 落通用插头**，且落回落的时候画的确实不是某家的标志。
 *
 * 外加两条商标纪律的回归（`docs/36` §8）：图标一律 `aria-hidden`（读屏念的是旁边那行
 * 品牌文字），彩色品牌图标的 `fill` 就是官方那个色、不跟主题变。
 */
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { render, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { BrandIcon, hasBrandIcon } from '@/components/brand-icons'

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..')

function read(relative: string): string {
  return readFileSync(join(repoRoot, relative), 'utf8')
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

  it('图标 aria-hidden，尺寸默认 20px，品牌色不跟主题变', () => {
    const { unmount } = render(<BrandIcon provider="shopify_admin" />)
    const icon = screen.getByTestId('brand-icon')
    expect(icon.getAttribute('aria-hidden')).toBe('true')
    expect(icon.getAttribute('width')).toBe('20')
    expect(icon.getAttribute('height')).toBe('20')
    expect(icon.getAttribute('data-icon')).toBe('shopify')
    // Simple Icons 给 Shopify 的品牌色，写死不走 currentColor
    expect(icon.querySelector('path')?.getAttribute('fill')).toBe('#7AB55C')
    unmount()

    render(<BrandIcon provider="ga4" size={16} />)
    const ga4 = screen.getByTestId('brand-icon')
    expect(ga4.getAttribute('width')).toBe('16')
    expect(ga4.getAttribute('data-icon')).toBe('googleanalytics')
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
