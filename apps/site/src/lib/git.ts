/**
 * 教程上官网（私有 docs/113 §4.4）：构建时向 git 问三件事——
 *
 * 1. 最新的正式版 tag（`v0.2.1-beta.7` 这种）：头上写着 `requires: next` 的教程，官网用这一版时的文字；
 * 2. 某个文件在那一版时长什么样；
 * 3. 某个文件最后一次改是哪天（页上的「更新于」、sitemap 的 lastmod、目录的 `updated`）。
 *
 * 拿不到 git（压缩包里构建、浅克隆没 tag）时不报错：没有 tag = 头上写 `next` 的那几篇先不上；
 * 没有修改日 = 用构建当天。`AGENTSWS_SITE_NO_GIT=1` 可以强制当作没有 git（测试用）。
 */
import { execFileSync } from 'node:child_process'
import { compareHelpVersion } from '@agentsws/contracts'

export interface SiteGit {
  /** 最新正式版的 tag（带 `v`）；没有回 `undefined`。 */
  latestRelease(): string | undefined
  /** `path`（相对仓库根）在 `tag` 那一版时的内容；那时还没有这个文件回 `undefined`。 */
  showAt(tag: string, path: string): string | undefined
  /** `path` 最后一次提交的日期（`YYYY-MM-DD`）；没提交过回 `undefined`。 */
  lastModified(path: string): string | undefined
}

const RELEASE_TAG = /^v\d+\.\d+\.\d+(?:-[0-9A-Za-z.]+)?$/u

/** 一组 tag 里最新的正式版（只认 `v主.次.修订[-预发布]`）。 */
export function newestRelease(tags: readonly string[]): string | undefined {
  return tags
    .filter((t) => RELEASE_TAG.test(t))
    .sort((a, b) => compareHelpVersion(b, a))
    .at(0)
}

/** 真 git（结果按仓库缓存：一次构建里同一个问题只问一次）。 */
export function realGit(root: string): SiteGit {
  const disabled = process.env.AGENTSWS_SITE_NO_GIT === '1'
  const run = (args: string[]): string | undefined => {
    if (disabled) return undefined
    try {
      return execFileSync('git', args, {
        cwd: root,
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'ignore'],
      })
    } catch {
      return undefined
    }
  }
  let release: string | undefined | null = null
  const shown = new Map<string, string | undefined>()
  const modified = new Map<string, string | undefined>()
  return {
    latestRelease() {
      if (release === null)
        release = newestRelease((run(['tag', '--list', 'v*']) ?? '').split('\n'))
      return release
    },
    showAt(tag, path) {
      const key = `${tag}:${path}`
      if (!shown.has(key)) shown.set(key, run(['show', `${tag}:${path}`]))
      return shown.get(key)
    },
    lastModified(path) {
      if (!modified.has(path)) {
        const day = (run(['log', '-1', '--format=%cs', '--', path]) ?? '').trim()
        modified.set(path, /^\d{4}-\d{2}-\d{2}$/u.test(day) ? day : undefined)
      }
      return modified.get(path)
    },
  }
}

const cache = new Map<string, SiteGit>()

export function siteGit(root: string): SiteGit {
  let git = cache.get(root)
  if (git === undefined) {
    git = realGit(root)
    cache.set(root, git)
  }
  return git
}

/** 构建当天（拿不到修改日时用）。 */
export function today(): string {
  return new Date().toISOString().slice(0, 10)
}
