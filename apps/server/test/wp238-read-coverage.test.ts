/**
 * WP238（Luoye 10-06 Windows 真机，岗位「Reddit 运营」）：「连上这 N 个就能开工」只列真缺的必需项。
 *
 * 钉四件：
 * 1. 读 Reddit 已能经接口中台取到 → 只读需求的那几条（`pr.monitoring` 的 `search`）不算缺；
 * 2. 要发帖 / 版务的（`social.reddit` 的 `submit` …）照旧留在清单里——但它是可选，进不了卡；
 * 3. 必需、只读、路由走得通 → 不进 `missing_required`；路由不通 → 照样缺；必需、要写 → 照样缺；
 * 4. 面板那一头：`social_reddit` 没连但有路取数 → 带上 `via`，面板不再出「去连接」。
 */
import type { Position, ReadonlyBrowserStatus } from '@agentsws/contracts'
import { assembleView, withOwnSources, withReadVia } from '@agentsws/deck'
import { loadBundledRole, type RoleStore } from '@agentsws/roles'
import { describe, expect, it } from 'vitest'
import { createConnectionDirectory } from '../src/connection-directory.js'
import { readRouteLevelOf, readViaSources } from '../src/read-route.js'
import type { SecretStore } from '../src/secret-store.js'

const NOW = '2026-10-06T09:00:00.000Z'

type Dep = { kind: string; required: boolean; grants: string[] }

function rolesWith(extra: Record<string, Dep[]>): RoleStore {
  const table = new Map<string, unknown>()
  for (const id of ['social.reddit', 'pr.reddit', 'pr.monitoring'])
    table.set(id, loadBundledRole(id))
  for (const [id, deps] of Object.entries(extra))
    table.set(id, {
      id,
      name: { zh: id, en: id },
      connectors: deps.map((d) => ({ ...d, ownership: 'workspace' })),
    })
  return {
    roles: table,
    assignments: { listByPerson: () => [], get: () => undefined },
  } as unknown as RoleStore
}

function directory(
  roleIds: string[],
  extra: Record<string, Dep[]>,
  level: 'workshop' | 'browser_readonly' | undefined,
) {
  const position = {
    id: 'reddit-ops',
    name: { zh: 'Reddit 运营', en: 'Reddit ops' },
    roles: roleIds.map((role) => ({ role })),
  } as unknown as Position
  return createConnectionDirectory({
    clock: { now: () => NOW },
    workspace_id: 'ws_local' as never,
    secrets: {} as SecretStore,
    roles: rolesWith(extra),
    positions: () => [position],
    connectedKinds: () => [],
    readRouteLevel: () => level,
  })
}

const view = (d: ReturnType<typeof directory>) =>
  d.positionConnections('p_me' as never, 'reddit-ops')

describe('WP238 岗位连接清单：只读已有路取数的不算缺', () => {
  it('Reddit 走接口中台：只要搜的那条不出现，要发帖的那条还在但只是可选', () => {
    const v = view(directory(['social.reddit', 'pr.reddit', 'pr.monitoring'], {}, 'workshop'))
    expect(v.missing_required).toEqual([])
    expect(v.ready).toBe(true)
    const reddit = v.items.find((i) => i.kind === 'reddit')
    // 两条要发帖的职责照旧列着（连接页按职责列），只读的 pr.monitoring 不在「要它的活儿」里
    expect(reddit?.required).toBe(false)
    expect(reddit?.needed_by).not.toContain('品牌监控')
    expect(reddit?.needed_by.length).toBe(2)
  })

  it('只有 pr.monitoring（只读）+ 走得通：清单里根本没有 Reddit', () => {
    const v = view(directory(['pr.monitoring'], {}, 'workshop'))
    expect(v.items.map((i) => i.kind)).not.toContain('reddit')
  })

  it('必需 + 只读：路由走得通不缺，不通照样缺', () => {
    const extra = { 'x.reader': [{ kind: 'reddit', required: true, grants: ['search'] }] }
    expect(view(directory(['x.reader'], extra, 'workshop')).missing_required).toEqual([])
    expect(view(directory(['x.reader'], extra, 'browser_readonly')).missing_required).toEqual([])
    const off = view(directory(['x.reader'], extra, undefined))
    expect(off.missing_required).toEqual(['reddit'])
    expect(off.ready).toBe(false)
  })

  it('必需 + 要写：读有路也照样缺（发帖只能用品牌号）', () => {
    const extra = {
      'x.poster': [{ kind: 'reddit', required: true, grants: ['search', 'submit'] }],
    }
    const v = view(directory(['x.poster'], extra, 'workshop'))
    expect(v.missing_required).toEqual(['reddit'])
    expect(v.items.find((i) => i.kind === 'reddit')?.required).toBe(true)
  })

  it('别的卡不受影响：必需的邮箱没连照样缺', () => {
    const extra = { 'x.mail': [{ kind: 'email', required: true, grants: ['read'] }] }
    expect(view(directory(['x.mail'], extra, 'workshop')).missing_required).toEqual(['email'])
  })
})

describe('WP238 readRouteLevelOf：路由现在走得通哪一级', () => {
  const browser = (state: ReadonlyBrowserStatus['state']) => ({
    status: (): ReadonlyBrowserStatus => ({ state, pages_last_day: 0, max_pages_per_day: 200 }),
  })
  const cloud = (linked: boolean, disabled: ('workshop' | 'browser_readonly')[] = []) => ({
    linked: () => linked,
    redditReadRoute: () => ({
      order: ['workshop' as const, 'browser_readonly' as const],
      disabled,
    }),
  })

  it('关联了账号 → 接口中台', () => {
    expect(readRouteLevelOf(cloud(true), undefined)('reddit.read')).toBe('workshop')
  })
  it('没关联、本机有只读浏览器 → 浏览器只读；找不到浏览器 → 都不通', () => {
    expect(readRouteLevelOf(cloud(false), browser('ready'))('reddit.read')).toBe('browser_readonly')
    expect(readRouteLevelOf(cloud(false), browser('no_browser'))('reddit.read')).toBeUndefined()
  })
  it('接口中台被关掉了 → 不算它', () => {
    expect(readRouteLevelOf(cloud(true, ['workshop']), undefined)('reddit.read')).toBeUndefined()
  })
  it('别的路由一概不认', () => {
    expect(readRouteLevelOf(cloud(true), undefined)('kol.youtube')).toBeUndefined()
  })
})

describe('WP238 面板：没连但有路取数的源带 via', () => {
  it('social_reddit 没连 + 接口中台 → 那一节带 via，不再是光秃秃的「没连」', () => {
    const via = readViaSources(() => 'workshop')
    expect(via.social_reddit).toBe('workshop')
    const sources = withReadVia(
      withOwnSources([{ id: 'social_reddit', label: 'Reddit', connected: false }]),
      via,
    )
    const sections = assembleView(
      'social.reddit' as never,
      {
        sources,
      } as never,
    )
    const reddit = sections.find((s) => s.source === 'social_reddit')
    expect(reddit?.connected).toBe(false)
    expect(reddit?.via).toBe('workshop')
  })

  it('已经连上的源不加 via；路由不通也不加', () => {
    const on = withReadVia([{ id: 'social_reddit', label: 'Reddit', connected: true }], {
      social_reddit: 'workshop',
    })
    expect(on[0]?.via).toBeUndefined()
    expect(readViaSources(() => undefined)).toEqual({})
  })
})
