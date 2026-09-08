/** 05 §2 / 04 §1.11：岗位模板只在分配那一刻展开成一组 Assignment。 */
import type {
  Assignment,
  Clock,
  Level,
  Mandate,
  PersonId,
  RangeRef,
  RoleId,
  WorkspaceId,
} from '@agentsws/contracts'
import { type Position, type RoleDefinitionFull, RoleError, type RoleResolver } from './types.js'

export interface AssignmentInit {
  person_id: PersonId
  workspace_id: WorkspaceId
  role: RoleDefinitionFull
  ranges: RangeRef[]
  granted_by: PersonId
  mandate_overrides?: Record<string, Partial<Mandate>>
}

export interface AssignmentFactoryOptions {
  clock: Clock
  newId: (init: AssignmentInit, at: string) => string
}

/** 新分配的自动化状态：等级从 Role.automation[action].initial 起（05 §1.4）。 */
export function initialAutomationState(
  role: RoleDefinitionFull,
  at: string,
): Assignment['automation_state'] {
  const state: Assignment['automation_state'] = {}
  for (const [actionId, spec] of Object.entries(role.automation)) {
    const level: Level = spec.initial
    state[actionId] = {
      level,
      adoption: { accepted: 0, edited: 0, rejected: 0, since: at },
      last_change: { at, reason: 'assignment_created' },
    }
  }
  return state
}

export function buildAssignment(
  init: AssignmentInit,
  options: AssignmentFactoryOptions,
): Assignment {
  const at = options.clock.now()
  return {
    id: options.newId(init, at),
    person_id: init.person_id,
    workspace_id: init.workspace_id,
    role_id: init.role.id,
    role_version: init.role.version,
    ranges: [...init.ranges],
    ...(init.mandate_overrides ? { mandate_overrides: init.mandate_overrides } : {}),
    automation_state: initialAutomationState(init.role, at),
    granted_by: init.granted_by,
    granted_at: at,
  }
}

export interface ApplyPositionOptions extends AssignmentFactoryOptions {
  granted_by: PersonId
  /** 必填：授予时要记下当时的 role_version，解析不到的职责不许授予。 */
  roles: RoleResolver
  /** 除默认包外额外勾选的职责（05 §2 里 default=false 的可勾选项）。 */
  include?: RoleId[]
}

/**
 * 展开岗位模板：只展开 `default: true` 的职责，外加显式勾选的可选项。
 * 之后改模板不影响已分配的人（05 §2）。
 */
export function applyPosition(
  position: Position,
  person: PersonId,
  workspace: WorkspaceId,
  ranges: RangeRef[],
  options: ApplyPositionOptions,
): Assignment[] {
  const extra = new Set(options.include ?? [])
  const unknown = [...extra].filter((id) => !position.roles.some((r) => r.role === id))
  if (unknown.length > 0)
    throw new RoleError(
      'invalid_input',
      `position ${position.id} does not offer role(s): ${unknown.join(', ')}`,
    )
  const wanted = position.roles.filter((r) => r.default || extra.has(r.role))
  return wanted.map((entry) => {
    const role = options.roles(entry.role)
    if (!role)
      throw new RoleError(
        'not_found',
        `role definition ${entry.role} is not loaded; cannot record role_version`,
      )
    return buildAssignment(
      { person_id: person, workspace_id: workspace, role, ranges, granted_by: options.granted_by },
      options,
    )
  })
}
