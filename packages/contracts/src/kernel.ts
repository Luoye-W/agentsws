/** 28 §1 内核：模块清单、急停、trace。 */
export interface ModuleManifest {
  id: string
  version: string
  provides: Record<string, string>
  requires: Record<string, string>
  entry: string
  signature?: string
}
export type HaltScope = 'all' | 'model' | 'outbound' | 'learning'
export interface Halt {
  isHalted(scope: HaltScope): boolean
  set(scope: HaltScope, on: boolean, reason?: string): void
  state(): Record<HaltScope, { on: boolean; reason?: string }>
}
export interface Trace {
  newTraceId(): string
  child(parent: string): string
}
export interface ModuleHealth {
  id: string
  state: 'active' | 'pending' | 'failed'
  missing?: string[]
  detail?: string
}
