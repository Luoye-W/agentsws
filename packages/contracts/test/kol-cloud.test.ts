/*
 * 67 的两条契约级规则：同步的胜负判定、订阅状态与同步权的对应。
 *
 * 这两条为什么值得单独钉住：它们是**两头各算一次**的规则。云端和本地各有一份
 * 实现路径，只要两边对「谁赢」的判断差一点，同步就永远收敛不了——两台机器会
 * 互相推翻对方，用户看到的是红人库自己在变。
 */
import { describe, expect, it } from 'vitest'
import {
  emptyKolSubscription,
  isKolObjectKind,
  KOL_OBJECT_KINDS,
  KOL_SERVICE_CAPABILITY,
  KOL_SERVICE_CREDITS_PER_MONTH,
  KOL_SERVICE_GRACE_DAYS,
  KOL_SERVICE_STATUSES,
  type KolSyncObject,
  kolSyncAllowed,
  kolWinsOver,
} from '../src/kol-cloud.js'

const obj = (over: Partial<KolSyncObject> = {}): KolSyncObject => ({
  kind: 'creator',
  id: 'c1',
  version: 1,
  updated_at: '2026-09-19T10:00:00.000Z',
  writer: 'device:a',
  ...over,
})

describe('最后写入者胜', () => {
  it('更晚的赢', () => {
    const older = obj({ updated_at: '2026-09-19T10:00:00.000Z' })
    const newer = obj({ updated_at: '2026-09-19T10:00:01.000Z' })
    expect(kolWinsOver(newer, older)).toBe(true)
    expect(kolWinsOver(older, newer)).toBe(false)
  })

  it('同一刻就比版本号——版本号是每对象自己数的，不是时间', () => {
    const v1 = obj({ version: 1 })
    const v2 = obj({ version: 2 })
    expect(kolWinsOver(v2, v1)).toBe(true)
    expect(kolWinsOver(v1, v2)).toBe(false)
  })

  it('时间与版本都一样就比 writer——为的是两头算出同一个结果，不是公平', () => {
    const a = obj({ writer: 'device:a' })
    const b = obj({ writer: 'device:b' })
    expect(kolWinsOver(b, a)).toBe(true)
    expect(kolWinsOver(a, b)).toBe(false)
  })

  it('完全相同的两份谁也不盖谁（反复推同一条不该每次都算一次冲突）', () => {
    expect(kolWinsOver(obj(), obj())).toBe(false)
  })

  it('判定是反对称的：任取两份，最多一份赢（否则同步不收敛）', () => {
    const samples = [
      obj(),
      obj({ version: 2 }),
      obj({ writer: 'device:z' }),
      obj({ updated_at: '2026-09-20T00:00:00.000Z' }),
      obj({ updated_at: '2026-09-20T00:00:00.000Z', version: 9, writer: 'cloud' }),
    ]
    for (const x of samples) {
      for (const y of samples) {
        expect(kolWinsOver(x, y) && kolWinsOver(y, x), `${x.writer}/${y.writer}`).toBe(false)
      }
    }
  })
})

describe('订阅状态与同步权', () => {
  it('只有 active 与 cancelling 能同步——欠费不删数据，但也不继续同步', () => {
    expect(kolSyncAllowed('active')).toBe(true)
    // 取消了当期还能用完
    expect(kolSyncAllowed('cancelling')).toBe(true)
    expect(kolSyncAllowed('grace')).toBe(false)
    expect(kolSyncAllowed('suspended')).toBe(false)
    expect(kolSyncAllowed('none')).toBe(false)
  })

  it('五态齐全，没开通过的那一态能渲染（不是 undefined）', () => {
    expect(KOL_SERVICE_STATUSES).toHaveLength(5)
    const empty = emptyKolSubscription('org_1', '2026-09-19T10:00:00.000Z')
    expect(empty.status).toBe('none')
    // 云端有多少条不在订阅上（那是同步的事，见 `KolSyncStatus`）：订阅这一层
    // 是通用的，客服那个服务根本没有「对象数」这回事
    expect(empty.service_id).toBe(KOL_SERVICE_CAPABILITY)
    expect(empty.granted_months).toBe(0)
    expect(empty.cancel_at_period_end).toBe(false)
  })

  it('30 积分 / 月、宽限 30 天（Luoye 2026-09-19 定）', () => {
    expect(KOL_SERVICE_CREDITS_PER_MONTH).toBe(30)
    expect(KOL_SERVICE_GRACE_DAYS).toBe(30)
  })
})

describe('对象种类', () => {
  it('本地那六张表都在，不认识的种类当场认出来', () => {
    for (const kind of [
      'creator',
      'platform_account',
      'creator_contact',
      'collaboration',
      'deliverable',
      'tracked_link',
    ]) {
      expect(KOL_OBJECT_KINDS).toContain(kind)
    }
    expect(isKolObjectKind('creator')).toBe(true)
    expect(isKolObjectKind('orders')).toBe(false)
    expect(isKolObjectKind('')).toBe(false)
  })
})
