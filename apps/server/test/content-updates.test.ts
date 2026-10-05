/**
 * WP219（docs/90 §6）：用户端内容更新——全部用**本地替身更新源**（内存里的 fetch），不联网。
 *
 * 钉住：签名对 / 不对、哈希不对整包拒收、最低版本不够、自动 / 每次问我、合并无冲突 / 有冲突、
 * 退回、只落启用品牌、可疑指令命中不自动更新、主源不通走镜像。密钥对每次现生成。
 */
import { generateKeyPairSync } from 'node:crypto'
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type {
  ApprovalItem,
  ContentPublicKey,
  DecideInput,
  StorefrontPlatform,
} from '@agentsws/contracts'
import {
  type BuiltContentPack,
  buildContentPack,
  type ContentItemMeta,
  contentPublicKeyOf,
  createSkills,
  seedBundledSkills,
} from '@agentsws/skills'
import { describe, expect, it } from 'vitest'
import {
  type ContentFetch,
  contentFeedSources,
  createContentUpdates,
} from '../src/content-updates.js'

const tmp = (p: string): string => mkdtempSync(join(tmpdir(), `wp219-${p}-`))
const key = (): string =>
  generateKeyPairSync('ed25519').privateKey.export({ format: 'pem', type: 'pkcs8' }).toString()

const SKILL = (name: string, version: string, rules: string, extra = ''): string =>
  `---\nname: ${name}\ndescription: 测试技能\nversion: ${version}\n---\n\n## 你做什么\n\n写草稿。\n\n## 规矩\n\n${rules}\n${extra}`

function writeSkill(root: string, name: string, md: string): string {
  const dir = join(root, name)
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'SKILL.md'), md)
  return dir
}

function meta(
  name: string,
  version: string,
  extra: Partial<ContentItemMeta> = {},
): ContentItemMeta {
  return {
    id: `skill:${name}`,
    kind: 'skill',
    name,
    version,
    title: { zh: `${name} 官方技能`, en: `${name} official` },
    summary: { zh: '规矩那段改了一句', en: 'One rule changed' },
    upstream: {
      id: 'up',
      repo: 'example/skills',
      commit: 'b'.repeat(40),
      published_at: '2026-10-01',
      license: 'MIT',
    },
    review: {
      reviewer: 'Fable',
      reviewed_at: '2026-10-04',
      license_before: 'MIT',
      license_after: 'MIT',
      scan_hits: 0,
      scan_rules: [],
      notes_ok: true,
      tests_ok: true,
    },
    ...extra,
  }
}

/** 本地替身更新源：主源与镜像各一份（内存），可以把某个文件改坏、让某个源不通。 */
function standInFeed(
  pack: BuiltContentPack,
  opts: { primaryDown?: boolean; corrupt?: string } = {},
) {
  const sources = contentFeedSources('beta', 'https://dl.example.invalid/content', 'example/mirror')
  const files = new Map<string, Buffer>()
  for (const s of sources) {
    files.set(s.manifestUrl, pack.manifestBytes)
    files.set(s.signatureUrl, Buffer.from(pack.signature))
    for (const [sha, b] of pack.blobs) {
      const bad = opts.corrupt === sha ? Buffer.concat([b, Buffer.from('!')]) : b
      files.set(s.blobUrl(sha), bad)
    }
  }
  const hits: string[] = []
  const fetch: ContentFetch = async (url) => {
    hits.push(url)
    if (opts.primaryDown === true && url.startsWith('https://dl.example.invalid'))
      throw new Error('ECONNREFUSED')
    const b = files.get(url)
    return {
      ok: b !== undefined,
      status: b === undefined ? 404 : 200,
      arrayBuffer: async () => new Uint8Array(b ?? Buffer.alloc(0)).buffer as ArrayBuffer,
    }
  }
  return { sources, fetch, hits }
}

/** 最小审批总线替身：create / get / decide。 */
function fakeBus() {
  const items = new Map<string, ApprovalItem>()
  let n = 0
  return {
    items,
    async create(input: never): Promise<ApprovalItem> {
      n += 1
      const item = { ...(input as object), id: `ap_${n}`, state: 'pending' } as ApprovalItem
      items.set(item.id, item)
      return item
    },
    async get(id: string) {
      return items.get(id)
    },
    async decide(id: string, by: never, input: DecideInput): Promise<ApprovalItem> {
      const item = items.get(id)
      if (item === undefined) throw new Error('no item')
      const next = {
        ...item,
        state: input.action === 'approve' ? 'approved' : 'deferred',
        decision: {
          action: input.action,
          by,
          at: '2026-10-05T00:00:00.000Z',
          via: 'workstation',
          ...(input.selected_option_id === undefined
            ? {}
            : { selected_option_id: input.selected_option_id }),
        },
      } as ApprovalItem
      items.set(id, next)
      return next
    },
  }
}

