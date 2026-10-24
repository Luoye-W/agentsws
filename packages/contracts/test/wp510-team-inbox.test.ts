/** WP510（决策 1515）：邮箱负责人 → 现在给谁（在的负责人 / 都不在给兜底的人 / 没指定按老规矩）。 */
import { describe, expect, it } from 'vitest'
import { clampAwayDays, isAway, routeToOwners, type TeamMember } from '../src/index.js'

const NOW = '2026-10-25T02:00:00.000Z'
const DAY = 86_400_000
const ago = (days: number): string => new Date(Date.parse(NOW) - days * DAY).toISOString()
const members: TeamMember[] = [
  { person_id: 'wang', name: '王芳', admin: true, last_seen_at: ago(0) },
  { person_id: 'lin', name: '林峰', admin: false, last_seen_at: ago(5) },
  { person_id: 'zhao', name: '赵敏', admin: false },
]

describe('routeToOwners', () => {
  it('没指定（或指定的人不在这个品牌里）→ 空，按老规矩走', () => {
    const r = routeToOwners({
      owners: ['ghost'],
      members,
      now: NOW,
      away_days: 3,
      fallbackPeople: ['wang'],
    })
    expect(r).toEqual({ to: [], owners: [], fallback: false, away: [] })
  })

  it('有人在就给在的那几位；都不在给兜底的人；兜底一个都没有还给负责人', () => {
    expect(
      routeToOwners({
        owners: ['lin', 'zhao'],
        members,
        now: NOW,
        away_days: 3,
        fallbackPeople: ['wang'],
      }).to,
    ).toEqual(['zhao'])
    expect(
      routeToOwners({ owners: ['lin'], members, now: NOW, away_days: 3, fallbackPeople: ['wang'] }),
    ).toEqual({ to: ['wang'], owners: ['lin'], fallback: true, away: ['lin'] })
    expect(
      routeToOwners({ owners: ['lin'], members, now: NOW, away_days: 7, fallbackPeople: ['wang'] })
        .to,
    ).toEqual(['lin'])
    expect(
      routeToOwners({ owners: ['lin'], members, now: NOW, away_days: 3, fallbackPeople: [] }),
    ).toMatchObject({ to: ['lin'], fallback: false })
  })

  it('没上线记录不算不在；天数夹在 1–30', () => {
    expect(isAway({}, NOW, 1)).toBe(false)
    expect(isAway({ last_seen_at: ago(2) }, NOW, 1)).toBe(true)
    expect(clampAwayDays(0)).toBe(1)
    expect(clampAwayDays(99)).toBe(30)
    expect(clampAwayDays(Number.NaN)).toBe(3)
  })
})
