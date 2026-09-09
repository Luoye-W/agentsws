/**
 * `@agentsws/simulation` —— 模拟回路（09 §3、26）。
 *
 * 场景 DSL + 合成公司生成器 + runner + 六条不变量 + 报告与合并门禁。
 *
 * 边界（31 §1 I9）：这里做的是**协议不变量**那一类模拟。平台契约冒烟（真实测试店）、
 * 真实模型质量评测、独立隐藏恶意输入是另外三类，不在这个包里，也不互相代替。
 * **替身跑通不等于上线可靠**（26 原则 ④）。
 */
export * from './context.js'
export * from './errors.js'
export * from './evidence.js'
export * from './expectations.js'
export * from './invariants.js'
export * from './learning.js'
export * from './metrics.js'
export * from './pack.js'
export * from './replay.js'
export * from './report.js'
export * from './routine.js'
export * from './runner.js'
export * from './scenario/duration.js'
export * from './scenario/parse.js'
export * from './scenario/types.js'
export * from './suite.js'
export * from './synth.js'
export * from './world.js'
