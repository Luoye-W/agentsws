# @agentsws/packages-local — 占位，二阶段实现

**契约在 `packages/contracts/src/packages.ts`（23 §1 `package.yml`、扩展点）。这个目录还没有实现。**

它是契约 #11「应用包与分发」的本地一半：`package.yml` 解析、本地安装 / 卸载 / 升级、
叠加与晋升、安装类审批项的执行器。31 §2 把它定为二阶段；38 §1 的盘点里它是
「契约有、实现无」的两层之一（另一层「定时与流程」由 WP27 补）。

现在能用的部分在别处，不在这里：

| 这件事 | 现在在哪 |
|---|---|
| `package.yml` 与扩展点的类型 | `packages/contracts/src/packages.ts` |
| 假 registry（模拟回路用） | `packages/stand-ins/src/registry.ts` |
| 官方职责包本体（roles + skills + scenarios） | `role-packs/`、`packs/dtc-3c-3p/` |
| 技能的解析、段 id、三层叠加 | `packages/skills` |

留这个目录只为占位：它没有 `package.json`，所以既不在 pnpm workspace 里也不在根
`tsconfig.json` 的 references 里，不参与安装、构建与测试。开始实现时再补
`package.json` 与 `tsconfig.json`，并把它加进根 references。

实现顺序（真要动手时）：`package.yml` schema → 本地清单与安装 → 安装 / 卸载 / 升级
作为 14 的审批项 kind + 执行器 → 再谈 registry（`agentsws-registry` 独立仓，见 34 §1）。
