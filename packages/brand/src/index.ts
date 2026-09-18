/**
 * `@agentsws/brand` —— 母品牌「出海Agents工坊」标记在代码里的唯一副本。
 *
 * 真源是 `00_Brand/品牌设计规范-v2.md`（见 `geometry.ts` 抬头）。这个包**零依赖**，
 * 工作台的 `BrandMark` 组件、桌面壳的图标生成脚本、将来云端的登录页与邮件模板
 * 都从这里取同一份数字与同一份 SVG，不各写一遍、也不各画一版。
 */
export * from './geometry.js'
export * from './svg.js'
