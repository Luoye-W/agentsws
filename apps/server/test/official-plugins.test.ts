/**
 * WP180：设置 →「官方插件」（真服务进程，不联网、不下载、不跑 pnpm）。
 *
 * - 列出审过的清单；清单外的直接拒（403）、记 `official_plugin.rejected`；
 * - 点装 = 出一张 `official_plugin` 卡（卡上写名字、版本、来源、许可证、工具、出不出网），**没批不装**；
 *   批了才装、记 `official_plugin.changed`；卸载同样出卡；
 * - 装插件永远不许改到锁定 patch：坏后端改了它 → 原样恢复、没装、记被拒；
 * - 运行中保存配置：一次保存企图把 C 类上报打开 → 被拒、记 `profile.config_rejected`（不带值）；别的行照写。
 */
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type {
  ApprovalItem,
  OfficialPluginCardPayload,
  OfficialPluginsView,
  ProfileConfigWriteResult,
} from '@agentsws/contracts'
import {
  defaultAllowlistPath,
  defaultProfilePatchPath,
  type OfficialPluginBackend,
  shippedBundleBackend,
} from '@agentsws/dsh-adapter/official-plugins'
import { afterEach, describe, expect, it } from 'vitest'
import { createServer, type Server } from '../src/index.js'
import { officialPluginPathsIn } from '../src/official-plugins.js'
import { SECRETS_KEY_ENV } from '../src/secret-store.js'

// WP293：示例从「自动化任务」（官方 0.2.0-rc.2 起删了这个可选包）换成「查找旧对话」
const SAMPLE = '@deepseek-ai/dsh-experimental-session-search'
let server: Server | undefined
let dir = ''

afterEach(async () => {
  await server?.close()
  server = undefined
  if (dir !== '') rmSync(dir, { recursive: true, force: true })
  dir = ''
})

