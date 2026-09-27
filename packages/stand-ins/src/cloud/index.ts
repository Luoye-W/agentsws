/**
 * WP165（docs/83 §2 第 5 条）：云端那一侧的**契约替身**。
 *
 * 云端代码要搬去私有仓；开源这一侧（合成世界、`apps/server` 的测试、demo）不再真起云服务，
 * 改用这里按 `@agentsws/contracts` 写的内存替身：一份固定价目样例、一个钱包、一个公共红人库。
 */
export * from './http.js'
export * from './kol-public.js'
export * from './kol-sync.js'
export * from './pricing-sample.js'
export * from './wallet.js'
