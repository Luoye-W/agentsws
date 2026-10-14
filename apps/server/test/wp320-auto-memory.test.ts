/**
 * WP320：AI 随工作自动记 + 记忆账本 + 「自动记忆」开关 + 删了就不再进上下文。
 *
 * 前半段是纯函数（标记、「记住」、「以后…」、过滤、候选合并）；后半段走真装配线
 * （`createServer` → `autoMemory` → `learning` → 技能库 → `/v1/memory*` 路由），不打桩。
 */
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  askedToRemember,
  cueSentences,
  memoryCandidatesOf,
  screenMemoryText,
  splitRememberTags,
} from '../src/auto-memory.js'
import { createServer, type Server } from '../src/index.js'

describe('WP320 纯函数', () => {
  it('<remember> 从正文里拿掉，层与类认得出', () => {
    const out = splitRememberTags(
      '好了，已经回了。\n<remember>回复美国客户一律用英文</remember>\n<remember layer="brand" kind="fact">品牌只卖正版授权</remember>',
    )
    expect(out.text).toBe('好了，已经回了。')
    expect(out.items).toEqual([
      { text: '回复美国客户一律用英文' },
      { text: '品牌只卖正版授权', layer: 'brand', kind: 'fact' },
    ])
    expect(splitRememberTags('没有标记').items).toEqual([])
  })

  it('「记住…」取后面那一截；「别记住」「记住了吗」不算', () => {
    expect(askedToRemember('帮我回一下这封信。记住：退货一律先查物流。')).toEqual([
      '退货一律先查物流',
    ])
    expect(askedToRemember('Remember that we never ship on Sundays')).toEqual([
      'we never ship on Sundays',
    ])
    expect(askedToRemember('你记住了吗')).toEqual([])
  })

  it('「以后 / 别再…」那几句是保底候选；带「记住」的不重复', () => {
    expect(cueSentences('这样回可以。以后别再用感叹号了。')).toEqual([
      { text: '以后别再用感叹号了', reason: 'correction' },
    ])
    expect(cueSentences('记住，以后都先道歉')).toEqual([])
  })

  it('过滤：秘密 / 账号 / 一次性的不记；人明说的一次性也记', () => {
    expect(screenMemoryText('店铺后台密码是 abc123').ok).toBe(false)
    expect(screenMemoryText('客服邮箱 a@b.com 一律抄送')).toEqual({ ok: false, reason: 'secret' })
    expect(screenMemoryText('这单先退款')).toEqual({ ok: false, reason: 'one_off' })
    expect(screenMemoryText('这单先退款', { asked: true }).ok).toBe(true)
    expect(screenMemoryText('好的')).toEqual({ ok: false, reason: 'too_short' })
  })

  it('开关关了：只留人明说的；模型写的只在人这次也说了「记住」时才算', () => {
    const items = [{ text: '回复美国客户一律用英文' }]
    expect(memoryCandidatesOf({ brief: '回一下', items, auto: false })).toEqual([])
    expect(
      memoryCandidatesOf({ brief: '回一下。以后别再用感叹号了', items, auto: true }).map(
        (c) => c.reason,
      ),
    ).toEqual(['preference', 'correction'])
    const asked = memoryCandidatesOf({ brief: '记住这个', items, auto: false })
    expect(asked.map((c) => [c.text, c.asked])).toEqual([['回复美国客户一律用英文', true]])
  })
})

