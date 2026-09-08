import type { Clock, RoleId } from '@agentsws/contracts'
import type { RoleDefinitionFull } from '../src/index.js'
import { loadBundledPosition, loadBundledRole } from '../src/index.js'

/** 合成时钟：不用 Date.now()。 */
export function fixedClock(
  start = '2026-09-09T00:00:00.000Z',
): Clock & { advance(ms: number): void } {
  let t = Date.parse(start)
  return {
    now: () => new Date(t).toISOString(),
    advance(ms: number) {
      t += ms
    },
  }
}

export const aftersales = (): RoleDefinitionFull => loadBundledRole('dtc.aftersales')
export const member = (): RoleDefinitionFull => loadBundledRole('common.member')
export const owner = (): RoleDefinitionFull => loadBundledRole('common.owner')
export const dtcOps = () => loadBundledPosition('dtc-ops')

/** 04 §1.11 里默认包的其余职责在本包还没有 YAML，用最小定义占位，只为测岗位展开。 */
export function stubRole(id: RoleId): RoleDefinitionFull {
  return {
    id,
    version: '1.0.0',
    domain: 'dtc',
    name: { zh: id, en: id },
    description: `stub ${id}`,
    scopes: [{ domain: 'order', ops: ['read'], range: 'assigned', max_sensitivity: 'internal' }],
    connectors: [],
    actions: [],
    automation: {},
    skills: [],
    home_blocks: [],
    notifications: [],
    handover: {
      transfers: ['open_work_items'],
      fallback: 'owner',
      revoke_context_on_removal: true,
    },
  }
}
