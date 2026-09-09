/** `FileStore` 的 node:fs 实现。缺文件一律当 `undefined`，不抛。 */
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import { dirname } from 'node:path'
import type { FileStore } from './ports.js'

function missing(err: unknown): boolean {
  return typeof err === 'object' && err !== null && (err as { code?: string }).code === 'ENOENT'
}

export function nodeFileStore(): FileStore {
  const ensureDir = (dir: string): void => {
    mkdirSync(dir, { recursive: true })
  }
  const ensureParent = (path: string): void => {
    ensureDir(dirname(path))
  }
  return {
    readText(path) {
      try {
        return readFileSync(path, 'utf8')
      } catch (err) {
        if (missing(err)) return undefined
        throw err
      }
    },
    writeText(path, data) {
      ensureParent(path)
      writeFileSync(path, data, { encoding: 'utf8', mode: 0o600 })
    },
    appendText(path, data) {
      ensureParent(path)
      appendFileSync(path, data, { encoding: 'utf8', mode: 0o600 })
    },
    readBytes(path) {
      try {
        return new Uint8Array(readFileSync(path))
      } catch (err) {
        if (missing(err)) return undefined
        throw err
      }
    },
    writeBytes(path, data) {
      ensureParent(path)
      writeFileSync(path, data, { mode: 0o600 })
    },
    ensureDir,
    size(path) {
      try {
        return statSync(path).size
      } catch (err) {
        if (missing(err)) return undefined
        throw err
      }
    },
    rename(from, to) {
      ensureParent(to)
      renameSync(from, to)
    },
    remove(path) {
      rmSync(path, { force: true, recursive: true })
    },
    exists(path) {
      return existsSync(path)
    },
  }
}

/** 内存实现，测试与 `--dry-run` 用。 */
export function memoryFileStore(seed: Readonly<Record<string, string>> = {}): FileStore {
  const files = new Map<string, Uint8Array>()
  const encoder = new TextEncoder()
  const decoder = new TextDecoder()
  for (const [path, data] of Object.entries(seed)) files.set(path, encoder.encode(data))
  return {
    readText(path) {
      const bytes = files.get(path)
      return bytes === undefined ? undefined : decoder.decode(bytes)
    },
    writeText(path, data) {
      files.set(path, encoder.encode(data))
    },
    appendText(path, data) {
      const prev = files.get(path)
      const text = prev === undefined ? '' : decoder.decode(prev)
      files.set(path, encoder.encode(text + data))
    },
    readBytes(path) {
      return files.get(path)
    },
    writeBytes(path, data) {
      files.set(path, data)
    },
    ensureDir() {
      // 内存里没有目录概念。
    },
    size(path) {
      return files.get(path)?.byteLength
    },
    rename(from, to) {
      const bytes = files.get(from)
      if (bytes === undefined) throw new Error(`ENOENT: ${from}`)
      files.set(to, bytes)
      files.delete(from)
    },
    remove(path) {
      files.delete(path)
    },
    exists(path) {
      return files.has(path)
    },
  }
}
