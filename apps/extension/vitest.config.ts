import { fileURLToPath } from 'node:url'
import { defineConfig } from 'vitest/config'

/**
 * 插件自己的测试。**不经 WXT**：被测的是 `src/lib/*` 那几个纯函数
 * （体检、解析、阈值筛选、导出、排队），它们一个都不碰 `chrome.*`——
 * 碰 `chrome.*` 的那几个（`settings` / `queue`）在测试里注入一个假的
 * `chrome.storage.local`，而不是起一个浏览器。
 */
export default defineConfig({
  resolve: { alias: { '@': fileURLToPath(new URL('./src', import.meta.url)) } },
  test: {
    environment: 'jsdom',
    globals: false,
    include: ['test/**/*.test.ts'],
  },
})
