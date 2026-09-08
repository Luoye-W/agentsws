import type { Clock } from '@agentsws/contracts'
import { createUlidFactory, type IdFactory } from './ids.js'
import { type LessonPoolOptions, MemoryLessonPool } from './lessons.js'
import { MemorySkillRegistry } from './registry.js'
import { createFileSidecarStore, createMemorySidecarStore, type SidecarStore } from './sidecar.js'

export * from './errors.js'
export * from './frontmatter.js'
export * from './ids.js'
export * from './lessons.js'
export * from './parse.js'
export * from './registry.js'
export * from './sidecar.js'
export * from './text.js'

export interface CreateSkillsOptions extends LessonPoolOptions {
  clock: Clock
  /** 注入的随机源（seed 化），不用裸 Math.random */
  random: () => number
  /** 给定目录则把 `<skill>.sections.json` sidecar 落盘，跨进程保持段 id */
  dir?: string
}

export interface Skills {
  registry: MemorySkillRegistry
  lessons: MemoryLessonPool
  sidecar: SidecarStore
  nextId: IdFactory
}

/** WP6 组装入口：内存实现 + 可选文件目录持久 sidecar。 */
export function createSkills(options: CreateSkillsOptions): Skills {
  const nextId = createUlidFactory(options.clock, options.random)
  const sidecar =
    options.dir === undefined ? createMemorySidecarStore() : createFileSidecarStore(options.dir)
  const registry = new MemorySkillRegistry(sidecar, nextId)
  const lessons = new MemoryLessonPool(registry, options.clock, nextId, {
    ...(options.policySkills === undefined ? {} : { policySkills: options.policySkills }),
  })
  return { registry, lessons, sidecar, nextId }
}
