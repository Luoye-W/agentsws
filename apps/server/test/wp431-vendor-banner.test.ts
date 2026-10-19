/**
 * WP431（Luoye 10-19 beta.3 真机）：岗位页那条黄条「还缺必需的连接：店铺后台、邮件营销」——
 * 和 WP424 首次设置同一套规矩：邮件营销只有品牌档案「邮件营销用的」说过（或官网认出）某一家，
 * 才算「要连」、才提示连那一家；没说过的只算可选（职责照常能起草，到真发那一步再就地弹连接卡，决策 690）。
 */
import type { Position } from '@agentsws/contracts'
import { loadBundledRole, type RoleStore } from '@agentsws/roles'
import { describe, expect, it } from 'vitest'
import { createConnectionDirectory } from '../src/connection-directory.js'
import type { SecretStore } from '../src/secret-store.js'

const NOW = '2026-10-19T09:00:00.000Z'

function directory(options: { stated?: string; withVendor?: boolean; connected?: string[] }) {
  const roles = {
    roles: new Map([['dtc.email-marketing', loadBundledRole('dtc.email-marketing')]]),
    assignments: { listByPerson: () => [], get: () => undefined },
  } as unknown as RoleStore
  const position = {
    id: 'web-ops',
    name: { zh: '网站运营', en: 'Web operations' },
    roles: [{ role: 'dtc.email-marketing' }],
  } as unknown as Position
  return createConnectionDirectory({
    clock: { now: () => NOW },
    workspace_id: 'ws_local' as never,
    secrets: {} as SecretStore,
    roles,
    positions: () => [position],
    connectedKinds: () => options.connected ?? [],
    ...(options.withVendor === false ? {} : { statedVendor: () => options.stated }),
  })
}

const view = (d: ReturnType<typeof directory>) => d.positionConnections('p_me' as never, 'web-ops')

describe('WP431 岗位页「还没连上」：邮件营销按档案说的那一家', () => {
  it('没说过用哪家：不算缺（岗位页不提示），清单里只是可选', () => {
    const v = view(directory({}))
    expect(v.missing_required).toEqual([])
    expect(v.ready).toBe(true)
    const row = v.items.find((i) => i.kind === 'email_marketing')
    expect(row?.required).toBe(false)
  })

  it('说的那家目录里没有（Omnisend）：同样不提示', () => {
    expect(view(directory({ stated: 'Omnisend' })).missing_required).toEqual([])
  })

  it('说过用 Klaviyo：算缺，提示连的就是 Klaviyo（名字不带括号说明）', () => {
    const v = view(directory({ stated: '我们用 klaviyo' }))
    expect(v.missing_required).toEqual(['email_marketing'])
    const row = v.items.find((i) => i.kind === 'email_marketing')
    expect(row?.required).toBe(true)
    expect(row?.connect_service).toBe('klaviyo')
    expect(row?.name.zh).toBe('Klaviyo')
  })

  it('已经连上：不出现在清单里', () => {
    const v = view(directory({ stated: 'Klaviyo', connected: ['email_marketing'] }))
    expect(v.missing_required).toEqual([])
    expect(v.items.map((i) => i.kind)).not.toContain('email_marketing')
  })

  it('装配没给档案（老调用方）：照旧按职责定义算', () => {
    expect(view(directory({ withVendor: false })).missing_required).toEqual(['email_marketing'])
  })
})
