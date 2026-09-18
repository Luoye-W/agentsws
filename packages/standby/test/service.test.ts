/**
 * 值守的状态机与账（49 §6 WP60）。
 *
 * 钉的是六件事：开通 → 起进程 → 健康 → 到期停；余额不足开不了（402 人话）；
 * 崩溃退避；密钥与令牌的去处；包坏了不解包；到期前 3 天提醒。
 */
import { describe, expect, it } from 'vitest'
import { backoffMs, STANDBY_CAPABILITY, StandbyError } from '../src/index.js'
import { harness } from './helpers.js'

const OPEN = { org_id: 'org_1', account_id: 'acc_1', workspace_id: 'ws_1', seats: 2 }

describe('开通 → 起进程 → 健康 → 到期停', () => {
  it('开通就扣一个月，起一个子进程，健康检查过了才算 running', async () => {
    const h = harness({ credits: 1000 })
    const view = await h.service.open(OPEN)

    // 起了，但还没体检：starting
    expect(view.status).toBe('starting')
    expect(h.spawn.calls).toHaveLength(1)
    expect(view.port).toBe(41000)

    // 账：`standby.seat.month` × 2 个座位，一次结清
    const price = h.service.seatPrice()
    expect(h.wallet.balance('org_1').available).toBe(1000 - price * 2)
    const usage = h.wallet.usage({ org_id: 'org_1', group: 'capability' })
    expect(usage.rows).toEqual([
      expect.objectContaining({ key: STANDBY_CAPABILITY, quantity: 2, credits: price * 2 }),
    ])

    await h.service.tick()
    const after = h.service.get('ws_1')
    expect(after?.status).toBe('running')
    expect(after?.last_health_at).toBe('2026-09-15T00:00:00.000Z')
    expect(h.events.map((e) => e.type)).toContain('standby.started')
  })

  it('子进程拿到的是自己的数据目录、自己的库密钥、自己那把只有 ai + wallet:read 的令牌', async () => {
    const h = harness({ credits: 1000 })
    await h.service.open(OPEN)
    const env = h.spawn.last().env

    expect(env.AGENTSWS_DATA_DIR).toBe('/data/standby/ws_1')
    expect(env.AGENTSWS_BIND_HOST).toBe('127.0.0.1')
    expect(env.AGENTSWS_DATA_KEY).toBeTruthy()
    expect(env.AGENTSWS_SECRETS_KEY).toBe(env.AGENTSWS_DATA_KEY)
    expect(env.AGENTSWS_PUBLIC_BASE_URL).toBe('https://cloud.agentsws.com/w/ws_1')

    // 密钥**不在编排层的库里**（21：我们没有读数据的路径）
    const row = JSON.stringify(h.store.get('ws_1'))
    expect(row).not.toContain(env.AGENTSWS_DATA_KEY as string)

    // 子进程那把令牌验得过，而且**没有 standby**
    const verified = h.childTokens.verify(env.AGENTSWS_CLOUD_WORKSPACE_TOKEN as string)
    expect(verified?.workspace_id).toBe('ws_1')
    expect(verified?.scopes).toEqual(['ai', 'wallet:read'])
    expect(verified?.scopes).not.toContain('standby')
  })

  it('重拉一次换一把新令牌，旧的当场作废', async () => {
    const h = harness({ credits: 1000 })
    await h.service.open(OPEN)
    const first = h.spawn.last().env.AGENTSWS_CLOUD_WORKSPACE_TOKEN as string

    h.spawn.last().crash(1)
    h.clock.advance(backoffMs(1) + 1)
    await h.service.tick()

    const second = h.spawn.last().env.AGENTSWS_CLOUD_WORKSPACE_TOKEN as string
    expect(second).not.toBe(first)
    expect(h.childTokens.verify(first)).toBeUndefined()
    expect(h.childTokens.verify(second)?.workspace_id).toBe('ws_1')
  })

  it('到期且余额不足：停，状态 expired，数据不删，导出照常', async () => {
    const h = harness({ credits: 200 })
    await h.service.open({ ...OPEN, seats: 1 })
    h.fs.dirs.set('/data/standby/ws_1', 5) // 目录里有数据
    await h.service.tick()
    expect(h.service.get('ws_1')?.status).toBe('running')

    // 钱花光 + 时间推到期后
    const left = h.wallet.balance('org_1').available
    if (left > 0)
      h.wallet.settle(
        h.wallet.reserve({
          org_id: 'org_1',
          workspace_id: 'ws_1',
          capability: 'ai.chat',
          unit: '1k_tokens',
          quantity: 1,
          credits: left,
          request_id: 'drain',
        }),
        { quantity: 1, credits: left },
      )
    h.clock.advance(31 * 24 * 60 * 60 * 1000)
    await h.service.tick()

    const after = h.service.get('ws_1')
    expect(after?.status).toBe('expired')
    expect(h.spawn.last().killed).toContain('SIGTERM')
    expect(h.events.at(-1)?.type).toBe('standby.stopped')

    // 41 §2.3 第一条纪律：到期也能搬家
    const pkg = await h.service.exportPackage('ws_1')
    expect(pkg.name).toMatch(/^ws_1-/)
    expect(h.packager.exported).toEqual(['/data/standby/ws_1'])

    // 到期之后不再自动拉起来
    const spawnedBefore = h.spawn.calls.length
    await h.service.tick()
    expect(h.spawn.calls).toHaveLength(spawnedBefore)
  })

  it('余额够就自动续一期，不用用户做任何事', async () => {
    const h = harness({ credits: 1000 })
    await h.service.open({ ...OPEN, seats: 1 })
    const first = h.service.get('ws_1')?.period_end
    h.clock.advance(31 * 24 * 60 * 60 * 1000)
    await h.service.tick()
    const after = h.service.get('ws_1')
    expect(after?.status).not.toBe('expired')
    expect(after?.period_end).not.toBe(first)
    expect(h.wallet.balance('org_1').available).toBe(1000 - h.service.seatPrice() * 2)
  })

  it('到期前 3 天出一条 standby.renewal_due，一期只出一次', async () => {
    const h = harness({ credits: 1000 })
    await h.service.open({ ...OPEN, seats: 1 })
    h.clock.advance(28 * 24 * 60 * 60 * 1000)
    await h.service.tick()
    await h.service.tick()
    expect(h.events.filter((e) => e.type === 'standby.renewal_due')).toHaveLength(1)
  })
})

