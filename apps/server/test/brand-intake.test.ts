/**
 * 服务进程这一侧的网址分析（WP121，70 §3）。
 *
 * 五件：
 *
 * 1. `start` **不等**分析跑完就返回（用户这就能去第 ③ 步）；
 * 2. 跑完之后状态自己变成 `awaiting_confirm`，进度与花的钱都在 run 上；
 * 3. 确认那一下**先盖用户的改动再写出去**（顺序反了写出去的就是分析结果）；
 * 4. **重新分析不覆盖手改**；
 * 5. 一个页面都没抓着就如实 `failed`，不写任何东西出去。
 *
 * 不联网：抓取口塞的是 `@agentsws/brand-intake` 那份夹具表。
 */
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { BrandIntakeActor } from '@agentsws/api'
import type { PageFetch } from '@agentsws/brand-intake'
import type { BrandIntakeProfile } from '@agentsws/contracts'
import { describe, expect, it } from 'vitest'
import { createBrandIntake } from '../src/brand-intake.js'

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

/** 夹具表里没有的网址回 503——哪天谁加了个真请求，用例会当场红。 */
function replay(pages: Record<string, string> = PAGES): PageFetch {
  return async (url) => {
    const name = pages[url]
    if (name === undefined) return { ok: false, status: 503, text: async () => '' }
    return { ok: true, status: 200, text: async () => readFileSync(join(FIXTURES, name), 'utf8') }
  }
}

const ACTOR: BrandIntakeActor = {
  workspace_id: 'ws_test',
  person_id: 'p_1',
  assignment_id: 'a_1',
  role_id: 'r_1',
}

function fixture(options: { pages?: Record<string, string> } = {}) {
  let seq = 0
  const written: BrandIntakeProfile[] = []
  const seeded: BrandIntakeProfile[] = []
  const made = createBrandIntake({
    clock: { now: () => new Date(Date.UTC(2026, 8, 19, 0, 0, ++seq)).toISOString() },
    workspace_id: ACTOR.workspace_id,
    fetch: replay(options.pages),
    newId: (prefix) => `${prefix}_${String(++seq).padStart(4, '0')}`,
    sinks: {
      applyProfile: (p) => {
        written.push(p)
      },
      seedKnowledge: (p) => {
        seeded.push(p)
      },
    },
    warn: () => {},
  })
  return { ...made, written, seeded }
}

describe('WP121 服务侧 · 跑一轮', () => {
  it('start 不等分析跑完就返回；跑完自己变成 awaiting_confirm', async () => {
    const f = fixture()
    const started = await f.port.start(ACTOR, { urls: [`${SHOP}/`] })
    // 这一刻还没抓任何东西——用户这就可以去第 ③ 步选岗位
    expect(started.status).toBe('running')
    expect(started.pages).toHaveLength(0)

    await f.settle()
    const done = await f.port.get(ACTOR, started.id)
    expect(done.status).toBe('awaiting_confirm')
    expect(done.profile.brand_name?.value).toBe('Nordvik Supply')
    expect(done.pages.filter((p) => p.ok).length).toBeGreaterThan(5)
    expect(done.budget.spent_credits).toBeGreaterThan(0)
    expect(done.budget.spent_credits).toBeLessThanOrEqual(done.budget.cap_credits)
  })

  it('latest 回这个工作区最近的那一次；别人的看不见', async () => {
    const f = fixture()
    const mine = await f.port.start(ACTOR, { urls: [`${SHOP}/`] })
    await f.settle()
    expect((await f.port.latest(ACTOR))?.id).toBe(mine.id)
    // 换一个工作区问：没有
    expect(await f.port.latest({ ...ACTOR, workspace_id: 'ws_other' })).toBeUndefined()
  })

  it('别的工作区的 run：当它不存在，不泄露「有这么个 id」', async () => {
    const f = fixture()
    const mine = await f.port.start(ACTOR, { urls: [`${SHOP}/`] })
    await f.settle()
    await expect(async () =>
      f.port.get({ ...ACTOR, workspace_id: 'ws_other' }, mine.id),
    ).rejects.toThrow('没有这一次分析')
  })

  it('一个页面都没抓着：如实 failed，一个字都不写出去', async () => {
    const f = fixture({ pages: {} })
    const started = await f.port.start(ACTOR, { urls: [`${SHOP}/`] })
    await f.settle()
    const done = await f.port.get(ACTOR, started.id)
    expect(done.status).toBe('failed')
    expect(done.failure).toBeDefined()
    expect(f.written).toHaveLength(0)
  })
})

describe('WP121 服务侧 · 确认', () => {
  it('先盖用户的改动，再写出去', async () => {
    const f = fixture()
    const started = await f.port.start(ACTOR, { urls: [`${SHOP}/`] })
    await f.settle()

    const out = await f.port.confirm(ACTOR, {
      run_id: started.id,
      edits: { brand_name: 'Nordvik 北欧补给' },
    })
    expect(out.status).toBe('confirmed')
    // 写出去的是**用户确认过的那一份**，不是分析结果
    expect(f.written).toHaveLength(1)
    expect(f.written[0]?.brand_name?.value).toBe('Nordvik 北欧补给')
    expect(f.written[0]?.brand_name?.edited).toBe(true)
    // 知识那一口也收到了同一份
    expect(f.seeded[0]?.brand_name?.value).toBe('Nordvik 北欧补给')
  })

  it('不带 edits 就按分析结果走', async () => {
    const f = fixture()
    const started = await f.port.start(ACTOR, { urls: [`${SHOP}/`] })
    await f.settle()
    await f.port.confirm(ACTOR, { run_id: started.id })
    expect(f.written[0]?.brand_name?.value).toBe('Nordvik Supply')
    expect(f.written[0]?.brand_name?.edited).toBeUndefined()
  })
})

describe('WP121 服务侧 · 重新分析', () => {
  it('用户改过的格子整格不动，没改过的照常刷新', async () => {
    const f = fixture()
    const started = await f.port.start(ACTOR, { urls: [`${SHOP}/`] })
    await f.settle()
    await f.port.confirm(ACTOR, {
      run_id: started.id,
      edits: { brand_name: 'Nordvik 北欧补给' },
    })

    // 换了新品，重跑一次。机器还是会抽出 "Nordvik Supply"
    const again = await f.port.reanalyze(ACTOR, { run_id: started.id })
    expect(again.status).toBe('running')
    await f.settle()

    const done = await f.port.get(ACTOR, started.id)
    // **不动**——这个按钮只要吃掉过一次手改就再没人敢按
    expect(done.profile.brand_name?.value).toBe('Nordvik 北欧补给')
    expect(done.profile.brand_name?.edited).toBe(true)
    // 没改过的那些照常是这一轮抓回来的
    expect(done.profile.support_email?.value).toBe('hello@nordvik.example')
    expect(done.status).toBe('awaiting_confirm')
  })

  it('重新分析可以换一组网址', async () => {
    const f = fixture()
    const started = await f.port.start(ACTOR, { urls: [`${SHOP}/`] })
    await f.settle()
    const again = await f.port.reanalyze(ACTOR, { run_id: started.id, urls: [`${SHOP}/`] })
    expect(again.inputs.map((i) => i.kind)).toEqual(['website'])
    await f.settle()
  })
})
