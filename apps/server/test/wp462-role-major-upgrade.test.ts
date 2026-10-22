/**
 * WP462（急修，beta.5 真机）：**老品牌升级上来**——职责升了大版本，首页、左栏、岗位页不许被一条分配拖垮。
 *
 * 现象（Luoye 10-22）：beta.4 → beta.5，首页只剩一行英文 `role dtc.content is at 3.0.0 but assignment …
 * was granted at 2.0.0; re-confirm the assignment`，左栏岗位全空。WP446 把「内容与搜索」2.x 拆成
 * 「内容与博客」3.0.0 +「SEO 与 GEO」，合并时的测试与 e2e 全是新建品牌，没一条从老数据升上来。
 *
 * 这一份就是补那一条：
 *
 * 1. 先用当前代码建一个品牌、建「网站运营」岗位，再把落盘的库**改回 beta.4 的形态**——
 *    内容那条记着 2.0.0、自动化状态里有 SEO 三个动作（采纳率也在）、没有 `dtc.seo` 这条分配、
 *    网站运营岗位行里没有它；SEO / 体检那几条定时照 beta.5 打开过的样子停着（`auto_stopped`）。
 *    另把「邮件营销」那条改成一个**没登记的大版本**（= 放宽权限 / 忘了登记的那一种）。
 * 2. 起**真的服务进程**（`node dist/index.js`，与安装包里同一个入口、同一道升级闸），走 HTTP：
 *    首页、左栏岗位、网站运营岗位页、内容与博客 / SEO 与 GEO 职责页都 200；内容接到 3.0.0、补发了
 *    SEO 与 GEO（采纳率搬过去、安放跟原分配）、定时放开了、事件里有迁移记录；
 *    没登记的那一条只标「要确认」、不拖垮别的，人点了确认才接上，也留痕。
 *
 * 以后任何内置职责再升大版本，`packages/roles/test/major-upgrades.test.ts` 先要求登记；这一份保证登记了的
 * 真能从老数据接上、没登记的也只坏那一条。
 *
 * 跑之前要先 `tsc -b`（门禁本来就先编再测）：起的是编好的 `dist/index.js`。
 * 端口默认让系统挑（0），本机手动跑可以用 `WP462_PORT` 指定。
 */
import { type ChildProcess, spawn } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { Assignment } from '@agentsws/contracts'
import { initialAutomationState, parseRole } from '@agentsws/roles'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createServer } from '../src/index.js'

const ENTRY = fileURLToPath(new URL('../dist/index.js', import.meta.url))
/** beta.4 发出去的那份「内容与搜索」2.0.0（职责包的门禁也用它核"没放宽"）。 */
const BETA4_CONTENT = fileURLToPath(
  new URL(
    '../../../packages/roles/test/fixtures/released-roles/dtc.content@2.yml',
    import.meta.url,
  ),
)
const OWNER = 'owner@example.test'

type Db = {
  prepare(sql: string): {
    run(...a: unknown[]): void
    get(...a: unknown[]): unknown
    all(...a: unknown[]): unknown[]
  }
  close(): void
}
const openDb = (path: string): Db => {
  const Database = createRequire(import.meta.url)('better-sqlite3') as new (p: string) => Db
  return new Database(path)
}

let root = ''
let dataDir = ''
let child: ChildProcess | undefined
let base = ''
let token = ''
let ownerAssignment = ''
let workspaceId = ''
const ids = { content: '', seo: '', email: '', store: '' }

const call = async (
  method: string,
  path: string,
  assignment = ownerAssignment,
): Promise<{ status: number; body: { data?: unknown; message?: string; code?: string } }> => {
  const res = await fetch(`${base}${path}`, {
    method,
    headers: {
      authorization: `Bearer ${token}`,
      'x-assignment': assignment,
      ...(method === 'POST' ? { 'content-type': 'application/json' } : {}),
    },
    ...(method === 'POST' ? { body: '{}' } : {}),
  })
  return {
    status: res.status,
    body: (await res.json().catch(() => ({}))) as { data?: unknown; message?: string },
  }
}
const dataOf = async <T>(method: string, path: string, assignment?: string): Promise<T> => {
  const out = await call(method, path, assignment)
  if (out.status !== 200 && out.status !== 201)
    throw new Error(`${method} ${path} → ${out.status} ${out.body.message ?? ''}`)
  return out.body.data as T
}