describe('余额不足', () => {
  it('开不了：402 + 一句人话，而且一分钱没扣', async () => {
    const h = harness({ credits: 10 })
    await expect(h.service.open(OPEN)).rejects.toMatchObject({
      code: 'insufficient_credits',
      status: 402,
    })
    await expect(h.service.open(OPEN)).rejects.toThrow(/充值/)
    expect(h.wallet.balance('org_1').available).toBe(10)
    expect(h.wallet.balance('org_1').reserved).toBe(0)
    expect(h.spawn.calls).toHaveLength(0)
  })

  it('这一次拒了，充完钱下一次就过——不冻结', async () => {
    const h = harness({ credits: 10 })
    await expect(h.service.open(OPEN)).rejects.toThrow()
    h.wallet.topup({ org_id: 'org_1', credits: 1000, kind: 'purchased' })
    const view = await h.service.open(OPEN)
    expect(view.status).toBe('starting')
  })
})

describe('崩溃退避', () => {
  it('崩一次记一次，退避到点才重拉；台阶越来越长', async () => {
    const h = harness({ credits: 5000 })
    await h.service.open(OPEN)
    await h.service.tick()

    h.spawn.last().crash(1)
    const crashed = h.store.get('ws_1')
    expect(crashed?.status).toBe('stopped')
    expect(crashed?.restarts).toBe(1)
    expect(crashed?.port).toBeUndefined()

    // 还没到点：不拉
    await h.service.tick()
    expect(h.spawn.calls).toHaveLength(1)

    h.clock.advance(backoffMs(1) + 1)
    await h.service.tick()
    expect(h.spawn.calls).toHaveLength(2)

    // 起成功一次（下一拍健康检查过）才清零——"拉起来了"与"接得了活"是两件事
    expect(h.store.get('ws_1')?.restarts).toBe(1)
    await h.service.tick()
    expect(h.store.get('ws_1')?.restarts).toBe(0)

    // 再崩：又从第一级台阶起
    h.spawn.last().crash(1)
    expect(h.store.get('ws_1')?.restarts).toBe(1)
    expect(backoffMs(1)).toBeLessThan(backoffMs(2))
    expect(backoffMs(99)).toBe(300_000)
  })

  it('用户自己停的不会被自动拉起来', async () => {
    const h = harness({ credits: 1000 })
    await h.service.open(OPEN)
    h.service.stop('ws_1')
    expect(h.store.get('ws_1')?.restart_at).toBeUndefined()
    h.clock.advance(10 * 60 * 1000)
    await h.service.tick()
    expect(h.spawn.calls).toHaveLength(1)
  })

  it('云进程自己重启过（库里写着在跑、内存里没有）：下一拍重新拉起来', async () => {
    const h = harness({ credits: 1000 })
    await h.service.open(OPEN)
    await h.service.tick()
    // 模拟云进程重启：另一个 service 拿同一个库
    const h2 = harness({ credits: 1000 })
    const running = h.store.get('ws_1')
    if (running !== undefined) h2.store.put(running)
    await h2.service.tick()
    expect(h2.spawn.calls).toHaveLength(1)
  })
})

