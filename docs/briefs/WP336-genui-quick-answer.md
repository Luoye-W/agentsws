# WP336 当场回答换用 dsh-genui 渲染层（Luoye 10-15 提；决策 810–812 按建议先做）

worktree `../agentsws-wt/wp336-genui` · 分支 `wp/336-genui`。先读 `_common.md`、`docs/briefs/reports/WP291.md`、`packages/contracts/src/answer.ts`（`splitAnswer`）、`apps/workstation/src/components/answer/answer-view.tsx`、`packages/roles/src/entry-kind.ts`、`packages/simulation/src/positions.ts`、`docs/96`。插件：https://github.com/omdsh-dev/dsh-genui （npm `@changfenhuang/dsh-genui`，MIT，注意不是无 scope 的同名 Vue 包）；嵌入入口 `/embed`（`GenuiBlock`、`processGenuiSpec`）。

## 要做
1. **只用渲染层 + 借写法协议**：锁定确切版本依赖 `@changfenhuang/dsh-genui` 的 `/embed`；**不装它的 dsh 服务端插件和 42KB skill**（避免三个运行时不一致）。先实测 React 19 下（pnpm overrides 压 React 18 依赖）能否正常渲染、`@deepseek-ai/dsh-client-ui-primitives` 依赖怎么处理；压不住就把需要的渲染文件移植进仓（MIT，保留版权与 NOTICE）。
2. **白名单（服务端共享 contracts 里过滤）**：text / card / grid / stat / table / list / keyvalue / timeline / steps / callout / badge / progress / chart（echart 只开柱 / 线 / 饼 / 漏斗预设，资产本机托管）；其余类型（button、表单、image / audio / video、link、svg、mermaid、scene3d 等）一律丢掉；去掉所有 action 与自定义配色（决策 337）。不传 action 处理器（按钮即使漏网也是禁用）。
3. **契约**：在 text / table / metric 之外加 `kind: 'genui'`（携带过滤后的描述）；`QUICK_ANSWER_RULE` 改成教模型写这个子集的精简说明（不塞整份 SKILL.md）；三个运行时都从回答文本取 ```dsh-ui 代码块。
4. **渲染**：`answer-view` 遇到 genui 交给 `GenuiBlock`；`--ws-*` 映射到它的 `--dsw-*` 变量；线程里同样能画。
5. **回退**：一个开关切回现有 ```answer 渲染；`splitAnswer` 与旧组件保留，老回答照常能画。
6. **测试**：确定性替身改写 ```dsh-ui，断言过滤后节点类型 / 数量 / 数字等于 mock 数据；红线用例：替身输出 button / image / scene3d / 外链必须被过滤。截图对比新旧两种（同一问题）。记录包体积增加多少。

## 纪律
不读 .env*；不碰 key / token；不调真实付费接口；不连远程机器；不碰本机 4317；不跑批量清理；不用 pkill。界面少字；截图用别的端口、拍完停掉，不写 .review-ready。不合 main、不打 tag、不发版（决策 381）。测试用 `--maxWorkers=2 --testTimeout=120000`。

## 验证
`scripts/verify-changed.sh`（LC_ALL=en_US.UTF-8）+ 模拟三包 × stub/direct/dsh + gen 检查 + 装包前冒烟 + 开源仓边界检查（新依赖许可证）；报告 `docs/briefs/reports/WP336.md`（决策号 813–817）。
