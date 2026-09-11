import type { FactCard, Provenance, RangeRef } from '@agentsws/contracts'
import { sensitivityRank } from './visibility.js'

export interface CardRow {
  id: string
  schema_version: number
  workspace_id: string
  layer: string
  domain: string
  scope_json: string
  sensitivity: string
  sensitivity_rank: number
  subject_type: string
  subject_id: string | null
  subject_key: string
  statement: string
  structured_json: string | null
  provenance_json: string
  confidence_value: number
  confidence_state: string
  conflicts_json: string
  valid_from: string | null
  valid_until: string | null
  as_of: string | null
  downgraded_from: string | null
  usage_recalled: number
  usage_cited: number
  usage_last_recalled_at: string | null
  usage_drafts_edited: number
  status: string
  owner: string
  created_by_kind: string
  created_by_id: string
  created_at: string
  updated_at: string
}

export const CARD_COLUMNS = [
  'id',
  'schema_version',
  'workspace_id',
  'layer',
  'domain',
  'scope_json',
  'sensitivity',
  'sensitivity_rank',
  'subject_type',
  'subject_id',
  'subject_key',
  'statement',
  'structured_json',
  'provenance_json',
  'confidence_value',
  'confidence_state',
  'conflicts_json',
  'valid_from',
  'valid_until',
  'as_of',
  'downgraded_from',
  'usage_recalled',
  'usage_cited',
  'usage_last_recalled_at',
  'usage_drafts_edited',
  'status',
  'owner',
  'created_by_kind',
  'created_by_id',
  'created_at',
  'updated_at',
] as const

export function rowToCard(row: CardRow): FactCard {
  const valid: FactCard['valid'] = {}
  if (row.valid_from !== null) valid.from = row.valid_from
  if (row.valid_until !== null) valid.until = row.valid_until

  const subject: FactCard['subject'] = { type: row.subject_type, key: row.subject_key }
  if (row.subject_id !== null) subject.id = row.subject_id

  const usage: FactCard['usage'] = {
    recalled: row.usage_recalled,
    cited: row.usage_cited,
    drafts_edited_after_cite: row.usage_drafts_edited,
  }
  if (row.usage_last_recalled_at !== null) usage.last_recalled_at = row.usage_last_recalled_at

  const conflicts = JSON.parse(row.conflicts_json) as FactCard['conflicts']
  const card: FactCard = {
    id: row.id,
    schema_version: 1,
    workspace_id: row.workspace_id,
    layer: row.layer as FactCard['layer'],
    domain: row.domain as FactCard['domain'],
    scope: JSON.parse(row.scope_json) as RangeRef[],
    sensitivity: row.sensitivity as FactCard['sensitivity'],
    subject,
    statement: row.statement,
    provenance: JSON.parse(row.provenance_json) as Provenance[],
    confidence: {
      value: row.confidence_value,
      state: row.confidence_state as FactCard['confidence']['state'],
    },
    valid,
    usage,
    status: row.status as FactCard['status'],
    owner: row.owner,
    created_by: {
      kind: row.created_by_kind as FactCard['created_by']['kind'],
      id: row.created_by_id,
    },
    created_at: row.created_at,
    updated_at: row.updated_at,
  }
  if (row.as_of !== null) card.as_of = row.as_of
  if (row.downgraded_from !== null) card.downgraded_from = row.downgraded_from as FactCard['layer']
  if (row.structured_json !== null)
    card.structured = JSON.parse(row.structured_json) as Record<string, unknown>
  if (conflicts && conflicts.length > 0) card.conflicts = conflicts
  return card
}

export function cardToRowValues(card: FactCard): (string | number | null)[] {
  return [
    card.id,
    card.schema_version,
    card.workspace_id,
    card.layer,
    card.domain,
    JSON.stringify(card.scope),
    card.sensitivity,
    sensitivityRank(card.sensitivity),
    card.subject.type,
    card.subject.id ?? null,
    card.subject.key,
    card.statement,
    card.structured === undefined ? null : JSON.stringify(card.structured),
    JSON.stringify(card.provenance),
    card.confidence.value,
    card.confidence.state,
    JSON.stringify(card.conflicts ?? []),
    card.valid.from ?? null,
    card.valid.until ?? null,
    card.as_of ?? null,
    card.downgraded_from ?? null,
    card.usage.recalled,
    card.usage.cited,
    card.usage.last_recalled_at ?? null,
    card.usage.drafts_edited_after_cite,
    card.status,
    card.owner,
    card.created_by.kind,
    card.created_by.id,
    card.created_at,
    card.updated_at,
  ]
}

/** 卡片的可检索文本：陈述 + 主题键 + 结构化值。 */
export function searchableText(card: FactCard): string {
  const structured =
    card.structured === undefined
      ? []
      : Object.entries(card.structured).map(([k, v]) => `${k} ${String(v)}`)
  return [card.subject.key, card.statement, ...structured].join(' \n ')
}
