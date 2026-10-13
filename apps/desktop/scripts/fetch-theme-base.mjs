#!/usr/bin/env node
/**
 * WP297（决策 140 / 376）：把建站**起底用的开源主题包**随安装包带一份，作 GitHub 下不动时的兜底。
 *
 * 钉子只在一处：`apps/server/src/theme-base-pin.json`（repo / commit / sha256 / bytes）。这个脚本按它
 * 从 codeload 按 commit 下那一份 tar.gz，**字节数与 sha256 都对上**才落到
 * `vendor/theme-base/<repo名>-<commit>.tgz`（文件名与服务端 `site-theme.ts` 的 `localBaseFile` 同一套）；
 * 对不上当场失败，不重试、不将就——那是包被换了，不是网络抖了。网络失败才重试（几次、间隔加倍）。
 *
 * - 已经有一份、校验对得上 → 不再下（CI 缓存 / 本机第二次打包都走这条）；对不上 → 当作没有，重下。
 * - 换了钉子：目录里旧 commit 的那几份 `.tgz` 删掉（只删这个脚本自己放进去的那种名字），
 *   免得 extraResources 把两份都带进安装包。
 * - `electron-builder.yml` 的 extraResources 把这个目录摆进 `<resources>/theme-base/`；
 *   afterPack 用 {@link bundledThemeBaseProblem} 再核一次（不在 / 不对就打包失败）；
 *   桌面壳经 `AGENTSWS_THEME_BASE_DIR` 把那个目录告诉服务进程。
 *
 * 用法：`node apps/desktop/scripts/fetch-theme-base.mjs`（`scripts/dist.mjs` 打包前也会自己调一次）。
 */
import { createHash } from 'node:crypto'
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
export const DESKTOP_ROOT = resolve(here, '..')
export const REPO_ROOT = resolve(DESKTOP_ROOT, '..', '..')
export const PIN_FILE = join(REPO_ROOT, 'apps', 'server', 'src', 'theme-base-pin.json')
export const THEME_BASE_VENDOR_DIR = join(DESKTOP_ROOT, 'vendor', 'theme-base')
/** 安装包里放它的目录（`<resources>/theme-base`）。桌面壳 `bundledThemeBaseDir` 按同一个名字找。 */
export const THEME_BASE_RESOURCE_DIR = 'theme-base'

/** 读钉子并核一遍形状（缺一项就失败：没有期望值可对等于没有锁）。 */
export function readPin(path = PIN_FILE) {
  const pin = JSON.parse(readFileSync(path, 'utf8'))
  const bad = []
  if (typeof pin.repo !== 'string' || !/^[^/\s]+\/[^/\s]+$/.test(pin.repo)) bad.push('repo')
  if (typeof pin.commit !== 'string' || !/^[0-9a-f]{40}$/.test(pin.commit)) bad.push('commit')
  if (typeof pin.sha256 !== 'string' || !/^[0-9a-f]{64}$/.test(pin.sha256)) bad.push('sha256')
  if (!Number.isInteger(pin.bytes) || pin.bytes <= 0) bad.push('bytes')
  if (bad.length > 0) throw new Error(`${path} 缺这几项或写得不对：${bad.join('、')}`)
  return pin
}

/** `<repo名>-<commit>.tgz`——与服务端 `localBaseFile` 同一个名字，两边改要一起改。 */
export function themeBaseFileName(pin) {
  return `${pin.repo.split('/')[1]}-${pin.commit}.tgz`
}

export function themeBaseUrl(pin) {
  return `https://codeload.github.com/${pin.repo}/tar.gz/${pin.commit}`
}

export function sha256(bytes) {
  return createHash('sha256').update(bytes).digest('hex')
}

/** 这份字节有什么不对（空 = 对上了）：先比字节数，再比 sha256。 */
export function themeBaseProblem(bytes, pin) {
  if (bytes.length !== pin.bytes) return `字节数对不上：钉的是 ${pin.bytes}，实际 ${bytes.length}`
  const actual = sha256(bytes)
  if (actual !== pin.sha256) return `sha256 对不上\n  钉的：${pin.sha256}\n  实际：${actual}`
  return undefined
}

