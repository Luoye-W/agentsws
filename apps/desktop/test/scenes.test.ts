/**
 * WP136（docs/79）：桌面壳这一侧的场景切换。
 *
 * - `DSH_HOME` 在 `<userData>/dsh`（与 `data/` 平级，不是 `~/.dsh`），经环境变量交给服务进程；
 *   环境变量的名字与服务进程那边认的是同一个（从 `@agentsws/server` 取来比对）；
 * - 托盘「切换场景」子菜单：Agents 工坊第一个、打勾；网页场景跟在后面；最后「管理场景…」；
 *   连公司服务器 / 服务不健康 / 没问到清单时不出现；
 * - api-client：只留点得开的；服务说不可用就是空；打开回网址、失败回人话。
 */
import { homedir } from 'node:os'
import { join } from 'node:path'
import { DSH_APP_DATA_ENV, DSH_HOME_ENV } from '@agentsws/server'
import { describe, expect, it } from 'vitest'
import { createApiClient } from '../src/api-client.js'
import type { HealthSnapshot } from '../src/health.js'
import { strings } from '../src/i18n.js'
import { buildTrayMenu, sceneSubmenu, type TrayModelInput } from '../src/menu.js'
import { desktopPaths } from '../src/paths.js'
import type { ApiFetchLike, ApiResponseLike } from '../src/ports.js'
import { serverSpawnRequest } from '../src/server-process.js'

const healthy: HealthSnapshot = {
  ok: true,
  status: 'ok',
  version: '0.1.0',
  halted: false,
  at: undefined,
  error: undefined,
}

const input = (patch: Partial<TrayModelInput> = {}): TrayModelInput => ({
  language: 'zh-CN',
  serverUrl: 'http://127.0.0.1:4317',
  version: '0.1.0',
  server: {
    name: 'server',
    state: 'running',
    pid: 1,
    attempts: 0,
    startedAt: undefined,
    lastExit: undefined,
    retryInMs: undefined,
  },
  health: healthy,
  paused: false,
  connect: undefined,
  launchAtLogin: false,
  ...patch,
})

describe('DSH_HOME 放哪', () => {
  it('<userData>/dsh：与 data/ 平级，不是 ~/.dsh', () => {
    const paths = desktopPaths('/u')
    expect(paths.dshHome).toBe(join('/u', 'dsh'))
    expect(paths.dshHome).not.toBe(join(homedir(), '.dsh'))
    expect(paths.dshHome.startsWith(paths.serverDataDir)).toBe(false)
  })

  it('交给服务进程：场景目录 + 同一个值当 DSH_HOME（凭据库所有场景共用）+ 应用数据目录', () => {
    const request = serverSpawnRequest({
      runtime: { kind: 'node', execPath: '/r/node/bin/node' },
      entry: '/r/server/index.js',
      port: 4317,
      dataDir: '/u/data',
      halt: [],
      secrets: {
        connectEncryptionKey: 'a',
        connectAdminToken: 'b',
        serverSessionKey: 'c',
        serverSecretsKey: 'd',
      } as never,
      version: '0.1.0',
      baseEnv: { DSH_HOME: join(homedir(), '.dsh'), PATH: '/bin' },
      dshHome: '/u/dsh',
      appDataDir: '/u',
    })
    expect(request.env[DSH_HOME_ENV]).toBe('/u/dsh')
    expect(request.env.DSH_HOME).toBe('/u/dsh')
    expect(request.env[DSH_APP_DATA_ENV]).toBe('/u')
    // 不给就不带（老调用方不受影响）
    const bare = serverSpawnRequest({
      runtime: { kind: 'node', execPath: 'node' },
      entry: 'x',
      port: 1,
      dataDir: '/d',
      halt: [],
      secrets: {} as never,
      version: '0',
      baseEnv: { DSH_HOME: '/elsewhere' },
    })
    expect(bare.env.DSH_HOME).toBeUndefined()
    expect(bare.env[DSH_HOME_ENV]).toBeUndefined()
  })
})

