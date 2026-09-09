import { defineConfig } from '@playwright/test'

/**
 * Electron 冒烟（不需要浏览器二进制，只驱动 Electron 自己）。
 * 跑之前先 `pnpm -w exec tsc -b apps/desktop`（e2e 用的是 dist/）。
 */
export default defineConfig({
  testDir: '.',
  testMatch: '*.spec.ts',
  timeout: 120_000,
  expect: { timeout: 30_000 },
  workers: 1,
  retries: 0,
  reporter: [['list']],
})
