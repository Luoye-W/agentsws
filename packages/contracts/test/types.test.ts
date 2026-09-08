import { describe, expect, it } from 'vitest'
import type { ApprovalItem, StagedChange, RunRequest } from '../src/index.js'
import { SENSITIVITY_ORDER } from '../src/index.js'

describe('contracts', () => {
  it('sensitivity order is total', () => {
    expect(SENSITIVITY_ORDER).toEqual(['public', 'internal', 'confidential', 'restricted'])
  })
  it('types compile for the canonical example (14 §12 / 15 §9)', () => {
    const change: Pick<StagedChange, 'kind' | 'risk_class' | 'status'> = { kind: 'refund', risk_class: 'medium', status: 'staged' }
    const item: Pick<ApprovalItem, 'kind' | 'state' | 'revision'> = { kind: 'outbound_draft', state: 'pending', revision: 1 }
    const req: Pick<RunRequest, 'kind' | 'tools'> = { kind: 'work_item', tools: { allow: [], connect_token: 't', side_effect_policy: 'executor' } }
    expect([change.kind, item.kind, req.kind]).toEqual(['refund', 'outbound_draft', 'work_item'])
  })
})
