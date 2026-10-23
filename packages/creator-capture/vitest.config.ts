import { defineConfig } from 'vitest/config'

/**
 * 和私有插件同一个测试环境（jsdom）：搬来的算法对拍与采集器测试在那边就是这么跑的，换环境等于换了对拍条件。
 */
export default defineConfig({
  test: { environment: 'jsdom', globals: false, include: ['test/**/*.test.ts'] },
})