interface Rig {
  updates: ReturnType<typeof createContentUpdates>
  bus: ReturnType<typeof fakeBus>
  decide: (id: string, input: Partial<DecideInput>) => Promise<ApprovalItem>
  skills: ReturnType<typeof createSkills>
  events: { type: string; workspace_id: string; payload: unknown }[]
  feed: ReturnType<typeof standInFeed>
}

async function rig(opts: {
  pack: BuiltContentPack
  keys: ContentPublicKey[]
  appVersion?: string
  platforms?: Record<string, StorefrontPlatform>
  feed?: { primaryDown?: boolean; corrupt?: string }
}): Promise<Rig> {
  const bundled = tmp('bundled')
  writeSkill(bundled, 'demo', SKILL('demo', '1.0.0', '出卡等人批。'))
  const clock = { now: () => '2026-10-05T08:00:00.000Z' }
  let seq = 0
  const random = (): number => {
    seq += 1
    return (seq % 97) / 97
  }
  const skills = createSkills({ clock, random })
  await seedBundledSkills(skills.registry, { dir: bundled })
  const bus = fakeBus()
  const events: Rig['events'] = []
  const feed = standInFeed(opts.pack, opts.feed)
  const platforms = opts.platforms ?? { ws_a: 'shopify', ws_b: 'woocommerce' }
  const updates = createContentUpdates({
    root: tmp('store'),
    appVersion: opts.appVersion ?? '0.2.0-beta.1',
    channel: 'beta',
    keys: opts.keys,
    sources: feed.sources,
    fetch: feed.fetch,
    clock,
    registry: skills.registry,
    bundledDir: bundled,
    brands: async () => Object.keys(platforms).map((id) => ({ id, owner_id: 'p_owner' })),
    platformOf: (ws) => platforms[ws],
    approvals: () => bus,
    appendEvent: (e) =>
      events.push({ type: e.type, workspace_id: e.workspace_id, payload: e.payload }),
  })
  const wrapped = updates.wrap(bus)
  const decide = (id: string, input: Partial<DecideInput>) =>
    wrapped.decide(id, 'p_owner' as never, {
      decision_token: 't',
      action: 'approve',
      via: 'workstation',
      ...input,
    })
  return { updates, bus, decide, skills, events, feed }
}

function makePack(
  k: string,
  items: { meta: ContentItemMeta; md: string }[],
  opts: { serial?: number; min?: string } = {},
): BuiltContentPack {
  const root = tmp('src')
  return buildContentPack({
    channel: 'beta',
    serial: opts.serial ?? 1,
    created_at: '2026-10-05T00:00:00.000Z',
    min_app_version: opts.min ?? '0.1.0',
    items: items.map(({ meta: m, md }) => ({
      meta: m,
      dir: writeSkill(join(root, m.name), m.name, md),
    })),
    privateKeyPem: k,
  })
}

const resolved = async (r: Rig, ws: string) =>
  (await r.skills.registry.resolve('demo', { person_id: 'p_owner', workspace_id: ws }))?.markdown ??
  ''

const NEW_RULES = '出卡等人批；周日不发。'