/** 起真进程，等它把「health: http://127.0.0.1:<端口>/v1/health」那一行打出来。 */
async function startProcess(): Promise<void> {
  const dsh = join(root, 'dsh')
  mkdirSync(dsh, { recursive: true })
  const proc = spawn(process.execPath, [ENTRY], {
    env: {
      ...(process.env.PATH === undefined ? {} : { PATH: process.env.PATH }),
      ...(process.env.SystemRoot === undefined ? {} : { SystemRoot: process.env.SystemRoot }),
      AGENTSWS_DATA_DIR: dataDir,
      AGENTSWS_PORT: process.env.WP462_PORT ?? '0',
      // 换了版本号 = 走一遍升级闸（先备份、再建服务），与真机升级同一条路
      AGENTSWS_VERSION: '0.2.1-wp462-upgrade-test',
      AGENTSWS_OWNER_EMAIL: OWNER,
      // 一个字节都不出网、不碰本机别处（与 preinstall-smoke 同一套隔离）
      AGENTSWS_CLOUD_BASE_URL: 'http://127.0.0.1:9',
      AGENTSWS_CONNECT_URL: 'http://127.0.0.1:9',
      AGENTSWS_CONTENT_UPDATES: 'off',
      AGENTSWS_DSH_HOME: dsh,
      DSH_HOME: dsh,
      AGENTSWS_DSH_WORKSPACE: join(root, 'workspace'),
      AGENTSWS_APP_DATA_DIR: root,
      AGENTSWS_OFFICIAL_DESKTOP_APP: 'off',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  child = proc
  let out = ''
  base = await new Promise<string>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`服务进程 60 秒没起来：\n${out}`)), 60_000)
    const onData = (chunk: Buffer): void => {
      out += chunk.toString()
      const m = /health: (http:\/\/127\.0\.0\.1:\d+)\/v1\/health/.exec(out)
      if (m?.[1] !== undefined) {
        clearTimeout(timer)
        resolve(m[1])
      }
    }
    proc.stdout?.on('data', onData)
    proc.stderr?.on('data', onData)
    proc.on('exit', (code) => {
      clearTimeout(timer)
      reject(new Error(`服务进程退出了（${String(code)}）：\n${out}`))
    })
  })
}

async function stopProcess(): Promise<void> {
  const proc = child
  child = undefined
  if (proc === undefined || proc.exitCode !== null) return
  await new Promise<void>((resolve) => {
    const timer = setTimeout(() => {
      proc.kill('SIGKILL')
      resolve()
    }, 20_000)
    proc.once('exit', () => {
      clearTimeout(timer)
      resolve()
    })
    proc.kill('SIGTERM')
  })
}

