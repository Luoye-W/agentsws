import type { WorkspaceId } from './common.js'

/** 23 §1 package.yml（对外「应用」）。声明类为主；只有 connector / dsh-plugin-wrapper 可含代码引用。 */
export type PackageKind =
  | 'role-pack'
  | 'position'
  | 'starter'
  | 'skill'
  | 'block'
  | 'connector'
  | 'backend'
  | 'dsh-plugin-wrapper'
export interface PackageManifest {
  id: string
  version: string
  kind: PackageKind
  name: { zh: string; en: string }
  description?: { zh: string; en: string }
  publisher: { id: string; tier: 'official' | 'verified' | 'community' }
  license: string
  pricing: { model: 'free' | 'credits' | 'subscription' | 'one-time'; plan_ref?: string }
  provides: {
    roles?: string[]
    positions?: string[]
    skills?: string[]
    blocks?: string[]
    scenarios?: string[]
    backends?: string[]
    connectors?: string[]
    tools?: {
      plugin: string
      tool: string
      side_effect: 'local' | 'read_external' | 'write_external' | 'credential' | 'ui'
    }[]
  }
  requires: {
    contracts: Record<string, string>
    agentsws?: string
    connectors?: {
      service: string
      grants: string[]
      ownership: 'workspace' | 'person'
      required: boolean
    }[]
    permissions?: { domain: string; ops: string[]; caps?: Record<string, unknown> }[]
    model_budget?: { per_run_tokens: number; per_day_tokens: number }
    packages?: { id: string; range: string }[]
  }
  upgrade?: { breaking_permissions: boolean; migrations: string[] }
  signature?: { sigstore_bundle?: string; sha256?: string }
  files: string[]
}

export interface InstalledPackage {
  manifest: PackageManifest
  workspace_id: WorkspaceId
  installed_at: string
  consent_event_id: string
  status: 'ready' | 'missing_connectors' | 'disabled'
}

/** 23 §2 本地包管理（#11）。拉取永不执行代码。 */
export interface LocalPackages {
  validate(
    manifest: unknown,
  ): { ok: true; manifest: PackageManifest } | { ok: false; errors: string[] }
  install(
    manifest: PackageManifest,
    opts: { workspace_id: WorkspaceId; consent_event_id: string; source_dir: string },
  ): Promise<InstalledPackage>
  uninstall(id: string, opts: { workspace_id: WorkspaceId; keep_data: boolean }): Promise<void>
  list(workspace_id: WorkspaceId): Promise<InstalledPackage[]>
  status(id: string, workspace_id: WorkspaceId): Promise<InstalledPackage | undefined>
}
