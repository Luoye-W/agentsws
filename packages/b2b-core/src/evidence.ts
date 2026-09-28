/**
 * 证据分级 `decideEvidence`（docs/84 §2.5：和 prospecting 打分合成一个）。
 *
 * 出处：Luoye/BtoBAgents（Luoye 自己的私有仓库，本机 `~/Documents/BtoBAgents`）
 * `src/features/btobagents/domain/evidence.ts`，首次 `5d4ed9c`、`29f93fe` 改过、`c832e1e` 改名，移植时仓库 HEAD `940f12b`。
 * 不在 KOLAgents 纯模板提交 `cb506142` 里（业务文件，非 MkSaaS 模板）。
 *
 * 移植改动：只把字段改成本仓的 snake_case（`source_id` / `can_apply_automatically`），权重、分档线（90 / 55）与文案原样。技能讲"怎么判断"，这里算"几分、哪一档、能不能自动写进客户库"，同一套权重。
 */
export type EvidenceKind =
  | 'crm.thread-reply'
  | 'crm.signature-block'
  | 'crm.meeting-attendance'
  | 'profile.email-match'
  | 'linkedin.employer-and-name'
  | 'document.primary'
  | 'crm.imported-field'
  | 'web.cited-claim'
  | 'search.cites-profile'
  | 'employer-only'
  | 'contradiction'

export type EvidenceBand = 'verified' | 'probable' | 'possible' | 'held'

export interface EvidenceObservation {
  kind: EvidenceKind
  source_id: string
  detail: string
}

export interface EvidenceDecision {
  band: EvidenceBand
  score: number
  can_apply_automatically: boolean
  reason: string
}

/** 签名、回信、名片（会议出席）算强证据；只知道公司名算弱证据；来源矛盾挂起。 */
export const EVIDENCE_WEIGHTS: Readonly<Record<EvidenceKind, number>> = {
  'crm.thread-reply': 100,
  'crm.signature-block': 95,
  'crm.meeting-attendance': 90,
  'profile.email-match': 100,
  'linkedin.employer-and-name': 90,
  'document.primary': 90,
  'crm.imported-field': 55,
  'web.cited-claim': 40,
  'search.cites-profile': 25,
  'employer-only': 10,
  contradiction: -1000,
}

export function decideEvidence(observations: EvidenceObservation[]): EvidenceDecision {
  if (observations.some((observation) => observation.kind === 'contradiction')) {
    return {
      band: 'held',
      score: 0,
      can_apply_automatically: false,
      reason: '来源互相矛盾，必须由团队成员确认。',
    }
  }

  // 同一个来源只算它最强的那一条：两个以上独立来源才会叠上去
  const independentSources = new Map<string, number>()
  for (const observation of observations) {
    const current = independentSources.get(observation.source_id) ?? 0
    independentSources.set(
      observation.source_id,
      Math.max(current, EVIDENCE_WEIGHTS[observation.kind]),
    )
  }

  const score = Math.min(
    100,
    [...independentSources.values()].reduce((total, weight) => total + weight, 0),
  )

  if (score >= 90) {
    return {
      band: 'verified',
      score,
      can_apply_automatically: true,
      reason: '存在可独立确认该事实的强证据。',
    }
  }

  if (score >= 55) {
    return {
      band: 'probable',
      score,
      can_apply_automatically: false,
      reason: '证据较强，但仍应由成员快速确认。',
    }
  }

  return {
    band: 'possible',
    score,
    can_apply_automatically: false,
    reason: '仅有弱证据，保留为候选建议，不写入正式事实。',
  }
}
