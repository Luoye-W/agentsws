/**
 * 模块清单装载器（28 §1、28 §4 用例 2）。
 *
 * `modules.yml` 每条：`{ id, version, provides: {contract: version}, requires: {contract: range},
 * entry, publisher, signature }`。
 *
 * 三道关，顺序固定：
 * 1. **形状**：Schemastery 校验（09 §0「Schemastery 校验配置」）；坏条目单独 `failed`，不拖垮整份清单。
 * 2. **签名与允许源**（v1）：`signature` = `sha256:<hex>`，须等于 `entry` 文件的 sha256；
 *    `publisher` 须在允许列表（官方 / 公司私有）。任一不符 → `failed`，**不装载**。
 * 3. **依赖**：`requires` 的契约版本范围必须被仍然存活的模块 `provides` 满足（semver）。
 *    不满足 → `pending` 并列出 missing（Cordis 挂起语义），并且级联：挂起模块提供的契约随之失效。
 *
 * 装载器只读文件、算哈希、比版本——**从不执行 `entry`**（23 §2「拉取永不执行代码」）。
 */

import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { dirname, isAbsolute, resolve } from 'node:path'
import type { ModuleHealth, ModuleManifest } from '@agentsws/contracts'
import Schema from '@deepseek-ai/schemastery'
import { satisfies, valid, validRange } from 'semver'
import { parse as parseYaml } from 'yaml'
import { KernelError } from './errors.js'

/**
 * 清单条目 = 契约的 `ModuleManifest` + `publisher`。
 * `publisher` 是 28 §1「允许源」校验必需的，但当前契约里没有 → 见报告「需要契约改动」。
 */
export interface ModuleEntry extends ModuleManifest {
  publisher?: string
}

/** 默认允许源：只有官方。公司私有源由部署方经 `allowedPublishers` 显式加入。 */
export const DEFAULT_ALLOWED_PUBLISHERS: readonly string[] = ['official']

export interface ModuleLoaderOptions {
  /** `modules.yml` 路径；缺省表示没有外部模块（空清单）。 */
  manifestPath?: string
  /** 允许源，缺省 {@link DEFAULT_ALLOWED_PUBLISHERS}。 */
  allowedPublishers?: readonly string[]
  /** 是否强制签名，缺省 true（28 §4 用例 2「未签名模块装载被拒」）。 */
  requireSignature?: boolean
  /** 计算 entry 文件的 sha256；缺省读磁盘。测试可注入。 */
  hashEntry?: (absolutePath: string) => string
}

const EntrySchema = Schema.object({
  id: Schema.string().required(),
  version: Schema.string().required(),
  provides: Schema.dict(Schema.string()).default({}),
  requires: Schema.dict(Schema.string()).default({}),
  entry: Schema.string().required(),
  publisher: Schema.string(),
  signature: Schema.string(),
})

const SIGNATURE_RE = /^(?:sha256:)?([0-9a-f]{64})$/i

function sha256File(absolutePath: string): string {
  return createHash('sha256').update(readFileSync(absolutePath)).digest('hex')
}

function describe(value: unknown): string {
  return value instanceof Error ? value.message : String(value)
}

/**
 * 装载并校验模块清单。构造即校验；`health()` 给 `/health` 与 doctor 用（28 §4 用例 2
 * 「requires 不满足的模块处于挂起并在 /health 可见」）。
 */
export class ModuleRegistry {
  private readonly options: ModuleLoaderOptions
  private readonly allowedPublishers: ReadonlySet<string>
  private readonly requireSignature: boolean
  private readonly hashEntry: (absolutePath: string) => string
  private entries: ModuleEntry[] = []
  private validated: (ModuleEntry | undefined)[] = []
  private healthList: ModuleHealth[] = []
  private healthById = new Map<string, ModuleHealth>()

  constructor(options: ModuleLoaderOptions = {}) {
    this.options = options
    this.allowedPublishers = new Set(options.allowedPublishers ?? DEFAULT_ALLOWED_PUBLISHERS)
    this.requireSignature = options.requireSignature ?? true
    this.hashEntry = options.hashEntry ?? sha256File
    this.load()
  }

  /** 重新读清单并重算健康度；返回 `ModuleHealth[]`（顺序与清单一致）。 */
  load(): ModuleHealth[] {
    this.entries = this.readManifest()
    this.validated = this.entries.map(() => undefined)
    this.healthList = this.evaluate(this.entries)
    this.healthById = new Map()
    for (const health of this.healthList) {
      if (!this.healthById.has(health.id)) this.healthById.set(health.id, health)
    }
    return this.health()
  }

  /** 与清单同序（重复 id 的条目各自占一行）。 */
  health(): ModuleHealth[] {
    return [...this.healthList]
  }

  get(id: string): ModuleHealth | undefined {
    return this.healthById.get(id)
  }

  /** 清单条目；通过形状校验的返回补齐缺省后的版本，未通过的返回原样。 */
  manifests(): readonly ModuleEntry[] {
    return this.entries.map((raw, index) => this.validated[index] ?? raw)
  }

  /** 当前生效（active）的模块提供的契约版本表。 */
  activeContracts(): Record<string, string> {
    const out: Record<string, string> = {}
    this.validated.forEach((entry, index) => {
      if (entry === undefined || this.healthList[index]?.state !== 'active') return
      for (const [contract, version] of Object.entries(entry.provides)) out[contract] = version
    })
    return out
  }

