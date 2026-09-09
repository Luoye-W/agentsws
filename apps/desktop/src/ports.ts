/**
 * 桌面壳的注入口（13 §5「启动器没有界面逻辑」）。
 *
 * 除 `main.ts` / `preload.cts` 外，本包所有模块都只依赖这里的接口，不 import `electron`
 * ——这样状态机、退避、配置、密钥、URL 判定、菜单模型都能在 vitest 里跑满覆盖。
 */

/** 时间注入点（35 §2：不裸调 `Date.now()`）。 */
export interface Clock {
  /** ISO-8601 字符串。 */
  now(): string
}

/** 文件系统注入点；只用得上这几件事。 */
export interface FileStore {
  readText(path: string): string | undefined
  writeText(path: string, data: string): void
  appendText(path: string, data: string): void
  readBytes(path: string): Uint8Array | undefined
  writeBytes(path: string, data: Uint8Array): void
  ensureDir(dir: string): void
  size(path: string): number | undefined
  rename(from: string, to: string): void
  remove(path: string): void
  exists(path: string): boolean
}

export interface TimerHandle {
  readonly id: number
}

/** 定时注入点：退避重启、健康轮询都走它。 */
export interface TimerPort {
  setTimeout(fn: () => void, ms: number): TimerHandle
  clear(handle: TimerHandle): void
}

/** 子进程注入点。`onExit` 只会被调用一次。 */
export interface ChildHandle {
  readonly pid: number | undefined
  kill(signal?: string): void
  onStdout(cb: (chunk: string) => void): void
  onStderr(cb: (chunk: string) => void): void
  onExit(cb: (code: number | null, signal: string | null) => void): void
}

export interface SpawnRequest {
  command: string
  args: readonly string[]
  env: Readonly<Record<string, string>>
  cwd?: string
}

export interface Spawner {
  spawn(request: SpawnRequest): ChildHandle
}

/** 最小 fetch 形状：只要状态码与文本。 */
export interface FetchResponseLike {
  readonly ok: boolean
  readonly status: number
  text(): Promise<string>
}

export type FetchLike = (
  url: string,
  init?: { method?: string; headers?: Record<string, string>; signal?: AbortSignal },
) => Promise<FetchResponseLike>

/** Electron `safeStorage` 的最小面（macOS 钥匙串 / Windows DPAPI）。 */
export interface SafeStorageLike {
  isEncryptionAvailable(): boolean
  encryptString(plain: string): Uint8Array
  decryptString(encrypted: Uint8Array): string
}

export type RandomBytes = (size: number) => Uint8Array
