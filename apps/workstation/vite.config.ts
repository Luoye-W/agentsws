import { fileURLToPath } from 'node:url'
import tailwindcss from '@tailwindcss/vite'
import react from '@vitejs/plugin-react'
import type { Plugin } from 'vite'
import { defineConfig } from 'vitest/config'

const here = (rel: string): string => fileURLToPath(new URL(rel, import.meta.url))

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
      return null
    },
  }
}

/** 服务进程只听回环口；开发时把 /v1 代到它上面，构建产物由它自己在 / 托管。 */
const API = process.env.AGENTSWS_API ?? 'http://127.0.0.1:4317'

export default defineConfig({
  plugins: [genuiShims(), react(), tailwindcss()],
  resolve: {
    alias: { '@': fileURLToPath(new URL('./src', import.meta.url)) },
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
