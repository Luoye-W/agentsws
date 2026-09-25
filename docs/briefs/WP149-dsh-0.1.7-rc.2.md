# WP149 dsh 升级：0.1.7-rc.1 → 0.1.7-rc.2

worktree `../agentsws-wt/wp149-dsh-rc2` · 分支 `wp/149-dsh-rc2`（从 main 新起）。

## 背景
Luoye 09-25：「DSH 0.1.7 rc2 更新了，同步更新」。npm 实查（09-25）：`next = 0.1.7-rc.2`（09-24 14:18 UTC 发），release 说明：
https://github.com/deepseek-ai/deepseek-harness/releases/tag/dsh-v0.1.7-rc.2 。我们现在钉 `0.1.7-rc.1`（WP132）。
**所有 `@deepseek-ai/dsh*` 直接依赖一起升到同一版**（WP134 / WP136 / WP144 / WP147 加了不少：账号登录三件、dsh-computer-use、cua-driver-mcp、attachment 两件、compaction-image-offload …，一个都不许落在 rc.1），
`pnpm-workspace.yaml` 的 `minimumReleaseAgeExclude` 与 overrides 跟着改；BrowserSkill 那几条手工 overrides 照旧要能装上。

## 做法：严格照 `docs/42` 的 checklist，一步不跳
① 基线（升级前存档：`packages/dsh-adapter` 用例数、两个模拟包 **dsh 运行时** fast 档结果与指标、seam 清单）→ ② 观察上游：读 rc.1 → rc.2 的 release 说明全文与提交摘要；
**并用 `gh api "repos/deepseek-ai/deepseek-harness/git/trees/dsh-v0.1.7-rc.2?recursive=1"` 列 `packages/` 全部包，与 rc.1 的 tag 比新增 / 改名 / 转正 / 移除**（不只看我们依赖树里的——WP132 就因此漏过电脑操控）→
③ 改版本号看依赖树（diff lockfile，新增传递依赖逐个看许可证、体积、安装脚本、原生模块）→ ④ 修 seam（逐个对新 `.d.ts`；`cordis.patch.yml` 与 `profile-lockdown.test.ts` 用 `--dump-config-schema` 校验，锁定的 id 一个都不许静默失效；④bis 默认值扫描）→
⑤ 重判上次放弃的选项 → ⑥ 升级后重跑 ①，逐条比（token / cost 漂移 > 5% 要解释）→ ⑦ 全仓验证与收尾。七条红线照 docs/42 §2。

## 这一版要特别看的（release 说明里与我们相关的）
1. **「账号任务与 API Key 任务使用独立的模型入口；退出账号前确认并停止账号任务」**——对照 WP134 的 `deepseek-account` 宿主与 `deepseekAccountProvider`，行为有没有变、要不要跟。
2. **「插件管理页可启用自动审阅；Inspector 不再默认提供，需要单独安装」**——我们关死了 auto review、没挂 Inspector；确认 profile 锁定仍然成立。
3. **定时任务 / 提醒（默认关）、时间上下文（默认关，开了每 10 分钟更新）**——确认默认关、我们的锁定不受影响；另外对照我们右栏「定时任务」面板（WP140 藏起来的那个，还没做）与服务端的定时 / 例行任务：官方这套能不能借、借哪部分——**只评估写进报告，不动手**。
4. **「进行中的对话可直接使用新启用的工具」**——与我们「一次运行一棵树、工具面运行开始时定死」的纪律冲不冲突；确认职责白名单、浏览器 / 电脑操控的「批了才挂」不被它绕开。
5. **「减少标准模式每轮对话中固定提示信息的 token 开销」**——看模拟指标 token 有没有降、我们的 persona / 分段装配有没有受影响。
6. **「修复过长工具输出中的部分字符显示残缺、并可能导致后续对话失败」**——截图 / 长工具结果那条路（WP147）顺带复核。
7. 电脑操控（WP144）、截图进模型（WP147）、DeepSeek 账号（WP134）、场景切换（WP136）各自的测试全过；`computer-use.lock.json` 的 cua-driver 版本是否要随 rc.2 文档引用的版本变。

## 验证
`scripts/verify-changed.sh` + `vitest run packages/dsh-adapter packages/runtime-direct packages/simulation packages/model-gateway apps/server apps/desktop` + 两个模拟包 **三个运行时** fast 档门禁 +
`pnpm -F @agentsws/desktop package --dir` 起得来（dsh 子进程运行时随桌面壳走；许可证清单打包检查要过）+ `node scripts/check-upstreams.mjs --check`。
`docs/42` 末尾按格式记这一次；`upstreams.yml` 的 dsh 条目版本同步；`packages/dsh-adapter/UPGRADE.md` 新节；`docs/35` 记「WP149 完成，待审」。

## 报告额外要一节
「rc.2 里官方化了 / 新出了哪些我们也有或需要的」：逐条 = 我们的实现 / 官方对应物 / 换不换或借不借的建议 / 工作量 S-M-L。

## 纪律
不跑任何批量清理命令；不启动 cua-driver 操作桌面、不开真浏览器；测试不联网；不读 .env*。