  private readManifest(): ModuleEntry[] {
    const path = this.options.manifestPath
    if (path === undefined) return []
    let raw: unknown
    try {
      raw = parseYaml(readFileSync(path, 'utf8')) as unknown
    } catch (cause) {
      throw new KernelError(
        'invalid_input',
        `cannot read module manifest ${path}: ${describe(cause)}`,
        {
          cause,
        },
      )
    }
    const list = Array.isArray(raw)
      ? raw
      : raw !== null &&
          typeof raw === 'object' &&
          Array.isArray((raw as { modules?: unknown }).modules)
        ? ((raw as { modules: unknown[] }).modules ?? [])
        : undefined
    if (list === undefined) {
      throw new KernelError(
        'invalid_input',
        `module manifest ${path} must be a list, or a mapping with a "modules" list`,
      )
    }
    return list as ModuleEntry[]
  }

  private evaluate(entries: readonly ModuleEntry[]): ModuleHealth[] {
    const results: (ModuleHealth | undefined)[] = entries.map(() => undefined)
    const accepted = new Map<string, { index: number; entry: ModuleEntry }>()
    const ids: string[] = []

    entries.forEach((raw, index) => {
      const rawId = (raw as { id?: unknown } | null)?.id
      const id = typeof rawId === 'string' && rawId.length > 0 ? rawId : `#${index}`
      ids.push(id)
      if (ids.indexOf(id) !== index) {
        results[index] = {
          id,
          state: 'failed',
          detail: `duplicate module id ${id} in the manifest`,
        }
        return
      }
      let entry: ModuleEntry
      try {
        entry = EntrySchema(raw) as ModuleEntry
      } catch (cause) {
        results[index] = {
          id,
          state: 'failed',
          detail: `invalid manifest entry: ${describe(cause)}`,
        }
        return
      }
      const rejected = this.checkTrust(entry) ?? this.checkVersions(entry)
      if (rejected !== undefined) {
        results[index] = { id, state: 'failed', detail: rejected }
        return
      }
      this.validated[index] = entry
      accepted.set(id, { index, entry })
    })

    // 依赖收敛：挂起会级联（挂起模块提供的契约不算数）。
    const active = new Map(accepted)
    const pending = new Map<string, { index: number; missing: string[] }>()
    for (;;) {
      const provided = new Map<string, string>()
      for (const { entry } of active.values()) {
        for (const [contract, version] of Object.entries(entry.provides)) {
          provided.set(contract, version)
        }
      }
      let changed = false
      for (const [id, { index, entry }] of active) {
        const missing: string[] = []
        for (const [contract, range] of Object.entries(entry.requires)) {
          const version = provided.get(contract)
          if (version === undefined || !satisfies(version, range)) {
            missing.push(`${contract}@${range}`)
          }
        }
        if (missing.length > 0) {
          active.delete(id)
          pending.set(id, { index, missing })
          changed = true
        }
      }
      if (!changed) break
    }

    for (const [id, { index }] of active) results[index] = { id, state: 'active' }
    for (const [id, { index, missing }] of pending) {
      results[index] = {
        id,
        state: 'pending',
        missing,
        detail: `waiting for ${missing.join(', ')}`,
      }
    }
    return results.map(
      (health, index) => health ?? { id: ids[index] ?? `#${index}`, state: 'failed' },
    )
  }

  /** 第 2 关：签名与允许源。 */
  private checkTrust(entry: ModuleEntry): string | undefined {
    const publisher = entry.publisher
    if (publisher === undefined || !this.allowedPublishers.has(publisher)) {
      return `publisher ${JSON.stringify(publisher ?? null)} is not in the allowed sources (${[...this.allowedPublishers].join(', ')})`
    }
    if (entry.signature === undefined) {
      if (!this.requireSignature) return undefined
      return 'module is unsigned; a sha256 signature is required'
    }
    const match = SIGNATURE_RE.exec(entry.signature)
    if (!match?.[1]) {
      return `signature must be "sha256:<64 hex>", got ${JSON.stringify(entry.signature)}`
    }
    const expected = match[1].toLowerCase()
    const base =
      this.options.manifestPath === undefined ? process.cwd() : dirname(this.options.manifestPath)
    const absolute = isAbsolute(entry.entry) ? entry.entry : resolve(base, entry.entry)
    let actual: string
    try {
      actual = this.hashEntry(absolute).toLowerCase()
    } catch (cause) {
      return `cannot hash entry ${entry.entry}: ${describe(cause)}`
    }
    if (actual !== expected) {
      return `signature mismatch for ${entry.entry}: manifest says ${expected}, file hashes to ${actual}`
    }
    return undefined
  }

  /** provides 必须是确切版本，requires 必须是合法 semver 范围——不然「满足」无从判断。 */
  private checkVersions(entry: ModuleEntry): string | undefined {
    for (const [contract, version] of Object.entries(entry.provides)) {
      if (valid(version) === null) {
        return `provides.${contract} must be an exact semver version, got ${JSON.stringify(version)}`
      }
    }
    for (const [contract, range] of Object.entries(entry.requires)) {
      if (validRange(range) === null) {
        return `requires.${contract} must be a semver range, got ${JSON.stringify(range)}`
      }
    }
    return undefined
  }
}
