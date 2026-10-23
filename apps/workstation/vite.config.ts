import { existsSync, readdirSync, readFileSync, realpathSync } from 'node:fs'
import { dirname, resolve as resolvePath } from 'node:path'
import { fileURLToPath } from 'node:url'
import { readHelpArticle } from '@agentsws/contracts'
import tailwindcss from '@tailwindcss/vite'
import react from '@vitejs/plugin-react'
import type { Plugin } from 'vite'
import { defineConfig } from 'vitest/config'

const here = (rel: string): string => fileURLToPath(new URL(rel, import.meta.url))

/** WP341：插件包里预先打好的引擎文件（`lib/assets/*.js`，插件的 exports 没开这条路径，按包目录找）。 */
function genuiAsset(file: string): string {
  const pkg = realpathSync(here('./node_modules/@changfenhuang/dsh-genui'))
  return resolvePath(pkg, 'lib/assets', file)
}

/**
 * WP336：dsh-genui 的 `/embed` 渲染层里两处换成本地的壳（见各文件头注释）——
 * `@deepseek-ai/dsh-client-ui-primitives`（代码 / 差异 / JSON 三种组件，白名单里全关）、
 * 它自己引用的 `katex`（行内公式，当场回答用不到）。别处的引用一概不动。
 */
function genuiShims(): Plugin {
  return {
    name: 'agentsws-genui-shims',
    enforce: 'pre',
    resolveId(source, importer) {
      if (source === '@deepseek-ai/dsh-client-ui-primitives')
        return here('./src/components/answer/genui/primitives-shim.tsx')
      if (source === 'katex' && importer?.includes('dsh-genui') === true)
        return here('./src/components/answer/genui/katex-shim.ts')
      // WP341：mermaid / 3D 两个引擎用插件自己打好的那两个文件（本机打包、用到才加载，不插外部 <script>）
      if (source === 'genui-engine:mermaid' || source === 'genui-engine:three')
        return genuiAsset(`${source.slice('genui-engine:'.length)}.js`)
      return null
    },
  }
}

/** 打包清单的文件名（`dist/` 下；桌面安装包的第三方许可证清单读它）。 */
export const BUNDLED_PACKAGES_FILE = 'third-party-packages.json'

/** 模块路径 → 它所在的 npm 包根目录（最后一个 `node_modules/` 后面的包名）。 */
function packageDirOf(id: string): string | undefined {
  const clean = id.replace(/^\0/u, '').split('?')[0] ?? ''
  const at = clean.lastIndexOf('/node_modules/')
  if (at < 0) return undefined
  const rest = clean.slice(at + '/node_modules/'.length).split('/')
  const name = rest[0]?.startsWith('@') === true ? rest.slice(0, 2).join('/') : rest[0]
  return name === undefined || name === ''
    ? undefined
    : `${clean.slice(0, at)}/node_modules/${name}`
}

/**
 * WP336（决策 826）：**真打进工作台产物的**第三方包清单（名字 / 版本 / 许可证），写到
 * `dist/third-party-packages.json`。按 rollup 实际输出算：JS 只认渲染进块里的模块（摇树摇掉的、
 * 被换成本地壳的 primitives / katex 不算），样式与字体按引用到的算。桌面打包时
 * `apps/desktop/scripts/third-party-licenses.mjs` 读它，把这些包的许可证全文并进安装包的清单。
 */