describe('导入一个包', () => {
  it('校验不过就不解包，租户目录一个字节都不动', async () => {
    const h = harness({ credits: 1000, packageOk: false })
    await expect(
      h.service.importAndStart({
        org_id: 'org_1',
        account_id: 'acc_1',
        workspace_id: 'ws_1',
        zip: new Uint8Array([1, 2, 3]),
        seats: 1,
      }),
    ).rejects.toMatchObject({ code: 'corrupt_package', status: 422 })
    expect(h.packager.imported).toHaveLength(0)
    expect(h.fs.isEmptyDir('/data/standby/ws_1')).toBe(true)
    // 临时文件收干净了
    expect(h.fs.temps).toHaveLength(0)
    // 一分钱没扣、一个进程没起
    expect(h.wallet.balance('org_1').available).toBe(1000)
    expect(h.spawn.calls).toHaveLength(0)
  })

  it('校验过了就解包并起进程', async () => {
    const h = harness({ credits: 1000 })
    const view = await h.service.importAndStart({
      org_id: 'org_1',
      account_id: 'acc_1',
      workspace_id: 'ws_1',
      zip: new Uint8Array([1, 2, 3]),
      seats: 1,
    })
    expect(h.packager.imported).toEqual(['/data/standby/ws_1'])
    expect(view.status).toBe('starting')
    expect(h.spawn.calls).toHaveLength(1)
  })

  it('已经有数据的工作区不默认覆盖', async () => {
    const h = harness({ credits: 1000 })
    h.fs.dirs.set('/data/standby/ws_1', 9)
    await expect(
      h.service.importAndStart({
        org_id: 'org_1',
        account_id: 'acc_1',
        workspace_id: 'ws_1',
        zip: new Uint8Array([1]),
        seats: 1,
      }),
    ).rejects.toMatchObject({ code: 'conflict' })
  })

  it('正在跑的时候不许导入（一边跑一边换库底下的文件）', async () => {
    const h = harness({ credits: 1000 })
    await h.service.open({ ...OPEN, seats: 1 })
    await expect(
      h.service.importAndStart({
        org_id: 'org_1',
        account_id: 'acc_1',
        workspace_id: 'ws_1',
        zip: new Uint8Array([1]),
        seats: 1,
      }),
    ).rejects.toMatchObject({ code: 'conflict' })
  })

  it('工作区 id 里塞路径一律拒（白名单，不是过滤黑名单）', () => {
    const h = harness({ credits: 1000 })
    expect(() => h.service.get('../../etc')).toThrow(StandbyError)
    expect(() => h.service.get('ws/1')).toThrow(StandbyError)
  })
})

describe('重复开通', () => {
  it('这一期还没到、座位数没变：只重新拉起来，不收第二次钱', async () => {
    const h = harness({ credits: 1000 })
    await h.service.open({ ...OPEN, seats: 1 })
    const after = h.wallet.balance('org_1').available
    await h.service.open({ ...OPEN, seats: 1 })
    expect(h.wallet.balance('org_1').available).toBe(after)
    expect(h.spawn.calls).toHaveLength(1)
  })

  it('别人的工作区开不了', async () => {
    const h = harness({ credits: 1000 })
    await h.service.open(OPEN)
    await expect(h.service.open({ ...OPEN, org_id: 'org_2' })).rejects.toMatchObject({
      code: 'forbidden',
    })
  })
})
