# WP177 dsh 升级：0.1.7-rc.2 → 0.2.0-rc.1

worktree `../agentsws-wt/wp177-dsh-020` · 分支 `wp/177-dsh-020`（从 main 新起）。

## 背景
Luoye 09-28：「DeepSeek harness 有一个非常大的更新，0.2.0 出来了，同步更新到最新版」。npm 实查（09-28）：`next = 0.2.0-rc.1`（09-28 12:34 UTC 发），`latest` 仍是 `0.1.7-rc.2`；还没有正式的 `0.2.0`。release 说明：
https://github.com/deepseek-ai/deepseek-harness/releases/tag/dsh-v0.2.0-rc.1 （对比：`dsh-v0.1.7-rc.2...dsh-v0.2.0-rc.1`）。我们现在钉 `0.1.7-rc.2`（WP149）。
**所有 `@deepseek-ai/dsh*` 直接依赖一起升到同一版**；`@deepseek-ai/cordis` 仍是 `~4.0.4`、`@deepseek-ai/schemastery` `~3.18.4`（核实一遍，变了就一起跟）；`pnpm-workspace.yaml` 的 `minimumReleaseAgeExclude` 与 overrides 跟着改；BrowserSkill 那几条手工 overrides 照旧要能装上。
这是**大版本号**的变动（0.1 → 0.2），不只是修修补补：公开 API、包结构、插件模型都可能变，seam 要逐个对。

## 做法：严格照 `docs/42` 的 checklist，一步不跳
① 基线（升级前存档：`packages/dsh-adapter` 用例数、三个模拟包 **dsh 运行时** fast 档结果与指标、seam 清单）→ ② 观察上游：读 release 说明全文与 `dsh-v0.1.7-rc.2...dsh-v0.2.0-rc.1` 的提交摘要；**用 `gh api "repos/deepseek-ai/deepseek-harness/git/trees/dsh-v0.2.0-rc.1?recursive=1"` 列 `packages/` 全部包，与 rc.2 的 tag 比新增 / 改名 / 转正 / 移除** → ③ 改版本号看依赖树（diff lockfile，新增传递依赖逐个看许可证、体积、安装脚本、原生模块）→ ④ 修 seam（逐个对新 `.d.ts`；`cordis.patch.yml` 与 `profile-lockdown.test.ts` 用 `--dump-config-schema` 校验，锁定的 id 一个都不许静默失效；④bis 默认值扫描：任何新出现的出网 / 自动执行 / 自动审阅默认开的开关都要报）→ ⑤ 重判上次放弃的选项 → ⑥ 升级后重跑 ①，逐条比（token / cost 漂移 > 5% 要解释）→ ⑦ 全仓验证与收尾。七条红线照 docs/42 §2。

## 这一版要特别看的（release 说明里与我们相关的）
1. **「自动化任务改由可选插件包提供」**——我们依赖的定时 / 例行任务那部分（`dsh-schedule` 等）还在不在默认包里；我们服务端的定时（每日 SEO、开发信 09:00 巡检等）是自己写的还是借了 dsh 的，查清；profile 锁定对这个插件包是否仍然关着。
2. **「使用 DeepSeek 账号模型的会话无需额外 API Key 即可网页搜索」**——这是一条**新的出网能力**：对照 WP134 账号宿主与我们的网页搜索口（docs/75 / docs/81：数据接口走我们自己的路由、计费与缓存），默认必须**关着**，不许绕过我们的数据接口路由；报告写清要不要、怎么接。
3. **「修复工具调度异常后对话无法继续；结果未知的操作提示先核实副作用、不盲目重试」**——与我们 txn / 出卡纪律（发信、付款等不许重复执行）对照，看有没有可借的、会不会和我们的重试冲突。
4. **「调整工作过程展示在不同初始化路径的默认值」**「创造模式完善插件开发指引、体验技能」「插件管理与安装引导」——确认我们的 profile 锁定（关插件市场、关自动审阅、不挂 Inspector 等）仍成立。
5. **「改善会话在图片失效后自动重传并继续请求」**——截图进模型那条路（WP147）复核。
6. 电脑操控（WP144）、截图进模型（WP147）、DeepSeek 账号（WP134、WP150、WP151）、场景切换（WP136）、浏览器运行时（WP148）、`read_skill` 工具桥（WP162）各自的测试全过；`computer-use.lock.json` 的 cua-driver 版本是否要随新版变。

## 验证
`scripts/verify-changed.sh` + `vitest run packages/dsh-adapter packages/runtime-direct packages/simulation packages/model-gateway apps/server apps/desktop` + **三个模拟包（b2b-3c-3p、dtc-3c-3p、dtc-15p）三个运行时** fast 档门禁 + `pnpm -F @agentsws/desktop package --dir` 起得来（要下载捆绑 Node 就停在那一步并在报告写明，不擅自下载新的来源）+ `node scripts/check-upstreams.mjs --check`。
`docs/42` 末尾按格式记这一次；`upstreams.yml` 的 dsh 条目版本同步；`packages/dsh-adapter/UPGRADE.md` 新节；`docs/35` 记「WP177 完成，待审」。

## 报告额外要一节
「0.2.0-rc.1 里官方化了 / 新出了哪些我们也有或需要的」：逐条 = 我们的实现 / 官方对应物 / 换不换或借不借的建议 / 工作量 S-M-L。

## 纪律
不跑任何批量清理命令；不启动 cua-driver 操作桌面、不开真浏览器；测试不联网；不读 .env*；**Luoye 的本机服务在 4317 别碰也别重启**；Luoye 的机器负载可能很高，测试 `--maxWorkers=2`，起服务钩子超时的文件串行重跑确认。
