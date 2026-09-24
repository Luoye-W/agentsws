# WP138–WP142 共同约定（内测前修复，来自 docs/78 走查）

在 `_common.md` 之上再加这几条：

- **真点证据是验收的一部分**：修完先 `npx tsc -b && pnpm -F @agentsws/workstation exec vite build`，再跑
  `node scripts/walkthrough-beta.mjs --port <你的端口> --only <相关段>`，派工单写了「验收步」就要那几步从「部分 / 不通」变「通」。
  端口各用各的：WP138 → 4431，WP139 → 4432，WP140 → 4433，WP141 → 4434，WP142 → 4435（同时有好几个代理在跑）。
- **走查脚本的产物不要提交**：它写 `docs/assets/walkthrough/`（大家共用）。跑完把你要当证据的几张**复制**到
  `docs/assets/wpNNN/`，然后 `git checkout -- docs/assets/walkthrough` 还原。脚本本身要改（比如 WP140 去掉分段起 demo、
  或者某一步的断言跟着界面变了）可以改，只改你那几步。
- 报告写到 `docs/briefs/reports/WPNNN.md` 并**提交**（不是 worktree 根的 REPORT.md）。
- `apps/workstation/src/lib/api.ts` 与 `lib/i18n.ts` **只在你负责的那一段附近改或在末尾追加**，别整块挪位置——几个包会同时改这两个文件。
- 文案：说人话、减字；屏幕上不许出现 snake_case 内部值、ISO 时间戳、i18n 键、工具名、人员 id。
