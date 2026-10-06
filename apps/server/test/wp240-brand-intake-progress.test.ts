/**
 * WP240 服务侧：分析跑着的时候进度跟着动；读不到时一句人话 + 种类；店铺密码只活在那一次抓取里。
 *
 * 不联网：抓取口是内存替身。
 */
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { BrandIntakeActor } from '@agentsws/api'
import type { PageFetch, StorefrontPasswordPost } from '@agentsws/brand-intake'
import { describe, expect, it } from 'vitest'
import { createBrandIntake, failureLine } from '../src/brand-intake.js'

const FIXTURES = join(
  dirname(fileURLToPath(import.meta.url)),
  '..',
  '..',
  '..',
  'packages',
  'brand-intake',
  'test',
  'fixtures',
)
const read = (name: string): string => readFileSync(join(FIXTURES, name), 'utf8')
const SHOP = 'https://nordvik.example'
const PAGES: Record<string, string> = {
  [`${SHOP}/robots.txt`]: 'robots.txt',
  [`${SHOP}/`]: 'shop-home.html',
  [`${SHOP}/pages/about`]: 'shop-about.html',
  [`${SHOP}/pages/contact`]: 'shop-contact.html',
  [`${SHOP}/policies/refund-policy`]: 'shop-refund.html',
  [`${SHOP}/policies/shipping-policy`]: 'shop-shipping.html',
  [`${SHOP}/products/granite-wallet`]: 'product-wallet.html',
  [`${SHOP}/products/fjord-tote`]: 'product-tote.html',
}
const ACTOR: BrandIntakeActor = {
  workspace_id: 'ws_rollout',
  person_id: 'p_1',
  assignment_id: 'a_1',
  role_id: 'common.owner',
}
const STORE_PASSWORD = 'fake-store-pass-wp240'

function make(fetch: PageFetch, passwordPost?: StorefrontPasswordPost) {
  let seq = 0
  const warned: string[] = []
  const written: { ws: string }[] = []
  const made = createBrandIntake({
    clock: { now: () => new Date(Date.UTC(2026, 9, 6, 0, 0, ++seq)).toISOString() },
    workspace_id: 'ws_inmo',
    fetch,
    newId: (prefix) => `${prefix}_${String(++seq)}`,
    sinks: {
      applyProfile: (_p, actor) => {
        written.push({ ws: actor.workspace_id })
      },
    },
    warn: (line) => {
      warned.push(line)
    },
    ...(passwordPost === undefined ? {} : { passwordPost }),
  })
  return { ...made, warned, written }
}

describe('WP240 服务侧 · 进度', () => {
  it('跑着的时候 get 就看得到已经读了几页（不等整轮跑完）', async () => {
    let release: () => void = () => {}
    const gate = new Promise<void>((r) => {
      release = r
    })
    const fetch: PageFetch = async (url) => {
      // 读到「联系」页之前先停住：这时候首页与关于页已经读完了
      if (url.endsWith('/pages/contact')) await gate
      const name = PAGES[url]
      if (name === undefined) return { ok: false, status: 404, text: async () => '' }
      return { ok: true, status: 200, text: async () => read(name) }
    }
    const f = make(fetch)
    const started = await f.port.start(ACTOR, { urls: [`${SHOP}/`] })
    for (let i = 0; i < 50; i++) {
      const now = await f.port.get(ACTOR, started.id)
      if (now.pages.length >= 2) break
      await new Promise((r) => setTimeout(r, 2))
    }
    const mid = await f.port.get(ACTOR, started.id)
    expect(mid.status).toBe('running')
    expect(mid.pages.length).toBeGreaterThanOrEqual(2)
    release()
    await f.settle()
    const done = await f.port.get(ACTOR, started.id)
    expect(done.status).toBe('awaiting_confirm')
    expect(done.pages.length).toBeGreaterThan(mid.pages.length)
  })
})

describe('WP240 服务侧 · 读不到时照实说', () => {
  it('429：failed + blocked + 一句带下一步的人话', async () => {
    const f = make(async () => ({ ok: false, status: 429, text: async () => '' }))
    const started = await f.port.start(ACTOR, { urls: [`${SHOP}/`] })
    await f.settle()
    const done = await f.port.get(ACTOR, started.id)
    expect(done.status).toBe('failed')
    expect(done.failure_kind).toBe('blocked')
    expect(done.failure).toBe(failureLine('blocked', '对方在限流（429），先不抓了'))
    expect(done.failure).toContain('手动填')
  })

  it('店铺有访问密码：failed + password；填对密码重新分析就读到了；密码哪儿都不留', async () => {
    const fetch: PageFetch = async (url, init) => {
      if (url.endsWith('/robots.txt')) return { ok: true, status: 200, text: async () => '' }
      if (init.headers.cookie?.includes('storefront_digest=') !== true)
        return {
          ok: true,
          status: 200,
          url: `${SHOP}/password`,
          text: async () => read('shop-password.html'),
        }
      const name = PAGES[url]
      if (name === undefined) return { ok: false, status: 404, text: async () => '' }
      return { ok: true, status: 200, text: async () => read(name) }
    }
    const post: StorefrontPasswordPost = async (_url, init) => ({
      status: 302,
      headers: {
        get: () => null,
        getSetCookie: () =>
          new URLSearchParams(init.body).get('password') === STORE_PASSWORD
            ? ['storefront_digest=ok; path=/']
            : [],
      },
    })
    const f = make(fetch, post)
    const started = await f.port.start(ACTOR, { urls: [`${SHOP}/`] })
    await f.settle()
    const locked = await f.port.get(ACTOR, started.id)
    expect(locked.status).toBe('failed')
    expect(locked.failure_kind).toBe('password')
    expect(locked.password_protected).toBe(true)
    expect(locked.failure).toContain('店铺密码')

    const again = await f.port.reanalyze(ACTOR, {
      run_id: started.id,
      storefront_password: STORE_PASSWORD,
    })
    expect(again.failure).toBeUndefined()
    await f.settle()
    const opened = await f.port.get(ACTOR, started.id)
    expect(opened.status).toBe('awaiting_confirm')
    expect(opened.failure_kind).toBeUndefined()
    expect(opened.profile.brand_name?.value).toBe('Nordvik Supply')
    // 密码不在 run 里、不在 warn 里
    expect(JSON.stringify(opened)).not.toContain(STORE_PASSWORD)
    expect(f.warned.join('\n')).not.toContain(STORE_PASSWORD)

    // 确认：写的是确认人所在的品牌
    await f.port.confirm(ACTOR, { run_id: started.id })
    expect(f.written).toEqual([{ ws: 'ws_rollout' }])
  })
})
