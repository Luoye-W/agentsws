/**
 * WP219（docs/90 §6）：真服务进程 + HTTP——设置 → 通用「已审的内容更新」与内容更新卡。
 *
 * 更新源是本地替身（内存 fetch），钥匙现生成；拿随软件带的 `cold-email` 打一个新版：
 * 查一次 → 出卡 → 批卡 → 这个品牌换上新版 → 查看改动 → 退回 → 改成自动。
 * 不注入时：没开（`AGENTSWS_CONTENT_UPDATES` 不是 on）→ 设置里照实说关着；不落盘 → 那一行不出。
 */
import { generateKeyPairSync } from 'node:crypto'
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { ApprovalItem, ContentDiffView, ContentUpdatesView } from '@agentsws/contracts'
import {
  BUNDLED_SKILLS_DIR,
  buildContentPack,
  bundledSkillVersion,
  contentPublicKeyOf,
} from '@agentsws/skills'
import { afterEach, describe, expect, it } from 'vitest'
import { type ContentFetch, contentFeedSources, createServer, type Server } from '../src/index.js'
import { SECRETS_KEY_ENV } from '../src/secret-store.js'

let server: Server | undefined
const dirs: string[] = []
const tmp = (p: string): string => {
  const d = mkdtempSync(join(tmpdir(), `wp219-${p}-`))
  dirs.push(d)
  return d
}

afterEach(async () => {
  await server?.close()
  server = undefined
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true })
})

const NAME = 'cold-email'