describe('签名与整包拒收', () => {
  it('签名对 → 收下、给启用了的品牌出一张卡（每次问我是默认）', async () => {
    const k = key()
    const r = await rig({
      pack: makePack(k, [{ meta: meta('demo', '1.1.0'), md: SKILL('demo', '1.1.0', NEW_RULES) }]),
      keys: [contentPublicKeyOf(k)],
    })
    const report = await r.updates.check()
    expect(report.state).toBe('ok')
    const cards = [...r.bus.items.values()]
    expect(cards.map((c) => [c.kind, c.workspace_id])).toEqual([
      ['content_update', 'ws_a'],
      ['content_update', 'ws_b'],
    ])
    expect(cards[0]?.title).toBe('demo 官方技能 有新版 · 官方 2026-10-01 更新 · 已审')
    // deck 按去重键第一段合并同族卡：内容更新卡一条内容一族，不和别的条目合成一张
    expect(cards[0]?.dedupe_key.split(':')[0]).toBe('content_update@skill/demo@1.1.0')
    // 没点之前谁都没换
    expect(await resolved(r, 'ws_a')).not.toContain('周日不发')
    // 6 小时后再查一次：不重复出卡
    await r.updates.check()
    expect(r.bus.items.size).toBe(2)
    expect(r.updates.view('ws_a').items[0]).toMatchObject({
      state: 'available',
      current_version: '1.0.0',
      available_version: '1.1.0',
    })
  })

  it('签名不对（别人的钥匙）→ 不收、不出卡，设置里写人话', async () => {
    const r = await rig({
      pack: makePack(key(), [
        { meta: meta('demo', '1.1.0'), md: SKILL('demo', '1.1.0', NEW_RULES) },
      ]),
      keys: [contentPublicKeyOf(key())],
    })
    const report = await r.updates.check()
    expect([report.state, report.reason]).toEqual(['error', 'bad_signature'])
    expect(r.bus.items.size).toBe(0)
    const v = r.updates.view('ws_a')
    expect([v.state, v.reason]).toEqual([
      'error',
      '这次的更新包签名对不上，没收，照旧用现在这一版。',
    ])
    expect(r.events.some((e) => e.type === 'content_update.rejected')).toBe(true)
  })

  it('没有内置钥匙 → 通道关着（fail-closed）', async () => {
    const k = key()
    const r = await rig({
      pack: makePack(k, [{ meta: meta('demo', '1.1.0'), md: SKILL('demo', '1.1.0', NEW_RULES) }]),
      keys: [],
    })
    expect((await r.updates.check()).reason).toBe('no_keys')
  })

  it('一个条目的一个文件哈希不对 → 整包拒收（另一条好的也不收）', async () => {
    const k = key()
    const pack = makePack(k, [
      { meta: meta('demo', '1.1.0'), md: SKILL('demo', '1.1.0', NEW_RULES) },
      { meta: meta('other', '1.0.0'), md: SKILL('other', '1.0.0', '别的') },
    ])
    const bad = pack.manifest.items[1]?.files[0]?.sha256
    const r = await rig({ pack, keys: [contentPublicKeyOf(k)], feed: { corrupt: bad } })
    const report = await r.updates.check()
    expect([report.state, report.reason]).toEqual(['error', 'bad_hash'])
    expect(r.bus.items.size).toBe(0)
    expect(r.updates.view('ws_a').items).toEqual([])
  })

  it('最低软件版本不够 → 不收，提示先更新软件', async () => {
    const k = key()
    const r = await rig({
      pack: makePack(k, [{ meta: meta('demo', '1.1.0'), md: SKILL('demo', '1.1.0', NEW_RULES) }], {
        min: '0.3.0',
      }),
      keys: [contentPublicKeyOf(k)],
      appVersion: '0.2.0-beta.1',
    })
    const report = await r.updates.check()
    expect([report.reason, report.text]).toEqual([
      'app_too_old',
      '这批内容要更新的软件版本才收得下，先更新软件。',
    ])
  })

  it('条目自己的最低版本不够 → 只这一条显示「要先更新软件」，不出卡', async () => {
    const k = key()
    const r = await rig({
      pack: makePack(k, [
        {
          meta: meta('demo', '1.1.0', { min_app_version: '0.9.0' }),
          md: SKILL('demo', '1.1.0', NEW_RULES),
        },
      ]),
      keys: [contentPublicKeyOf(k)],
    })
    expect((await r.updates.check()).state).toBe('ok')
    expect(r.bus.items.size).toBe(0)
    expect(r.updates.view('ws_a').items[0]?.state).toBe('needs_app_update')
  })

  it('主源不通 → 走 GitHub 镜像', async () => {
    const k = key()
    const r = await rig({
      pack: makePack(k, [{ meta: meta('demo', '1.1.0'), md: SKILL('demo', '1.1.0', NEW_RULES) }]),
      keys: [contentPublicKeyOf(k)],
      feed: { primaryDown: true },
    })
    expect((await r.updates.check()).state).toBe('ok')
    expect(r.feed.hits.some((u) => u.includes('/releases/download/content-beta/blob-'))).toBe(true)
  })
})