function bundledPackages(): Plugin {
  return {
    name: 'agentsws-bundled-packages',
    apply: 'build',
    generateBundle(_options, bundle) {
      const dirs = new Set<string>()
      const add = (id: string): void => {
        const dir = packageDirOf(id)
        if (dir !== undefined) dirs.add(dir)
      }
      for (const out of Object.values(bundle)) {
        if (out.type === 'chunk') {
          for (const [id, m] of Object.entries(out.modules)) if (m.renderedLength > 0) add(id)
        } else {
          // 字体 / 图片这类资源：按它原来的文件算（@fontsource 的字体就是这样进来的）
          for (const f of out.originalFileNames ?? []) add(resolvePath(here('.'), f))
        }
      }
      for (const id of this.getModuleIds()) {
        if (!/\.css(\?|$)/u.test(id)) continue
        add(id)
        // Tailwind 把样式表里的 `@import "包"` 就地展开，不进模块图：按样式表原文认这些包
        if (id.includes('/node_modules/')) continue
        let css: string
        try {
          css = readFileSync(id.split('?')[0] ?? id, 'utf8')
        } catch {
          continue
        }
        for (const m of css.matchAll(/@import\s+["']([^"'./][^"']*)["']/gu)) {
          const parts = (m[1] ?? '').split('/')
          const name = parts[0]?.startsWith('@') === true ? parts.slice(0, 2).join('/') : parts[0]
          // 从样式表所在目录往上找 node_modules/<包>（pnpm 的链接取真实路径）
          for (let dir = dirname(id); name !== undefined; dir = dirname(dir)) {
            const hit = `${dir}/node_modules/${name}`
            if (existsSync(`${hit}/package.json`)) {
              add(`${realpathSync(hit)}/package.json`)
              break
            }
            if (dirname(dir) === dir) break
          }
        }
      }
      const rows = new Map<string, { name: string; version: string; license: string }>()
      for (const dir of dirs) {
        let meta: { name?: string; version?: string; license?: unknown; licenses?: unknown }
        try {
          meta = JSON.parse(readFileSync(`${dir}/package.json`, 'utf8'))
        } catch {
          continue
        }
        if (typeof meta.name !== 'string' || meta.name.startsWith('@agentsws/')) continue
        const raw = meta.license ?? (Array.isArray(meta.licenses) ? meta.licenses[0] : undefined)
        const license =
          typeof raw === 'string'
            ? raw
            : typeof (raw as { type?: unknown } | undefined)?.type === 'string'
              ? String((raw as { type: string }).type)
              : 'UNKNOWN'
        const version = typeof meta.version === 'string' ? meta.version : '0.0.0'
        rows.set(`${meta.name}@${version}`, { name: meta.name, version, license })
      }
      const list = [...rows.values()].sort((a, b) =>
        a.name === b.name ? a.version.localeCompare(b.version) : a.name.localeCompare(b.name),
      )
      this.emitFile({
        type: 'asset',
        fileName: BUNDLED_PACKAGES_FILE,
        source: `${JSON.stringify(list, null, 2)}\n`,
      })
    },
  }
}

/** 教程上官网（私有 docs/113 §4.4）：随包那份教程的源头（仓库的 `docs/help`）。 */
const HELP_DIR = here('../../docs/help')
const HELP_VIRTUAL = 'virtual:agentsws-help'
/** 构建产物里的随包教程原文（本机服务读它：断网、官网打不开时用，「查工坊帮助」也搜它）。 */
export const HELP_SNAPSHOT_FILE = 'help-snapshot.json'

function helpFiles(): Record<string, string> {
  const out: Record<string, string> = {}
  for (const f of readdirSync(HELP_DIR)
    .filter((x) => x.endsWith('.md'))
    .sort())
    out[f] = readFileSync(resolvePath(HELP_DIR, f), 'utf8')
  return out
}

/**
 * 教程上官网（私有 docs/113 §4）：
 *
 * - `virtual:agentsws-help`：随包那份教程的**目录**（标题、摘要、分组、顺序、归属，全从文章头上读）——
 *   不再在工作台里手抄 `HELP_SLUGS` / `HELP_SCOPES` / 标题词条。正文仍是 `lib/help.ts` 里按篇懒加载的。
 * - 构建时把全部原文收进 `dist/help-snapshot.json`，给本机服务用。
 */
function helpContent(): Plugin {
  const resolved = `\0${HELP_VIRTUAL}`
  return {
    name: 'agentsws-help-content',
    resolveId(id) {
      return id === HELP_VIRTUAL ? resolved : null
    },
    load(id) {
      if (id !== resolved) return null
      const files = helpFiles()
      for (const f of Object.keys(files)) this.addWatchFile(resolvePath(HELP_DIR, f))
      const list = Object.keys(files)
        .filter((f) => !f.endsWith('.en.md'))
        .map((f) => {
          const slug = f.slice(0, -3)
          const zh = readHelpArticle(files[f] ?? '')
          const enText = files[`${slug}.en.md`]
          const en = enText === undefined ? zh : readHelpArticle(enText)
          return {
            slug,
            title: { zh: zh.meta.title ?? slug, en: en.meta.title ?? zh.meta.title ?? slug },
            description: {
              zh: zh.meta.description ?? '',
              en: en.meta.description ?? zh.meta.description ?? '',
            },
            ...(zh.meta.group === undefined ? {} : { group: zh.meta.group }),
            ...(zh.meta.order === undefined ? {} : { order: zh.meta.order }),
            positions: zh.meta.positions,
            roles: zh.meta.roles,
            ...(zh.meta.requires === undefined ? {} : { requires: zh.meta.requires }),
            ...(zh.meta.aliases.length === 0 ? {} : { aliases: zh.meta.aliases }),
          }
        })
      return `export default ${JSON.stringify(list)}\n`
    },
    generateBundle() {
      this.emitFile({
        type: 'asset',
        fileName: HELP_SNAPSHOT_FILE,
        source: `${JSON.stringify({ schema: 1, files: helpFiles() })}\n`,
      })
    },
  }
}

/** 服务进程只听回环口；开发时把 /v1 代到它上面，构建产物由它自己在 / 托管。 */
const API = process.env.AGENTSWS_API ?? 'http://127.0.0.1:4317'

export default defineConfig({
  plugins: [genuiShims(), react(), tailwindcss(), bundledPackages(), helpContent()],
  resolve: {
    alias: [
      { find: '@', replacement: fileURLToPath(new URL('./src', import.meta.url)) },
      // WP461：shadcn 组件直接 `import { cn } from 'cn'`；换成认得工坊字号 / 圆角 / 阴影档位的那份（见 src/lib/cn.ts）
      { find: /^cn$/u, replacement: here('./src/lib/cn.ts') },
    ],
  },
  server: {
    host: '127.0.0.1',
    port: 4318,
    proxy: { '/v1': { target: API, changeOrigin: false } },
  },
  build: { outDir: 'dist', emptyOutDir: true },
  // WP336：dsh-genui 发的是 TS 源码；不预打包，让上面的壳在开发服务器里也生效
  optimizeDeps: { exclude: ['@changfenhuang/dsh-genui'] },
  test: {
    environment: 'jsdom',
    globals: false,
    setupFiles: ['./test/setup.ts'],
    include: ['test/**/*.test.{ts,tsx}'],
    // WP336：dsh-genui 的 TS 源码与 CSS modules 走 vite 转换（不交给 Node 直接跑）
    server: { deps: { inline: [/@changfenhuang\/dsh-genui/u] } },
  },
})
