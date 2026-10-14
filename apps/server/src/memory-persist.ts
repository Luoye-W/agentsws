/**
 * WP320：记忆落盘。
 *
 * 技能库一直是内存的（WP36 / WP71 记过「重启即失」）——手动加的、提升批下来的、AI 随工作记下的，
 * 进程一重启全没了。「AI 自动记」要是记了第二天就忘，等于没做，所以这一单把它补上：
 *
 * - 存什么：技能库包基础层**以外**的记录与 overlay（`exportUpperLayers`）+ 记忆账本（来历 / 变更 /
 *   墓碑）。包基础层每次启动从软件里重新种，不存。
 * - 存哪：数据目录下一个 `memory-layers.json`（没有数据目录 = 全内存档，什么都不落）。
 * - 什么时候：启动时装回来（在种完自带技能之后）；之后上层或账本一变就攒一下、同一轮里只写一次；
 *   关进程时再写一次。写法是先写临时文件再改名——写到一半断电，旧的那份还在。
 * - 读坏了：当没有（记一行日志），不让服务起不来。
 */
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { MemorySkillRegistry, SkillUpperLayers } from '@agentsws/skills'
import type { MemoryBook, MemoryBookSnapshot } from './memory-book.js'

export const MEMORY_LAYERS_FILE = 'memory-layers.json'

interface MemoryLayersFile {
  version: 1
  saved_at: string
  layers: SkillUpperLayers
  book: MemoryBookSnapshot
}

export interface MemoryPersistence {
  /** 启动时装回来了几条。 */
  loaded: { records: number; overlays: number }
  /** 现在就写（测试与关进程用）。 */
  flush(): void
  close(): void
}

export function attachMemoryPersistence(options: {
  dir?: string
  registry: MemorySkillRegistry
  book: MemoryBook
  now: () => string
  log?: (line: string) => void
}): MemoryPersistence {
  const { dir, registry, book } = options
  if (dir === undefined)
    return { loaded: { records: 0, overlays: 0 }, flush: () => undefined, close: () => undefined }
  const file = join(dir, MEMORY_LAYERS_FILE)
  let loaded = { records: 0, overlays: 0 }
  if (existsSync(file)) {
    try {
      const parsed = JSON.parse(readFileSync(file, 'utf8')) as Partial<MemoryLayersFile>
      if (parsed.layers !== undefined) loaded = registry.importUpperLayers(parsed.layers)
      if (parsed.book !== undefined) book.restore(parsed.book)
    } catch (err) {
      options.log?.(
        `memory-layers.json 读不了，当没有：${err instanceof Error ? err.message : String(err)}`,
      )
    }
  }

  let dirty = false
  let closed = false
  const flush = (): void => {
    dirty = false
    const body: MemoryLayersFile = {
      version: 1,
      saved_at: options.now(),
      layers: registry.exportUpperLayers(),
      book: book.snapshot(),
    }
    try {
      mkdirSync(dir, { recursive: true })
      const tmp = `${file}.tmp`
      writeFileSync(tmp, `${JSON.stringify(body)}\n`, 'utf8')
      renameSync(tmp, file)
    } catch (err) {
      options.log?.(`记忆落盘失败：${err instanceof Error ? err.message : String(err)}`)
    }
  }
  const schedule = (): void => {
    if (closed || dirty) return
    dirty = true
    // 一次写记忆常常连着改好几处（记录 + 账本）：攒到这一轮结束再写一次
    queueMicrotask(() => {
      if (dirty && !closed) flush()
    })
  }
  const offRegistry = registry.onChange(schedule)
  const offBook = book.onChange(schedule)
  return {
    loaded,
    flush,
    close() {
      if (closed) return
      offRegistry()
      offBook()
      flush()
      closed = true
    },
  }
}
