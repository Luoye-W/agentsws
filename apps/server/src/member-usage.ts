/**
 * WP282（决策 281 / 286–290）：按人看积分——本机这一头的两件事。
 *
 * 1. **谁看得到谁**（判在本机：云上一把工作区令牌分不出本机里谁是谁，WP279 §1.3）：
 *    ② 同事互联谁都看全员；③ 公司集体 owner / admin 看全员、别人只看自己；① 个人只有自己。
 * 2. **把云上那一份补齐**：云上只回有用量的人（决策 290），本机按名册补 0 行、补名字。
 *
 * 纯函数，不打云、不读库——`cloud.ts` 装配时调。
 */
import type { MemberUsageReport, MemberUsageRow, OrganizationMode } from '@agentsws/contracts'
import { emptyMemberUsageBlocks } from '@agentsws/contracts'

export type MemberUsageScope = 'all' | 'self'

/** 这个人在这种用法下能看多少。`manager` = 公司的 owner / admin（只有 ③ 用得上）。 */
export function memberUsageScopeOf(mode: OrganizationMode, manager: boolean): MemberUsageScope {
  if (mode === 'peers') return 'all'
  if (mode === 'company') return manager ? 'all' : 'self'
  return 'self'
}

const zeroRow = (key: string, name: string | undefined): MemberUsageRow => ({
  key,
  ...(name === undefined ? {} : { name }),
  credits: 0,
  quantity: 0,
  calls: 0,
  blocks: emptyMemberUsageBlocks(),
})

/**
 * 云上的按人报表 → 界面上那一份：名字用本机名册补（云上有就用云上的——停用的人云上记着停用那一刻的名字），
 * `all` 时名册里还在、但这段时间没用量的人补 0 行（排在有用量的人后面，按名册顺序）；
 * `self` 时只留本人一行（没用量补 0），「没标注」清零（那不是他的）。
 */
export function fillMemberUsage(
  report: MemberUsageReport,
  input: {
    scope: MemberUsageScope
    self: string
    /** 成员 id → 名字（含离开了的人，翻名字用）。 */
    names: Readonly<Record<string, string>>
    /** 还在的成员 id（补 0 行用；不给就不补）。 */
    active?: readonly string[] | undefined
  },
): MemberUsageReport {
  const named = (row: MemberUsageRow): MemberUsageRow => {
    const name = row.name ?? input.names[row.key]
    return name === undefined ? row : { ...row, name }
  }
  if (input.scope === 'self') {
    const mine = report.rows.find((r) => r.key === input.self)
    const row = named(mine ?? zeroRow(input.self, undefined))
    return {
      ...report,
      rows: [row],
      unattributed: { credits: 0, quantity: 0, calls: 0, blocks: emptyMemberUsageBlocks() },
      total_credits: row.credits,
    }
  }
  const rows = report.rows.map(named)
  const seen = new Set(rows.map((r) => r.key))
  for (const id of input.active ?? []) {
    if (seen.has(id)) continue
    seen.add(id)
    rows.push(zeroRow(id, input.names[id]))
  }
  return { ...report, rows }
}
