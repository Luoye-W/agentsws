import { fileURLToPath } from 'node:url'
import tailwindcss from '@tailwindcss/vite'
import react from '@vitejs/plugin-react'
import { defineConfig } from 'vitest/config'

/**
 * 后台由云进程在 `/admin/*` 下当静态文件回（65 §8），所以 `base` 是 `/admin/`——
 * 产物里的每一条资源路径都得带上它，否则部署之后页面能开、js 404。
 *
 * 开发时把 `/v1` 代到本地跑着的云进程（默认 4400），cookie 才带得过去。
 */
const CLOUD = process.env.AGENTSWS_CLOUD ?? 'http://127.0.0.1:4400'

export default defineConfig({
  base: '/admin/',
  plugins: [react(), tailwindcss()],
  resolve: { alias: { '@': fileURLToPath(new URL('./src', import.meta.url)) } },
  server: {
    host: '127.0.0.1',
    port: 4401,
    proxy: { '/v1': { target: CLOUD, changeOrigin: false } },
  },
  build: { outDir: 'dist', emptyOutDir: true },
  test: {
    environment: 'jsdom',
    globals: false,
    include: ['test/**/*.test.{ts,tsx}'],
  },
})
