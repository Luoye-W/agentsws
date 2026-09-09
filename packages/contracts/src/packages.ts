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
/**
 * 23 应用扩展点。声明类包不含代码，扩展点由 `kind: connector | dsh-plugin-wrapper` 的包
 * 或内核自带实现提供；`provides.extensions` 只是**声明**，装载仍按 23 §2 的规则来。
 */
export type ExtensionPoint =
  /** 37 §4.2：提供会议记录（轮询 / 推送 / 设备同步） */
  | 'meeting.record_source'
  /** 37 §4.2：从转写抽产出（必须走围栏与 provenance） */
  | 'meeting.processor'

export const EXTENSION_POINTS: readonly ExtensionPoint[] = [
  'meeting.record_source',
  'meeting.processor',
]

export interface ExtensionDeclaration {
  point: ExtensionPoint
  /** 实例 id，形如 `<publisher>/<name>`；与内核自带的免费默认版同名即覆盖（23 §2 叠加解析）。 */
  id: string
  name?: { zh: string; en: string }
  /** `meeting.record_source` 专用：它能供哪几种来源。 */
  sources?: string[]
}

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
    /** 23：本包实现了哪些扩展点（WP23 起：`meeting.record_source` / `meeting.processor`）。 */
    extensions?: ExtensionDeclaration[]
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