/** 这次失败值不值得重试：校验不对不重试（包被换了），其余（断网、超时、5xx）重试。 */
class IntegrityError extends Error {}

const defaultFetch = (url, timeoutMs) =>
  fetch(url, { redirect: 'follow', signal: AbortSignal.timeout(timeoutMs) })

/**
 * 确保 `dir` 里有一份对得上钉子的起底包，回 `{ file, cached, attempts }`。
 *
 * `fetch` / `sleep` / `log` 供测试替换（测试不联网）。
 */
export async function fetchThemeBase({
  pin = readPin(),
  dir = THEME_BASE_VENDOR_DIR,
  fetch: fetchImpl = defaultFetch,
  attempts = 4,
  timeoutMs = 120_000,
  sleep = (ms) => new Promise((r) => setTimeout(r, ms)),
  log = (line) => process.stdout.write(`  • 起底包 ${line}\n`),
} = {}) {
  const name = themeBaseFileName(pin)
  const file = join(dir, name)
  mkdirSync(dir, { recursive: true })
  // 换了钉子：旧 commit 的那几份不带进安装包
  for (const old of readdirSync(dir)) {
    if (old !== name && /^[A-Za-z0-9._-]+-[0-9a-f]{40}\.tgz(\.part)?$/.test(old)) {
      rmSync(join(dir, old), { force: true })
      log(`删掉旧钉子的那一份：${old}`)
    }
  }
  if (existsSync(file)) {
    const problem = themeBaseProblem(readFileSync(file), pin)
    if (problem === undefined) {
      log(`已有、校验对得上：${file}`)
      return { file, cached: true, attempts: 0 }
    }
    log(`已有的那一份不对（${problem.split('\n')[0]}），重下`)
    rmSync(file, { force: true })
  }
  const url = themeBaseUrl(pin)
  let last
  for (let i = 1; i <= attempts; i += 1) {
    try {
      const res = await fetchImpl(url, timeoutMs)
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      const bytes = Buffer.from(await res.arrayBuffer())
      const problem = themeBaseProblem(bytes, pin)
      if (problem !== undefined) throw new IntegrityError(`${url} ${problem}`)
      // 先写 .part 再改名：打包中途被掐断不会留下半份「看起来在」的包
      writeFileSync(`${file}.part`, bytes)
      renameSync(`${file}.part`, file)
      log(`下好了、校验对上（${bytes.length} 字节）：${file}`)
      return { file, cached: false, attempts: i }
    } catch (err) {
      if (err instanceof IntegrityError) throw err
      last = err
      const reason = err instanceof Error ? err.message : String(err)
      if (i < attempts) {
        const wait = 2000 * 2 ** (i - 1)
        log(`第 ${i} 次没下下来（${reason}），${wait / 1000} 秒后再试`)
        await sleep(wait)
      }
    }
  }
  const reason = last instanceof Error ? last.message : String(last)
  throw new Error(`起底包下了 ${attempts} 次都没下下来：${url}（${reason}）`)
}

/** 安装包里那一份有什么问题（空 = 在、且对得上钉子）。afterPack 与 Windows 装包冒烟都用它。 */
export function bundledThemeBaseProblem(resourcesDir, pin = readPin()) {
  const file = join(resourcesDir, THEME_BASE_RESOURCE_DIR, themeBaseFileName(pin))
  if (!existsSync(file))
    return `安装包里没有随带的起底包：${file}（先跑 fetch-theme-base.mjs；extraResources 没生效？）`
  const problem = themeBaseProblem(readFileSync(file), pin)
  return problem === undefined ? undefined : `安装包里的起底包不对：${file}\n${problem}`
}

export async function main() {
  await fetchThemeBase()
}

// 被 import（测试 / dist.mjs）时什么都不做。
if (
  process.argv[1] !== undefined &&
  import.meta.url === pathToFileURL(resolve(process.argv[1])).href
) {
  await main()
}