const T0 = '2026-10-14T01:00:00.000Z'
function makeClock() {
  let t = Date.parse(T0)
  return {
    now: () => {
      t += 1000
      return new Date(t).toISOString()
    },
  }
}
function seeded(seed = 320): () => number {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

let server: Server
let dataDir: string | undefined
const ROLE = 'dtc.store'
const POSITION = 'web-ops'

async function boot(dbDir?: string): Promise<Server> {
  const s = await createServer({
    clock: makeClock(),
    random: seeded(),
    quiet: true,
    tokenRefreshIntervalMs: 0,
    scheduleIntervalMs: 0,
    ...(dbDir === undefined ? {} : { dbDir }),
  })
  if (
    s.roles.assignments
      .listByPerson(s.bootstrap.person.id, { workspace_id: s.bootstrap.workspace.id })
      .every((a) => a.role_id !== ROLE || a.revoked_at !== undefined)
  )
    s.roles.assignments.create({
      person_id: s.bootstrap.person.id,
      workspace_id: s.bootstrap.workspace.id,
      role_id: ROLE,
      granted_by: s.bootstrap.person.id,
      ranges: [{ kind: 'store', id: 'store_1' }],
    })
  return s
}

const call = async (method: string, path: string, body?: unknown): Promise<Response> => {
  const headers = new Headers()
  headers.set('Authorization', `Bearer ${server.bootstrap.internalToken}`)
  headers.set('X-Assignment', server.bootstrap.ownerAssignment.id)
  if (body !== undefined) headers.set('content-type', 'application/json')
  return server.gateway.fetch(
    new Request(`http://127.0.0.1${path}`, {
      method,
      headers,
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    }),
  )
}
const dataOf = async <T>(res: Response): Promise<T> => {
  const parsed = (await res.json()) as { data?: unknown; code?: string; message?: string }
  if (parsed.data === undefined) throw new Error(`没有 data：${parsed.code} ${parsed.message}`)
  return parsed.data as T
}

interface Entry {
  id: string
  body: string
  written_by?: string
  run_id?: string
  matter_id?: string
  reason?: string
}
const positionMemory = async (): Promise<Entry[]> =>
  (
    await dataOf<{ entries: Entry[] }>(
      await call('GET', `/v1/memory?tier=position&scope_id=${POSITION}`),
    )
  ).entries

const actor = () => ({
  person_id: server.bootstrap.person.id,
  workspace_id: server.bootstrap.workspace.id,
  position_id: POSITION,
  role_id: ROLE,
})

const run = (brief: string, items: { text: string; layer?: 'brand' }[] = [], n = 1) =>
  server.autoMemory.afterRun({
    run_id: `run_${n}`,
    matter_id: `mat_${n}`,
    actor: actor(),
    brief,
    items,
  })

beforeEach(async () => {
  dataDir = undefined
  server = await boot()
})
afterEach(async () => {
  await server.close()
  if (dataDir !== undefined) rmSync(dataDir, { recursive: true, force: true })
})

describe('WP320 自动写入点 + 事件 + 账本', () => {
  it('人说「记住」→ 记进岗位层，带来源；事件一条（谁、哪层、哪条、为什么，不带正文）', async () => {
    const out = await run('帮我回这封。记住：回复美国客户一律用英文。')
    expect(out.written).toHaveLength(1)
    const entries = await positionMemory()
    const hit = entries.find((e) => e.body === '回复美国客户一律用英文')
    expect(hit).toMatchObject({
      written_by: 'ai',
      run_id: 'run_1',
      matter_id: 'mat_1',
      reason: 'asked',
    })
    const events = server.kernel.eventLog
      .readSync({ workspace_id: server.bootstrap.workspace.id })
      .filter((e) => e.type === 'memory.added')
    const last = events[events.length - 1]
    expect(last?.actor.kind).toBe('agent')
    expect(last?.actor.run_id).toBe('run_1')
    expect(last?.payload).toMatchObject({
      entry_id: hit?.id,
      tier: 'position',
      scope_id: POSITION,
      by: server.bootstrap.person.id,
      written_by: 'ai',
      reason: 'asked',
    })
    expect(JSON.stringify(last?.payload)).not.toContain('英文')
    const changes = await dataOf<{ kind: string; text: string; entry_id: string }[]>(
      await call('GET', '/v1/memory/changes?written_by=ai'),
    )
    expect(changes.map((c) => [c.kind, c.text])).toEqual([['added', '回复美国客户一律用英文']])
  })

  it('模型写的 <remember> 也记；一样的不记第二遍；很像 AI 记过的就并进去', async () => {
    await run('回一下', [{ text: '回复美国客户一律用英文' }], 1)
    const again = await run('回一下', [{ text: '回复美国客户一律用英文' }], 2)
    expect(again.skipped.map((s) => s.reason)).toEqual(['duplicate'])
    const merged = await run('回一下', [{ text: '回复美国客户一律用英文，签名用 Rollout Team' }], 3)
    expect(merged.merged).toHaveLength(1)
    const entries = (await positionMemory()).filter((e) => e.written_by === 'ai')
    expect(entries.map((e) => e.body)).toEqual(['回复美国客户一律用英文，签名用 Rollout Team'])
    expect(entries[0]?.run_id).toBe('run_3')
    const kinds = server.kernel.eventLog
      .readSync({ workspace_id: server.bootstrap.workspace.id })
      .filter((e) => e.type.startsWith('memory.'))
      .map((e) => e.type)
    expect(kinds).toEqual(['memory.added', 'memory.merged'])
  })

  it('人写的那条很像：不替人改字', async () => {
    await call('POST', '/v1/memory', {
      tier: 'position',
      scope_id: POSITION,
      text: '回复美国客户一律用英文',
    })
    const out = await run('回一下', [{ text: '回复美国客户一律用英文和美元价格' }])
    expect(out.skipped.map((s) => s.reason)).toEqual(['similar_to_human'])
  })

  it('密钥 / 账号 / 一次性的不记；一次最多 3 条', async () => {
    const out = await run('回一下', [
      { text: '后台账号是 admin' },
      { text: '这单先退款' },
      { text: '退货一律先查物流' },
      { text: '回复先道歉再说原因' },
      { text: '报价一律用美元' },
      { text: '周末不发货要提前告知' },
    ])
    expect(out.written).toHaveLength(3)
    expect(out.skipped.map((s) => s.reason)).toEqual(['sensitive', 'one_off', 'per_run_cap'])
  })
})

describe('WP320 删了就不再进上下文 + 墓碑 + 开关', () => {
  it('删掉 → 下一次运行的「记忆」那一段里没有它；AI 不再记回来，人明说就再记', async () => {
    await run('回一下', [{ text: '退货一律先查物流' }], 1)
    const before = server.autoMemory.section(actor(), [])
    expect(before.text).toContain('退货一律先查物流')
    const id = (await positionMemory()).find((e) => e.body === '退货一律先查物流')?.id ?? ''
    expect((await call('DELETE', `/v1/memory/${encodeURIComponent(id)}`)).status).toBe(200)
    expect(server.autoMemory.section(actor(), []).text).not.toContain('退货一律先查物流')
    const back = await run('回一下', [{ text: '退货一律先查物流' }], 2)
    expect(back.skipped.map((s) => s.reason)).toEqual(['deleted_before'])
    const asked = await run('记住：退货一律先查物流', [], 3)
    expect(asked.written).toHaveLength(1)
  })

  it('技能正文里已有的不在「记忆」那一段重复列', async () => {
    await run('回一下', [{ text: '退货一律先查物流' }])
    expect(server.autoMemory.section(actor(), ['customer-care']).text).not.toContain(
      '退货一律先查物流',
    )
  })

  it('关掉「自动记忆」：模型自己想记的不记，人明说的照记；规矩那一句也换成「只在明说时」', async () => {
    expect(
      await dataOf<{ enabled: boolean }>(await call('GET', '/v1/settings/auto-memory')),
    ).toEqual({ enabled: true })
    await call('PUT', '/v1/settings/auto-memory', { enabled: false })
    expect(server.autoMemory.section(actor(), []).text).toContain('只有用户明确说')
    const quiet = await run('回一下。以后别再用感叹号了', [{ text: '报价一律用美元' }], 1)
    expect(quiet.written).toHaveLength(0)
    const asked = await run('记住：报价一律用美元', [], 2)
    expect(asked.written.map((e) => e.body)).toEqual(['报价一律用美元'])
  })
})

describe('WP320 记忆落盘', () => {
  it('重启之后记忆、来源、墓碑都还在', async () => {
    await server.close()
    dataDir = mkdtempSync(join(tmpdir(), 'wp320-'))
    server = await boot(dataDir)
    await run('回一下', [{ text: '退货一律先查物流' }, { text: '报价一律用美元' }], 1)
    const gone = (await positionMemory()).find((e) => e.body === '报价一律用美元')?.id ?? ''
    await call('DELETE', `/v1/memory/${encodeURIComponent(gone)}`)
    await server.close()
    server = await boot(dataDir)
    const entries = await positionMemory()
    expect(entries.find((e) => e.body === '退货一律先查物流')).toMatchObject({
      written_by: 'ai',
      run_id: 'run_1',
    })
    expect(entries.some((e) => e.body === '报价一律用美元')).toBe(false)
    const back = await run('回一下', [{ text: '报价一律用美元' }], 2)
    expect(back.skipped.map((s) => s.reason)).toEqual(['deleted_before'])
  })
})
