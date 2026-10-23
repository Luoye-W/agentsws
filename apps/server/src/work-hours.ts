/**
 * WP474（决策 1530）：「我的作息」——每人一份，只影响「帮我排进空档」的候选。
 *
 * 存在品牌目录下的 `work-hours.json`（`{ [person_id]: WorkHours }`）；没有数据目录就是内存档。
 * 读坏了 / 没设过 = 默认（9:00–18:00、不排周末、直播前后 30 分钟、不避午饭）。
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import type { PersonId, WorkHours } from '@agentsws/contracts'
import { normalizeWorkHours } from '@agentsws/work'

export interface WorkHoursStore {
  get(person_id: PersonId): WorkHours
  set(person_id: PersonId, next: WorkHours): WorkHours
}

export function createWorkHoursStore(file?: string): WorkHoursStore {
  let state: Record<string, unknown> = {}
  if (file !== undefined && existsSync(file)) {
    try {
      const parsed = JSON.parse(readFileSync(file, 'utf8')) as unknown
      if (parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed))
        state = parsed as Record<string, unknown>
    } catch {
      // 只是偏好：读坏了就当没设过
    }
  }
  const save = (): void => {
    if (file === undefined) return
    mkdirSync(dirname(file), { recursive: true })
    writeFileSync(file, `${JSON.stringify(state, null, 2)}\n`, 'utf8')
  }
  return {
    get: (person_id) => normalizeWorkHours(state[person_id]),
    set: (person_id, next) => {
      const clean = normalizeWorkHours(next)
      state = { ...state, [person_id]: clean }
      save()
      return clean
    },
  }
}
