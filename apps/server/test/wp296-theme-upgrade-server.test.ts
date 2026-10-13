/**
 * WP296 端到端（真装配线：路由 → 运行时（stub）→ 主题工坊 → 审批总线 → 决定钩子）。
 *
 * 同一个数据目录起两次服务进程：第一次钉旧版（像 v0.9.2）起底搭首页，第二次钉新版（像 v0.10.0）再干活——
 * 钉住：运行里照实说一句、只出一张「升级到 vX（会跑迁移）」卡、**不自动改**；人在卡上点了批准才升，
 * 事项时间线上记一句。起底包是这里现造的假包，`shopify` 是进程内替身；不联网、不碰真店。
 */
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { ApprovalItem, Assignment } from '@agentsws/contracts'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createServer, type Server } from '../src/index.js'
import type { ProbeExec } from '../src/platform-cli.js'
import { FAKE_THEME_FILES, fakeThemeBase, themeCliStandIn } from '../src/site-theme-stand-in.js'

const SHOP = '6suegp-md.myshopify.com'
const OLD = fakeThemeBase(
  { ...FAKE_THEME_FILES, 'AGENTS.md': '# old\n' },
  { version: '0.9.2', commit: `${'9'.repeat(39)}2` },
)
const NEW = fakeThemeBase(
  {
    ...FAKE_THEME_FILES,
    'AGENTS.md': '# new\n',
    'scripts/migrate-blocks.mjs': "console.log('Nothing to migrate.')\n",
  },
  { version: '0.10.0', commit: `${'a'.repeat(39)}0` },
)

let dir: string
let server: Server | undefined
let now = '2026-10-13T09:00:00.000Z'

async function boot(
  base: typeof OLD,
  seed: number,
): Promise<{ server: Server; theme: Assignment }> {
  const fake = themeCliStandIn()
  const exec: ProbeExec = async (bin) =>
    bin === 'node'
      ? { ok: true, stdout: 'v22.12.0' }
      : { ok: true, stdout: 'Current Shopify CLI version: 4.8.5' }
  const s = await createServer({
    quiet: true,
    clock: { now: () => now },
    // 两次起在同一个库上：随机数各走各的（事件 id 不撞）
    random: (() => {
      let x = seed
      return () => {
        x = (x * 9301 + 49297) % 233280
        return x / 233280
      }
    })(),
    scheduleIntervalMs: 0,
    tokenRefreshIntervalMs: 0,
    mdns: () => ({ mdns: { publish() {}, browse() {}, stop() {} } }),
    env: { AGENTSWS_OWNER_EMAIL: 'owner@example.test' },
    dbDir: dir,
    platformCliExec: exec,
    siteTheme: { run: fake.run, fetch: base.fetch, base: base.pin },
  })
  const ws = s.bootstrap.workspace.id
  const theme =
    s.roles.assignments.listByWorkspace(ws, {}).find((a) => a.role_id === 'site.shopify-theme') ??
    s.roles.assignments.create({
      person_id: s.bootstrap.person.id,
      workspace_id: ws,
      role_id: 'site.shopify-theme',
      granted_by: s.bootstrap.person.id,
      ranges: [{ kind: 'brand', id: ws }],
    })
  return { server: s, theme }
}

const call = async (
  s: Server,
  as: string,
  method: string,
  path: string,
  body?: unknown,
): Promise<{ status: number; data: unknown }> => {
  const headers = new Headers({ Authorization: `Bearer ${s.bootstrap.internalToken}` })
  headers.set('X-Assignment', as)
  if (body !== undefined) headers.set('content-type', 'application/json')
  const res = await s.gateway.fetch(
    new Request(`http://127.0.0.1${path}`, {
      method,
      headers,
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    }),
  )
  const parsed = (await res.json()) as { data?: unknown }
  if (parsed.data === undefined)
    throw new Error(`${method} ${path} → ${res.status} ${JSON.stringify(parsed)}`)
  return { status: res.status, data: parsed.data }
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'wp296-server-'))
})
afterEach(async () => {
  await server?.close()
  server = undefined
  rmSync(dir, { recursive: true, force: true })
})