describe('托盘「切换场景」', () => {
  const scenes = [
    { name: 'agentsws', origin: 'agentsws' as const, state: 'running' as const },
    { name: 'web', origin: 'official' as const, state: 'running' as const },
    { name: 'coding', origin: 'custom' as const, state: 'starting' as const },
    { name: 'notes', origin: 'custom' as const, state: 'stopped' as const },
  ]

  it('Agents 工坊第一个、打勾；网页场景跟在后面；最后「管理场景…」', () => {
    const t = strings('zh-CN')
    const sub = sceneSubmenu(input({ scenes }))
    expect(sub?.label).toBe(t.switchScene)
    const items = sub?.submenu ?? []
    expect(items[0]).toMatchObject({ id: 'switch-scene', scene: 'agentsws', checked: true })
    expect(items[0]?.label).toBe(t.sceneAgentsws)
    expect(items.slice(1, 4).map((i) => i.label)).toEqual([
      `web（${t.sceneRunning}）`,
      `coding（${t.sceneStarting}）`,
      'notes',
    ])
    expect(items.slice(1, 4).map((i) => i.scene)).toEqual(['web', 'coding', 'notes'])
    expect(items.at(-1)).toMatchObject({ id: 'manage-scenes', label: t.manageScenes })
  })

  it('摆在「打开工作台 / 在浏览器打开」下面', () => {
    const menu = buildTrayMenu(input({ scenes }))
    expect(menu.map((i) => i.id).slice(0, 5)).toEqual([
      'open-workstation',
      'open-browser',
      'separator',
      'submenu',
      'separator',
    ])
  })

  it('连公司服务器 / 服务不健康 / 没问到清单：这一项不出现', () => {
    expect(sceneSubmenu(input({ scenes, mode: 'remote' }))).toBeUndefined()
    expect(sceneSubmenu(input({ scenes, health: { ...healthy, ok: false } }))).toBeUndefined()
    expect(sceneSubmenu(input())).toBeUndefined()
    expect(buildTrayMenu(input()).some((i) => i.id === 'submenu')).toBe(false)
  })

  it('英文也有', () => {
    const sub = sceneSubmenu(input({ language: 'en-US', scenes }))
    expect(sub?.label).toBe('Switch scene')
    expect(sub?.submenu?.[0]?.label).toBe('Agents Workshop')
  })
})

describe('api-client 的两条', () => {
  const session = { cookie: 'c=1', name: 'c', value: '1', person: { id: 'p', email: 'e' } }
  const res = (status: number, body: unknown): ApiResponseLike => ({
    ok: status < 400,
    status,
    text: async () => JSON.stringify(body),
    headers: { get: () => null },
  })
  const clientOf = (routes: Record<string, ApiResponseLike>) => {
    const calls: { url: string; method?: string | undefined }[] = []
    const fetchImpl: ApiFetchLike = async (url, init) => {
      calls.push({ url, method: init?.method })
      return routes[url.replace('http://127.0.0.1:4317', '')] ?? res(404, {})
    }
    return {
      calls,
      api: createApiClient({ baseUrl: 'http://127.0.0.1:4317', sessionKey: 'k', fetchImpl }),
    }
  }

  it('scenes：只留点得开的；不可用就是空；坏行跳过', async () => {
    const { api } = clientOf({
      '/v1/dsh-scenes': res(200, {
        data: {
          available: true,
          scenes: [
            { name: 'agentsws', origin: 'agentsws', state: 'running', launchable: true },
            { name: 'web', origin: 'official', state: 'weird', launchable: true },
            { name: 'headless', origin: 'official', state: 'stopped', launchable: false },
            { name: 7, origin: 'custom', state: 'stopped', launchable: true },
          ],
        },
      }),
    })
    const out = await api.scenes(session, 'asg_1')
    expect(out).toEqual({
      ok: true,
      value: [
        { name: 'agentsws', origin: 'agentsws', state: 'running' },
        { name: 'web', origin: 'official', state: 'stopped' },
      ],
    })
    const off = clientOf({ '/v1/dsh-scenes': res(200, { data: { available: false } }) })
    expect(await off.api.scenes(session, 'asg_1')).toEqual({ ok: true, value: [] })
    const bad = clientOf({})
    expect((await bad.api.scenes(session, 'asg_1')).ok).toBe(false)
    const empty = clientOf({ '/v1/dsh-scenes': res(200, { data: { available: true } }) })
    expect(await empty.api.scenes(session, 'asg_1')).toEqual({ ok: true, value: [] })
  })

  it('openScene：回网址；名字转义；失败回服务端那句人话', async () => {
    const { api, calls } = clientOf({
      '/v1/dsh-scenes/web/open': res(200, {
        data: { url: 'http://127.0.0.1:5000/?token=t', scene: {} },
      }),
      '/v1/dsh-scenes/headless/open': res(400, {
        error: { code: 'invalid_input', message: '命令行场景打不开' },
      }),
      '/v1/dsh-scenes/nourl/open': res(200, { data: {} }),
    })
    expect(await api.openScene(session, 'a', 'web')).toEqual({
      ok: true,
      value: 'http://127.0.0.1:5000/?token=t',
    })
    expect(calls[0]?.method).toBe('POST')
    expect(await api.openScene(session, 'a', 'headless')).toEqual({
      ok: false,
      reason: '命令行场景打不开',
    })
    expect((await api.openScene(session, 'a', 'nourl')).ok).toBe(false)
    await api.openScene(session, 'a', 'a b')
    expect(calls.at(-1)?.url).toContain('/v1/dsh-scenes/a%20b/open')
  })
})
