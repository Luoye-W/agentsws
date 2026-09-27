# WP169 市场三件小事：向导提示花费、店铺校正后推动态、按市场的主要语言探测

worktree `../agentsws-wt/wp169-markets-2` · 分支 `wp/169-markets-2`（从 main 新起）。先读 `_common.md`、`docs/briefs/reports/WP166.md`、`docs/81`、`docs/82`、`packages/contracts/src/markets.ts`、`apps/server/src/seo-service.ts`、向导与设置页的 `MarketsPicker`。

## Luoye 09-27 定
每日搜索结果页（SERP）上限**按每个市场各 5 次**（维持现状）；下面三件都做。

## 要做
1. **向导提示花费**：`MarketsPicker` 选了 2 个及以上市场时，一句短提示「多一个市场，搜索可见度的探测花费多一份」（照 docs/36 §7：一句话，细节进问号：每周默认 6 问 × 3 平台 × N 个市场 × 0.2 积分，以及每日搜索结果页每个市场各 5 次）。设置页同一个组件同样显示。
2. **店铺校正后推一条动态**：WP166 的店铺校正（`list_markets` / `list_shipping_zones`）改了市场时，除了设置页那一句，再推一条动态 / 通知给工作区所有者（照现有通知机制，不新造渠道），点开到设置页公司档案。没改就不推。
3. **按市场的主要语言探测**：每个市场一个主要语言（写进 `markets.ts` 的表：如 DE → de、FR → fr、JP → ja、US / GB / CA / AU → en，多语国家取第一语言并允许档案里覆盖——加可选字段，只加不改）。每周 AI 问答探测用该语言问（问题由模型从品牌语言翻成该市场语言，翻译结果缓存、每个问题每种语言只翻一次；没配模型就用原语言问并在面板注明）；SERP 的 `language` 参数同样按市场。结果展示仍用用户界面语言说明。价目不变。
4. docs/81 / docs/82 相应段落补上。

## 纪律
契约只加不改；不连真服务；不跑批量清理命令；不读 .env*；Luoye 的本机服务在 4317 别碰。WP168 在私有仓并行（不动开源仓）。

## 验证（审核方全量用）
`vitest run packages/contracts packages/seo-core packages/search-providers apps/server apps/workstation` + fast 模拟两个包三个运行时 + `gen-sdk` / `gen-ontology --check` / `gen-cloud-contract --check`；截图：向导选两个市场时的提示。
