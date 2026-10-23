/**
 * WP483（决策 1660）：岗位上的「发之前让我看一眼」——**默认关**。
 *
 * 关着：要批的卡批了（或不用批的到点了），工坊在 ego 里填好就**直接点发送**，发完读回、记「已发 · 已记录」。
 * 开着：工坊在 ego 里填好、把页面留给人，人自己点发送；之后工坊隔一阵读回一次「发了没有」。
 *
 * 每个品牌一份（`<品牌目录>/write-review.json`），按岗位 id 记。只记开着的那几个岗位。
 */
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { WriteReviewSetting } from '@agentsws/contracts'

interface FileShape {
  version: 1
  /** 开着「发之前让我看一眼」的岗位。 */
  positions: string[]
}

export interface WriteReviewSettings {
  get(position_id: string): WriteReviewSetting
  set(position_id: string, on: boolean): WriteReviewSetting
  /** 开着的那几个岗位。 */
  list(): string[]
}

export function createWriteReviewSettings(options: { dir?: string } = {}): WriteReviewSettings {
  const file = options.dir === undefined ? undefined : join(options.dir, 'write-review.json')
  const on = new Set<string>(
    (() => {
      if (file === undefined || !existsSync(file)) return []
      try {
        const raw = JSON.parse(readFileSync(file, 'utf8')) as FileShape
        return raw.version === 1 && Array.isArray(raw.positions)
          ? raw.positions.filter((x): x is string => typeof x === 'string')
          : []
      } catch {
        return []
      }
    })(),
  )
  const save = (): void => {
    if (file === undefined || options.dir === undefined) return
    mkdirSync(options.dir, { recursive: true })
    const tmp = `${file}.tmp`
    writeFileSync(
      tmp,
      JSON.stringify({ version: 1, positions: [...on].sort() } satisfies FileShape),
    )
    renameSync(tmp, file)
  }
  return {
    get: (position_id) => ({ position_id, review_before_send: on.has(position_id) }),
    set(position_id, value) {
      if (value) on.add(position_id)
      else on.delete(position_id)
      save()
      return { position_id, review_before_send: value }
    },
    list: () => [...on].sort(),
  }
}