describe('WP296 旧版工作目录端到端', () => {
  it('新钉子下再干活：照实说 + 一张升级卡、不自动改；人批了才升，时间线记一句', async () => {
    // ① 旧版起底搭首页
    const a = await boot(OLD, 1)
    server = a.server
    const owner = a.server.bootstrap.ownerAssignment.id
    await call(a.server, owner, 'PUT', '/v1/workspace/profile', {
      legal_name: 'Rollout',
      storefront_platform: 'shopify',
    })
    await call(a.server, a.theme.id, 'GET', '/v1/site/theme?fresh=1')
    await call(a.server, a.theme.id, 'PUT', '/v1/platform-kit/cli/login', { confirmed: true })
    await call(a.server, a.theme.id, 'PUT', '/v1/site/theme/store', { store: SHOP })
    await call(a.server, a.theme.id, 'POST', `/v1/positions/${a.theme.id}/matters`, {
      title: '用 agentsws-theme 给我搭个首页',
      role_id: 'site.shopify-theme',
    })
    const view0 = (await call(a.server, a.theme.id, 'GET', '/v1/site/theme')).data as {
      workspace: { base?: { version: string } }
    }
    expect(view0.workspace.base?.version).toBe('0.9.2')
    await a.server.close()
    server = undefined

    // ② 新钉子：再让它改首页 → 回话照实说、出一张升级卡，工作目录不动
    now = '2026-10-13T10:00:00.000Z'
    const b = await boot(NEW, 7)
    server = b.server
    await call(b.server, b.theme.id, 'GET', '/v1/site/theme?fresh=1')
    await call(b.server, b.theme.id, 'PUT', '/v1/platform-kit/cli/login', { confirmed: true })
    const out = (
      await call(b.server, b.theme.id, 'POST', `/v1/positions/${b.theme.id}/matters`, {
        title: '首页再改一版出预览',
        role_id: 'site.shopify-theme',
      })
    ).data as { matter: { id: string } }
    const matter = (await call(b.server, b.theme.id, 'GET', `/v1/matters/${out.matter.id}`))
      .data as { timeline: { kind: string; text: string }[] }
    const reply = matter.timeline.find((e) => e.kind === 'agent_message')?.text ?? ''
    expect(reply).toContain('这份主题是 v0.9.2，新版 v0.10.0 要迁移')
    expect(reply).toContain('升级到 v0.10.0（会跑迁移）')
    const cards = (
      await b.server.txn.approvals.queue({
        workspace_id: b.server.bootstrap.workspace.id,
        person_id: b.server.bootstrap.person.id,
        lane: 'mine',
      })
    ).filter((c: ApprovalItem) => c.kind === 'upstream_upgrade')
    expect(cards).toHaveLength(1)
    const card = cards[0] as ApprovalItem
    expect(card.title).toBe('升级到 v0.10.0（会跑迁移）')
    expect(card.subject.matter_id).toBe(out.matter.id)
    expect(NEW.urls).toEqual([])
    const root = join(dir, 'themes', b.server.bootstrap.workspace.id, SHOP)
    expect(readFileSync(join(root, 'AGENTS.md'), 'utf8')).toBe('# old\n')

    // ③ 人在卡上点批准 → 升；时间线一句人话；起底版本记成新版
    const decided = await call(b.server, b.theme.id, 'POST', `/v1/approvals/${card.id}/decide`, {
      action: 'approve',
    })
    expect(decided.status).toBe(200)
    expect(readFileSync(join(root, 'AGENTS.md'), 'utf8')).toBe('# new\n')
    const after = (await call(b.server, b.theme.id, 'GET', '/v1/site/theme')).data as {
      workspace: { base?: { version: string } }
    }
    expect(after.workspace.base?.version).toBe('0.10.0')
    const timeline = (
      (await call(b.server, b.theme.id, 'GET', `/v1/matters/${out.matter.id}`)).data as {
        timeline: { text: string }[]
      }
    ).timeline
    expect(timeline.some((e) => e.text.startsWith('主题升到 v0.10.0 了'))).toBe(true)
  })
})
