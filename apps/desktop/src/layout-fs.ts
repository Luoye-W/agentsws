/**
 * WP327：`fast-update.ts` 要的文件系统（真的那份）。Windows 上目录联接由 Node 当成「目录符号链接」处理：
 * `symlinkSync(target, link, 'junction')` 建（普通用户权限就行），`rmdirSync` 删联接本身（不碰它指向的目录）。
 */
import {
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmdirSync,
  rmSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs'
import { dirname } from 'node:path'
import type { LayoutFs } from './fast-update.js'

export function nodeLayoutFs(): LayoutFs {
  return {
    exists: (p) => existsSync(p),
    isLink: (p) => {
      try {
        return lstatSync(p).isSymbolicLink()
      } catch {
        return false
      }
    },
    target: (p) => {
      try {
        return realpathSync.native(p)
      } catch {
        return undefined
      }
    },
    readText: (p) => {
      try {
        return readFileSync(p, 'utf8')
      } catch {
        return undefined
      }
    },
    writeText: (p, text) => {
      mkdirSync(dirname(p), { recursive: true })
      writeFileSync(p, text)
    },
    remove: (p) => {
      rmSync(p, { force: true })
    },
    list: (dir) => {
      try {
        return readdirSync(dir)
      } catch {
        return []
      }
    },
    unlink: (p) => {
      if (!existsSync(p) && !isDanglingLink(p)) return
      try {
        rmdirSync(p)
      } catch {
        unlinkSync(p)
      }
    },
    link: (target, p) => {
      symlinkSync(target, p, 'junction')
    },
  }
}

function isDanglingLink(p: string): boolean {
  try {
    return lstatSync(p).isSymbolicLink()
  } catch {
    return false
  }
}
