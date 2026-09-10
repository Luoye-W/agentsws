import type { Clock } from '@agentsws/contracts'
import type { CatalogEntry, CatalogSource } from '../src/index.js'

export const WS = 'ws_1'

export function fixedClock(at = '2026-09-10T00:00:00.000Z'): Clock {
  let now = at
  return {
    now: () => now,
    // 测试里要往前走时间就直接改（不用 Date.now）
    set: (next: string) => {
      now = next
    },
  } as Clock & { set(next: string): void }
}

export function entry(
  patch: Partial<CatalogEntry> & Pick<CatalogEntry, 'id' | 'title'>,
): CatalogEntry {
  return {
    kind: 'schedule',
    summary: '',
    owner: 'p_li',
    layer: 'personal',
    used_by_positions: [],
    runs_30d: 0,
    workspace_id: WS,
    ...patch,
  }
}

export function source(kind: CatalogEntry['kind'], entries: CatalogEntry[]): CatalogSource {
  return { kind, list: () => entries }
}
