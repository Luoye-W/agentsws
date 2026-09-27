/**
 * WP165（docs/83 §2、§8 第 2 步）：开源这一侧**不许**直接依赖云端代码。
 *
 * 云端（`apps/cloud*`、`packages/{metering,cloud-entry,hosted,kol-cloud,kol-public,standby}`）要整体搬进
 * 私有仓。搬之前先把线划清：开源这一侧（`apps/{server,workstation,desktop,cli,extension}` 与云端包以外的
 * `packages/*`）只认契约（`@agentsws/contracts`）、客户端与替身（`@agentsws/stand-ins`）。
 * 聊天转发核心（`@agentsws/chat-relay`）留开源（docs/83 §2 第 4 条），不在禁单里。
 *
 * 三处都查：源码与测试里的 import（含相对路径钻进云端包目录的）、`package.json` 的依赖、
 * `tsconfig.json` 的工程引用。不出网、不起服务，只读文件。
 */
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { dirname, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')

/** 云端包（将来进私有仓）。 */
export const CLOUD_PACKAGES = [
  'metering',
  'cloud-entry',
  'hosted',
  'kol-cloud',
  'kol-public',
  'standby',
]
/** 云端应用。 */
export const CLOUD_APPS = ['cloud', 'cloud-worker', 'cloud-admin']
/** 开源这一侧的应用。 */
export const OPEN_APPS = ['server', 'workstation', 'desktop', 'cli', 'extension']

const FORBIDDEN_NAMES = [...CLOUD_PACKAGES, ...CLOUD_APPS].map((n) => `@agentsws/${n}`)
const CODE = /\.(?:[cm]?[jt]sx?)$/u
const SKIP = new Set(['node_modules', 'dist', 'build', 'out', '.vite', 'coverage', 'release'])

/** 开源这一侧的包目录（相对仓库根）。 */
export function openSideDirs(root = ROOT) {
  const packages = readdirSync(join(root, 'packages'))
    .filter((n) => statSync(join(root, 'packages', n)).isDirectory())
    .filter((n) => !CLOUD_PACKAGES.includes(n))
    .map((n) => `packages/${n}`)
  const apps = OPEN_APPS.filter((n) => existsSync(join(root, 'apps', n))).map((n) => `apps/${n}`)
  return [...apps, ...packages]
}

function* walk(dir) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (SKIP.has(entry.name) || entry.name.startsWith('.')) continue
    const path = join(dir, entry.name)
    if (entry.isDirectory()) yield* walk(path)
    else if (CODE.test(entry.name)) yield path
  }
}

/** 一行里的模块说明符（import / export from / 动态 import / require）。 */
const SPECIFIER =
  /(?:\bfrom\s*|\bimport\s*\(\s*|\brequire\s*\(\s*|^\s*import\s+)(['"])([^'"]+)\1/gmu

/** 一个说明符算不算钻进了云端：包名在禁单里，或者相对路径落进云端目录。 */
export function forbiddenSpecifier(spec, fromFile, root = ROOT) {
  if (FORBIDDEN_NAMES.some((n) => spec === n || spec.startsWith(`${n}/`))) return true
  if (!spec.startsWith('.')) return false
  const target = relative(root, resolve(dirname(fromFile), spec))
    .split('\\')
    .join('/')
  return (
    CLOUD_PACKAGES.some((n) => target === `packages/${n}` || target.startsWith(`packages/${n}/`)) ||
    CLOUD_APPS.some((n) => target === `apps/${n}` || target.startsWith(`apps/${n}/`))
  )
}

/** 扫开源这一侧，回所有越界的地方（`文件: 说明`）。 */
export function scanOpenSide(root = ROOT) {
  const hits = []
  for (const dir of openSideDirs(root)) {
    const abs = join(root, dir)
    for (const file of walk(abs)) {
      const text = readFileSync(file, 'utf8')
      for (const m of text.matchAll(SPECIFIER)) {
        const spec = m[2]
        if (forbiddenSpecifier(spec, file, root))
          hits.push(`${relative(root, file)}: import '${spec}'`)
      }
    }
    const pkgFile = join(abs, 'package.json')
    if (existsSync(pkgFile)) {
      const pkg = JSON.parse(readFileSync(pkgFile, 'utf8'))
      for (const field of [
        'dependencies',
        'devDependencies',
        'peerDependencies',
        'optionalDependencies',
      ])
        for (const name of Object.keys(pkg[field] ?? {}))
          if (FORBIDDEN_NAMES.includes(name))
            hits.push(`${dir}/package.json: ${field} 里有 ${name}`)
    }
    for (const name of ['tsconfig.json', 'tsconfig.check.json']) {
      const tsFile = join(abs, name)
      if (!existsSync(tsFile)) continue
      const refs = JSON.parse(readFileSync(tsFile, 'utf8')).references ?? []
      for (const ref of refs) {
        const target = relative(root, resolve(abs, ref.path)).split('\\').join('/')
        if (
          CLOUD_PACKAGES.some((n) => target === `packages/${n}`) ||
          CLOUD_APPS.some((n) => target === `apps/${n}`)
        )
          hits.push(`${dir}/${name}: 引用了 ${target}`)
      }
    }
  }
  return hits
}

describe('开源仓的边界：开源这一侧不 import 云端代码（WP165）', () => {
  it('开源这一侧一处都没有越界（import / 依赖 / 工程引用）', () => {
    expect(scanOpenSide()).toEqual([])
  })

  it('扫的范围是对的：五个开源应用都在、云端包一个不在、聊天转发核心在', () => {
    const dirs = openSideDirs()
    for (const app of ['apps/server', 'apps/workstation', 'apps/desktop', 'apps/cli'])
      expect(dirs).toContain(app)
    expect(dirs).toContain('packages/chat-relay')
    expect(dirs).toContain('packages/search-providers')
    for (const n of CLOUD_PACKAGES) expect(dirs).not.toContain(`packages/${n}`)
  })

  it('判得出来：包名、子路径、相对路径钻进云端目录都算；契约与聊天转发不算', () => {
    const from = join(ROOT, 'apps/server/src/x.ts')
    expect(forbiddenSpecifier('@agentsws/metering', from)).toBe(true)
    expect(forbiddenSpecifier('@agentsws/kol-public/sources', from)).toBe(true)
    expect(forbiddenSpecifier('@agentsws/cloud', from)).toBe(true)
    expect(forbiddenSpecifier('../../../packages/hosted/src/env.js', from)).toBe(true)
    expect(forbiddenSpecifier('@agentsws/contracts', from)).toBe(false)
    expect(forbiddenSpecifier('@agentsws/chat-relay', from)).toBe(false)
    expect(forbiddenSpecifier('@agentsws/cloud-api-client', from)).toBe(false)
    expect(forbiddenSpecifier('./cloud.js', from)).toBe(false)
  })
})
