/**
 * WP220：研究技能的取数层与产出（`trend-research` 给公共关系、`social-research` 给社媒运营）。
 *
 * | 模块 | 干什么 |
 * |---|---|
 * | `sources` | 能从哪取数的白名单 + 接口管理待接能力清单 |
 * | `reddit-read` | Reddit 两路取数（接口中台 → 浏览器只读），限速、只读会话、每次记来源 |
 * | `trend` | 最近 N 天在聊什么：时间窗、去重、主体对得上、打分、扩散速度（方法改编自 last30days-skill） |
 * | `outliers` | 爆款帖：按账号自己的中位数算倍数（方法改编自 social-media-research-skills） |
 * | `report` | 报告的形状（按话题 / 情绪 / 平台分组、带出处）与进卡片流的建议 |
 */
export * from './outliers.js'
export * from './reddit-read.js'
export * from './report.js'
export * from './sources.js'
export * from './trend.js'