describe('自动 / 每次问我、只落启用品牌', () => {
  it('批了卡 → 这个品牌换上新版；别的品牌不动；只给平台对得上的品牌', async () => {
    const k = key()
    const r = await rig({
      pack: makePack(k, [
        {
          meta: meta('demo', '1.1.0', { platforms: ['shopify'] }),
          md: SKILL('demo', '1.1.0', NEW_RULES),
        },
      ]),
      keys: [contentPublicKeyOf(k)],
    })
    await r.updates.check()
    const cards = [...r.bus.items.values()]
    expect(cards.map((c) => c.workspace_id)).toEqual(['ws_a'])
    await r.decide(cards[0]?.id ?? '', {})
    expect(await resolved(r, 'ws_a')).toContain('周日不发')
    expect(await resolved(r, 'ws_b')).not.toContain('周日不发')
    expect(r.updates.view('ws_a').items[0]).toMatchObject({
      state: 'current',
      current_version: '1.1.0',
      previous_version: '1.0.0',
    })
    expect(r.updates.view('ws_b').items).toEqual([])
    expect(r.events.find((e) => e.type === 'content_update.applied')?.payload).toMatchObject({
      by: 'person',
      version: '1.1.0',
    })
  })

  it('平台专属的：没设建站平台的品牌不落（与 WP216 同口径，不按 Shopify 兜底）', async () => {
    const k = key()
    const r = await rig({
      pack: makePack(k, [
        {
          meta: meta('demo', '1.1.0', { platforms: ['shopify'] }),
          md: SKILL('demo', '1.1.0', NEW_RULES),
        },
      ]),
      keys: [contentPublicKeyOf(k)],
      platforms: { ws_a: 'shopify', ws_none: undefined as unknown as StorefrontPlatform },
    })
    await r.updates.check()
    expect([...r.bus.items.values()].map((c) => c.workspace_id)).toEqual(['ws_a'])
  })

  it('设成「自动」→ 不出卡直接换；审核记录里有命中的 → 照样出卡', async () => {
    const k = key()
    const r = await rig({
      pack: makePack(k, [
        { meta: meta('demo', '1.1.0'), md: SKILL('demo', '1.1.0', NEW_RULES) },
        {
          meta: meta('flagged', '1.0.0', {
            review: { ...meta('x', '1').review, scan_hits: 1, scan_rules: ['exfil-telemetry'] },
          }),
          md: SKILL('flagged', '1.0.0', '查询会上报 telemetry（已审放行）'),
        },
      ]),
      keys: [contentPublicKeyOf(k)],
      platforms: { ws_a: 'shopify' },
    })
    r.updates.setMode('ws_a', 'auto')
    const report = await r.updates.check()
    expect(report.applied).toEqual(['ws_a:skill:demo@1.1.0'])
    expect(report.carded).toEqual(['ws_a:skill:flagged@1.0.0'])
    expect(await resolved(r, 'ws_a')).toContain('周日不发')
    expect(r.events.find((e) => e.type === 'content_update.applied')?.payload).toMatchObject({
      by: 'auto',
    })
  })
})

