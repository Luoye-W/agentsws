/**
 * 落用户数据目录的行日志。每一行出门前都过一遍 `Redactor`——**日志里永远不出现密钥**。
 * 简单的单份轮转：超过 `maxBytes` 就把当前文件挪成 `.1`。
 */
import type { Clock, FileStore } from './ports.js'
import { defaultRedactor, type Redactor } from './redact.js'

export type LogLevel = 'info' | 'warn' | 'error'

export interface Logger {
  info(message: string, fields?: Readonly<Record<string, unknown>>): void
  warn(message: string, fields?: Readonly<Record<string, unknown>>): void
  error(message: string, fields?: Readonly<Record<string, unknown>>): void
  /** 原样写一行（子进程输出用；依然过脱敏）。 */
  raw(line: string): void
  child(scope: string): Logger
  /** 换掉脱敏器（密钥读出来之后把字面量补进去）。 */
  setRedactor(redactor: Redactor): void
}

export interface LoggerOptions {
  files: FileStore
  path: string
  clock: Clock
  redactor?: Redactor
  /** 超过就轮转；默认 2 MiB。 */
  maxBytes?: number
  /** 额外出口（开发期镜像到 stdout）。 */
  mirror?: (line: string) => void
}

export function formatLine(
  at: string,
  level: LogLevel,
  scope: string,
  message: string,
  fields?: Readonly<Record<string, unknown>>,
): string {
  const head = `${at} ${level.toUpperCase().padEnd(5)} [${scope}] ${message}`
  if (fields === undefined) return head
  const entries = Object.entries(fields)
  if (entries.length === 0) return head
  const tail = entries.map(([k, v]) => `${k}=${stringify(v)}`).join(' ')
  return `${head} ${tail}`
}

function stringify(value: unknown): string {
  if (typeof value === 'string') return value
  if (value === undefined) return 'undefined'
  try {
    return JSON.stringify(value) ?? String(value)
  } catch {
    return String(value)
  }
}

export function createLogger(options: LoggerOptions): Logger {
  const { files, path, clock, mirror } = options
  const maxBytes = options.maxBytes ?? 2 * 1024 * 1024
  let redactor: Redactor = options.redactor ?? defaultRedactor

  const emit = (line: string): void => {
    const safe = redactor(line)
    const size = files.size(path)
    if (size !== undefined && size + safe.length + 1 > maxBytes) {
      files.remove(`${path}.1`)
      files.rename(path, `${path}.1`)
    }
    files.appendText(path, `${safe}\n`)
    if (mirror !== undefined) mirror(safe)
  }

  const make = (scope: string): Logger => {
    const write = (
      level: LogLevel,
      message: string,
      fields?: Readonly<Record<string, unknown>>,
    ): void => {
      emit(formatLine(clock.now(), level, scope, message, fields))
    }
    return {
      info: (message, fields) => {
        write('info', message, fields)
      },
      warn: (message, fields) => {
        write('warn', message, fields)
      },
      error: (message, fields) => {
        write('error', message, fields)
      },
      raw: (line) => {
        emit(line)
      },
      child: (name) => make(`${scope}/${name}`),
      setRedactor: (next) => {
        redactor = next
      },
    }
  }

  files.ensureDir(dirOf(path))
  return make('desktop')
}

function dirOf(path: string): string {
  const idx = Math.max(path.lastIndexOf('/'), path.lastIndexOf('\\'))
  return idx <= 0 ? path : path.slice(0, idx)
}

/** 什么都不写的 logger（测试与 `--dry-run`）。 */
export function silentLogger(): Logger {
  const self: Logger = {
    info: () => undefined,
    warn: () => undefined,
    error: () => undefined,
    raw: () => undefined,
    child: () => self,
    setRedactor: () => undefined,
  }
  return self
}
