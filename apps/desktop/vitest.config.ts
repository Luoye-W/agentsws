import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    include: ['test/**/*.test.ts'],
    coverage: {
      provider: 'v8',
      include: ['src/**'],
      // main / preload 是 Electron 进程入口，由 e2e/ 的 playwright smoke 覆盖；
      // ports.ts 只有类型，编译产物是空的 `export {}`，没有可执行行。
      exclude: ['src/main.ts', 'src/preload.cts', 'src/ports.ts', 'src/tray-icon.ts'],
      thresholds: { lines: 100, functions: 100, statements: 100 },
      reporter: ['text'],
    },
  },
})
