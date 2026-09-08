import type { PackageManifest } from '@agentsws/contracts'
import { describe, expect, it } from 'vitest'
import { createStandIns, FakeRegistry, InboxDelivery, SyntheticClock } from '../src/index.js'

const item = {
  id: 'ai_1',
  title: '回信草稿 #1001',
  summary: '退款 129 USD',
  view: 'full' as const,
  decision_token: 'dtok_1',
  actions: ['approve', 'approve_edited', 'reject'],
}

describe('收件箱投递（18 §3 / 14 §7）', () => {
  it('两个实例：workstation 与 email', () => {
    const s = createStandIns({ seed: 1 })
    expect(s.deliveries.workstation.channel).toBe('workstation')
    expect(s.deliveries.email.channel).toBe('email')
  })

  it('deliver 记录投递，refresh 刷新状态', async () => {
    const clock = new SyntheticClock('2026-09-07T09:00:00.000Z')
    const inbox = new InboxDelivery({ channel: 'workstation', clock })
    const first = await inbox.deliver(item, 'p_wang')
    expect(first.external_id).toBe('workstation_1')
    clock.advance(60_000)
    await inbox.deliver({ ...item, id: 'ai_2' }, 'p_li')

    expect(inbox.length).toBe(2)
    expect(inbox.inbox('p_wang')).toHaveLength(1)
    expect(inbox.inbox('p_wang')[0]).toMatchObject({
      channel: 'workstation',
      to: 'p_wang',
      sent_at: '2026-09-07T09:00:00.000Z',
      state: 'sent',
    })
    expect(inbox.forItem('ai_2')).toHaveLength(1)

    await inbox.refresh('workstation_1', '已由 p_li 处理')
    expect(inbox.inbox('p_wang')[0]?.state).toBe('已由 p_li 处理')
    expect(inbox.inbox('p_wang')[0]?.refreshed_at).toBe('2026-09-07T09:01:00.000Z')
    await expect(inbox.refresh('nope', 'x')).rejects.toMatchObject({ code: 'not_found' })

    inbox.clear()
    expect(inbox.all()).toEqual([])
  })

  it('parseCallback 只认 item_id / decision_token / action（14 §7 防篡改）', () => {
    const clock = new SyntheticClock('2026-09-07T09:00:00.000Z')
    const inbox = new InboxDelivery({ channel: 'email', clock })
    expect(
      inbox.parseCallback({
        item_id: 'ai_1',
        decision_token: 'dtok_1',
        action: 'approve',
        amount: 999,
      }),
    ).toEqual({ item_id: 'ai_1', decision_token: 'dtok_1', action: 'approve' })
    expect(
      inbox.parseCallback('{"item_id":"ai_1","decision_token":"t","action":"reject"}'),
    ).toEqual({ item_id: 'ai_1', decision_token: 't', action: 'reject' })
    expect(
      inbox.parseCallback({ item_id: 'ai_1', decision_token: 't', action: 'apply' }),
    ).toBeUndefined()
    expect(inbox.parseCallback({ item_id: 'ai_1', action: 'approve' })).toBeUndefined()
    expect(
      inbox.parseCallback({ item_id: '', decision_token: 't', action: 'approve' }),
    ).toBeUndefined()
    expect(inbox.parseCallback('not json')).toBeUndefined()
    expect(inbox.parseCallback([1, 2])).toBeUndefined()
    expect(inbox.parseCallback(null)).toBeUndefined()
  })

  it('合成人回调闭环：从收件箱取回 token 与动作', async () => {
    const clock = new SyntheticClock('2026-09-07T09:00:00.000Z')
    const inbox = new InboxDelivery({ channel: 'workstation', clock })
    await inbox.deliver(item, 'p_wang')
    const record = inbox.inbox('p_wang')[0]
    const callback = inbox.parseCallback({
      item_id: record?.item.id,
      decision_token: record?.item.decision_token,
      action: 'approve_edited',
    })
    expect(callback).toEqual({
      item_id: 'ai_1',
      decision_token: 'dtok_1',
      action: 'approve_edited',
    })
  })
})

function manifest(id: string, version: string, kind: PackageManifest['kind']): PackageManifest {
  return {
    id,
    version,
    kind,
    name: { zh: '售后客服包', en: 'Aftersales pack' },
    publisher: { id: 'agentsws', tier: 'official' },
    license: 'Apache-2.0',
    pricing: { model: 'free' },
    provides: { roles: ['dtc.aftersales'] },
    requires: { contracts: { run: '^1.0.0' } },
    files: ['role.yml'],
  }
}

describe('假 registry（23 §3）', () => {
  it('search / get / download 三个方法', () => {
    const registry = new FakeRegistry()
    registry.add({ manifest: manifest('dtc.aftersales', '1.0.0', 'role-pack'), dir: '/packs/a' })
    registry.add({
      manifest: manifest('dtc.aftersales', '1.2.0', 'role-pack'),
      dir: '/packs/a12',
      category: 'aftersales',
    })
    registry.add({
      manifest: {
        ...manifest('ops.block', '0.1.0', 'block'),
        publisher: { id: 'x', tier: 'community' },
      },
      dir: '/packs/b',
    })
    expect(registry.size).toBe(3)

    expect(registry.search({ kind: 'role-pack' })).toHaveLength(2)
    expect(registry.search({ tier: 'community' }).map((e) => e.manifest.id)).toEqual(['ops.block'])
    expect(registry.search({ category: 'aftersales' })).toHaveLength(1)
    expect(registry.search({ q: 'nothing here' })).toHaveLength(0)
    expect(registry.search({ q: 'ops.block' })).toHaveLength(1)
    expect(registry.search({ q: 'Aftersales' })).toHaveLength(3)
    expect(registry.search()).toHaveLength(3)

    expect(registry.versions('dtc.aftersales')).toEqual(['1.0.0', '1.2.0'])
    expect(registry.get('dtc.aftersales')?.manifest.version).toBe('1.2.0')
    expect(registry.get('dtc.aftersales', '1.0.0')?.dir).toBe('/packs/a')
    expect(registry.get('nope')).toBeUndefined()

    const dl = registry.download('dtc.aftersales')
    expect(dl).toMatchObject({ id: 'dtc.aftersales', version: '1.2.0', dir: '/packs/a12' })
    expect(dl.sha256).toMatch(/^[0-9a-f]{64}$/)
    expect(dl.signature.startsWith('stand-in:')).toBe(true)
    expect(registry.get('dtc.aftersales')?.downloads).toBe(1)
    expect(() => registry.download('nope')).toThrowError(/registry/)

    registry.clear()
    expect(registry.size).toBe(0)
  })
})
