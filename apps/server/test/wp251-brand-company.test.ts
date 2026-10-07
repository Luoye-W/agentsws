/**
 * WP251：品牌 / 公司口径修正。
 *
 * Fable 10-07 Windows 真机（只读查的）：
 * - 公司 `org_…` 的全称是在 Rollout 的设置页改的新名字；
 * - 启动品牌 INMO **没有 `org_id`**、`kind: personal`；加的品牌 Rollout `kind: shared`、挂在公司下；
 * - `onboarding_profiles` 每个品牌各存一份公司全称（INMO 那份还是 "INMO"），老表 `onboarding_profile` 也是 "INMO"。
 *
 * 这一档钉住：公司级字段只认公司（设置页「公司」改的是公司）、启动品牌挂进公司（迁移幂等、
 * 一条数据不丢）、AI 上下文「品牌：」按运行所在品牌 +「公司：」另起一行、加的品牌走完第 ④ 步才算设置完。
 *
 * 不联网：抓取口是 `@agentsws/brand-intake` 的夹具表。
 */
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { dirname, join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { PageFetch } from '@agentsws/brand-intake'
import { afterEach, describe, expect, it } from 'vitest'
import { createServer, type Server } from '../src/index.js'

const T0 = '2026-10-07T09:00:00.000Z'
const COMPANY = '深圳卢耶科技有限公司'

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
const replay: PageFetch = async (url) => {
  const name = PAGES[url]
  if (name === undefined) return { ok: false, status: 404, text: async () => '' }
  return { ok: true, status: 200, text: async () => readFileSync(join(FIXTURES, name), 'utf8') }
}

function makeClock(start = T0) {
  let t = Date.parse(start)
  return {
    now: () => {
      t += 1
      return new Date(t).toISOString()
    },
  }
}

function seeded(seed = 11): () => number {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

const servers: Server[] = []
afterEach(async () => {
  for (const s of servers.splice(0)) await s.close()
})

async function boot(dbDir?: string, start?: string): Promise<Server> {
  const server = await createServer({
    ...(dbDir === undefined ? {} : { dbDir }),
    clock: makeClock(start),
    random: seeded(),
    quiet: true,
    startRun: false,
    tokenRefreshIntervalMs: 0,
    scheduleIntervalMs: 0,
    liveDataIntervalMs: 0,
    env: { AGENTSWS_OWNER_EMAIL: 'luoye@example.com', AGENTSWS_WORKSPACE_NAME: 'INMO' },
    mdns: () => ({ reason: '测试里不开局域网' }),
    brandIntakeFetch: replay,
  })
  servers.push(server)
  return server
}

async function shut(server: Server): Promise<void> {
  servers.splice(servers.indexOf(server), 1)
  await server.close()
}

interface Who {
  workspace_id: string
  token: string
  assignment: string
}

async function call<T>(
  server: Server,
  who: Who,
  method: string,
  path: string,
  body?: unknown,
): Promise<{ status: number; data?: T; message?: string }> {
  const headers = new Headers({ 'content-type': 'application/json' })
  headers.set('Authorization', `Bearer ${who.token}`)
  headers.set('X-Assignment', who.assignment)
  const res = await server.gateway.fetch(
    new Request(`http://127.0.0.1${path}`, {
      method,
      headers,
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    }),
  )
  const parsed = (await res.json()) as { data?: T; message?: string }
  return {
    status: res.status,
    ...(parsed.data === undefined ? {} : { data: parsed.data }),
    ...(parsed.message === undefined ? {} : { message: parsed.message }),
  }
}

function inmo(server: Server): Who {
  return {
    workspace_id: server.bootstrap.workspace.id,
    token: server.bootstrap.internalToken,
    assignment: server.bootstrap.ownerAssignment.id,
  }
}

async function orgId(server: Server): Promise<string> {
  const orgs = await call<{ id: string }[]>(server, inmo(server), 'GET', '/v1/orgs')
  const id = orgs.data?.[0]?.id
  if (id === undefined) throw new Error('启动之后应该有一个组织')
  return id
}

/** 切到某个品牌（拿一张绑它的会话票 + 本人在那里的 owner 分配）。 */
async function enter(server: Server, workspace_id: string): Promise<Who> {
  const org = await orgId(server)
  const switched = await call<{ session_token?: string }>(
    server,
    inmo(server),
    'POST',
    `/v1/orgs/${org}/brands/${workspace_id}/switch`,
  )
  expect(switched.status).toBe(200)
  const a = server.roles.assignments
    .listByPerson(server.bootstrap.person.id, { workspace_id })
    .find((x) => x.revoked_at === undefined && x.role_id === 'common.owner')
  if (a === undefined) throw new Error('品牌里应该有一条 owner 分配')
  return { workspace_id, token: switched.data?.session_token ?? '', assignment: a.id }
}

async function addBrand(server: Server, name: string): Promise<Who> {
  const org = await orgId(server)
  const created = await call<{ workspace_id: string }>(
    server,
    inmo(server),
    'POST',
    `/v1/orgs/${org}/brands`,
    { name },
  )
  expect(created.status).toBe(201)
  return enter(server, created.data?.workspace_id ?? '')
}

interface State {
  needs_setup: boolean
  business_done?: true
  added_brand?: true
  brand_name: string
  profile?: {
    legal_name: string
    domain?: string
    discoverable: boolean
    postal_address?: string
    one_liner?: string
  }
}

const state = async (server: Server, who: Who): Promise<State> => {
  const res = await call<State>(server, who, 'GET', '/v1/onboarding/state')
  expect(res.status).toBe(200)
  if (res.data === undefined) throw new Error('state 应该有回执')
  return res.data
}

async function putProfile(server: Server, who: Who, body: Record<string, unknown>): Promise<void> {
  const res = await call(server, who, 'PUT', '/v1/workspace/profile', body)
  expect(res.status, res.message).toBe(200)
}

async function analyzeAndConfirm(server: Server, who: Who): Promise<void> {
  const started = await call<{ id: string }>(server, who, 'POST', '/v1/brand-intake/runs', {
    urls: [`${SHOP}/`],
  })
  expect(started.status).toBe(201)
  const id = started.data?.id ?? ''
  for (let i = 0; i < 200; i++) {
    const run = await call<{ status: string }>(server, who, 'GET', `/v1/brand-intake/runs/${id}`)
    if (run.data?.status !== 'running') break
    await new Promise((r) => setTimeout(r, 5))
  }
  const confirmed = await call(server, who, 'POST', `/v1/brand-intake/runs/${id}/confirm`, {})
  expect(confirmed.status).toBe(200)
}

async function applyCustomerCare(server: Server, who: Who): Promise<void> {
  const applied = await call(server, who, 'POST', '/v1/onboarding/apply', {
    position_ids: [],
    role_ids: [],
    positions: [{ name: '客服', role_ids: ['dtc.support'], template_id: 'customer-care' }],
  })
  expect([200, 201]).toContain(applied.status)
}

const brandText = (server: Server, workspace_id: string): string =>
  server.personas.sections({ role_id: 'dtc.support', workspace_id }).find((s) => s.id === 'brand')
    ?.text ?? ''

describe('WP251 公司全称归公司（设置页「公司」改的是公司）', () => {
  it('在 Rollout 的设置页改公司全称 / 地址：INMO 也是新的；「这个品牌」那几格只改 Rollout', async () => {
    const server = await boot()
    await putProfile(server, inmo(server), { legal_name: 'INMO', brand_name: 'INMO' })
    const rollout = await addBrand(server, 'Rollout')
    await putProfile(server, rollout, {
      legal_name: COMPANY,
      postal_address: '深圳市南山区科技路 8 号',
      one_liner: '户外滑板与配件',
    })

    const r = await state(server, rollout)
    const i = await state(server, inmo(server))
    for (const s of [r, i]) {
      expect(s.profile?.legal_name).toBe(COMPANY)
      expect(s.profile?.postal_address).toBe('深圳市南山区科技路 8 号')
    }
    // 品牌那几格各是各的
    expect(r.profile?.one_liner).toBe('户外滑板与配件')
    expect(i.profile?.one_liner).toBeUndefined()
    expect(r.brand_name).toBe('Rollout')
    expect(i.brand_name).toBe('INMO')
    // 真源是公司
    const org = server.identity.getOrganization(await orgId(server))
    expect(org?.legal_name).toBe(COMPANY)
    expect(org?.postal_address).toBe('深圳市南山区科技路 8 号')
    // 开发信页脚那一格（B2B 读 `brandProfile().postal_address`）两个品牌一样
    expect(server.onboarding.brandProfile(inmo(server).workspace_id as never).postal_address).toBe(
      '深圳市南山区科技路 8 号',
    )

    // 在 INMO 下清掉地址：公司没有地址了，Rollout 也看不到
    await putProfile(server, inmo(server), { legal_name: COMPANY, postal_address: '' })
    expect((await state(server, rollout)).profile?.postal_address).toBeUndefined()
    expect(server.identity.getOrganization(await orgId(server))?.postal_address).toBeUndefined()
  })
})

describe('WP251 AI 上下文（决策 119）', () => {
  it('Rollout 跑 AI 看到「品牌：Rollout」+「公司：深圳卢耶科技有限公司」；INMO 看到自己的品牌名', async () => {
    const server = await boot()
    await putProfile(server, inmo(server), { legal_name: 'INMO', brand_name: 'INMO' })
    // 公司全称与品牌名一样时不重复写「公司：」
    expect(brandText(server, inmo(server).workspace_id)).toContain('品牌：INMO')
    expect(brandText(server, inmo(server).workspace_id)).not.toContain('公司：')

    const rollout = await addBrand(server, 'Rollout')
    await putProfile(server, rollout, { legal_name: COMPANY })
    const r = brandText(server, rollout.workspace_id)
    expect(r).toContain('品牌：Rollout')
    expect(r).toContain(`公司：${COMPANY}`)
    expect(r).not.toContain('品牌：INMO')
    expect(r).not.toContain(`品牌：${COMPANY}`)
    const i = brandText(server, inmo(server).workspace_id)
    expect(i).toContain('品牌：INMO')
    expect(i).toContain(`公司：${COMPANY}`)
  })
})

describe('WP251 加的品牌走完第 ④ 步才算设置完（决策 92）', () => {
  it('②做完、③④没做：回首页仍拉回首次设置（停在第 ③ 步）；走完 ④ 才算完；启动品牌口径不变', async () => {
    const server = await boot()
    await putProfile(server, inmo(server), { legal_name: 'INMO', brand_name: 'INMO' })
    // 启动品牌：第 ① 步存过档案就算设过（口径不变）
    expect((await state(server, inmo(server))).needs_setup).toBe(false)

    const rollout = await addBrand(server, 'Rollout')
    expect((await state(server, rollout)).needs_setup).toBe(true)
    await analyzeAndConfirm(server, rollout)
    const mid = await state(server, rollout)
    expect(mid.needs_setup).toBe(true)
    expect(mid.business_done).toBe(true)
    expect(mid.added_brand).toBe(true)

    await applyCustomerCare(server, rollout)
    expect((await state(server, rollout)).needs_setup).toBe(false)
    expect((await state(server, inmo(server))).needs_setup).toBe(false)
  })
})

/* ------------------------------------------------------------------ */
/* 模拟真机形状的数据目录：迁移前后一条不丢、幂等                          */
/* ------------------------------------------------------------------ */

type Db = {
  prepare(sql: string): {
    run(...a: unknown[]): unknown
    get(...a: unknown[]): unknown
    all(...a: unknown[]): unknown[]
  }
  close(): void
}
const openDb = (path: string): Db =>
  new (createRequire(import.meta.url)('better-sqlite3') as new (p: string) => Db)(path)

/** 数据目录下每个 SQLite 文件每张表的行数（`brands/<ws>/…` 一起算）。 */
function rowCounts(dir: string): Map<string, number> {
  const out = new Map<string, number>()
  const walk = (d: string): void => {
    for (const f of readdirSync(d)) {
      const p = join(d, f)
      if (statSync(p).isDirectory()) {
        walk(p)
        continue
      }
      if (!/\.(sqlite|db)$/.test(f)) continue
      const db = openDb(p)
      try {
        const tables = db
          .prepare(
            "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'",
          )
          .all() as { name: string }[]
        for (const { name } of tables) {
          const row = db.prepare(`SELECT COUNT(*) AS n FROM "${name}"`).get() as { n: number }
          out.set(`${relative(dir, p)}:${name}`, row.n)
        }
      } finally {
        db.close()
      }
    }
  }
  walk(dir)
  return out
}

/** 业务数据（连接、岗位、事项、知识库……）所在的表：迁移前后必须一行不差。 */
const BUSINESS =
  /(roles\.db:assignments|work\.sqlite:(matters|matter_events|todos)|knowledge\.db:|org\.sqlite:|secrets\.sqlite:)/

/** 每个品牌目录里的 connections.json（有就读原文）。 */
function connectionFiles(dir: string): Map<string, string> {
  const out = new Map<string, string>()
  const walk = (d: string): void => {
    for (const f of readdirSync(d)) {
      const p = join(d, f)
      if (statSync(p).isDirectory()) walk(p)
      else if (f === 'connections.json') out.set(relative(dir, p), readFileSync(p, 'utf8'))
    }
  }
  walk(dir)
  return out
}

describe('WP251 启动品牌挂到公司（模拟真机数据目录）', () => {
  /*
   * 两种形状都钉：真机实际是 INMO 一直挂着公司、只是 kind = personal（Fable 10-07 复查）；
   * 另一种是工单最初以为的「没有 org_id」——也要挂得进去。
   */
  it.each([
    ['真机：INMO 挂着公司、kind = personal', true],
    ['INMO 没有 org_id', false],
  ] as const)(
    '%s、各品牌各存一份公司全称 → 升级后以公司为准；一条数据不丢；再启动不再变',
    async (_label, keepOrg) => {
      const dir = mkdtempSync(join(tmpdir(), 'wp251-brandco-'))
      try {
        // ── 上一版的样子：INMO 设过、有岗位 / 事项 / 知识；加 Rollout，也有岗位 / 事项 / 知识
        const first = await boot(dir)
        await analyzeAndConfirm(first, inmo(first))
        await putProfile(first, inmo(first), { legal_name: 'INMO', brand_name: 'INMO' })
        await applyCustomerCare(first, inmo(first))
        const m1 = await call(first, inmo(first), 'POST', '/v1/matters', {
          kind: 'adhoc',
          title: 'INMO 的一件事',
        })
        expect(m1.status).toBe(201)
        const rollout = await addBrand(first, 'Rollout')
        await analyzeAndConfirm(first, rollout)
        await applyCustomerCare(first, rollout)
        const m2 = await call(first, rollout, 'POST', '/v1/matters', {
          kind: 'adhoc',
          title: 'Rollout 的一件事',
        })
        expect(m2.status).toBe(201)
        // Rollout 的设置页改了公司全称（真机就是这么改的）
        await putProfile(first, rollout, { legal_name: COMPANY })
        const INMO = inmo(first).workspace_id
        const ROLLOUT = rollout.workspace_id
        const ORG = await orgId(first)
        await shut(first)

        // ── 把数据目录改成真机那一刻的形状
        {
          const id = openDb(join(dir, 'identity.sqlite'))
          const row = id.prepare('SELECT json FROM workspaces WHERE id = ?').get(INMO) as {
            json: string
          }
          const parsed = JSON.parse(row.json) as Record<string, unknown>
          const { org_id: _o, ...ws } = parsed
          if (keepOrg) ws.org_id = parsed.org_id
          id.prepare('UPDATE workspaces SET json = ? WHERE id = ?').run(
            JSON.stringify({ ...ws, kind: 'personal' }),
            INMO,
          )
          const orgRow = id.prepare('SELECT json FROM organizations WHERE id = ?').get(ORG) as {
            json: string
          }
          const { postal_address: _a, ...org } = JSON.parse(orgRow.json) as Record<string, unknown>
          id.prepare('UPDATE organizations SET json = ? WHERE id = ?').run(JSON.stringify(org), ORG)
          id.close()
          const ob = openDb(join(dir, 'onboarding.sqlite'))
          const mine = ob
            .prepare('SELECT json FROM onboarding_profiles WHERE workspace_id = ?')
            .get(INMO) as { json: string }
          const inmoProfile = {
            ...(JSON.parse(mine.json) as Record<string, unknown>),
            legal_name: 'INMO',
            postal_address: 'INMO 的老地址',
          }
          ob.prepare('UPDATE onboarding_profiles SET json = ? WHERE workspace_id = ?').run(
            JSON.stringify(inmoProfile),
            INMO,
          )
          ob.prepare('UPDATE onboarding_profile SET json = ? WHERE id = 1').run(
            JSON.stringify(inmoProfile),
          )
          // 上一版没有这几样记号
          ob.prepare("DELETE FROM onboarding_migrations WHERE key LIKE 'wp251_%'").run()
          ob.prepare('DELETE FROM onboarding_completed').run()
          ob.close()
        }
        const before = rowCounts(dir)
        const connectionsBefore = connectionFiles(dir)

        // ── 升级后第一次启动
        const second = await boot(dir, '2026-10-08T09:00:00.000Z')
        const inmoWs = await second.identity.getWorkspace(INMO as never)
        expect(inmoWs?.org_id).toBe(ORG)
        expect(inmoWs?.kind).toBe('shared')
        expect((await second.identity.getWorkspace(ROLLOUT as never))?.kind).toBe('shared')
        expect(second.identity.listOrganizations()).toHaveLength(1)
        // 以公司为准：全称是 Rollout 设置页改的那个；公司没有地址 → 从品牌档案搬上来
        const org = second.identity.getOrganization(ORG as never)
        expect(org?.legal_name).toBe(COMPANY)
        expect(org?.postal_address).toBe('INMO 的老地址')
        // 两个品牌读到的公司一样
        const r = await state(second, await enter(second, ROLLOUT))
        const i = await state(second, inmo(second))
        expect(r.profile?.legal_name).toBe(COMPANY)
        expect(i.profile?.legal_name).toBe(COMPANY)
        expect(i.profile?.postal_address).toBe('INMO 的老地址')
        // 存量加的品牌已经有岗位：不被拉回向导
        expect(r.needs_setup).toBe(false)
        expect(i.needs_setup).toBe(false)
        // Rollout 自己没接模型：挂进来之后跟随公司（INMO 成了公司默认品牌）
        expect(second.brands.orgDefaultOf(ROLLOUT as never)).toBe(INMO)
        // AI 上下文
        expect(brandText(second, ROLLOUT)).toContain('品牌：Rollout')
        expect(brandText(second, ROLLOUT)).toContain(`公司：${COMPANY}`)
        await shut(second)

        // 档案里的影子刷成公司的值（老表也是）；迁移前的原样留了一份备份
        {
          const ob = openDb(join(dir, 'onboarding.sqlite'))
          for (const ws of [INMO, ROLLOUT]) {
            const row = ob
              .prepare('SELECT json FROM onboarding_profiles WHERE workspace_id = ?')
              .get(ws) as { json: string }
            expect(JSON.parse(row.json).legal_name).toBe(COMPANY)
          }
          const legacy = ob.prepare('SELECT json FROM onboarding_profile WHERE id = 1').get() as {
            json: string
          }
          expect(JSON.parse(legacy.json).legal_name).toBe(COMPANY)
          const backup = ob
            .prepare(
              "SELECT json FROM onboarding_profiles_backup WHERE key = 'wp251' AND workspace_id = ?",
            )
            .get(INMO) as { json: string }
          expect(JSON.parse(backup.json).legal_name).toBe('INMO')
          expect(JSON.parse(backup.json).postal_address).toBe('INMO 的老地址')
          ob.close()
        }

        // 一条不丢：业务表一行不差，其余的表只多不少（启动会记事件、Rollout 的后台这次起来了）
        const after = rowCounts(dir)
        const businessKeys = [...before.keys()].filter((k) => BUSINESS.test(k))
        expect(businessKeys.length).toBeGreaterThan(5)
        for (const k of businessKeys) expect([k, after.get(k)]).toEqual([k, before.get(k)])
        for (const [k, n] of before) expect([k, (after.get(k) ?? 0) >= n]).toEqual([k, true])
        expect(connectionFiles(dir)).toEqual(connectionsBefore)
        // 两个品牌各自的事项都还在原来的品牌名下（事项库按 workspace_id 分）
        {
          const work = openDb(join(dir, 'work.sqlite'))
          for (const [ws, title] of [
            [INMO, 'INMO 的一件事'],
            [ROLLOUT, 'Rollout 的一件事'],
          ] as const) {
            const titles = (
              work.prepare('SELECT json FROM matters WHERE workspace_id = ?').all(ws) as {
                json: string
              }[]
            ).map((m) => (JSON.parse(m.json) as { title: string }).title)
            expect(titles).toContain(title)
          }
          work.close()
        }

        // ── 再启动一次：什么都不再变（幂等）
        const settled = rowCounts(dir)
        const third = await boot(dir, '2026-10-09T09:00:00.000Z')
        expect(third.identity.listOrganizations()).toHaveLength(1)
        expect((await third.identity.getWorkspace(INMO as never))?.org_id).toBe(ORG)
        expect(third.identity.getOrganization(ORG as never)?.postal_address).toBe('INMO 的老地址')
        await shut(third)
        const again = rowCounts(dir)
        for (const k of [...settled.keys()].filter((key) => BUSINESS.test(key)))
          expect([k, again.get(k)]).toEqual([k, settled.get(k)])
        expect(again.get('onboarding.sqlite:onboarding_profiles_backup')).toBe(
          settled.get('onboarding.sqlite:onboarding_profiles_backup'),
        )
        expect(existsSync(join(dir, 'identity.sqlite'))).toBe(true)
      } finally {
        for (const s of servers.splice(0)) await s.close()
        rmSync(dir, { recursive: true, force: true })
      }
    },
  )
})