/** 用当前代码建品牌 + 网站运营岗位，再把库改回 beta.4（且被 beta.5 打开过）的样子。 */
async function seedBeta4Brand(): Promise<void> {
  const first = await createServer({
    quiet: true,
    dbDir: dataDir,
    env: { AGENTSWS_OWNER_EMAIL: OWNER, AGENTSWS_CONTENT_UPDATES: 'off' },
    tokenRefreshIntervalMs: 0,
    scheduleIntervalMs: 0,
    startRun: false,
  })
  token = first.bootstrap.internalToken
  ownerAssignment = first.bootstrap.ownerAssignment.id
  workspaceId = first.bootstrap.workspace.id
  const res = await first.gateway.fetch(
    new Request('http://127.0.0.1/v1/onboarding/apply', {
      method: 'POST',
      headers: {
        authorization: `Bearer ${token}`,
        'x-assignment': ownerAssignment,
        'content-type': 'application/json',
      },
      body: JSON.stringify({ position_ids: ['web-ops'], role_ids: [] }),
    }),
  )
  expect(res.status).toBe(201)
  // 分配一变，定时在后台即时对一遍：等 SEO 那两条建出来
  for (let i = 0; i < 100 && first.schedule.scheduler.get('sched_seo_daily') === undefined; i++)
    await new Promise((r) => setTimeout(r, 50))
  expect(first.schedule.scheduler.get('sched_seo_daily')).toBeDefined()
  const mine = first.roles.assignments.listByPerson(first.bootstrap.person.id, {
    workspace_id: workspaceId,
  })
  const idOf = (role: string): string => mine.find((a) => a.role_id === role)?.id ?? ''
  ids.content = idOf('dtc.content')
  ids.seo = idOf('dtc.seo')
  ids.email = idOf('dtc.email-marketing')
  ids.store = idOf('dtc.store')
  expect(Object.values(ids).every((x) => x !== '')).toBe(true)
  await first.close()

  // ── roles.db：内容那条记回 2.0.0、带 beta.4 的自动化状态；beta.4 没有 `dtc.seo` ──
  const roles = openDb(join(dataDir, 'roles.db'))
  const docOf = (id: string): Assignment =>
    JSON.parse(
      (roles.prepare('SELECT doc FROM assignments WHERE id = ?').get(id) as { doc: string }).doc,
    )
  const old = parseRole(readFileSync(BETA4_CONTENT, 'utf8'), 'beta.4')
  const content = docOf(ids.content)
  const state = initialAutomationState(old, content.granted_at)
  const seoEdit = state.stage_page_seo_edit
  if (seoEdit !== undefined) seoEdit.adoption = { ...seoEdit.adoption, accepted: 3, edited: 1 }
  const put = (doc: Assignment): void => {
    roles.prepare('UPDATE assignments SET doc = ? WHERE id = ?').run(JSON.stringify(doc), doc.id)
  }
  put({ ...content, role_version: '2.0.0', automation_state: state })
  roles.prepare('DELETE FROM assignments WHERE id = ?').run(ids.seo)
  // 「放宽权限 / 没登记」的那一种：邮件营销记着一个对不上的大版本
  put({ ...docOf(ids.email), role_version: '0.9.0' })
  roles.close()

  // ── org.sqlite：beta.4 的网站运营岗位行里没有 SEO 与 GEO；内容那条安放在网站运营 ──
  const org = openDb(join(dataDir, 'org.sqlite'))
  const row = org.prepare("SELECT json FROM org_positions WHERE id = 'web-ops'").get() as {
    json: string
  }
  const position = JSON.parse(row.json) as { roles: { role: string }[]; major_splits?: string[] }
  position.roles = position.roles.filter((r) => r.role !== 'dtc.seo')
  delete position.major_splits
  org
    .prepare("UPDATE org_positions SET json = ? WHERE id = 'web-ops'")
    .run(JSON.stringify(position))
  org.prepare('DELETE FROM org_placements WHERE assignment_id = ?').run(ids.seo)
  org
    .prepare('INSERT OR REPLACE INTO org_placements (assignment_id, position_id) VALUES (?, ?)')
    .run(ids.content, 'web-ops')
  org.close()

  // ── schedule.sqlite：beta.5 打开过——没人担 SEO 与 GEO，那两条被自动停了（带记号） ──
  const sched = openDb(join(dataDir, 'schedule.sqlite'))
  for (const id of ['sched_seo_daily', 'sched_seo_weekly']) {
    const t = sched.prepare('SELECT json FROM tasks WHERE id = ?').get(id) as { json: string }
    const task = JSON.parse(t.json) as { state: string; params?: Record<string, unknown> }
    task.state = 'paused'
    task.params = { ...(task.params ?? {}), auto_stopped: 'role_released' }
    sched
      .prepare('UPDATE tasks SET state = ?, json = ? WHERE id = ?')
      .run('paused', JSON.stringify(task), id)
  }
  sched.close()
}

