import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { invalidInput } from './errors.js'
import type { KnownSection } from './parse.js'

export interface SidecarEntry {
  id: string
  heading: string
  body_hash: string
}

/** `<skill>.sections.json`：heading → id 映射 + 正文哈希。段 id 对用户不可见。 */
export interface Sidecar {
  skill: string
  sections: SidecarEntry[]
}

export interface SidecarStore {
  read(skill: string): Sidecar | undefined
  write(sidecar: Sidecar): void
}

export function createMemorySidecarStore(): SidecarStore {
  const map = new Map<string, Sidecar>()
  return {
    read: (skill) => {
      const s = map.get(skill)
      return s ? { skill: s.skill, sections: s.sections.map((e) => ({ ...e })) } : undefined
    },
    write: (sidecar) => {
      map.set(sidecar.skill, {
        skill: sidecar.skill,
        sections: sidecar.sections.map((e) => ({ ...e })),
      })
    },
  }
}

function fileNameOf(skill: string): string {
  const safe = skill.replace(/[^A-Za-z0-9._-]/g, '_')
  if (safe === '' || safe === '.' || safe === '..') throw invalidInput(`非法 skill 名：${skill}`)
  return `${safe}.sections.json`
}

/** 内存 + 文件双写：进程内命中内存，落盘用于跨进程保持段 id。 */
export function createFileSidecarStore(dir: string): SidecarStore {
  mkdirSync(dir, { recursive: true })
  const memory = createMemorySidecarStore()
  return {
    read: (skill) => {
      const hit = memory.read(skill)
      if (hit) return hit
      const path = join(dir, fileNameOf(skill))
      if (!existsSync(path)) return undefined
      const parsed: unknown = JSON.parse(readFileSync(path, 'utf8'))
      if (!isSidecar(parsed)) throw invalidInput(`sidecar 文件格式非法：${path}`)
      memory.write(parsed)
      return parsed
    },
    write: (sidecar) => {
      memory.write(sidecar)
      writeFileSync(
        join(dir, fileNameOf(sidecar.skill)),
        `${JSON.stringify(sidecar, null, 2)}\n`,
        'utf8',
      )
    },
  }
}

function isSidecar(value: unknown): value is Sidecar {
  if (typeof value !== 'object' || value === null) return false
  const v = value as { skill?: unknown; sections?: unknown }
  if (typeof v.skill !== 'string' || !Array.isArray(v.sections)) return false
  return v.sections.every((e: unknown) => {
    if (typeof e !== 'object' || e === null) return false
    const s = e as { id?: unknown; heading?: unknown; body_hash?: unknown }
    return (
      typeof s.id === 'string' && typeof s.heading === 'string' && typeof s.body_hash === 'string'
    )
  })
}

export function sidecarToKnown(sidecar: Sidecar | undefined): KnownSection[] {
  return (sidecar?.sections ?? []).map((e) => ({
    id: e.id,
    heading: e.heading,
    body_hash: e.body_hash,
  }))
}

/** 合并已知段：内存里的 Skill 段优先（带 body），sidecar 补上不在场的历史段。 */
export function mergeKnown(
  primary: readonly KnownSection[],
  fallback: readonly KnownSection[],
): KnownSection[] {
  const out = primary.map((k) => ({ ...k }))
  const seen = new Set(out.map((k) => k.id))
  for (const k of fallback) if (!seen.has(k.id)) out.push({ ...k })
  return out
}
