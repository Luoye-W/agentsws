import type { PackageKind, PackageManifest } from '@agentsws/contracts'
import { canonicalJson, sha256 } from '@agentsws/core'
import { StandInError } from './errors.js'

export interface RegistryEntry {
  manifest: PackageManifest
  /** 本地包源目录：`download` 返回它，客户端从这里读文件（拉取永不执行代码）。 */
  dir: string
  category?: string
  downloads: number
}

export interface RegistrySearchQuery {
  q?: string
  category?: string
  kind?: PackageKind
  tier?: PackageManifest['publisher']['tier']
}

export interface RegistryDownload {
  id: string
  version: string
  dir: string
  sha256: string
  signature: string
}

/**
 * 26 §3 假 registry / 23 §3 的最小形状：search / get / download 三个方法，本地包源。
 * 只做索引与"签名"，不解压、不执行。
 */
export class FakeRegistry {
  private readonly entries = new Map<string, RegistryEntry>()

  private static key(id: string, version: string): string {
    return `${id}@${version}`
  }

  /** 放一个包进本地源。 */
  add(entry: Omit<RegistryEntry, 'downloads'> & { downloads?: number }): RegistryEntry {
    const rec: RegistryEntry = {
      manifest: entry.manifest,
      dir: entry.dir,
      downloads: entry.downloads ?? 0,
      ...(entry.category === undefined ? {} : { category: entry.category }),
    }
    this.entries.set(FakeRegistry.key(rec.manifest.id, rec.manifest.version), rec)
    return rec
  }

  /** `GET /registry/search?q=&category=&kind=&tier=` */
  search(query: RegistrySearchQuery = {}): RegistryEntry[] {
    const q = query.q?.toLowerCase()
    return [...this.entries.values()]
      .filter((e) => (query.kind === undefined ? true : e.manifest.kind === query.kind))
      .filter((e) => (query.tier === undefined ? true : e.manifest.publisher.tier === query.tier))
      .filter((e) => (query.category === undefined ? true : e.category === query.category))
      .filter((e) =>
        q === undefined
          ? true
          : [e.manifest.id, e.manifest.name.zh, e.manifest.name.en]
              .join(' ')
              .toLowerCase()
              .includes(q),
      )
      .sort((a, b) =>
        FakeRegistry.key(a.manifest.id, a.manifest.version).localeCompare(
          FakeRegistry.key(b.manifest.id, b.manifest.version),
        ),
      )
  }

  /** `GET /registry/packages/{id}`；不给版本时取最新登记的版本（按字符串序最大）。 */
  get(id: string, version?: string): RegistryEntry | undefined {
    if (version !== undefined) return this.entries.get(FakeRegistry.key(id, version))
    const all = this.versions(id)
    const latest = all.at(-1)
    return latest === undefined ? undefined : this.entries.get(FakeRegistry.key(id, latest))
  }

  versions(id: string): string[] {
    return [...this.entries.values()]
      .filter((e) => e.manifest.id === id)
      .map((e) => e.manifest.version)
      .sort((a, b) => a.localeCompare(b, 'en', { numeric: true }))
  }

  /** `GET /registry/packages/{id}/{version}/download` —— 返回本地目录 + 校验和。 */
  download(id: string, version?: string): RegistryDownload {
    const entry = this.get(id, version)
    if (!entry) {
      throw new StandInError('not_found', `registry 里没有 ${id}${version ? `@${version}` : ''}`, {
        id,
        version,
      })
    }
    entry.downloads += 1
    const digest = sha256(canonicalJson(entry.manifest))
    return {
      id: entry.manifest.id,
      version: entry.manifest.version,
      dir: entry.dir,
      sha256: digest,
      signature: `stand-in:${digest.slice(0, 32)}`,
    }
  }

  get size(): number {
    return this.entries.size
  }

  clear(): void {
    this.entries.clear()
  }
}
