/**
 * WP335（决策 659）：品牌档案的「品类」一格——品牌分析时 AI 填（标「请确认」）、人可改；
 * 设置页写得进、读得出、空串清空；手填 / 确认分析都写进档案。不联网（抓取口是夹具，模型口是替身）。
 */
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { BrandIntakeActor } from '@agentsws/api'
import type { PageFetch } from '@agentsws/brand-intake'
import type { BrandIntakeProfile } from '@agentsws/contracts'
import { afterEach, describe, expect, it } from 'vitest'
import { createBrandIntake } from '../src/brand-intake.js'
import { createServer, type Server } from '../src/index.js'

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
  [`${SHOP}/products/granite-wallet`]: 'product-wallet.html',
}
const replay: PageFetch = async (url) => {
  const name = PAGES[url]
  if (name === undefined) return { ok: false, status: 503, text: async () => '' }
  return { ok: true, status: 200, text: async () => readFileSync(join(FIXTURES, name), 'utf8') }
}
const ACTOR: BrandIntakeActor = {
  workspace_id: 'ws_test',
  person_id: 'p_1',
  assignment_id: 'a_1',
  role_id: 'r_1',
}

function intake(reply: string | undefined) {
  let seq = 0
  const prompts: string[] = []
  const written: BrandIntakeProfile[] = []
  const made = createBrandIntake({
    clock: { now: () => new Date(Date.UTC(2026, 9, 15, 0, 0, ++seq)).toISOString() },
    workspace_id: ACTOR.workspace_id,
    fetch: replay,
    newId: (p) => `${p}_${++seq}`,
    sinks: { applyProfile: (p) => void written.push(p) },
    warn: () => {},
    ...(reply === undefined
      ? {}
      : {
          categoryModel:
            () =>
            async ({ prompt }: { prompt: string }) => {
              prompts.push(prompt)
              return { text: reply }
            },
        }),
  })
  return { ...made, prompts, written }
}

describe('WP335 品类：品牌分析时 AI 填', () => {
  it('接了模型：读到的几格交给模型，回来的品类标「请确认」（模型那一层、把握度低）', async () => {
    const f = intake('{"category": "leather goods"}')
    const run = await f.port.start(ACTOR, { urls: [`${SHOP}/`] })
    await f.settle()
    const done = await f.port.get(ACTOR, run.id)
    expect(done.profile.category).toMatchObject({ value: 'leather goods', confidence: 'low' })
    expect(done.profile.category?.evidence[0]?.locator).toBe('model')
    expect(f.prompts).toHaveLength(1)
    expect(f.prompts[0]).toContain('Nordvik')
    // 确认：品类跟着别的格子一起写出去
    await f.port.confirm(ACTOR, { run_id: run.id })
    expect(f.written[0]?.category?.value).toBe('leather goods')
  })

  it('没接模型 / 模型答不像样：品类空着（人自己填）；人改过的重新分析也不覆盖', async () => {
    const none = intake(undefined)
    const a = await none.port.start(ACTOR, { urls: [`${SHOP}/`] })
    await none.settle()
    expect((await none.port.get(ACTOR, a.id)).profile.category).toBeUndefined()

    const vague = intake('I think they sell many things, mostly wallets.')
    const b = await vague.port.start(ACTOR, { urls: [`${SHOP}/`] })
    await vague.settle()
    expect((await vague.port.get(ACTOR, b.id)).profile.category).toBeUndefined()

    const f = intake('{"category": "bags"}')
    const c = await f.port.start(ACTOR, { urls: [`${SHOP}/`] })
    await f.settle()
    await f.port.confirm(ACTOR, { run_id: c.id, edits: { category: '钱包' } })
    await f.port.reanalyze(ACTOR, { run_id: c.id })
    await f.settle()
    expect((await f.port.get(ACTOR, c.id)).profile.category).toMatchObject({
      value: '钱包',
      edited: true,
    })
    // WP346：重新分析会再问一次模型（人群 / 关键词那几格要重归纳），但人改过的品类整格不动
    expect(f.prompts).toHaveLength(2)
  })
})

const servers: Server[] = []
afterEach(async () => {
  for (const s of servers.splice(0)) await s.close()
})

describe('WP335 品类：品牌档案里人可改', () => {
  it('设置页写得进、读得出、不给不改、空串清空；手填品牌资料也写进档案', async () => {
    const server = await createServer({
      clock: { now: () => '2026-10-15T08:00:00.000Z' },
      quiet: true,
      startRun: false,
      tokenRefreshIntervalMs: 0,
      scheduleIntervalMs: 0,
      liveDataIntervalMs: 0,
      env: { AGENTSWS_OWNER_EMAIL: 'luoye@example.com', AGENTSWS_WORKSPACE_NAME: 'IVRA' },
      mdns: () => ({ reason: '测试里不开局域网' }),
      brandIntakeFetch: async () => ({ ok: false, status: 429, text: async () => '' }),
    })
    servers.push(server)
    const ws = server.bootstrap.workspace.id
    const call = async (method: string, path: string, body?: unknown) => {
      const res = await server.gateway.fetch(
        new Request(`http://127.0.0.1${path}`, {
          method,
          headers: {
            Authorization: `Bearer ${server.bootstrap.internalToken}`,
            'X-Assignment': server.bootstrap.ownerAssignment.id,
            'content-type': 'application/json',
          },
          ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        }),
      )
      return {
        status: res.status,
        data: ((await res.json()) as { data?: { category?: string } }).data,
      }
    }
    const set = await call('PUT', '/v1/workspace/profile', {
      legal_name: 'IVRA',
      category: '  AR   眼镜 ',
    })
    expect(set.status).toBe(200)
    expect(set.data?.category).toBe('AR 眼镜')
    expect(server.onboarding.brandProfile(ws).category).toBe('AR 眼镜')
    const kept = await call('PUT', '/v1/workspace/profile', { legal_name: 'IVRA Tech' })
    expect(kept.data?.category).toBe('AR 眼镜')
    const cleared = await call('PUT', '/v1/workspace/profile', { legal_name: 'IVRA', category: '' })
    expect(cleared.data?.category).toBeUndefined()
    expect(
      (await call('PUT', '/v1/workspace/profile', { legal_name: 'IVRA', category: 'x'.repeat(81) }))
        .status,
    ).toBe(400)

    const manual = await call('POST', '/v1/brand-intake/manual', {
      edits: { category: '户外滑板' },
    })
    expect(manual.status).toBe(201)
    expect(server.onboarding.brandProfile(ws).category).toBe('户外滑板')
  })
})
