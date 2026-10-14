import { defineConfig } from 'vitest/config'

/** DOM 那几组（选择器、页面操作、假页面跑一遍）在文件头用 `@vitest-environment jsdom` 单独切。 */
export default defineConfig({
  test: { environment: 'node', globals: false, include: ['test/**/*.test.ts'] },
})
