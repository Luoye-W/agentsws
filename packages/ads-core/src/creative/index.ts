/**
 * WP317（docs/101 §5.1④，决策 559）：广告素材流水线的纯逻辑。
 *
 * 导出表进来（`performance`）→ 标题 / 描述两个子 Agent（`copy-agents`）按平台硬规矩过一遍
 * （`copy-rules`）→ 上传表（`upload-sheet`，WP314 之前的最小版本）→ 设计岗批量出图单
 * （`design-batch`）→ 实验记忆（`experiments`）。全部纯函数，模型调用注入。
 */
export * from './copy-agents.js'
export * from './copy-rules.js'
export * from './design-batch.js'
export * from './experiments.js'
export * from './performance.js'
export * from './upload-sheet.js'
