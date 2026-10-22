# docs

这个目录只放对外的文档。

| 位置 | 是什么 |
|---|---|
| [`ARCHITECTURE.md`](ARCHITECTURE.md) | 英文架构说明，给外部贡献者：分层、契约、运行时、审批、安全模型 |
| [`telemetry-events.md`](telemetry-events.md) | 匿名使用数据：发什么、不发什么、怎么关（事件清单与 `packages/contracts/src/telemetry.ts` 对得上） |
| [`help/`](help/) | 用户帮助文章（中文 `*.md`、英文 `*.en.md`）。工作台右栏与官网 `/docs/` 在构建 / 运行时直接读这里 |
| [`assets/brand/`](assets/brand/) | 品牌标记 SVG（README 门面用，由 `scripts/gen-brand-assets.py` 生成） |
| `assets/架构图-0*.png` | README 与 ARCHITECTURE 引用的三张架构图 |

接口的权威定义在代码里：`packages/contracts/src/*.ts`。

内部的讨论记录、设计稿、派工单与决策过程不在这个仓库里（2026-10-18 起）。
`scripts/check-no-internal-docs.mjs` 在校验与 CI 里只放行上面这几类路径；
要新加一份对外文档，先确认里面没有业务讨论、客户名、价目和决策过程，再把路径加进那个脚本的白名单。

**English.** This directory holds only public documentation: the English architecture overview,
the anonymous usage-data event list (`telemetry-events.md`),
the user help articles (read at build and run time by the workstation and the website),
the brand marks and the three architecture diagrams. Internal design notes are not published.
