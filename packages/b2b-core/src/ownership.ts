/**
 * 离职交接 `buildTransferPlan`（docs/84 §3.2：业务员走了，客户、商机、未回询盘按规则分给接手的人，出一张卡给老板批）。
 *
 * 出处：Luoye/BtoBAgents（Luoye 自己的私有仓库，本机 `~/Documents/BtoBAgents`）
 * `src/features/btobagents/domain/ownership.ts`，首次 `5d4ed9c`、`29f93fe` 改过、`c832e1e` 改名，移植时仓库 HEAD `940f12b`。
 * 不在 KOLAgents 纯模板提交 `cb506142` 里（业务文件，非 MkSaaS 模板）。
 *
 * 移植改动：字段改成本仓的 snake_case（`owner_id` / `successor_id` / `value_usd` / `product_line`）；`kind` 加一种 `inquiry`（未回的询盘，docs/84 §3.2 点名要交接的）。规则匹配顺序（第一条命中的规则生效）与合计口径原样。
 */
export interface OwnedRecord {
  id: string
  kind: 'account' | 'deal' | 'task' | 'mission' | 'approval' | 'meeting' | 'inquiry'
  owner_id: string
  value_usd?: number
  region?: string
  product_line?: string
}

export interface TransferRule {
  successor_id: string
  kinds?: OwnedRecord['kind'][]
  region?: string
  product_line?: string
}

export interface TransferPlan {
  assignments: Array<OwnedRecord & { successor_id: string }>
  unassigned: OwnedRecord[]
  totals: {
    records: number
    accounts: number
    deals: number
    value_usd: number
  }
}

export function buildTransferPlan(
  departingUserId: string,
  records: OwnedRecord[],
  rules: TransferRule[],
): TransferPlan {
  const ownedRecords = records.filter((record) => record.owner_id === departingUserId)
  const assignments: TransferPlan['assignments'] = []
  const unassigned: OwnedRecord[] = []

  for (const record of ownedRecords) {
    const rule = rules.find((candidate) => {
      const kindMatches = !candidate.kinds || candidate.kinds.includes(record.kind)
      const regionMatches = !candidate.region || candidate.region === record.region
      const productMatches =
        !candidate.product_line || candidate.product_line === record.product_line
      return kindMatches && regionMatches && productMatches
    })

    if (!rule) {
      unassigned.push(record)
      continue
    }

    assignments.push({ ...record, successor_id: rule.successor_id })
  }

  return {
    assignments,
    unassigned,
    totals: {
      records: ownedRecords.length,
      accounts: ownedRecords.filter((record) => record.kind === 'account').length,
      deals: ownedRecords.filter((record) => record.kind === 'deal').length,
      value_usd: ownedRecords.reduce((total, record) => total + (record.value_usd ?? 0), 0),
    },
  }
}