function standIn(): {
  keys: ReturnType<typeof contentPublicKeyOf>[]
  fetch: ContentFetch
  version: string
} {
  const key = generateKeyPairSync('ed25519')
    .privateKey.export({ format: 'pem', type: 'pkcs8' })
    .toString()
  const src = tmp('src')
  cpSync(join(BUNDLED_SKILLS_DIR, NAME), join(src, NAME), { recursive: true })
  const file = join(src, NAME, 'SKILL.md')
  const was = bundledSkillVersion(readFileSync(file, 'utf8'))
  const version = `${was}.1`
  writeFileSync(
    file,
    `${readFileSync(file, 'utf8')
      .replace(`version: ${was}`, `version: ${version}`)
      .replace(
        '主题行只负责让人打开，不负责推销。',
        '主题行只负责让人打开，不负责推销；一轮三封不换主题。',
      )
      .trimEnd()}\n\n## 官方新加的一段\n\n回信超过 14 天没动静的，这一轮就收尾。\n`,
  )
  const pack = buildContentPack({
    channel: 'beta',
    serial: 7,
    created_at: '2026-10-05T00:00:00.000Z',
    min_app_version: '0.1.0',
    items: [
      {
        meta: {
          id: `skill:${NAME}`,
          kind: 'skill',
          name: NAME,
          version,
          title: { zh: '开发信', en: 'Cold email' },
          summary: { zh: '加了一段「什么时候收尾」', en: 'Added when to stop' },
          upstream: {
            id: 'marketingskills',
            repo: 'coreyhaines31/marketingskills',
            commit: 'c'.repeat(40),
            published_at: '2026-10-02',
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
        },
        dir: join(src, NAME),
      },
    ],
    privateKeyPem: key,
  })
  const files = new Map<string, Buffer>()
  for (const s of contentFeedSources('beta')) {
    files.set(s.manifestUrl, pack.manifestBytes)
    files.set(s.signatureUrl, Buffer.from(pack.signature))
    for (const [sha, b] of pack.blobs) files.set(s.blobUrl(sha), b)
  }
  const fetch: ContentFetch = async (url) => {
    const b = files.get(url)
    return {
      ok: b !== undefined,
      status: b === undefined ? 404 : 200,
      arrayBuffer: async () => new Uint8Array(b ?? Buffer.alloc(0)).buffer as ArrayBuffer,
    }
  }
  return { keys: [contentPublicKeyOf(key)], fetch, version }
}

async function boot(opts: { inject?: boolean; dbDir?: boolean } = {}) {
  const feed = standIn()
  server = await createServer({
    ...(opts.dbDir === false ? {} : { dbDir: tmp('db') }),
    quiet: true,
    env: { [SECRETS_KEY_ENV]: 'c'.repeat(64) },
    tokenRefreshIntervalMs: 0,
    ...(opts.inject === false
      ? {}
      : {
          contentUpdates: {
            enabled: true,
            keys: feed.keys,
            fetch: feed.fetch,
            appVersion: '0.2.0-beta.1',
            schedule: false,
          },
        }),
  })
  const { url } = await server.listen(0)
  const s = server
  const api = (path: string, init: RequestInit = {}) => {
    const headers = new Headers(init.headers)
    headers.set('Authorization', `Bearer ${s.bootstrap.internalToken}`)
    headers.set('X-Assignment', s.bootstrap.ownerAssignment.id)
    if (init.body !== undefined) headers.set('content-type', 'application/json')
    return fetch(`${url}${path}`, { ...init, headers })
  }
  const send = (path: string, body: unknown = {}, method = 'POST') =>
    api(path, { method, body: JSON.stringify(body) })
  const resolved = async () =>
    (
      await s.skills.registry.resolve(NAME, {
        person_id: s.bootstrap.person.id,
        workspace_id: s.bootstrap.workspace.id,
      })
    )?.markdown ?? ''
  return { api, send, resolved, version: feed.version, s }
}

const data = async <T>(res: Response): Promise<T> => ((await res.json()) as { data: T }).data
const ITEM = encodeURIComponent(`skill:${NAME}`)

describe('WP219 设置 → 通用「已审的内容更新」', () => {
  it('查一次 → 出卡（每次问我）→ 批了换上新版 → 查看改动 → 退回 → 改成自动', async () => {
    const { api, send, resolved, version } = await boot()
    const first = await data<ContentUpdatesView>(await api('/v1/settings/content-updates'))
    expect([first.mode, first.state, first.channel]).toEqual(['ask', 'unknown', 'beta'])

    const checked = await data<ContentUpdatesView>(await send('/v1/settings/content-updates/check'))
    expect(checked.state).toBe('ok')
    expect(checked.items).toEqual([
      expect.objectContaining({
        id: `skill:${NAME}`,
        state: 'available',
        available_version: version,
      }),
    ])
    const cards = await data<ApprovalItem[]>(await api('/v1/approvals?kind=content_update'))
    expect(cards).toHaveLength(1)
    expect(cards[0]?.title).toBe('开发信 有新版 · 官方 2026-10-02 更新 · 已审')
    expect(await resolved()).not.toContain('官方新加的一段')

    const diff = await data<ContentDiffView>(
      await api(`/v1/settings/content-updates/items/${ITEM}/diff`),
    )
    expect(diff.sections.map((x) => `${x.change}:${x.heading}`)).toEqual([
      'changed:主题行',
      'added:官方新加的一段',
    ])

    expect((await send(`/v1/approvals/${cards[0]?.id}/decide`, { action: 'approve' })).status).toBe(
      200,
    )
    expect(await resolved()).toContain('回信超过 14 天没动静的')
    const now = await data<ContentUpdatesView>(await api('/v1/settings/content-updates'))
    expect(now.items[0]).toMatchObject({ state: 'current', current_version: version })

    const back = await data<ContentUpdatesView>(
      await send(`/v1/settings/content-updates/items/${ITEM}/rollback`),
    )
    expect(back.items[0]?.state).toBe('available')
    expect(await resolved()).not.toContain('官方新加的一段')

    const auto = await data<ContentUpdatesView>(
      await send('/v1/settings/content-updates', { mode: 'auto' }, 'PUT'),
    )
    expect(auto.mode).toBe('auto')
    expect((await send('/v1/settings/content-updates', { mode: 'sometimes' }, 'PUT')).status).toBe(
      400,
    )
    // 设置里点「更新」也行（退回过的那一版不会自己再换上）
    await send(`/v1/settings/content-updates/items/${ITEM}/apply`)
    expect(await resolved()).toContain('官方新加的一段')
  })

  it('你改过「主题行」→ 批了更新出冲突卡（用新版 / 保留我的）；选「用新版」走真的批卡路', async () => {
    const { api, send, resolved, s } = await boot()
    const ws = s.bootstrap.workspace.id
    const base = s.skills.registry.peek(NAME, 'package')
    const subject = base?.sections.find((x) => x.heading === '主题行')
    if (base === undefined || subject === undefined) throw new Error('没有「主题行」那一段')
    await s.skills.registry.setOverlay({
      skill: NAME,
      tier: 'company',
      owner: ws,
      base_version: base.version,
      version: 0,
      ops: [
        {
          op: 'replace',
          section_id: subject.id,
          body: '我们家：主题行带品类词。',
          origin: 'learned',
        },
      ],
    })
    await send('/v1/settings/content-updates/check')
    const [update] = await data<ApprovalItem[]>(await api('/v1/approvals?kind=content_update'))
    await send(`/v1/approvals/${update?.id}/decide`, { action: 'approve' })
    const [conflict] = await data<ApprovalItem[]>(await api('/v1/approvals?kind=content_conflict'))
    expect(conflict?.title).toBe('开发信「主题行」这一段：新版和你的改动不一样')
    expect(await resolved()).toContain('我们家：主题行带品类词。')
    // 选择题卡：不带选项批会被拒；带上「用新版」才算
    expect((await send(`/v1/approvals/${conflict?.id}/decide`, { action: 'approve' })).status).toBe(
      400,
    )
    const ok = await send(`/v1/approvals/${conflict?.id}/decide`, {
      action: 'approve',
      selected_option_id: 'use_new',
    })
    expect(ok.status).toBe(200)
    expect(await resolved()).toContain('一轮三封不换主题')
    expect(await resolved()).not.toContain('我们家：主题行带品类词。')
    const v = await data<ContentUpdatesView>(await api('/v1/settings/content-updates'))
    expect(v.items[0]?.state).toBe('current')
  })

  it('没开（桌面安装包才开）→ 设置里照实说关着、不查', async () => {
    const { api, send } = await boot({ inject: false })
    const v = await data<ContentUpdatesView>(await api('/v1/settings/content-updates'))
    expect([v.state, v.reason]).toEqual(['off', '这台没开内容更新（装好的桌面版才开）。'])
    const after = await data<ContentUpdatesView>(await send('/v1/settings/content-updates/check'))
    expect(after.items).toEqual([])
  })

  it('不落盘的进程（又没注入存放处）→ 不装配，路由回 not_implemented', async () => {
    const { api } = await boot({ inject: false, dbDir: false })
    expect((await api('/v1/settings/content-updates')).status).toBe(501)
  })
})
