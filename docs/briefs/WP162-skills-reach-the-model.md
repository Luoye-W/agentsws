# WP162 技能正文真的进到模型：自带技能入库、按需技能可读、每个登记的技能都有正文

worktree `../agentsws-wt/wp162-skills-load` · 分支 `wp/162-skills-load`（从 main 新起）。先读 `_common.md`、`docs/briefs/reports/WP160.md`（§偏离第 1 条）、
`packages/learning/src/resolved.ts`（`skillPromptSections`）、`apps/server/src/runtime.ts`（约 1030 行拼 persona 段）、`apps/server/src/learning.ts`（`seedDefaultSkill`、`DEFAULT_SKILL_NAME`）、
`packages/skills/src/{registry,bundled}.ts`、`packages/roles/src/schema.ts`（`SKILL_REF`：`load: always | on_demand`）、`packages/stand-ins`（`TOOL_WORDS_ZH` 工具名人话表，WP153）。

## 问题（Fable 09-27 核实）
1. `skillPromptSections` 把 `load: on_demand` 的技能直接过滤掉，运行时也没有「按需读技能」的工具——按需技能**模型永远读不到**。
   受影响：`seo-judgment`、`ad-copywriting`、`audience-research`、`email-sms`、`influencer-marketing`（WP160）、`returns-policy-calc`、`chargeback-evidence`、`workspace-basics`、`policy-review`。
2. 服务端启动只 `seedDefaultSkill`（`customer-care` 一份）。WP160 放在 `packages/skills/bundled/` 的正文**没有种进技能库**，`resolve` 查不到。
3. 职责 YAML 里登记的技能名，有不少仓库里根本没有正文：`brand-voice`（19 条职责、always）、`brand-system`（5 条、always）、`returns-policy-calc`、`chargeback-evidence`、`workspace-basics`、`policy-review`——请逐个查实（有的可能由品牌档案动态生成，如 brand-voice；是的话写明来源）。

## 要做
1. **自带技能入库**：服务端启动时把 `packages/skills/bundled/*/SKILL.md` 按包基础层（`tier: 'package'`、`owner: 'package'`）种进每个工作区的技能库；已有同名包层段落且版本相同就跳过，版本新了就替换包层（**上面几层的覆盖一律不动**）。`customer-care` 的默认正文也搬进 `bundled/`，`seedDefaultSkill` 并进同一条路。
2. **always 技能**照旧进 persona 段（字节稳定、`prompt_replayable` 不变量要过）。
3. **按需技能**：
   - persona 里加一段「可用技能索引」：只列本次运行这条职责登记的按需技能的名字 + frontmatter 里的 `description` 一句（排序固定、字节稳定）。
   - 加一个只读工具 `read_skill(name)`：返回六层叠加后的正文。**只认本次运行这条职责（和岗位入口路由到的职责）登记了的技能名**，别的名字回「这条职责没有这个技能」；被本人排除的技能照旧读不到。stub / direct / dsh 三个运行时都能用，dsh 那边照 WP148 的工具桥接方式挂。
   - `TOOL_WORDS_ZH` 加这条的人话（「技能手册」之类，名词口径）。
4. **登记即要有正文**：加一个测试扫所有职责 YAML（`packages/roles/roles`、`packs/*/roles`、`role-packs`）：每个登记的技能名要么在 `bundled/` 里有正文，要么在一张写明理由的「动态来源」表里（例如 brand-voice 来自品牌档案，写清在哪生成）。缺正文的，本单补写中文正文（跨境 DTC 口吻、遵守 WP160 的改写规矩与授权字样守卫、数字只引事实卡）；拿不准内容的列进报告给 Fable。
5. 本单**不做**「按店铺情况自动挂技能」（订阅定价 / ASO 的按需挂上，Luoye 还没定），但 `read_skill` 与索引的写法要让以后「这条职责这家店多挂一个技能」只是往 effective skills 里多加一个名字。

## 纪律
不改契约的已有字段（只加）；不跑批量清理命令；不读 .env*；Luoye 的本机服务在 4317，别碰。WP158 / WP159 / WP161 / WP142 在并行或待审，改共享文件只动你那几处。
prompt 字节会变：WP148 金样摘要与 prompt 哈希要跟上，模拟基线如需重写，报告里逐条写清为什么变、指标不许劣化。

## 验证（审核方全量用）
`vitest run packages/skills packages/learning packages/roles apps/server packages/stand-ins` + fast 模拟两个包三个运行时 + `gen-ontology --check`。
加一条端到端：开一个挂了 `email-sms` 的职责跑一次（stub 剧本 + direct 替身上游），断言索引里有它、调 `read_skill('email-sms')` 拿到正文、调别的名字被拒。
