/**
 * `@agentsws/design-core`（58 §2）：五条设计职责共用的**能力**，不是职责。
 *
 * 同 `kol-core` / `social-core` 的纪律：纯逻辑 + 注入 IO。这个包里没有
 * `Date.now()`、没有 `fetch`、没有模型调用、碰不到一个凭据，也不落盘。
 * 五条职责（`packages/roles` 的 `roles/design/*.yml`）与服务进程那一侧调它。
 *
 * | 模块 | 干什么 |
 * |---|---|
 * | `brief` | 需求单 → brief（目标 / 受众 / 尺寸 / 文案 / 禁忌 + 变体计划），纯函数 |
 * | `specs` | 规格表的取数口；**广告规格暂时本地定义**（真源在 `ads-core`） |
 * | `variants` | 变体计划、提示词组装、品牌系统注入、额度提前说 |
 * | `library` | 素材库索引（按品牌 / 用途 / 尺寸 / 定稿状态）、查重、blob key |
 * | `brand` | 从公司层技能取品牌系统；缺 → 「先设品牌系统」卡 |
 *
 * **不在这里的东西**（各有去处，免得有人在这里找）：
 *
 * - 屏幕与印刷规格表 → `@agentsws/contracts` 的 `DESIGN_SPECS`（唯一真源）；
 * - 广告素材规格 → WP75 的 `@agentsws/ads-core` 的 `spec.ts`
 *   （还没合进 main，`specs.ts` 里先本地定义一份形状 + 一句 TODO）；
 * - 「素材入库永远人审」→ `@agentsws/core` 的 `HARD_L1`（yml 放宽不了）；
 * - 禁忌词的**强制** → `@agentsws/core` guardrail 的 `design_variant`
 *   （这个包里的 `checkPrompt` 只是自查，Agent 自查不能当门）；
 * - 图片模型 → `@agentsws/model-gateway` 的 `images` 槽；
 * - 素材字节 → blob store（41 §2）。
 */
export * from './brand.js'
export * from './brief.js'
export * from './library.js'
export * from './specs.js'
export * from './variants.js'