beforeAll(async () => {
  if (!existsSync(ENTRY))
    throw new Error(`没有 ${ENTRY}：先 \`pnpm exec tsc -b\`（这一条起的是编好的服务进程）`)
  root = mkdtempSync(join(tmpdir(), 'agentsws-wp462-'))
  dataDir = join(root, 'data')
  mkdirSync(dataDir)
  await seedBeta4Brand()
  await startProcess()
  // 补发那条的 id 是新进程启动时派生的：先认出来，后面几条都用它
  const mine = await dataOf<Assignment[]>('GET', '/v1/assignments')
  ids.seo = mine.find((a) => a.role_id === 'dtc.seo' && a.revoked_at === undefined)?.id ?? ''
}, 180_000)

afterAll(async () => {
  await stopProcess()
  if (root !== '') rmSync(root, { recursive: true, force: true })
}, 60_000)

interface PositionsView {
  positions: {
    position_id: string
    role_id: string
    ready: boolean
    needs_reconfirm?: { role_id: string; role_name: string; from: string; to: string }
  }[]
  instances?: { position_id: string; roles?: { role_id: string }[] }[]
}

describe('WP462 老品牌从 beta.4 升上来（真服务进程）', () => {
  it('首页、左栏岗位都 200；只标出没登记的那一条，别的照常', async () => {
    const view = await dataOf<PositionsView>('GET', '/v1/positions')
    const byRole = new Map(view.positions.map((p) => [p.role_id, p]))
    for (const role of ['dtc.store', 'dtc.content', 'dtc.seo', 'dtc.fulfillment'])
      expect(byRole.get(role)?.needs_reconfirm, role).toBeUndefined()
    expect(byRole.get('dtc.email-marketing')?.needs_reconfirm).toMatchObject({
      role_id: 'dtc.email-marketing',
      role_name: '邮件营销',
      from: '0.9.0',
    })
    expect(byRole.get('dtc.email-marketing')?.ready).toBe(false)
    const webOps = view.instances?.find((i) => i.position_id === 'web-ops')
    expect(webOps?.roles?.map((r) => r.role_id)).toEqual(
      expect.arrayContaining(['dtc.content', 'dtc.seo']),
    )
    expect((await call('GET', '/v1/home?range=yesterday')).status).toBe(200)
    expect((await call('GET', '/v1/me')).status).toBe(200)
  })

  it('网站运营岗位页、内容与博客 / SEO 与 GEO 职责页都打得开', async () => {
    for (const path of ['/v1/positions/web-ops', '/v1/positions/web-ops/work'])
      expect((await call('GET', path)).status, path).toBe(200)
    for (const id of [ids.content, ids.seo]) {
      for (const path of [
        `/v1/positions/${id}`,
        `/v1/positions/${id}/cards`,
        `/v1/positions/${id}/summary`,
        `/v1/positions/${id}/view?range=yesterday`,
        `/v1/assignments/${id}/effective`,
      ])
        expect((await call('GET', path, id)).status, path).toBe(200)
    }
  })

  it('内容接到当前版本（3.1.0，WP449 小版本）；同一个人补发了 SEO 与 GEO（采纳率搬过去、跟原分配安放在同一个岗位）', async () => {
    const mine = await dataOf<Assignment[]>('GET', '/v1/assignments')
    const content = mine.find((a) => a.id === ids.content)
    expect(content?.role_version).toBe('3.1.0')
    expect(Object.keys(content?.automation_state ?? {}).sort()).toEqual([
      'stage_listing_edit',
      'stage_publish_post',
    ])
    const seo = mine.filter((a) => a.role_id === 'dtc.seo' && a.revoked_at === undefined)
    expect(seo).toHaveLength(1)
    expect(seo[0]?.id).toBe(ids.seo)
    expect(seo[0]?.role_version).toBe('1.0.0')
    expect(seo[0]?.automation_state.stage_page_seo_edit?.adoption).toMatchObject({
      accepted: 3,
      edited: 1,
    })
    const effective = await dataOf<{ actions: { id: string }[] }>(
      'GET',
      `/v1/assignments/${ids.seo}/effective`,
      ids.seo,
    )
    expect(effective.actions.map((a) => a.id)).toEqual([
      'stage_page_seo_edit',
      'stage_page_section_add',
      'stage_internal_link_edit',
    ])
  })

  it('SEO 那两条被 beta.5 停掉的定时放开了', async () => {
    const tasks = await dataOf<{ id: string; state: string; params?: Record<string, unknown> }[]>(
      'GET',
      '/v1/schedules',
    )
    for (const id of ['sched_seo_daily', 'sched_seo_weekly']) {
      const t = tasks.find((x) => x.id === id)
      expect(t?.state, id).toBe('active')
      expect(t?.params?.auto_stopped, id).toBeUndefined()
    }
  })

  it('事件里有迁移记录（就地重确认 + 拆分补发，自动）', async () => {
    const out = await dataOf<{ events: { type: string; payload: Record<string, unknown> }[] }>(
      'GET',
      '/v1/events?types=assignment.role_major_upgraded&limit=500',
    )
    const rows = out.events
      .filter((e) => e.type === 'assignment.role_major_upgraded')
      .map((e) => e.payload)
    expect(rows).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          assignment_id: ids.content,
          role_id: 'dtc.content',
          kind: 'reconfirmed',
          from: '2.0.0',
          to: '3.1.0',
          via: 'auto',
          reason: 'wp446',
        }),
        expect.objectContaining({
          assignment_id: ids.seo,
          role_id: 'dtc.seo',
          kind: 'heir_granted',
          from: 'dtc.content@2.0.0',
          heir_of: ids.content,
          via: 'auto',
        }),
      ]),
    )
  })

  it('没登记的那一条：自己的页说人话；点了确认才接上、留痕，之后照常', async () => {
    const before = await call('GET', `/v1/assignments/${ids.email}/effective`, ids.email)
    expect(before.status).toBe(409)
    expect(before.body.message).toBe('「邮件营销」这条职责升级了，点一下确认就能接着用')
    // 它自己的岗位卡片页也不 500：标着要确认
    const cards = await dataOf<{ position: { needs_reconfirm?: unknown } }>(
      'GET',
      `/v1/positions/${ids.email}/cards`,
      ids.email,
    )
    expect(cards.position.needs_reconfirm).toBeDefined()

    const done = await dataOf<{ to: string }>(
      'POST',
      `/v1/assignments/${ids.email}/reconfirm`,
      ids.email,
    )
    expect(done.to).toMatch(/^1\./)
    expect((await call('GET', `/v1/assignments/${ids.email}/effective`, ids.email)).status).toBe(
      200,
    )
    const view = await dataOf<PositionsView>('GET', '/v1/positions')
    expect(view.positions.every((p) => p.needs_reconfirm === undefined)).toBe(true)
    const out = await dataOf<{ events: { type: string; payload: Record<string, unknown> }[] }>(
      'GET',
      '/v1/events?types=assignment.role_major_upgraded&limit=500',
    )
    expect(out.events.map((e) => e.payload)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ assignment_id: ids.email, via: 'person', from: '0.9.0' }),
      ]),
    )
    // 别人的分配不能替他点
    expect((await call('POST', `/v1/assignments/asg_nobody/reconfirm`, ids.email)).status).toBe(404)
  })

  it('岗位行补上 SEO 与 GEO、补发那条安放在网站运营（停进程后看库）', async () => {
    await stopProcess()
    const org = openDb(join(dataDir, 'org.sqlite'))
    const row = org.prepare("SELECT json FROM org_positions WHERE id = 'web-ops'").get() as {
      json: string
    }
    const position = JSON.parse(row.json) as { roles: { role: string; default?: boolean }[] }
    const roles = position.roles.map((r) => r.role)
    expect(roles.indexOf('dtc.seo')).toBe(roles.indexOf('dtc.content') + 1)
    expect(position.roles.find((r) => r.role === 'dtc.seo')?.default).toBe(true)
    const placed = org
      .prepare('SELECT position_id FROM org_placements WHERE assignment_id = ?')
      .get(ids.seo) as { position_id: string } | undefined
    expect(placed?.position_id).toBe('web-ops')
    org.close()
  })
})