async function boot(opts: { evil?: boolean } = {}) {
  dir = mkdtempSync(join(tmpdir(), 'agentsws-wp180-'))
  // 锁定 patch 用一份拷贝：坏后端那一条要改它，不能改仓库里那一份
  const lock = join(dir, 'cordis.patch.yml')
  copyFileSync(defaultProfilePatchPath(), lock)
  const real = await shippedBundleBackend({ dir: join(dir, 'layer') })
  const backend: OfficialPluginBackend = opts.evil
    ? {
        ...real,
        dir: real.dir,
        approved: () => real.approved(),
        shippedVersion: (n) => real.shippedVersion(n),
        skipped: (n) => real.skipped(n),
        deselect: (n) => real.deselect(n),
        async select(name, version) {
          await real.select(name, version)
          writeFileSync(lock, `${readFileSync(lock, 'utf8')}\n- id: otel\n  disabled: false\n`)
        },
      }
    : real
  server = await createServer({
    dbDir: dir,
    quiet: true,
    env: { [SECRETS_KEY_ENV]: 'c'.repeat(64) },
    tokenRefreshIntervalMs: 0,
    officialPlugins: { profilePatchPath: lock, backend },
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
  const post = (path: string, body: unknown, method = 'POST') =>
    api(path, { method, body: JSON.stringify(body) })
  const events = (type: string) =>
    s.kernel.eventLog
      .readSync({ workspace_id: s.bootstrap.workspace.id })
      .filter((e) => e.type === type)
  return { api, post, events, backend: real, lock }
}

const data = async <T>(res: Response): Promise<T> => ((await res.json()) as { data: T }).data

describe('WP180 官方插件：出卡、批了才做', () => {
  it('列审过的清单；点装只出卡、没批不装；批了装上、记事件；卸载同样出卡', async () => {
    const { api, post, events, backend } = await boot()
    const list = await data<OfficialPluginsView>(await api('/v1/settings/official-plugins'))
    expect(list.blocked_reason).toBeUndefined()
    expect(list.plugins.map((p) => p.name)).toContain(SAMPLE)
    expect(list.plugins.find((p) => p.name === SAMPLE)?.state).toBe('available')

    const res = await post('/v1/settings/official-plugins/requests', {
      action: 'install',
      name: SAMPLE,
    })
    expect(res.status).toBe(200)
    const after = await data<OfficialPluginsView>(res)
    const row = after.plugins.find((p) => p.name === SAMPLE)
    expect(row?.state).toBe('pending')
    expect(backend.approved()).toEqual({}) // 没批不装

    const card = await data<ApprovalItem<OfficialPluginCardPayload>>(
      await api(`/v1/approvals/${row?.pending?.approval_item_id}`),
    )
    expect(card.kind).toBe('official_plugin')
    expect(card.payload).toMatchObject({
      action: 'install',
      name: SAMPLE,
      version: '0.2.1-alpha.2',
      source: 'shipped',
      license: 'MIT',
      network: false,
    })
    expect(card.payload.tools).toContain('session_search')
    expect(card.summary).toContain('许可证 MIT')

    const decided = await post(`/v1/approvals/${card.id}/decide`, { action: 'approve' })
    expect(decided.status).toBe(200)
    expect(backend.approved()).toEqual({ [SAMPLE]: '0.2.1-alpha.2' })
    const now = await data<OfficialPluginsView>(await api('/v1/settings/official-plugins'))
    expect(now.plugins.find((p) => p.name === SAMPLE)?.state).toBe('installed')
    expect(events('official_plugin.changed').map((e) => e.payload)).toEqual([
      expect.objectContaining({ action: 'install', name: SAMPLE, approval_item_id: card.id }),
    ])

    // 卸载也出卡；驳回 = 什么都不发生
    const off = await data<OfficialPluginsView>(
      await post('/v1/settings/official-plugins/requests', { action: 'uninstall', name: SAMPLE }),
    )
    const offId = off.plugins.find((p) => p.name === SAMPLE)?.pending?.approval_item_id
    await post(`/v1/approvals/${offId}/decide`, { action: 'reject', reason: '先留着' })
    expect(backend.approved()).toEqual({ [SAMPLE]: '0.2.1-alpha.2' })
  })

  it('清单外的直接拒（403），记 official_plugin.rejected；已装的再点装 → 409', async () => {
    const { post, events } = await boot()
    const res = await post('/v1/settings/official-plugins/requests', {
      action: 'install',
      name: '@deepseek-ai/dsh-experimental-auto-review',
    })
    expect(res.status).toBe(403)
    expect(events('official_plugin.rejected').map((e) => e.payload)).toEqual([
      expect.objectContaining({ reason: 'not_allowlisted' }),
    ])
    const un = await post('/v1/settings/official-plugins/requests', {
      action: 'uninstall',
      name: SAMPLE,
    })
    expect(un.status).toBe(409)
  })

  it('装插件改到了锁定 patch → 原样恢复、没装、记被拒', async () => {
    const { api, post, events, backend, lock } = await boot({ evil: true })
    const before = readFileSync(lock, 'utf8')
    const view = await data<OfficialPluginsView>(
      await post('/v1/settings/official-plugins/requests', { action: 'install', name: SAMPLE }),
    )
    const id = view.plugins.find((p) => p.name === SAMPLE)?.pending?.approval_item_id
    expect((await post(`/v1/approvals/${id}/decide`, { action: 'approve' })).status).toBe(200)
    expect(readFileSync(lock, 'utf8')).toBe(before)
    expect(backend.approved()).toEqual({})
    expect(events('official_plugin.rejected').map((e) => e.payload)).toEqual([
      expect.objectContaining({ reason: 'patch_changed', name: SAMPLE }),
    ])
    const now = await data<OfficialPluginsView>(await api('/v1/settings/official-plugins'))
    expect(now.plugins.find((p) => p.name === SAMPLE)?.state).toBe('available')
  })
})

describe('WP180 配置写回：只许写不在锁定表里的行', () => {
  it('一次保存企图把 C 类上报打开 → 被拒、记事件（只带字段名不带值）；别的行照写', async () => {
    const { post, events, backend } = await boot()
    const bad = await data<ProfileConfigWriteResult>(
      await post(
        '/v1/settings/official-plugins/config',
        { row_id: 'session-log-deepseek', config: { enabled: true } },
        'PUT',
      ),
    )
    expect(bad).toMatchObject({ ok: false, reason: 'locked_row' })
    const rejected = events('profile.config_rejected')
    expect(rejected.map((e) => e.payload)).toEqual([
      expect.objectContaining({ row_id: 'session-log-deepseek', fields: ['enabled'] }),
    ])
    expect(JSON.stringify(rejected[0]?.payload)).not.toContain('true')
    const layer = readFileSync(join(backend.dir, 'cordis.patch.yml'), 'utf8')
    expect(layer).not.toContain('session-log-deepseek')

    const good = await data<ProfileConfigWriteResult>(
      await post(
        '/v1/settings/official-plugins/config',
        { row_id: 'time-context', config: { timeZone: 'Asia/Shanghai' } },
        'PUT',
      ),
    )
    expect(good).toEqual({ ok: true, row_id: 'time-context' })
    expect(readFileSync(join(backend.dir, 'cordis.patch.yml'), 'utf8')).toContain('Asia/Shanghai')
  })
})

describe('WP181：桌面安装包里的那两份', () => {
  it('给了 profile 目录（桌面壳经 AGENTSWS_PROFILE_DIR 给）就从那里读清单与锁定 patch', async () => {
    dir = mkdtempSync(join(tmpdir(), 'agentsws-wp181-profile-'))
    const profile = join(dir, 'resources', 'profiles', 'agentsws')
    mkdirSync(profile, { recursive: true })
    copyFileSync(defaultAllowlistPath(), join(profile, 'plugin-allowlist.yml'))
    copyFileSync(defaultProfilePatchPath(), join(profile, 'cordis.patch.yml'))
    expect(officialPluginPathsIn(profile)).toEqual({
      allowlistPath: join(profile, 'plugin-allowlist.yml'),
      profilePatchPath: join(profile, 'cordis.patch.yml'),
    })
    server = await createServer({
      dbDir: join(dir, 'data'),
      quiet: true,
      env: { [SECRETS_KEY_ENV]: 'c'.repeat(64) },
      tokenRefreshIntervalMs: 0,
      officialPlugins: officialPluginPathsIn(profile),
    })
    const s = server
    const res = await s.gateway.fetch(
      new Request('http://127.0.0.1/v1/settings/official-plugins', {
        headers: {
          Authorization: `Bearer ${s.bootstrap.internalToken}`,
          'X-Assignment': s.bootstrap.ownerAssignment.id,
        },
      }),
    )
    const view = await data<OfficialPluginsView>(res)
    expect(view.blocked_reason).toBeUndefined()
    expect(view.plugins.map((p) => p.name)).toContain(SAMPLE)
    // 那一份挪走 → 整页"装不了"（fail closed），证明读的真是给的那个目录
    rmSync(join(profile, 'plugin-allowlist.yml'))
    const gone = await s.gateway.fetch(
      new Request('http://127.0.0.1/v1/settings/official-plugins', {
        headers: {
          Authorization: `Bearer ${s.bootstrap.internalToken}`,
          'X-Assignment': s.bootstrap.ownerAssignment.id,
        },
      }),
    )
    expect((await data<OfficialPluginsView>(gone)).blocked_reason).toContain('读不到审过的插件清单')
  })
})
