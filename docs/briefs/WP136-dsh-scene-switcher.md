# WP136 在 Agents 工坊里切换 dsh 场景（Profile）

worktree `../agentsws-wt/wp136-dsh-scenes` · 分支 `wp/136-dsh-scenes`（从 main 新起）。

## Luoye 定（09-24）
dsh 的 Profile 就是「不同的工作场景」。Agents 工坊只专注跨境电商 / 出海营销，是 dsh 里的**一个**场景；用户想拿它编程、做别的事，直接切到 dsh 官方的场景（或自己建的）——**不该让用户为此再单独下载一份 dsh**。其他场景不是我们做的，我们只提供入口，不维护它们。

## 事实（Fable 已查 dsh 0.1.7-rc.1 README）
`dsh` 是唯一的启动器：`dsh --profile <name>` 启动 `$DSH_HOME/profiles/<name>`；官方自带模板 `web`（网页版通用助手）、`headless`、`sdk`、`sdk-minimal`、`acp`，首次使用时从模板自动初始化；`dsh --profile <name> --from-default-profile <template>` 从模板建自定义场景；`dsh plugin --profile <name> <pnpm args>` 管某个场景的插件。我们的安装包已经带了 dsh 全部代码与 Node 22 运行时（WP111），但只把它当库用，没有给用户留入口。

## 交付
1. **场景列表与启动**（`apps/server` + 桌面壳）：列出 `$DSH_HOME/profiles/*` + 官方模板；「Agents 工坊」固定在第一个且是默认；启动其他场景 = 用**捆绑的 Node** 跑捆绑的 `dsh` 启动器（`web` 场景起本机网页服务，端口自选、只监听回环），在系统浏览器或桌面壳新窗口里打开；关闭 / 重启 / 状态。
2. **DSH_HOME 放在我们的应用数据目录里**（不与用户可能另装的 dsh 共用 `~/.dsh`，避免两个 dsh 版本互改配置）；报告里写清路径与「用户已有另一份 dsh 时两边如何共存」。
3. **边界**：我们的七行锁定（`profiles/agentsws/cordis.patch.yml`）只作用于 Agents 工坊场景——其他场景是 dsh 官方或用户自己的，按 dsh 默认运行（插件管理、DeepSeek 账号等照常开）；界面上用一句人话写明「这个场景由 DeepSeek 官方维护，Agents 工坊不对它负责」。我们的业务数据（客户、红人、积分、密钥）在自己的数据目录与加密库，其他场景读不到（写测试证明：其他场景的工作区根不指向我们的数据目录，环境变量里不带我们的任何密钥）。
4. **共享**：DeepSeek 账号登录（WP134，若已合入）在 `$DSH_HOME` 的凭据库里，所有场景共用，登录一次即可；报告里评估「把 Agents 工坊官方积分接口作为其他场景的一个模型来源」的做法与工作量（本单只评估，不实现）。
5. **入口**：托盘菜单「切换场景」+ 工作台左下角账户块上方一个「场景」小入口（遵守 docs/36 减字：一行、一个图标）；新建场景（选模板、起名）；删除自建场景（二次确认、只删 `$DSH_HOME/profiles/<name>`，不碰 Agents 工坊）。
6. **安装包体积**：实测带不带官方 `web` 场景所需依赖的差值写进报告；若差值 > 50 MB，改为「首次打开该场景时下载」并说明方案。
7. 文档：`docs/79-dsh场景切换-v1.md`；`docs/62`（内测安装说明）加一节；`packages/dsh-adapter/UPGRADE.md` 记一行。

## 验证
`scripts/verify-changed.sh` + `vitest run apps/desktop apps/server packages/dsh-adapter` + `pnpm -F @agentsws/desktop package --dir` 后实测：包里能列出场景、能起 `web` 场景并返回 200、Agents 工坊场景不受影响（3 人包 `--runtime dsh` fast 档零漂移）。截图 `docs/assets/workstation/dsh-scenes-*.png`。
