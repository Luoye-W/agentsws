/**
 * `@agentsws/meetings` —— 会议内核（37 §4）。
 *
 * 免费默认层（随安装、Apache-2.0）：会议对象与存储两档、六种记录来源、受控原始材料区、
 * 转写 → 围栏 → 抽取的处理管线、默认会议助手、认领卡与纪要导出。
 *
 * 付费增强与第三方应用按 23 的应用规范接 `meeting.record_source` / `meeting.processor`
 * 两个扩展点，替换或叠加在免费默认版之上。
 */
export * from './assistant/extract.js'
export * from './assistant/processor.js'
export * from './erase.js'
export * from './errors.js'
export * from './fixtures.js'
export * from './ids.js'
export * from './migrations.js'
export * from './minutes.js'
export * from './outputs.js'
export * from './pipeline.js'
export * from './raw-store.js'
export * from './sources/index.js'
export * from './sqlite-raw-store.js'
export * from './sqlite-store.js'
export * from './store.js'
export * from './store-logic.js'