describe('合并与退回', () => {
  async function withEdit(body: string) {
    const k = key()
    const r = await rig({
      pack: makePack(k, [{ meta: meta('demo', '1.1.0'), md: SKILL('demo', '1.1.0', NEW_RULES) }]),
      keys: [contentPublicKeyOf(k)],
      platforms: { ws_a: 'shopify' },
    })
    const base = r.skills.registry.peek('demo', 'package')
    const rules = base?.sections.find((s) => s.heading === '规矩')
    const doing = base?.sections.find((s) => s.heading === '你做什么')
    if (rules === undefined || doing === undefined) throw new Error('没有段')
    await r.skills.registry.setOverlay({
      skill: 'demo',
      tier: 'company',
      owner: 'ws_a',
      base_version: '1.0.0',
      version: 0,
      ops: [
        {
          op: 'replace',
          section_id: body === '' ? doing.id : rules.id,
          body: body === '' ? '写草稿，先写中文。' : body,
          origin: 'learned',
        },
      ],
    })
    await r.updates.check()
    const card = [...r.bus.items.values()].find((c) => c.kind === 'content_update')
    await r.decide(card?.id ?? '', {})
    return r
  }

  it('你改的是上游没动的段 → 干净合并：新版 + 你的改动都在，不出冲突卡', async () => {
    const r = await withEdit('')
    expect([...r.bus.items.values()].filter((c) => c.kind === 'content_conflict')).toEqual([])
    const md = await resolved(r, 'ws_a')
    expect(md).toContain('周日不发')
    expect(md).toContain('写草稿，先写中文。')
  })

  it('上游改了你也改过的段 → 冲突卡；选「保留我的」照旧是你的，选「用新版」露出新版', async () => {
    const r = await withEdit('出卡等人批；只在工作日发。')
    const conflict = [...r.bus.items.values()].find((c) => c.kind === 'content_conflict')
    expect(conflict?.options?.map((o) => o.label)).toEqual(['用新版', '保留我的'])
    expect(conflict?.payload).toMatchObject({
      heading: '规矩',
      mine: '出卡等人批；只在工作日发。',
      base_after: NEW_RULES,
    })
    expect(r.updates.view('ws_a').items[0]?.state).toBe('conflict')
    // 冲突没选之前：你的那一段照旧生效（官方更新不冲掉你的改动）
    expect(await resolved(r, 'ws_a')).toContain('只在工作日发')
    await r.decide(conflict?.id ?? '', { selected_option_id: 'use_new' })
    expect(await resolved(r, 'ws_a')).toContain('周日不发')
    expect(r.updates.view('ws_a').items[0]?.state).toBe('current')
    expect(r.events.some((e) => e.type === 'content_update.resolved')).toBe(true)
  })

  it('「保留我的」：你的那一段留着，冲突不再问', async () => {
    const r = await withEdit('出卡等人批；只在工作日发。')
    const conflict = [...r.bus.items.values()].find((c) => c.kind === 'content_conflict')
    await r.decide(conflict?.id ?? '', { selected_option_id: 'keep_mine' })
    expect(await resolved(r, 'ws_a')).toContain('只在工作日发')
    expect(r.updates.view('ws_a').items[0]?.state).toBe('current')
  })

  it('一键退回：回到随软件带的那一版，不再自动提这一版；再点更新还能换回来', async () => {
    const k = key()
    const r = await rig({
      pack: makePack(k, [{ meta: meta('demo', '1.1.0'), md: SKILL('demo', '1.1.0', NEW_RULES) }]),
      keys: [contentPublicKeyOf(k)],
      platforms: { ws_a: 'shopify' },
    })
    r.updates.setMode('ws_a', 'auto')
    await r.updates.check()
    expect(await resolved(r, 'ws_a')).toContain('周日不发')
    const v = await r.updates.rollback('ws_a', 'skill:demo')
    expect(await resolved(r, 'ws_a')).not.toContain('周日不发')
    expect(v.items[0]).toMatchObject({ state: 'available', current_version: '1.0.0' })
    // 自动模式下再查：退回过的这一版不再自动换上
    expect((await r.updates.check()).applied).toEqual([])
    await r.updates.apply('ws_a', 'skill:demo', 'person')
    expect(await resolved(r, 'ws_a')).toContain('周日不发')
    expect(r.events.some((e) => e.type === 'content_update.rolled_back')).toBe(true)
  })

  it('查看改动：按段列出', async () => {
    const k = key()
    const r = await rig({
      pack: makePack(k, [
        {
          meta: meta('demo', '1.1.0'),
          md: SKILL('demo', '1.1.0', NEW_RULES, '\n## 新加的一段\n\n官方新增。\n'),
        },
      ]),
      keys: [contentPublicKeyOf(k)],
      platforms: { ws_a: 'shopify' },
    })
    await r.updates.check()
    const d = r.updates.diff('ws_a', 'skill:demo')
    expect([d.from_version, d.to_version]).toEqual(['1.0.0', '1.1.0'])
    expect(d.sections.map((s) => `${s.change}:${s.heading}`)).toEqual([
      'changed:规矩',
      'added:新加的一段',
    ])
  })

  it('重启：更新过的基础层装回去；软件自带版追上了就丢掉覆盖', async () => {
    const k = key()
    const r = await rig({
      pack: makePack(k, [{ meta: meta('demo', '1.1.0'), md: SKILL('demo', '1.1.0', NEW_RULES) }]),
      keys: [contentPublicKeyOf(k)],
      platforms: { ws_a: 'shopify' },
    })
    r.updates.setMode('ws_a', 'auto')
    await r.updates.check()
    r.skills.registry.drop('demo', 'package', { workspace_id: 'ws_a' })
    expect(await resolved(r, 'ws_a')).not.toContain('周日不发')
    await r.updates.restore()
    expect(await resolved(r, 'ws_a')).toContain('周日不发')
  })
})

describe('更新源', () => {
  it('主源 dl.agentsws.com/content/<渠道>/，镜像 GitHub Releases content-<渠道>', () => {
    const [p, m] = contentFeedSources('stable')
    expect(p?.manifestUrl).toBe('https://dl.agentsws.com/content/stable/content-manifest.json')
    expect(p?.blobUrl('a'.repeat(64))).toBe(
      `https://dl.agentsws.com/content/stable/blobs/${'a'.repeat(64)}`,
    )
    expect(m?.signatureUrl).toBe(
      'https://github.com/Luoye-W/agentsws/releases/download/content-stable/content-manifest.json.sig',
    )
  })
})
