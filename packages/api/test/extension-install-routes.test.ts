/**
 * WP345：插件随工坊安装与更新——网关这一层的形状。
 *
 * 1. 工作台看 / 打开：Bearer + 分配；看用读权限，打开与发配对码同一把闸；`target` 只认两种；
 * 2. 插件报版本：与 `/v1/extension/*` 同一道闸（令牌 + Origin），版本号只认干净的字符；
 * 3. 没装配：三条都回 not_implemented。
 */
import { describe, expect, it } from 'vitest'
import type { ExtensionInstallPort, ExtensionPort } from '../src/index.js'
import { createGateway, createMemoryExtensionStore } from '../src/index.js'
import { harness, makeClock, seeded } from './helpers.js'

const EXT_ORIGIN = 'chrome-extension://mlbfinfiigagllemohnopbhfdghagijg'

async function wired(withInstall = true) {
  const h = await harness()
  const store = createMemoryExtensionStore({ clock: makeClock(), random: seeded(5) })
  const calls: string[] = []
  const install: ExtensionInstallPort = {
    view: (ws) => {
      calls.push(`view:${ws}`)
      return {
        folder: '/ud/chrome-extension',
        folder_version: '0.2.0-beta.8',
        running: [],
        can_open: true,
      }
    },
    open: async (target) => {
      calls.push(`open:${target}`)
      return { opened: true }
    },
    report: (session, input) => {
      calls.push(`report:${session.workspace_id}:${JSON.stringify(input)}`)
      return { folder_version: '0.2.0-beta.8' }
    },
  }
  const gateway = createGateway({
    ...h.deps,
    extension: { store } as unknown as ExtensionPort,
    ...(withInstall ? { extensionInstall: install } : {}),
  })
  const send = (method: string, path: string, headers: Headers, body?: unknown) => {
    if (body !== undefined) headers.set('content-type', 'application/json')
    return gateway.fetch(
      new Request(`http://127.0.0.1${path}`, {
        method,
        headers,
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      }),
    )
  }
  const owner = (method: string, path: string, body?: unknown) =>
    send(
      method,
      path,
      new Headers({ Authorization: `Bearer ${h.token}`, 'X-Assignment': h.assignment.id }),
      body,
    )
  const plugin = (path: string, init: { token?: string; origin?: string; body?: unknown }) => {
    const headers = new Headers()
    if (init.token !== undefined) headers.set('Authorization', `Bearer ${init.token}`)
    if (init.origin !== undefined) headers.set('Origin', init.origin)
    return send('POST', path, headers, init.body)
  }
  const made = await owner('POST', '/v1/extension/pairings', {})
  const code = ((await made.json()) as { data: { code: string } }).data.code
  const res = await plugin('/v1/extension/pair', { origin: EXT_ORIGIN, body: { code } })
  const token = ((await res.json()) as { data: { token: string } }).data.token
  return { h, calls, owner, plugin, token }
}

describe('工作台：看 / 打开', () => {
  it('看：按分配的工作区问', async () => {
    const w = await wired()
    const res = await w.owner('GET', '/v1/extension/install')
    expect(res.status).toBe(200)
    expect(((await res.json()) as { data: { folder_version: string } }).data.folder_version).toBe(
      '0.2.0-beta.8',
    )
    expect(w.calls).toEqual([`view:${w.h.assignment.workspace_id}`])
  })

  it('打开：只认 folder / chrome；别的 400', async () => {
    const w = await wired()
    expect((await w.owner('POST', '/v1/extension/install/open', { target: 'folder' })).status).toBe(
      200,
    )
    expect((await w.owner('POST', '/v1/extension/install/open', { target: 'chrome' })).status).toBe(
      200,
    )
    expect(
      (await w.owner('POST', '/v1/extension/install/open', { target: 'C:\\Windows' })).status,
    ).toBe(400)
    expect(w.calls).toEqual(['open:folder', 'open:chrome'])
  })

  it('不带会话：401', async () => {
    const w = await wired()
    const res = await w.plugin('/v1/extension/install/open', { body: { target: 'folder' } })
    expect(res.status).toBe(401)
  })
})

describe('插件：报版本', () => {
  it('令牌 + Origin 对才认；回文件夹里那一版', async () => {
    const w = await wired()
    const body = { version: '0.2.0-beta.8', reloaded_from: '0.2.0-beta.7' }
    const res = await w.plugin('/v1/extension/version', {
      token: w.token,
      origin: EXT_ORIGIN,
      body,
    })
    expect(res.status).toBe(200)
    expect(((await res.json()) as { data: unknown }).data).toEqual({
      folder_version: '0.2.0-beta.8',
    })
    expect(w.calls).toEqual([`report:${w.h.assignment.workspace_id}:${JSON.stringify(body)}`])
    // 别的扩展拿着这把令牌：不认
    const other = await w.plugin('/v1/extension/version', {
      token: w.token,
      origin: 'chrome-extension://abcdefghijklmnop',
      body,
    })
    expect(other.status).toBe(401)
  })

  it('版本号只认数字字母与 . + -；多余的格子不收', async () => {
    const w = await wired()
    const bad = [
      { version: '' },
      { version: '1.0.0; rm -rf /' },
      { version: '1.0.0', gave_up: '<script>' },
      { version: '1.0.0', extra: 1 },
    ]
    for (const body of bad) {
      const res = await w.plugin('/v1/extension/version', {
        token: w.token,
        origin: EXT_ORIGIN,
        body,
      })
      expect(res.status).toBe(400)
    }
  })
})

describe('没装配', () => {
  it('三条都回 not_implemented', async () => {
    const w = await wired(false)
    expect((await w.owner('GET', '/v1/extension/install')).status).toBe(501)
    expect((await w.owner('POST', '/v1/extension/install/open', { target: 'folder' })).status).toBe(
      501,
    )
    const res = await w.plugin('/v1/extension/version', {
      token: w.token,
      origin: EXT_ORIGIN,
      body: { version: '1.0.0' },
    })
    expect(res.status).toBe(501)
  })
})
