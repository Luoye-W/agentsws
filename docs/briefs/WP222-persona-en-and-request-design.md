# WP222 两处小修：英文 persona 混中文 + 投放能下设计需求单

worktree `../agentsws-wt/wp222-persona-fix` · 分支 `wp/222-persona-fix`（从 main 新起）。先读 `_common.md`、`docs/91`（WP221 §三「顺手查到三个现有问题」与 §四 P0 两条）、`docs/58`（设计需求从投放来）、`packages/roles/roles/{ads,design,social}/*.yml`、`checkPersona` 所在文件（grep 一下）。

## 要做
1. **14 条职责的英文 persona 混着中文**（docs/91 列了：投放 4、设计 5、社媒 5，多在「Who you are」那句）→ 改成纯英文，意思与中文版一致；**只改英文那份里带汉字的句子**，别的不动。
2. `checkPersona` 加一条检查：英文 persona 里不许有汉字（CJK 统一表意文字范围），全部现有职责过检；加测试。
3. **投放 → 设计**：投放四条职责加 `request_design` 动作（照设计岗已有的需求入口与 docs/58 的写法；没有就照现有「转岗位」类动作的样子只加这一条，L1、出卡），persona 里补一句「要出图 / 改素材 → 发设计需求单给设计岗位」（中英各一，过 checkPersona 260 字上限）。
4. 模拟：基线有漂移逐条说明，否则零漂移。

## 纪律
只改上面这些；不跑批量清理命令；不读 .env*；本机 4317 服务别碰。并行中：WP220 在改 `packages/roles/roles/{pr,social}/*` 与技能——社媒那 5 条你只改英文「Who you are」里带汉字那一句，冲突留给 Fable 合并时两边都保留。

## 验证
`scripts/verify-changed.sh` + fast 模拟三包 × stub + `gen-ontology --check` + `gen-sdk` + `open-repo-boundary`（vitest）；报告 `docs/briefs/reports/WP222.md`。
