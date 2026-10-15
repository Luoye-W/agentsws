/**
 * WP341 追加（849，Luoye 10-15 改）：AI 回话里外部图片的**域名白名单**（品牌级）。
 *
 * 像邮箱里「始终显示这个发件人的图片」：对话里点「以后这个网站的图都直接显示」，或在设置里手动加，就记进这个品牌的名单；
 * 名单里的域名（连子域名）以后的图直接加载，其余照旧先「点开看 · 域名」。已连店铺的域名由调用方另给（自动算、删不掉）。
 *
 * 一个 JSON 文件跟着数据目录走（`genui-image-hosts.json`，按工作区分开；没有数据目录 = 内存档）。读坏了当空名单——它只是偏好。
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { GENUI_IMAGE_HOSTS_MAX, type GenuiImageHost, normalizeGenuiHost } from '@agentsws/contracts'

export interface GenuiImageHostsStore {
  list(workspace_id: string): GenuiImageHost[]
  /** 加一个（已经有了原样回）；不像域名回 `undefined`。 */
  add(workspace_id: string, input: string, at: string): GenuiImageHost | undefined
  remove(workspace_id: string, host: string): boolean
}

export function createGenuiImageHosts(options: { dir?: string } = {}): GenuiImageHostsStore {
  const file = options.dir === undefined ? undefined : join(options.dir, 'genui-image-hosts.json')
  let state: Record<string, GenuiImageHost[]> = {}
  if (file !== undefined && existsSync(file)) {
    try {
      const parsed = JSON.parse(readFileSync(file, 'utf8')) as Record<string, unknown>
      for (const [ws, rows] of Object.entries(parsed))
        if (Array.isArray(rows))
          state[ws] = rows.filter(
            (r): r is GenuiImageHost =>
              typeof (r as GenuiImageHost)?.host === 'string' &&
              typeof (r as GenuiImageHost)?.added_at === 'string',
          )
    } catch {
      state = {}
    }
  }
  const save = (): void => {
    if (file === undefined) return
    mkdirSync(dirname(file), { recursive: true })
    writeFileSync(file, `${JSON.stringify(state, null, 2)}\n`, 'utf8')
  }
  return {
    list: (ws) => [...(state[ws] ?? [])],
    add(ws, input, at) {
      const host = normalizeGenuiHost(input)
      if (host === undefined) return undefined
      const rows = state[ws] ?? []
      const hit = rows.find((r) => r.host === host)
      if (hit !== undefined) return hit
      const row = { host, added_at: at }
      state[ws] = [row, ...rows].slice(0, GENUI_IMAGE_HOSTS_MAX)
      save()
      return row
    },
    remove(ws, input) {
      const host = normalizeGenuiHost(input) ?? input
      const rows = state[ws] ?? []
      const next = rows.filter((r) => r.host !== host)
      if (next.length === rows.length) return false
      state[ws] = next
      save()
      return true
    },
  }
}
