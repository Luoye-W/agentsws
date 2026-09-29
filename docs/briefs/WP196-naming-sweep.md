# WP196 改名扫描：「店主」→「负责人」、用户看得到的「agentsws」→「Agents 工坊」、岗位可改名

worktree `../agentsws-wt/wp196-naming` · 分支 `wp/196-naming`（从 main 新起）。先读 `_common.md`、`docs/36`（界面与少字）、`packages/roles/positions/*.yml` 里最高那个岗位（现名「店主 / 负责人」）与 `packages/roles/roles/common/owner.yml`（「工作区所有者」）、`apps/workstation/src/lib/i18n.ts`、`apps/server/src/onboarding.ts`、`owner-tools.ts`、`packages/stand-ins/src/runtime/owner.ts`、`packages/skills/bundled/*/SKILL.md`、docs/35 里 WP188 合并记录（改名的来由）。

## 背景（Luoye 09-29）
1. 「店主这个岗位听起来有点怪怪的，感觉叫 CEO 好像也不太合适，也不一定就是 CEO 在用，可能管理海外业务的老大在管理。」→ Luoye 选定默认名 **「负责人」**（英文 **Lead**），并且**用户可以在公司页自己改名**（CEO、海外业务总监……）。
2. 早先定的：用户看得到的地方一律叫「**Agents 工坊**」（英文 Agents Workshop），`agentsws` 只留作仓库 / 包名 / 域名 / 命令行名。WP188 只改了模型卡与随便聊那部分，其余是这一单。

## 要做
1. **岗位名**：「店主 / 负责人」「店主」作岗位名的地方 → 「负责人」/ Lead（i18n、岗位 yml、种子数据、demo、模拟包合成数据、测试断言）。**岗位 id 不改**（数据兼容）。
2. **职责名**：「工作区所有者」→「**公司设置与授权**」（英文 Company Settings & Permissions）——它管策略规则、授权额度、职责分配、连接授权、公司简报；id `common.owner` 不改；persona 里「你是谁」一段同步改。
3. **提示词与技能里把用户叫「店主」的**（如 `policy-review` 的「帮店主把……」）→ 按语境改成「负责人」或直接「你」；评测集 `evals.json` 同步。
4. **老工作区迁移**：库里岗位名仍是旧默认值（「店主 / 负责人」「店主」「Owner」等）的，启动时改成新默认名；**用户自己改过的名字一律不动**；可重复跑。
5. **岗位可改名**：公司 → 岗位卡上加「改名」（有就确认能用）：只改显示名，中英各一；改名记审计；路由与意图不受影响（路由看的是职责，不看岗位显示名——核实一遍，受影响就写进报告）。
6. **「agentsws」→「Agents 工坊」扫描**：界面（左栏字标、页面标题 `<title>`、关于页、空态、提示、错误话术）、桌面壳（窗口标题、托盘菜单、安装包显示名、通知标题）、教程 `docs/help/*`（中英）、邮件与导出文件里给人看的名字、⌘K、顶栏模型芯片里露出的 `agentsws/…`（显示成「Agents 工坊 · 模型名」，id 不变）。**不改**：包名、仓库名、命令行 `agentsws` 命令、环境变量 `AGENTSWS_*`、数据目录名、协议 / 接口路径、代码标识符。列一张「改了哪些 / 故意没改哪些」的表进报告。
7. 模拟：名字进了报告的，基线按惯例重写并逐条说明；其余零漂移。

## 纪律
只改显示文字与迁移，不改 id / 契约语义；不跑批量清理命令；不读 .env*；本机 4317 服务别碰。并行中：WP191（`packages/roles/roles/social/*`、社媒岗位）、WP194（公司页「积分」tab、`/org`）、WP195（`brand-mark*`、`app-shell.tsx` 左栏标记）——碰到同一文件只改文字、别动结构，冲突留给 Fable 合并时两边都保留。

## 验证
`scripts/verify-changed.sh` + fast 模拟三包 × stub（有漂移说明）+ `gen-sdk` / `gen-ontology --check` / `gen-cloud-contract --check` + `open-repo-boundary`（vitest）；截图：公司页岗位卡（新名 + 改名）、左栏字标、关于页；报告 `docs/briefs/reports/WP196.md`。
