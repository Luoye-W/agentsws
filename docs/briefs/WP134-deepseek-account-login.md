# WP134 第三种模型来源：用 DeepSeek 账号登录（dsh 0.1.7 官方模块）

worktree `../agentsws-wt/wp134-deepseek-login` · 分支 `wp/134-deepseek-login`（从 main 新起）。

## Luoye 定（09-24）
dsh 0.1.7 带了官方的 `@deepseek-ai/dsh-deepseek-account-platform`（系统浏览器 PKCE 授权、凭据进 dsh 本机凭据库、`getProfile` / `getBalance`、推理走 `api.deepseek.com`）——**做成第三种模型来源**：① Agents 工坊官方接口（积分）② 用我自己的模型接口（API key）③ **用我的 DeepSeek 账号登录**。按 09-16 定的「能用 dsh 官方方案的都用官方」，登录流程用官方模块，不自写。

## 现状与约束（必读）
- WP132 把它在 `profiles/agentsws/cordis.patch.yml` 里写死 `disabled: true`（红线 7：它没有自己的关闭开关、默认联网）；WP133 让七行锁定对照 `--dump-config-schema` 校验。**这一行不能简单删掉**：默认仍要关，只有用户在向导或设置里选了「DeepSeek 账号登录」才开。做法自己评估两条路，选一条写进报告：(a) patch 里改成 cordis 表达式按一个本机设置 / 环境变量决定开关（`disabled: !!js "!…"`）；(b) 保持 profile 层关死，由服务进程在用户选中时用一份运行时 patch 打开。无论哪条，`profile-lockdown.test.ts` 都要改成「没选时一定是关的、选了才开」，并保留「id 存在」那条校验。
- **凭据纪律不变**：授权在系统浏览器里完成，令牌只进 dsh 的本机凭据库，不经过 AI、不进日志、不进我们的库、不上云；我们只读「登录了没有 / 账号名 / 余额」。登出 = 调官方 logout 并清本机凭据。
- 读 README：`platformOrigin`、`inferenceOrigin`、`requestTimeoutMs`、`attemptTimeoutMs`；`desktopPlatform` 与 `x-client-platform` 头；issuer 不匹配时本机凭据被删。按官方默认值走，不加 `requestHeaders`、不开 `allowLoopbackHttp`、不开 `rewriteBrowserOrigin`。

## 交付
1. 契约：模型来源加 `deepseek_account`（只加）；`ModelProvider` 走 WP127 的三步验证（连通 → 文字 → **看图**），账号默认型号选能看图的那档（查官方文档确认当期型号名，查不到就在报告里写明、标未核）。
2. 服务端：开 / 关模块、发起登录（拿到系统浏览器要打开的地址交给桌面壳 / 工作台打开）、轮询登录状态、取账号名与余额、登出；模型网关里这一来源的调用走官方模块，不走我们的 OpenAI 兼容客户端。
3. 工作台：初始化向导第 ① 步与设置页「模型」都出现第三张卡「用我的 DeepSeek 账号登录」——点了打开浏览器登录，回来显示账号与余额，接着跑三步验证；余额查询失败说人话。数据驻留标「境内」。
4. 桌面壳：系统浏览器打开授权地址（复用现有外链打开逻辑）；回调走官方模块自己的回环，不另开端口。
5. 测试：模块默认关、选中才开（lockdown 测试改造）；登录状态机（开始 / 成功 / 取消 / 超时 / issuer 不匹配）全替身；凭据不出现在任何请求体 / 日志 / 我们的库（守卫测试）；三步验证对这一来源生效。docs/70（向导）、`packages/dsh-adapter/UPGRADE.md`、docs/42 红线 7 注释同步。

验证：`scripts/verify-changed.sh` + `vitest run packages/dsh-adapter packages/model-gateway apps/server apps/workstation` + 3 人包 `--runtime dsh` fast 档（没选这一来源时指标必须零漂移）。截图 `docs/assets/workstation/deepseek-login-*.png`（替身账号）。
